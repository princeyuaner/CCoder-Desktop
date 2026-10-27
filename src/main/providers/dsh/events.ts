import type { AgentEvent, Usage } from '../../../shared/events'
import type { ToolStat } from '../../../shared/tool'
import { diffLines } from '../permission-preview'
import {
  arr,
  clip,
  normalizeToolInput,
  num,
  obj,
  str,
  toolFailed,
  uiToolName,
  type Obj
} from './shared'

/**
 * dsh 的持久事件 → CCoder 的 AgentEvent。
 *
 * 同一个翻译器同时服务两条路：
 *  - 历史回放（history.ts）：只吃 `assistant/message` 这类终态事件；
 *  - 实时 Web 会话：先吃 `assistant-stream` 的增量，再在
 *    `assistant/message` 落地时只补发缺少的后缀，避免重复。
 *
 * 事件词汇来自 dsh 的 SessionEventMap；未知/扩展事件一律安静忽略，
 * 不要因为 dsh 加了一个新事件就让整条会话断掉。
 */

export interface DshWireEvent {
  type: string
  seq?: number
  time?: number
  data?: unknown
  ignorable?: true
  sourceEventSeqs?: unknown
  surfaceOp?: unknown
}

export type DshAssistantStreamFrame =
  | {
      type: 'start'
      attemptId: string
      revision: number
      startedAfterSeq?: number
      turn?: number
      step?: number
    }
  | {
      type: 'chunk'
      attemptId: string
      revision: number
      index: number
      time?: number
      chunk?: unknown
    }
  | {
      type: 'end'
      attemptId: string
      revision: number
      index?: number
      outcome?: unknown
    }

export interface DshTranslatorOptions {
  sessionId: string
  cwd: string
  /** 历史回放时先扫出来的模型/上下文窗口 */
  initialModel?: string
  initialContextWindow?: number
  /** 会话头里的 cwd；没有就用 cwd */
  headerCwd?: string
  /**
   * true：实时会话。用户消息已经由渲染层乐观插入，不能再发一次；
   * 同时 assistant/message 只补发没有流出去的后缀。
   */
  live?: boolean
  /** 历史回放需要自己发 session_started；实时会话由 Session 层发。 */
  emitStarted?: boolean
  /**
   * 实时会话不要发 turn_started：SessionManager 在 send() 时已经发过一次，
   * 重复发会把渲染层的 run 状态重新计时。历史回放必须发。
   */
  emitTurnStarted?: boolean
  onEvent: (e: AgentEvent) => void
}

function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0
  }
}

function contentText(content: unknown): string {
  const parts: string[] = []
  for (const item of arr(content)) {
    const o = obj(item)
    if (!o) continue
    const type = str(o.type)
    if (type === 'text') parts.push(str(o.text))
    else if (type === 'image') parts.push('[图片]')
    // grep / read 的结果会再套一层 tool-result
    else if (type === 'tool-result') parts.push(contentText(o.content))
  }
  return parts.filter(Boolean).join('\n')
}

function parseArguments(raw: unknown): Obj {
  if (typeof raw === 'string') {
    if (!raw.trim()) return {}
    try {
      return obj(JSON.parse(raw))
    } catch {
      return { raw }
    }
  }
  return obj(raw)
}

/** 流式已经发过的前缀；返回还没发的那一段。 */
function missingSuffix(full: string, streamed: string): string {
  if (!streamed) return full
  if (full.startsWith(streamed)) return full.slice(streamed.length)
  // 流里的文本和最终消息对不上（重试/归一化）：宁可重发，也不能丢
  return full
}

export class DshEventTranslator {
  private started = false
  private model: string
  private contextWindow: number
  private headerCwd: string
  private turnStart = 0
  private steps = 0
  private totals = emptyUsage()
  private lastRequest: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  } | null = null
  private seenCalls = new Set<string>()
  private callInputs = new Map<string, Obj>()
  private streamedText = ''
  private streamedThinking = ''
  private live: boolean
  private emitStarted: boolean
  private emitTurnStarted: boolean
  private onEvent: (e: AgentEvent) => void
  private title = ''

  constructor(private o: DshTranslatorOptions) {
    this.model = o.initialModel ?? ''
    this.contextWindow = o.initialContextWindow ?? 0
    this.headerCwd = o.headerCwd ?? ''
    this.live = o.live === true
    this.emitStarted = o.emitStarted === true
    this.emitTurnStarted = o.emitTurnStarted !== false
    this.onEvent = o.onEvent
  }

  get effectiveModel(): string {
    return this.model
  }

  get currentTitle(): string {
    return this.title
  }

  /** 权限请求到达时按 callId 找回原始工具参数。 */
  inputOf(callId: string): Obj | undefined {
    return this.callInputs.get(callId)
  }

  private start(): void {
    if (this.started) return
    this.started = true
    if (!this.emitStarted) return
    this.onEvent({
      t: 'session_started',
      sessionId: this.o.sessionId,
      provider: 'dsh',
      model: this.model,
      cwd: this.headerCwd || this.o.cwd,
      tools: [],
      permissionMode: 'standard'
    })
  }

  private emitCall(id: string, rawName: string, args: unknown): void {
    if (!id || this.seenCalls.has(id)) return
    this.seenCalls.add(id)
    const input = normalizeToolInput(parseArguments(args), [])
    this.callInputs.set(id, input)
    const name = uiToolName(rawName, '')
    const path = str(input.file_path) || str(input.path)
    this.onEvent({ t: 'tool_started', id, name, ...(path ? { path } : {}) })
    this.onEvent({ t: 'tool_call', id, name, input })
  }

  /** 持久事件；`session` 头记录不进来。 */
  push(event: DshWireEvent): void {
    const type = str(event.type)
    const data = obj(event.data)
    const time = num(event.time)

    if (type === 'request/context') {
      this.model = str(data.model) || this.model
      this.contextWindow = num(data.contextWindow) || this.contextWindow
      return
    }

    if (type === 'request/header') {
      const config = obj(obj(data.header)?.config)
      this.model = this.model || str(config.model)
      return
    }

    if (type === 'user/message') {
      if (this.live) return
      if (str(obj(data.source)?.kind) !== 'user') return
      const text = arr(data.content)
        .map((b) => (str(obj(b)?.type) === 'text' ? str(obj(b)?.text) : ''))
        .filter(Boolean)
        .join('\n')
        .trim()
      if (!text) return
      this.start()
      this.onEvent({
        t: 'user_message',
        text,
        at: time > 0 ? new Date(time).toISOString() : ''
      })
      return
    }

    if (type === 'turn/start') {
      this.start()
      this.turnStart = time
      this.steps = 0
      this.totals = emptyUsage()
      this.lastRequest = null
      this.streamedText = ''
      this.streamedThinking = ''
      if (this.emitTurnStarted) this.onEvent({ t: 'turn_started' })
      return
    }

    if (type === 'step/start') {
      this.steps += 1
      return
    }

    if (type === 'assistant/message') {
      this.start()
      const msg = obj(data.message) ?? {}
      for (const block of arr(msg.content)) {
        const b = obj(block)
        if (!b) continue
        const kind = str(b.type)
        if (kind === 'reasoning') {
          const full = str(b.text)
          if (!full) continue
          const rest = this.live ? missingSuffix(full, this.streamedThinking) : full
          this.streamedThinking = this.live ? full : this.streamedThinking
          if (rest) this.onEvent({ t: 'thinking_delta', text: rest })
          continue
        }
        if (kind === 'text') {
          const full = str(b.text)
          if (!full) continue
          const rest = this.live ? missingSuffix(full, this.streamedText) : full
          this.streamedText = this.live ? full : this.streamedText
          if (rest) this.onEvent({ t: 'text_delta', text: rest })
          continue
        }
        if (kind === 'tool-call') {
          this.emitCall(str(b.id), str(b.name), b.arguments)
        }
      }

      const usage = obj(data.usage)
      if (usage) {
        const input = num(usage.inputTokens)
        const output = num(usage.outputTokens)
        const cacheRead = num(usage.cacheReadTokens)
        const cacheWrite = num(usage.cacheWriteTokens)
        const total = num(usage.totalTokens) || input + output + cacheRead + cacheWrite
        this.totals = {
          inputTokens: this.totals.inputTokens + input,
          outputTokens: this.totals.outputTokens + output,
          cacheReadTokens: this.totals.cacheReadTokens + cacheRead,
          cacheCreationTokens: this.totals.cacheCreationTokens + cacheWrite
        }
        this.lastRequest = { input, output, cacheRead, cacheWrite, total }
      }
      return
    }

    if (type === 'tool/call') {
      this.start()
      this.emitCall(str(data.callId), str(data.name), data.arguments)
      return
    }

    if (type === 'tool/result') {
      const msg = obj(data.message) ?? {}
      const id = str(msg.toolCallId) || str(data.toolCallId)
      if (!id) return

      const content = clip(contentText(msg.content))
      const failed =
        msg.isError === true || data.error !== undefined || toolFailed(content, data.error)
      const meta = obj(data.meta) ?? {}
      const diffs = arr(meta.diffs)
        .map(obj)
        .filter((d): d is Obj => !!d)
      const created = str(meta.operation) === 'create'

      let stat: ToolStat | undefined
      if (diffs.length > 0) {
        let added = 0
        let removed = 0
        for (const d of diffs) {
          const before = d.oldText == null ? '' : str(d.oldText)
          const lines = diffLines(before, str(d.newText))
          added += lines.filter((l) => l.kind === 'add').length
          removed += lines.filter((l) => l.kind === 'del').length
        }
        stat = { added, removed }
      }

      this.onEvent({
        t: 'tool_result',
        id,
        status: failed ? 'error' : 'ok',
        content,
        ...(stat ? { stat } : {}),
        ...(created ? { created: true } : {})
      })

      for (const d of diffs) {
        const path = str(d.path) || str(meta.path)
        if (!path) continue
        const before = d.oldText == null ? '' : str(d.oldText)
        const lines = diffLines(before, str(d.newText))
        this.onEvent({
          t: 'file_change',
          path,
          added: lines.filter((l) => l.kind === 'add').length,
          removed: lines.filter((l) => l.kind === 'del').length,
          ...(d.oldText == null ? { created: true } : {}),
          source: 'agent'
        })
      }
      if (diffs.length === 0 && created) {
        const path = str(meta.path) || str(this.callInputs.get(id)?.file_path)
        if (path) this.onEvent({ t: 'file_change', path, created: true, source: 'agent' })
      }
      this.callInputs.delete(id)
      return
    }

    if (type === 'turn/end') {
      const reason = obj(data.reason)
      const kind = str(reason.kind)
      if (kind === 'error') {
        const error = obj(reason.error)
        const message =
          str(error.message) || str(reason.message) || 'DeepSeek Harness 执行失败'
        this.onEvent({ t: 'error', message, fatal: false })
      }

      const last = this.lastRequest
      const usage: Usage = {
        ...this.totals,
        ...(last
          ? {
              contextTokens: last.total,
              contextUsage: {
                inputTokens: last.input,
                outputTokens: last.output,
                cacheReadTokens: last.cacheRead,
                cacheCreationTokens: last.cacheWrite
              },
              contextPercent:
                this.contextWindow > 0
                  ? Math.round(Math.min(100, (last.total / this.contextWindow) * 100) * 10) / 10
                  : undefined
            }
          : {})
      }
      this.onEvent({
        t: 'turn_end',
        durationMs: this.turnStart > 0 && time >= this.turnStart ? time - this.turnStart : 0,
        usage,
        steps: this.steps
      })
      this.turnStart = 0
      this.steps = 0
      this.totals = emptyUsage()
      this.lastRequest = null
      this.streamedText = ''
      this.streamedThinking = ''
      return
    }

    if (type === 'session/title') {
      this.title = str(data.title)
      return
    }

    // system/developer/user-context、approval、todo、plan、compaction、job、
    // subagent 等：UI 暂时没有对应事件，安静忽略。
  }

  /** 实时 assistant-stream 帧；历史回放不会调用。 */
  pushStream(frame: DshAssistantStreamFrame): void {
    if (frame.type === 'start') {
      this.streamedText = ''
      this.streamedThinking = ''
      return
    }
    if (frame.type !== 'chunk') return

    const chunk = obj(frame.chunk)
    const type = str(chunk.type)
    if (type === 'text-delta') {
      const text = str(chunk.text)
      if (!text) return
      this.streamedText += text
      this.onEvent({ t: 'text_delta', text })
      return
    }
    if (type === 'reasoning-delta') {
      const text = str(chunk.text)
      if (!text) return
      this.streamedThinking += text
      this.onEvent({ t: 'thinking_delta', text })
    }
  }
}
