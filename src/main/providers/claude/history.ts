import type { AgentEvent, UsageBreakdown } from '../../../shared/events'
import type { ImageAttachment } from '../../../shared/attachment'
import { isFileEditTool, statFromPatch, toolDisplay, toolFamily } from '../../../shared/tool'
import { agentRunInfo, taskResultInfo } from './tool-result-meta'
import { taskNotificationFromText, taskSystemEvent } from './task-events'
import { normalizeQuestions } from './control'
import { t } from '../../i18n'

/**
 * 把 CLI 自己写的会话记录（jsonl）回放成 AgentEvent。
 *
 * 为什么不直接复用 ClaudeStreamTranslator：两者的记录形状**不一样**。
 *  - stream-json 的 `user` 消息：content 是块数组
 *  - jsonl 里的 `user` 记录：content 往往是**纯字符串**（就是用户敲的那句话）
 * 加上 jsonl 里混着大量我们不认识的记录类型（attachment / queue-operation /
 * atis-latch / api-request-blob …），以及 isSidechain 标记的子 agent 记录。
 * 所以单独写一层，别硬套。
 */

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : []
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * CLI 会把一些**系统注入**的内容也记成 user 记录（`/clear` 的 caveat、
 * 斜杠命令的展开、system-reminder 等）。它们在终端里不作为用户消息显示，
 * 当标题就是噪声（实测侧栏出现过 `<local-command-caveat…`）。
 */
const INJECTED_TAGS = [
  '<local-command-caveat',
  '<local-command-stdout',
  '<command-name',
  '<command-message',
  '<command-args',
  '<system-reminder',
  '<user-prompt-submit-hook'
]

export function looksInjected(text: string): boolean {
  const t = text.trimStart()
  if (!t.startsWith('<')) return false
  const head = t.slice(0, 64).toLowerCase()
  return INJECTED_TAGS.some((tag) => head.startsWith(tag))
}

/** 用户记录里真正"用户说的话"；工具结果不算 */
function userPromptText(message: unknown): string {
  const c = obj(message)?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return arr(c)
      .filter((b) => b.type === 'text')
      .map((b) => str(b.text))
      .join('\n')
  }
  return ''
}

/** 历史图片的单张上限：base64 字符数，约 3MB 原始字节 */
const MAX_HISTORY_IMAGE_CHARS = 4 * 1024 * 1024
const MAX_HISTORY_IMAGES = 5
const IMAGE_MEDIA = /^image\/(png|jpeg|webp|gif)$/i

/**
 * 从一条 user 记录里取出图片块。
 *
 * CLI 的 jsonl 和实时 stdin 用同一个 image block 形状，所以能原样回放。
 * 限制单张大小和条数：历史文件可能很大，别让一次 readTranscript 把 IPC
 * 响应和 React state 撑爆。
 */
function userImages(message: unknown): ImageAttachment[] {
  const c = obj(message)?.content
  if (!Array.isArray(c)) return []

  const out: ImageAttachment[] = []
  for (const b of arr(c)) {
    if (b.type !== 'image') continue
    const src = obj(b.source)
    if (!src || src.type !== 'base64') continue
    const mediaType = str(src.media_type)
    const data = str(src.data)
    if (!IMAGE_MEDIA.test(mediaType) || !data) continue
    if (data.length > MAX_HISTORY_IMAGE_CHARS) continue
    out.push({
      id: `hist-${out.length}-${mediaType}`,
      mediaType,
      data,
      name: t('history.imageName', { n: out.length + 1 })
    })
    if (out.length >= MAX_HISTORY_IMAGES) break
  }
  return out
}

function stringifyContent(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    return v
      .map((b) => {
        const o = obj(b)
        if (!o) return ''
        return typeof o.text === 'string' ? o.text : `[${str(o.type) || 'block'}]`
      })
      .filter(Boolean)
      .join('\n')
  }
  return v == null ? '' : JSON.stringify(v)
}

/**
 * 一轮 = 一条用户输入到下一个用户输入之间。
 * 每个 assistant 记录都往**当前这一轮**里追加，轮末才发 turn_end ——
 * 这样界面上是"一轮一个气泡"，而不是每条 assistant 消息一个。
 */
export function replayRecords(records: Record<string, unknown>[]): AgentEvent[] {
  const out: AgentEvent[] = []
  let open = false
  /** 当前这一轮最后一条 assistant 消息占用的上下文 token */
  let contextTokens: number | null = null
  /** 与 contextTokens 同一条 assistant 消息的四项构成 */
  let contextUsage: UsageBreakdown | null = null
  /** 同一条后台任务通知在 jsonl 里会挂两三个记录；按原文去重 */
  const seenNotifications = new Set<string>()
  /**
   * 编辑类 tool_use id → 路径 / 是否 Write / 按 input 估的行数。
   *
   * 回执里没有路径，只有 patch；路径在 tool_use 的 input 里。
   * 子代理（isSidechain）的也要记 —— 它们的改动不进转写，但要进修改清单。
   */
  const editFiles = new Map<
    string,
    { path: string; wrote: boolean; estimate?: { added: number; removed: number } }
  >()

  const emitNotification = (text: string): void => {
    if (!text.trimStart().startsWith('<task-notification>')) return
    if (seenNotifications.has(text)) return
    seenNotifications.add(text)
    const ev = taskNotificationFromText(text)
    if (ev) out.push(ev)
  }

  /**
   * 一条 user 记录里的 tool_result。
   *
   * 主转写：照旧发 tool_result（含增删统计）和 AskUserQuestion 留痕。
   * 子代理：只发 file_change —— 工具卡和提问都不属于主会话。
   */
  const emitToolResults = (rec: Record<string, unknown>, sidechain: boolean): void => {
    // jsonl 里这条记录带完整的 toolUseResult —— Edit/Write 的增删行数
    // 就藏在 structuredPatch 里，比拿 old/new 猜 replace_all 次数准
    const tur = obj(rec.toolUseResult)
    const stat = statFromPatch(tur?.structuredPatch)
    // 跟实时流同一套判据：只有 type 是 create 才算新建
    const created = tur?.type === 'create'
    const agent = agentRunInfo(tur)
    const task = taskResultInfo(tur)

    for (const b of arr(obj(rec.message)?.content)) {
      if (b.type !== 'tool_result') continue
      const id = str(b.tool_use_id)

      const edit = editFiles.get(id)
      if (edit) {
        editFiles.delete(id)
        const precise = stat ?? edit.estimate
        out.push({
          t: 'file_change',
          path: edit.path,
          ...(precise ? { added: precise.added, removed: precise.removed } : {}),
          ...(created ? { created: true } : {}),
          wrote: edit.wrote,
          source: sidechain ? 'subagent' : 'agent'
        })
      }

      if (sidechain) continue

      /*
       * AskUserQuestion 的回执里带完整的 questions + answers。
       * 实时流里这两样是分两步来的（question_request → 用户回答），
       * 但 jsonl 没有单独的"提问事件"，只能在这里合成一条已答的留痕 ——
       * 否则重开旧会话时，模型问过什么、用户选了什么会整段消失。
       */
      const asked = Array.isArray(tur?.questions) ? normalizeQuestions(tur) : []
      if (asked.length > 0) {
        const raw = obj(tur?.answers) ?? {}
        const answers: Record<string, string | string[]> = {}
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v === 'string') answers[k] = v
          else if (Array.isArray(v)) {
            const vals = v.filter((x): x is string => typeof x === 'string')
            if (vals.length > 0) answers[k] = vals
          }
        }
        out.push({
          t: 'question_request',
          id,
          tool: 'AskUserQuestion',
          input: { questions: asked },
          questions: asked,
          ...(Object.keys(answers).length > 0 ? { answers } : { skipped: true })
        })
      }

      out.push({
        t: 'tool_result',
        id,
        status: b.is_error === true ? 'error' : 'ok',
        content: stringifyContent(b.content),
        ...(stat ? { stat } : {}),
        ...(created ? { created: true } : {}),
        ...(agent ? { agent } : {}),
        ...(task ? { task } : {})
      })
    }
  }

  const closeTurn = (): void => {
    if (!open) return
    open = false
    // 历史里的耗时/吞吐不在这些记录里，留 0；界面会退化成只显示「已完成」。
    // 但最后一条 assistant 的 usage 是有的，用它把上下文胶囊点亮。
    out.push({
      t: 'turn_end',
      durationMs: 0,
      steps: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        ...(contextTokens != null ? { contextTokens } : {}),
        ...(contextUsage ? { contextUsage } : {})
      }
    })
    contextTokens = null
    contextUsage = null
  }

  for (const rec of records) {
    /*
     * 子 agent 的旁支记录不混进主转写。
     * 但**不能整条跳过**：它们改的文件要算进本轮修改，所以 assistant/user
     * 里仍然抽 file_change，其余记录类型照旧忽略。
     */
    const sidechain =
      rec.isSidechain === true || rec.parent_tool_use_id != null || rec.parentToolUseId != null

    // CLI 的 task_* system 事件（后台代理进度/完成）
    if (rec.type === 'system') {
      if (sidechain) continue
      const ev = taskSystemEvent(rec)
      if (ev) out.push(ev)
      continue
    }

    // 后台任务完成通知在 jsonl 里是这条队列记录
    if (rec.type === 'queue-operation') {
      if (sidechain) continue
      if (rec.operation === 'enqueue' && typeof rec.content === 'string') {
        emitNotification(rec.content)
      }
      continue
    }

    // 同一个通知也会以 attachment（queued_command）的形式出现
    if (rec.type === 'attachment') {
      if (sidechain) continue
      const att = obj(rec.attachment)
      if (att?.type === 'queued_command' && typeof att.prompt === 'string') {
        emitNotification(att.prompt)
      }
      continue
    }

    if (rec.type === 'user') {
      // 子代理的 user 记录只有工具回执；抽 file_change 就够
      if (sidechain) {
        emitToolResults(rec, true)
        continue
      }

      const prompt = userPromptText(rec.message)
      const images = userImages(rec.message)
      // 某些版本把 task-notification 记成 user 记录 —— 它不是用户说的话
      if (prompt.trimStart().startsWith('<task-notification>')) {
        emitNotification(prompt)
        continue
      }
      // 图片-only 消息也要算一条用户输入
      if ((prompt.trim() && !looksInjected(prompt)) || images.length > 0) {
        // 新一轮开始：上一轮没等到回执的编辑记录作废
        editFiles.clear()
        closeTurn()
        out.push({
          t: 'user_message',
          text: prompt,
          at: str(rec.timestamp),
          ...(images.length > 0 ? { images } : {})
        })
        open = true
        continue
      }
      // 不是用户输入，就是工具结果
      emitToolResults(rec, false)
      continue
    }

    if (rec.type === 'assistant') {
      // 子代理的正文不进主转写，但编辑工具要记下来
      if (!sidechain) {
        if (!open) {
          // 文件可能从一轮中间开始（例如被截断），仍然把它渲染出来
          open = true
        }
        // 最后一条 assistant 的 usage 才代表这一轮结束时的上下文
        const u = obj(obj(rec.message)?.usage)
        if (u) {
          const breakdown: UsageBreakdown = {
            inputTokens: num(u.input_tokens),
            outputTokens: num(u.output_tokens),
            cacheReadTokens: num(u.cache_read_input_tokens),
            cacheCreationTokens: num(u.cache_creation_input_tokens)
          }
          const ctx =
            breakdown.inputTokens +
            breakdown.cacheReadTokens +
            breakdown.cacheCreationTokens +
            breakdown.outputTokens
          if (ctx > 0) {
            contextTokens = ctx
            contextUsage = breakdown
          }
        }
      }

      for (const b of arr(obj(rec.message)?.content)) {
        if (b.type === 'text') {
          if (sidechain) continue
          const text = str(b.text)
          if (text) out.push({ t: 'text_delta', text })
        } else if (b.type === 'thinking') {
          if (sidechain) continue
          const text = str(b.thinking)
          if (text) out.push({ t: 'thinking_delta', text })
        } else if (b.type === 'tool_use') {
          const name = str(b.name)
          const id = str(b.id)
          if (isFileEditTool(name)) {
            const d = toolDisplay(name, b.input)
            if (d.path) {
              editFiles.set(id, {
                path: d.path,
                wrote: toolFamily(name) === 'write',
                estimate: d.stat
              })
            }
          }
          if (!sidechain) out.push({ t: 'tool_call', id, name, input: b.input })
        }
      }
      continue
    }
    // 其余记录类型一律忽略
  }

  closeTurn()
  return out
}
