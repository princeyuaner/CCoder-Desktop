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

/**
 * 落定通知的正文：第一段是 dsh 自己写的状态句，第二段常是
 * `Its closing message:` 标签 —— 卡片要的是孩子最后说的话。
 */
function closingText(msg: Obj): string {
  const texts = arr(msg.content)
    .map((b) => obj(b))
    .filter((b): b is Obj => !!b && str(b.type) === 'text')
    .map((b) => str(b.text))
  let i = 1
  if (texts[i] === 'Its closing message:') i += 1
  return texts.slice(i).join('\n').trim()
}

/**
 * 落定通知只有一句人话，没有结构化状态字段，只能按措辞还原：
 * `was stopped` = 被叫停，其余失败措辞 = 失败，默认算完成。
 */
function settleStatus(notice: string): 'completed' | 'failed' | 'stopped' {
  const s = notice.toLowerCase()
  if (s.includes('was stopped')) return 'stopped'
  if (/failed|ran out of room|declined|ended abnormally/.test(s)) return 'failed'
  return 'completed'
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
  /** callId → dsh 原始工具名；只有它还是小写的 subagent，不能拿归一化后的 Task 判断 */
  private callNames = new Map<string, string>()
  /** 子会话 id → 触发它的 callId。结束时收件箱只报子会话 id，靠它找回卡片 */
  private subagentCalls = new Map<string, string>()
  /** callId → 启动时刻，用来补卡片的耗时 */
  private subagentStartedAt = new Map<string, number>()
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
    this.callNames.set(id, rawName)
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
      // 子代理是异步的：这句回执只是「已开跑」，结束要等收件箱里的落定通知
      this.noteSubagentLaunch(id, content, time)
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

    if (type === 'agent/inbox/spliced') {
      this.settleSubagents(data, time)
      return
    }

    // system/developer/user-context、approval、todo、plan、compaction、job、
    // subagent/catalog 等：UI 暂时没有对应事件，安静忽略。
  }

  /**
   * dsh 的 subagent 工具是**异步**的：`tool/result` 只有一句
   * `started subagent <id>`，真正的结束语在孩子落定后由收件箱塞进来。
   * 这句回执本身不是结果 —— 记下 子会话 id → callId 的对应关系即可。
   */
  private noteSubagentLaunch(callId: string, content: string, time: number): void {
    const raw = this.callNames.get(callId) ?? ''
    if (!/subagent/i.test(raw)) return
    const childId = /started subagent\s+([0-9A-Za-z_-]+)/.exec(content)?.[1]
    if (!childId) return
    this.subagentCalls.set(childId, callId)
    if (time > 0) this.subagentStartedAt.set(callId, time)
  }

  /**
   * 子会话落定 → 把对应的子代理卡片改成终态。
   *
   * 不翻译这条通知，右侧执行台的子代理卡片会永远停在「运行中」，
   * 计时器还会一直往上走 —— 因为整场会话里再没有任何事件会关掉它。
   */
  private settleSubagents(data: Obj, time: number): void {
    for (const item of arr(data.inserted)) {
      const msg = obj(item)
      if (!msg) continue
      const source = obj(msg.source) ?? {}
      if (str(source.kind) !== 'subagent-settled') continue

      const childId = str(source.senderSessionId)
      const callId = childId ? this.subagentCalls.get(childId) : undefined
      if (!childId || !callId) continue

      const notice = str(source.summary)
      const body = closingText(msg)
      const status = settleStatus(notice || body)
      const startedAt = this.subagentStartedAt.get(callId)
      const durationMs = time > 0 && startedAt && time > startedAt ? time - startedAt : undefined

      this.onEvent({
        t: 'task_notification',
        taskId: childId,
        toolUseId: callId,
        status,
        summary: body || notice,
        ...(durationMs ? { durationMs } : {})
      })
    }
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
