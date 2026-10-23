import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type {
  AgentEvent,
  PermissionMode,
  PermissionOption,
  PermissionPreview,
  Question,
  ToolStatus,
  Usage
} from '@shared/events'
import type { CliId, EffortLevel } from '@shared/settings'
import { DEFAULT_EFFORT, EFFORT_LABEL, sameCwd } from '@shared/settings'
import { toolDisplay, type ToolStat } from '@shared/tool'
import { applyFileChange, filesAfterLastTurn, type ChangedFile } from './changedFiles'
import type { ImageAttachment } from '@shared/attachment'
import type { IdeCodeRef } from '@shared/ide-chat'
import type {
  QuestionAnswer,
  SessionSendInput,
  SessionStatus,
  SessionStatusPayload
} from '@shared/session'
import { MODE_LABEL } from './constants'
import { emptyRunState, reduceRun, startRun, type RunState } from './run-state'
import {
  approvalFromEvent,
  clearPendingApproval,
  setPendingApproval
} from './pending-approvals'

/**
 * 转写区的一项 = 一张卡。
 *
 * 关键：**一项对应一个事件，不是一整个回合**。
 * 早先把整轮的文本/思考/工具都揉进一个 assistant 项里，结果界面上
 * 只能画出"每轮一张大卡"，看不出机器一步步在干什么。
 * 拆成逐事件之后，输出区就成了一条卡片流：思考一张、读文件一张、
 * 改文件一张、回答一张，边跑边长出来。
 */
/** 能被会话内切换、且需要留痕的设置项 */
export type SystemKey = 'effort' | 'permissionMode' | 'model' | 'channel' | 'auth'

export type ChatItem =
  | { kind: 'user'; id: string; text: string; at: string; images?: ImageAttachment[] }
  /** 模型的一段话。连续的 delta 追加到同一张卡上 */
  | { kind: 'text'; id: string; text: string; at: string; streaming: boolean }
  | { kind: 'thinking'; id: string; text: string; at: string; streaming: boolean }
  | {
      kind: 'tool'
      id: string
      at: string
      name: string
      /** 原始摘要（命令原文 / 路径…）—— 轨迹标签页用 */
      summary: string
      /** 折叠行的人话主题。Bash 用 input.description，文件工具用文件名 */
      subject: string
      /** 文件工具的父目录（已缩短） */
      dir?: string
      /** 文件工具的完整路径 —— 只进 title / 用来在 IDE 中打开 */
      path?: string
      /** Read 的起始行（入参 offset）。点开文件时直接跳到那儿 */
      line?: number
      /** Bash 的命令原文 —— 只进 title 和展开区 */
      command?: string
      /** 这次调用增删的行数（Edit / MultiEdit / Write） */
      stat?: ToolStat
      /** 这次 Write **新建**了文件（回执里带 created）。覆盖已有文件时没有 */
      created?: boolean
      status: ToolStatus
      /** 工具开始的时刻。历史回放时是 0（一次性归约，算出来没意义） */
      startedAt: number
      /** 耗时毫秒；拿不到就不显示 */
      ms?: number
      content?: string
    }
  | {
      kind: 'permission'
      id: string
      at: string
      tool: string
      /** 工具在干什么的短摘要（app.py / 命令原文…），给转写区那条留痕用 */
      summary: string
      input: unknown
      preview: PermissionPreview
      options: PermissionOption[]
      state: 'pending' | 'allowed' | 'denied'
      remembered: boolean
    }
  /**
   * 模型的一次提问（AskUserQuestion）。
   *
   * 与审批分开：审批只有 allow/deny，提问的答案是结构化数据。待回答时
   * 抽屉显示在输入框上方；答完后这里留一条痕，答案可回看。
   */
  | {
      kind: 'question'
      id: string
      at: string
      questions: Question[]
      state: 'pending' | 'answered' | 'skipped'
      /** question 原文 → 选项 label（多选为数组）或自由输入 */
      answers?: Record<string, string | string[]>
    }
  /**
   * 设置切换的留痕。**不是谁说的话** —— 是"这台机器被改了"。
   *
   * 模型 / 渠道 / 思考深度 / 权限模式走的是同一条 reconfigure 路径
   * （都是 CLI 启动参数，改了就得换进程 + --resume 接回），所以用一类 item
   * 就能覆盖四种切换，只是 key 不同。
   */
  | { kind: 'system'; id: string; at: string; key: SystemKey; from: string; to: string }
  | { kind: 'error'; id: string; at: string; message: string }
  /** 一轮结束的分隔条，不是卡片 —— 用来给回合切边界 */
  | { kind: 'turn'; id: string; at: string; durationMs?: number; steps?: number; usage?: Usage }

/**
 * 入队时保存的编辑器状态。
 *
 * `text` 里的 IDE 引用已经展开成 `<ide_reference>` 块，直接塞回输入框会
 * 露出一堆标签；所以单独留一份用户原话和引用卡，编辑取回时原样恢复。
 */
export interface SendMeta {
  draft: string
  refs: IdeCodeRef[]
}

/** 等待发送的一条消息 */
export interface QueuedMessage extends SendMeta {
  id: string
  /** 真正发给 CLI 的正文（引用已展开） */
  text: string
  images?: ImageAttachment[]
  at: number
}

export interface ChatApi {
  items: ChatItem[]
  status: SessionStatus
  /**
   * 这一轮还在跑 —— 含"正在连 CLI"那一段。
   * 和 `status === 'running'` 的区别：starting 也是忙，只是忙在连进程而不是模型。
   */
  busy: boolean
  model: string
  permissionMode: PermissionMode
  /** 本会话的思考深度（CLI 的 --effort） */
  effort: EffortLevel
  turns: number
  steps: number
  usage?: Usage
  /**
   * 本轮流式输出速度（tok/s 估算）。
   *
   * CLI 在流式过程中不给 token 计数，真实 usage 要等 `result`。所以运行中
   * 按增量字符估算（CJK ≈ 1 字/token，其余 ≈ 4 字符/token），每秒滑动刷新；
   * 轮末清空，状态栏回落到 `usage.tokensPerSecond` 的真实平均值。
   */
  liveRate?: number
  /** 等待队列：运行中发的消息排在这里，轮末按顺序自动发送 */
  queue: QueuedMessage[]
  /** 队列被暂停（打断 / 发送失败）—— 不会自动发送，等用户继续 */
  queuePaused: boolean
  /** 本轮的任务清单与子代理 —— 右侧执行台的数据源 */
  run: RunState
  /**
   * 本轮改过的文件。来源不止工具卡：子代理、Bash、脚本改的也算
   * （见 shared/events.ts 的 file_change）。
   */
  files: ChangedFile[]
  /**
   * 发送。会话忙时不会立刻发给 CLI，而是进等待队列；
   * `meta` 用于把原话和引用一并存下来，供队列里的「编辑」恢复。
   */
  send(input: SessionSendInput, meta?: SendMeta): Promise<void>
  removeQueued(id: string): void
  clearQueue(): void
  /** 取回一条排队消息（编辑）：从队列移除并返回，由输入框恢复 */
  takeQueued(id: string): QueuedMessage | null
  moveQueued(id: string, dir: -1 | 1): void
  /** 继续发送被暂停的队列 */
  resumeQueue(): void
  interrupt(): void
  respond(requestId: string, allow: boolean, always: boolean): void
  /** 回答一次提问。skipped=true 表示整组跳过。 */
  answerQuestion(requestId: string, answer: QuestionAnswer): void
  /** 换模型 / 换权限模式 / 换思考深度：主进程会换进程并 --resume 接回，上下文不丢 */
  applyModel(model: string): void
  applyPermissionMode(mode: PermissionMode): void
  applyEffort(level: EffortLevel): void
  /**
   * 换渠道之后踢一脚 —— 渠道是启动参数，不换进程不生效。
   * 两个参数只用于留痕（显示"旧渠道 → 新渠道"），主进程不需要。
   */
  applyChannel(from: string, to: string): void
  /** 切换凭据来源（官方登录 ↔ 渠道）。和换渠道一样，下一轮换进程生效。 */
  applyAuth(from: string, to: string): void
  notice: string | null
  clearNotice(): void
}

/**
 * 任务清单类工具**不占转写区** —— 它们由右侧执行台统一展示。
 *
 * 一次 5 条 TaskCreate + 一连串 TaskUpdate 会把对话刷成记账本，而它们
 * 说的其实是同一件事：计划到哪一步了。面板就是为这件事准备的。
 */
const RUN_META_TOOLS = new Set([
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TaskStop',
  // 子代理的调用/回执也不进转写区：它由右侧执行台负责展示，
  // 完整报告动辄上万字，摊在对话里会把正文冲掉。
  'Agent',
  'Task'
])

let seq = 0
const uid = (): string => `i${++seq}`

/** ISO 时间串 → 「10月20日 21:15」；空串或非法值表示"现在" */
function fmtAt(iso?: string): string {
  const d = iso ? new Date(iso) : new Date()
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 流式增量 → token 估算。
 *
 * 流式过程中拿不到真实 token 数（CLI 只在每条模型消息结束时给 usage），
 * 速度只能按字符推：CJK 约 1 字 1 token，其余约 4 字符 1 token。
 * 数字用于「运行中大概多快」，精确值仍以轮末 usage 为准。
 */
function estimateTokens(s: string): number {
  let cjk = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    // 基本汉字 + 扩展 A + 兼容区；表情符号不算 CJK，按 4 字符折算
    if ((c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) cjk++
  }
  return cjk + Math.max(0, s.length - cjk) / 4
}

/** 从工具入参里挑一句最能说明它在干什么的话，给工具卡当副标题 */
function toolSummary(name: string, input: unknown): string {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const pick = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '')
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return pick('file_path') || pick('notebook_path')
    case 'Bash':
      return pick('command')
    case 'Grep':
    case 'Glob':
      return pick('pattern')
    case 'WebFetch':
      return pick('url')
    case 'WebSearch':
      return pick('query')
    case 'Task':
    case 'Agent':
      return pick('description')
    default: {
      const first = Object.values(o).find((v) => typeof v === 'string')
      return typeof first === 'string' ? first : ''
    }
  }
}

/** Read 的 offset 是 1-based 起始行；拿去让 IDE 跳到同一处 */
function toolStartLine(name: string, input: unknown): number | undefined {
  if (name !== 'Read') return undefined
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const n = o.offset
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

/** 把还开着口的那张卡封口 —— 有新东西要上来了 */
function closeOpen(items: ChatItem[]): ChatItem[] {
  const last = items[items.length - 1]
  if (!last) return items
  if ((last.kind === 'text' || last.kind === 'thinking') && last.streaming) {
    const copy = items.slice()
    copy[copy.length - 1] = { ...last, streaming: false }
    return copy
  }
  return items
}

/** 往最后一张卡追加文字；不是同一类就新开一张 */
function appendDelta(
  items: ChatItem[],
  kind: 'text' | 'thinking',
  text: string
): ChatItem[] {
  const last = items[items.length - 1]
  if (last?.kind === kind && last.streaming) {
    const copy = items.slice()
    copy[copy.length - 1] = { ...last, text: last.text + text }
    return copy
  }
  // 换类了（思考 → 正文）要把上一张封口。不然那张卡永远停在 streaming，
  // 药丸会一直显示"思考中…"，连回合结束了都不消。
  return [...closeOpen(items), { kind, id: uid(), at: fmtAt(), text, streaming: true }]
}

/**
 * 记一条设置切换的留痕。
 *
 * 三条规则，都是为了别把转写区刷成日志：
 *  - 起止相同：什么都不记（点回原来那档，等于没发生）
 *  - 紧挨着的**同一种**切换：就地改上一条的终点，而不是新增
 *    （滑轨拖一下会连发好几次，否则一次拖拽能刷出三四条）
 *  - 合并之后起止又相同了：把那条删掉（拖出去又拖回来）
 *
 * 先 `closeOpen` —— 切换可能发生在模型正吐字的时候，那张卡得先封口，
 * 否则下一个 delta 会在留痕后面另起一张，前一张永远停在 streaming。
 */
function pushSystem(items: ChatItem[], key: SystemKey, from: string, to: string): ChatItem[] {
  if (from === to) return items

  const last = items[items.length - 1]
  if (last?.kind === 'system' && last.key === key) {
    const copy = items.slice()
    if (last.from === to) copy.pop()
    else copy[copy.length - 1] = { ...last, to }
    return copy
  }

  return [...closeOpen(items), { kind: 'system', id: uid(), at: fmtAt(), key, from, to }]
}

/**
 * 事件 → 卡片。**纯函数**，所以历史回放能走同一条路径：
 * 一次性 `events.reduce(reduce, [])`，而不是逐条 setState（那是 O(n²)）。
 *
 * `live=false` 是历史回放。只影响工具耗时：回放是一次性归约，
 * 用 Date.now() 相减永远是 0，不如干脆不算，界面上就不显示。
 */
function reduce(items: ChatItem[], e: AgentEvent, live = true): ChatItem[] {
  switch (e.t) {
    case 'user_message':
      return [
        ...closeOpen(items),
        { kind: 'user', id: uid(), text: e.text, at: fmtAt(e.at), images: e.images }
      ]

    case 'text_delta':
      return appendDelta(items, 'text', e.text)

    case 'thinking_delta':
      return appendDelta(items, 'thinking', e.text)

    case 'tool_started': {
      // 转写区不画的工具（任务清单/子代理/提问），连占位卡也不用出
      if (RUN_META_TOOLS.has(e.name) || e.name === 'AskUserQuestion') return items
      const idx = items.findIndex((it) => it.kind === 'tool' && it.id === e.id)
      // 已经画过：这条只是补一个刚认出来的路径
      if (idx >= 0) {
        if (!e.path) return items
        const prev = items[idx] as Extract<ChatItem, { kind: 'tool' }>
        if (prev.path === e.path) return items
        const d = toolDisplay(e.name, { file_path: e.path })
        const copy = items.slice()
        copy[idx] = { ...prev, subject: d.subject, dir: d.dir, path: d.path }
        return copy
      }
      const d = toolDisplay(e.name, e.path ? { file_path: e.path } : {})
      return [
        ...closeOpen(items),
        {
          kind: 'tool',
          id: e.id,
          at: fmtAt(),
          name: e.name,
          summary: e.path ?? '',
          subject: d.subject,
          dir: d.dir,
          path: d.path,
          status: 'running',
          startedAt: live ? Date.now() : 0
        }
      ]
    }

    case 'tool_call': {
      // 任务清单/子代理由执行台负责，转写区不重复记；
      // 但要先把正在流式的正文封口，别让光标一直挂在那儿
      // AskUserQuestion 由提问卡片/抽屉负责，工具卡不重复画。
      if (RUN_META_TOOLS.has(e.name) || e.name === 'AskUserQuestion') return closeOpen(items)
      const d = toolDisplay(e.name, e.input)
      const next = {
        kind: 'tool' as const,
        id: e.id,
        at: fmtAt(),
        name: e.name,
        summary: toolSummary(e.name, e.input),
        subject: d.subject,
        dir: d.dir,
        path: d.path,
        line: toolStartLine(e.name, e.input),
        command: d.command,
        stat: d.stat,
        status: 'running' as const,
        startedAt: live ? Date.now() : 0
      }
      // tool_started 已经先画了占位卡：原地补全，别出现两张同 id 的卡。
      // 位置和开始时刻都沿用占位卡 —— 耗时要从卡片出现时算起。
      const idx = items.findIndex((it) => it.kind === 'tool' && it.id === e.id)
      if (idx >= 0) {
        const prev = items[idx] as Extract<ChatItem, { kind: 'tool' }>
        const copy = items.slice()
        copy[idx] = { ...prev, ...next, at: prev.at, startedAt: prev.startedAt }
        return copy
      }
      return [...closeOpen(items), next]
    }

    case 'tool_result':
      // 被隐藏的任务工具没有对应 ChatItem：直接跳过，别每次都 map 出一个新数组
      if (!items.some((it) => it.kind === 'tool' && it.id === e.id)) return items
      return items.map((it) =>
        it.kind === 'tool' && it.id === e.id
          ? {
              ...it,
              status: e.status,
              content: e.content,
              // patch 里的精确值覆盖 tool_call 时用 input 估的那版 ——
              // replace_all 的真实次数只有它知道
              ...(e.stat ? { stat: e.stat } : {}),
              ...(e.created ? { created: true } : {}),
              ms: it.startedAt ? Date.now() - it.startedAt : undefined
            }
          : it
      )

    case 'permission_request':
      return [
        ...closeOpen(items),
        {
          kind: 'permission',
          id: e.id,
          at: fmtAt(),
          tool: e.tool,
          summary: toolSummary(e.tool, e.input),
          input: e.input,
          preview: e.preview,
          options: e.options,
          state: 'pending',
          remembered: false
        }
      ]

    case 'question_request': {
      // 历史回放会把答案一起带过来；实时流要等 answerQuestion 落状态
      const answered = e.answers && Object.keys(e.answers).length > 0
      return [
        ...closeOpen(items),
        {
          kind: 'question',
          id: e.id,
          at: fmtAt(),
          questions: e.questions,
          state: answered ? 'answered' : e.skipped ? 'skipped' : 'pending',
          ...(answered ? { answers: e.answers } : {})
        }
      ]
    }

    case 'turn_end':
      return [
        ...closeOpen(items),
        {
          kind: 'turn',
          id: uid(),
          at: fmtAt(),
          durationMs: e.durationMs,
          steps: e.steps,
          usage: e.usage
        }
      ]

    case 'error':
      return [...closeOpen(items), { kind: 'error', id: uid(), at: fmtAt(), message: e.message }]

    // session_started 不改转写内容，由调用方单独处理
    default:
      return items
  }
}

/* ── 每会话控制器与注册表 ─────────────────────────────────────
 *
 * 为什么把状态搬出 hook：一个会话要能在**不被看见**的时候继续跑。
 * hook 的 effect cleanup 天然跟组件生命周期绑定，切走就 stop —— 那正是
 * 「只有当前会话能跑」的根因。这里改用模块级的 ChatController：
 * 组件只是订阅者，挂载/卸载都不再决定会话生死；只有显式删除、/clear、
 * 在新会话里换 CLI 才会 dispose。
 */

/** 快照 = ChatApi 去掉方法后的部分。每次变化换一个新对象，供 useSyncExternalStore 比较 */
export interface ChatSnapshot {
  items: ChatItem[]
  status: SessionStatus
  model: string
  permissionMode: PermissionMode
  effort: EffortLevel
  turns: number
  steps: number
  usage?: Usage
  liveRate?: number
  queue: QueuedMessage[]
  queuePaused: boolean
  run: RunState
  files: ChangedFile[]
  notice: string | null
}

interface ChatInit {
  cli: CliId
  cwd: string
  permissionMode: PermissionMode
  effort: EffortLevel
  resumeId: string | null
}

const SEP = '\u0000'

/** 会话 key 里的 cwd 统一分隔符与结尾斜杠 —— Windows 上两种写法都见过 */
const normCwd = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')

/** 已有会话的身份是 (cli, cwd, id)：同一个 id 可能出现在两个工作区 */
export const storedChatKey = (cli: CliId, cwd: string, id: string): string =>
  `stored${SEP}${cli}${SEP}${normCwd(cwd)}${SEP}${id}`

/**
 * 新会话的身份是「这次点击」的序号。
 *
 * **故意不带 cwd**：cwd 来自 defaultCwd / fallbackCwd，会话列表刷新时可能变，
 * 带上会让同一个新会话的 controller 被重建。
 */
export const newChatKey = (cli: CliId, n: number): string => `new${SEP}${cli}${SEP}${n}`

/** chat key → controller。一个 controller 可能挂在多个 key 下（新会话后来变成已有会话） */
const controllers = new Map<string, ChatController>()
/** Live id（主进程的内部会话 id）→ controller，给唯一的全局 dispatcher 用 */
const byLive = new Map<string, ChatController>()

let wired = false

/**
 * 全局只订一次 IPC。每个挂载的 hook 各订一份的话，切来切去会叠加监听，
 * 而且每条事件都要被 N 个 listener 过滤一遍。
 */
function wireDispatcher(): void {
  if (wired) return
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.session) return
  wired = true
  api.session.onEvent((p) => {
    byLive.get(p.sessionId)?.handleEvent(p.event)
  })
  api.session.onStatus((p) => {
    byLive.get(p.sessionId)?.handleStatus(p)
  })
}

class ChatController {
  readonly init: ChatInit
  readonly key: string
  /** CLI 自己的 session id；已有会话在创建时就是 resumeId */
  providerSessionId: string | null
  /** CLI 回报的 cwd（或创建时的 cwd），用于把「新会话」和侧栏那一行对上 */
  providerCwd: string

  private listeners = new Set<() => void>()
  private snap: ChatSnapshot
  private liveId: string | null = null
  private startPromise: Promise<void> | null = null
  private disposed = false
  /**
   * 本轮流式 token 估算点（时间戳 + 估算 token 数）。
   * 只留最近几秒，用来算滑动窗口速度；不做长期统计。
   */
  private ratePoints: { at: number; tokens: number }[] = []
  private rateTimer: number | null = null
  /**
   * 这一轮是否还没真正结束。
   *
   * 状态事件是异步的：`session.send()` 已经返回、status 还停在 idle 的那几
   * 毫秒里，如果又来一条消息，只看 status 会把它当成新一轮直接发出去。
   * 用这个同步标记把「已发出、等轮末」这段锁住。
   */
  private turnOpen = false
  /**
   * 已经实时加进 `steps`、但还没被 `turn_end` 校准的步数。
   *
   * 不能用 run.steps 代替：用户在一轮还在跑时再发一条消息，send() 会立刻
   * startRun 把 run.steps 清零，而上一轮的工具事件仍在继续 —— 用 run.steps
   * 校准会把上一轮已经计过的步数再加一遍。
   */
  private pendingSteps = 0
  /** liveId 还没就绪时改的启动参数，attach 之后补发 */
  private pendingReconfigure:
    | { model?: string; permissionMode?: PermissionMode; effort?: EffortLevel }
    | null = null

  constructor(key: string, init: ChatInit) {
    this.key = key
    this.init = { ...init }
    this.providerSessionId = init.resumeId
    this.providerCwd = init.cwd
    this.snap = {
      items: [],
      status: 'idle',
      model: '',
      permissionMode: init.permissionMode,
      effort: init.effort,
      turns: 0,
      steps: 0,
      usage: undefined,
      queue: [],
      queuePaused: false,
      run: emptyRunState(),
      files: [],
      notice: null
    }
  }

  get snapshot(): ChatSnapshot {
    return this.snap
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  get providerId(): string | null {
    return this.providerSessionId
  }

  getSnapshot = (): ChatSnapshot => this.snap

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  /** 一次事件只换一次快照、只通知一次 —— 别让 items 和 run 分两帧落到界面上 */
  private patch(p: Partial<ChatSnapshot>): void {
    this.snap = { ...this.snap, ...p }
    for (const cb of this.listeners) cb()
  }

  /** 幂等：StrictMode 的 setup/cleanup/setup、切走再切回都只真正 start 一次 */
  ensureStarted = (): Promise<void> => {
    if (!this.startPromise) this.startPromise = this.start()
    return this.startPromise
  }

  private async start(): Promise<void> {
    if (this.disposed) return
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!api?.session) {
      this.patch({
        status: 'exited',
        notice: '当前不在 Electron 中运行，无法发起会话。'
      })
      return
    }

    try {
      const id = await api.session.start({
        cli: this.init.cli,
        cwd: this.init.cwd,
        permissionMode: this.init.permissionMode,
        effort: this.init.effort,
        resumeId: this.init.resumeId
      })
      // start 比 dispose 慢时，别把已经没人要的 Live 留在主进程里
      if (this.disposed) {
        api.session.stop(id)
        return
      }
      this.liveId = id
      byLive.set(id, this)
      if (this.pendingReconfigure) {
        api.session.reconfigure(id, this.pendingReconfigure)
        this.pendingReconfigure = null
      }
      if (this.init.resumeId) await this.loadHistory()
    } catch {
      if (!this.disposed) this.patch({ notice: '无法创建会话：主进程没有响应' })
    }
  }

  /**
   * 历史回放走与实时流**同一套 reducer**（live=false）。
   *
   * send() 会等 ensureStarted()（含这一段）完成后再发，所以不存在
   * 「历史晚到、把刚发出的用户气泡覆盖掉」的竞态。
   */
  private async loadHistory(): Promise<void> {
    const resumeId = this.init.resumeId
    if (!resumeId) return
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!api?.sessions) return
    try {
      const history = await api.sessions.transcript(this.init.cwd, resumeId)
      if (this.disposed) return

      const items = history.reduce((acc, e) => reduce(acc, e, false), [] as ChatItem[])
      const run = history.reduce((acc, e) => reduceRun(acc, e, false), emptyRunState())
      const turns = history.filter((h) => h.t === 'user_message').length
      const ends = history.filter((h) => h.t === 'turn_end')
      const steps = ends.reduce((n, h) => n + (h.t === 'turn_end' ? h.steps : 0), 0)
      const last = ends[ends.length - 1]
      let usage: Usage | undefined
      if (last && last.t === 'turn_end') usage = last.usage

      // 历史里的 steps 已经是权威累计值，待校准的实时计数清零
      this.pendingSteps = 0
      // 修改清单只回放最后一轮 —— 和实时行为一致
      this.patch({ items, run, turns, steps, usage, files: filesAfterLastTurn(history) })
    } catch {
      // 历史读不到就当空会话 —— 实时流仍然能继续
    }
  }

  /** 记录一段流式增量，并在需要时启动每秒刷新 */
  private noteRate(text: string): void {
    if (!text) return
    const now = Date.now()
    this.ratePoints.push({ at: now, tokens: estimateTokens(text) })
    // 只留最近 4 秒 —— 长回复也不会把数组撑大
    const cut = now - 4000
    while (this.ratePoints.length > 0 && this.ratePoints[0].at < cut) this.ratePoints.shift()
    if (this.rateTimer == null) {
      this.rateTimer = window.setInterval(() => this.tickRate(), 1000)
    }
  }

  /** 最近 3 秒的估算吞吐；窗口里没有增量（比如在跑工具）就归零 */
  private tickRate(): void {
    if (this.disposed) return
    const now = Date.now()
    const cut = now - 3000
    while (this.ratePoints.length > 0 && this.ratePoints[0].at < cut) this.ratePoints.shift()
    let tokens = 0
    for (const p of this.ratePoints) tokens += p.tokens
    const first = this.ratePoints[0]?.at ?? now
    const span = Math.max(1, (now - first) / 1000)
    const rate = Math.round(tokens / span)
    if (rate !== this.snap.liveRate) this.patch({ liveRate: rate })
  }

  /** 清计时器和窗口，不单独触发渲染 —— 调用方通常还要 patch 一次 */
  private clearRate(): void {
    if (this.rateTimer != null) {
      window.clearInterval(this.rateTimer)
      this.rateTimer = null
    }
    this.ratePoints = []
  }

  handleEvent = (e: AgentEvent): void => {
    if (this.disposed) return

    /*
     * 侧栏要能提醒「不是当前会话、但卡在审批上」的那些行。
     * 这里顺手按 CLI 自己的 session id 记下 —— 侧栏只认它。
     */
    if (e.t === 'permission_request' || e.t === 'question_request') {
      setPendingApproval(this.providerSessionId, approvalFromEvent(e))
    }

    // 流式增量顺手累计一下输出速度（正文和思考都算输出 token）
    if (e.t === 'text_delta' || e.t === 'thinking_delta') this.noteRate(e.text)

    // 文件改动不画卡片，只更新「本轮修改」这一份状态
    if (e.t === 'file_change') {
      this.patch({ files: applyFileChange(this.snap.files, e) })
      return
    }

    // 排队消息真正开始时才清零 —— 点发送那一刻可能还在上一轮里
    if (e.t === 'turn_started') {
      this.clearRate()
      this.patch({ files: [], liveRate: undefined })
      return
    }

    if (e.t === 'session_started') {
      if (e.sessionId) this.providerSessionId = e.sessionId
      if (e.cwd) this.providerCwd = e.cwd
      // 新会话这时候才第一次有 CLI 自己的 id —— 把它登记到「已有会话」的 key 下，
      // 之后用户点侧栏里刚出现的那一行会命中同一个 controller，而不是再开一条 Live。
      if (e.sessionId) {
        const key = storedChatKey(this.init.cli, e.cwd || this.init.cwd, e.sessionId)
        if (!controllers.has(key)) controllers.set(key, this)
      }
      this.patch({
        model: e.model || this.snap.model,
        permissionMode: e.permissionMode
      })
      return
    }

    if (e.t === 'turn_end') {
      this.clearRate()
      // 轮末一定没有还挂着的审批：答复、拒绝、被打断都走不到这里再等
      clearPendingApproval(this.providerSessionId)
      /*
       * 步数在事件到来时已经实时加过了（见下面的 stepDelta），所以这里先
       * 减掉待校准的实时计数，再加主进程给的本轮权威值（turn_end.steps）。
       * 直接加会把同一轮的工具调用算两遍。
       */
      const stepBase = Math.max(0, this.snap.steps - this.pendingSteps)
      this.pendingSteps = 0
      this.patch({
        items: reduce(this.snap.items, e),
        run: reduceRun(this.snap.run, e),
        steps: stepBase + e.steps,
        usage: e.usage,
        liveRate: undefined
      })
      return
    }

    const prevRun = this.snap.run
    const nextRun = reduceRun(prevRun, e)
    const patch: Partial<ChatSnapshot> = {
      items: reduce(this.snap.items, e),
      run: nextRun
    }
    // 状态栏的「步数」实时跟工具调用走；turn_end 时再用主进程的权威值校准
    const stepDelta = nextRun.steps - prevRun.steps
    if (stepDelta > 0) {
      patch.steps = this.snap.steps + stepDelta
      this.pendingSteps += stepDelta
    }
    this.patch(patch)
  }

  handleStatus = (p: SessionStatusPayload): void => {
    if (this.disposed) return
    if (p.providerSessionId) this.providerSessionId = p.providerSessionId
    const next: Partial<ChatSnapshot> = { status: p.status }
    // 进程停了就不该再显示「本轮速度」—— 没有 turn_end 的异常退出也走这里
    if (p.status === 'idle' || p.status === 'exited') {
      this.clearRate()
      next.liveRate = undefined
      // 被打断/异常退出时没有 turn_end，实时步数就此落定
      this.pendingSteps = 0
      this.turnOpen = false
      // 进程都不跑了，侧栏那行别再挂着「待审批」
      clearPendingApproval(this.providerSessionId)
    }
    if (p.message) next.notice = p.message
    this.patch(next)
    // 本轮真的结束了才发下一条 —— 用 status 而不是 turn_end，
    // 因为进程退出 / 打断也可能没有 turn_end
    if (p.status === 'idle') this.flushQueue()
  }

  /** 运行中的消息不进转写区，先排进等待队列 */
  private enqueue(input: SessionSendInput, meta?: SendMeta): void {
    const item: QueuedMessage = {
      id: uid(),
      text: input.text,
      draft: meta?.draft ?? input.text,
      refs: meta?.refs ?? [],
      images: input.images,
      at: Date.now()
    }
    this.patch({ queue: [...this.snap.queue, item] })
  }

  /** 发送失败时放回队首 —— 用户打过的字不能悄悄丢 */
  private requeueFront(item: QueuedMessage): void {
    this.patch({ queue: [item, ...this.snap.queue] })
  }

  /**
   * 真正把一条消息交给 CLI。
   *
   * 发出后 `turnOpen` 一直锁着，直到 idle 才打开；这段期间的新消息都会排队。
   * 状态事件比 `session.send()` 的返回慢，只靠 status 判断会漏掉这个窗口。
   */
  private async performSend(input: SessionSendInput, item?: QueuedMessage): Promise<void> {
    await this.ensureStarted()
    if (this.disposed) return

    const id = this.liveId
    if (!id) {
      this.patch({ notice: '会话还没就绪，请稍候再试' })
      if (item) this.requeueFront(item)
      return
    }

    this.turnOpen = true
    this.patch({
      items: [
        ...this.snap.items,
        { kind: 'user', id: uid(), text: input.text, at: fmtAt(), images: input.images }
      ],
      turns: this.snap.turns + 1,
      // 新一轮：子代理、步数、修改清单都从零算，任务清单留着（它是会话级的）
      run: startRun(this.snap.run, Date.now()),
      files: []
    })

    const r = await window.api!.session.send(id, input)
    if (this.disposed) return
    if (!r.ok) {
      // 自动发送先停下，消息放回队首；用户确认后点「继续发送」
      this.turnOpen = false
      this.patch({ queuePaused: true, notice: r.message ?? '发送失败' })
      if (item) this.requeueFront(item)
    }
  }

  send = async (input: SessionSendInput, meta?: SendMeta): Promise<void> => {
    if (!input.text.trim() && !(input.images?.length ?? 0)) return
    // 用户主动发送 = 恢复自动发送
    if (this.snap.queuePaused) this.patch({ queuePaused: false })
    if (this.turnOpen || this.snap.status !== 'idle') {
      this.enqueue(input, meta)
      return
    }
    await this.performSend(input)
  }

  /** 轮末把队首交给 CLI；一次只发一条，保持「一轮一结束」的节奏 */
  private flushQueue(): void {
    if (this.disposed || this.snap.queuePaused || this.turnOpen) return
    if (this.snap.status !== 'idle') return
    const next = this.snap.queue[0]
    if (!next) return
    this.patch({ queue: this.snap.queue.slice(1) })
    void this.performSend({ text: next.text, images: next.images }, next)
  }

  removeQueued = (id: string): void => {
    if (!this.snap.queue.some((x) => x.id === id)) return
    this.patch({ queue: this.snap.queue.filter((x) => x.id !== id) })
  }

  clearQueue = (): void => {
    if (this.snap.queue.length === 0) return
    this.patch({ queue: [], queuePaused: false })
  }

  takeQueued = (id: string): QueuedMessage | null => {
    const item = this.snap.queue.find((x) => x.id === id)
    if (!item) return null
    this.patch({ queue: this.snap.queue.filter((x) => x.id !== id) })
    return item
  }

  moveQueued = (id: string, dir: -1 | 1): void => {
    const list = this.snap.queue
    const i = list.findIndex((x) => x.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= list.length) return
    const next = list.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    this.patch({ queue: next })
  }

  resumeQueue = (): void => {
    if (!this.snap.queuePaused) return
    this.patch({ queuePaused: false })
    this.flushQueue()
  }

  interrupt = (): void => {
    // 停止后不要立刻把排队消息倒出去 —— 先让用户看一眼、改完再继续
    if (this.snap.queue.length > 0 && !this.snap.queuePaused) {
      this.patch({ queuePaused: true })
    }
    if (this.liveId) window.api?.session.interrupt(this.liveId)
  }

  respond = (requestId: string, allow: boolean, always: boolean): void => {
    const id = this.liveId
    if (!id) return
    // 先就地更新，别让按钮等一个往返
    this.patch({
      items: this.snap.items.map((it): ChatItem =>
        it.kind === 'permission' && it.id === requestId
          ? { ...it, state: allow ? 'allowed' : 'denied', remembered: allow && always }
          : it
      )
    })
    window.api?.session.respondPermission(
      id,
      requestId,
      { behavior: allow ? 'allow' : 'deny' },
      always
    )
    // 已经答复：侧栏的跑马灯立刻收，不等这一轮跑完
    clearPendingApproval(this.providerSessionId)
  }

  answerQuestion = (requestId: string, answer: QuestionAnswer): void => {
    const id = this.liveId
    if (!id) return
    this.patch({
      items: this.snap.items.map((it): ChatItem =>
        it.kind === 'question' && it.id === requestId
          ? {
              ...it,
              state: answer.skipped ? 'skipped' : 'answered',
              ...(answer.skipped ? {} : { answers: answer.answers })
            }
          : it
      )
    })
    window.api?.session.respondQuestion(id, requestId, answer)
    clearPendingApproval(this.providerSessionId)
  }

  /** liveId 还没就绪时把参数存起来，attach 后补发，别悄悄丢掉 */
  private reconfigure(patch: {
    model?: string
    permissionMode?: PermissionMode
    effort?: EffortLevel
  }): void {
    if (this.liveId) {
      window.api?.session.reconfigure(this.liveId, patch)
      return
    }
    this.pendingReconfigure = { ...this.pendingReconfigure, ...patch }
  }

  applyModel = (m: string): void => {
    const next = m.trim()
    if (!next || next === this.snap.model) return
    this.patch({
      model: next,
      items: pushSystem(this.snap.items, 'model', this.snap.model || '未选模型', next)
    })
    this.reconfigure({ model: next })
  }

  applyPermissionMode = (p: PermissionMode): void => {
    if (p === this.snap.permissionMode) return
    this.patch({
      permissionMode: p,
      items: pushSystem(
        this.snap.items,
        'permissionMode',
        MODE_LABEL[this.snap.permissionMode],
        MODE_LABEL[p]
      )
    })
    this.reconfigure({ permissionMode: p })
  }

  applyEffort = (level: EffortLevel): void => {
    if (level === this.snap.effort) return
    this.patch({
      effort: level,
      items: pushSystem(
        this.snap.items,
        'effort',
        EFFORT_LABEL[this.snap.effort],
        EFFORT_LABEL[level]
      )
    })
    this.reconfigure({ effort: level })
  }

  applyChannel = (from: string, to: string): void => {
    this.patch({ items: pushSystem(this.snap.items, 'channel', from, to) })
    // 空 patch 就够：主进程 reconfigure 会把 needsRespawn 置位，下次 spawn 读最新渠道
    this.reconfigure({})
  }

  applyAuth = (from: string, to: string): void => {
    this.patch({ items: pushSystem(this.snap.items, 'auth', from, to) })
    // 来源变了，旧模型可能不属于新来源；主进程的 settingsChanged 会清掉它
    this.reconfigure({})
  }

  clearNotice = (): void => {
    this.patch({ notice: null })
  }

  /**
   * 只有显式关闭才走到这里。
   *
   * start() 还在飞的时候 liveId 是 null：标记 disposed 就够了，start 的
   * resolve 路径会看到标记并把刚拿到的 id 停掉。
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearRate()
    this.pendingSteps = 0
    this.listeners.clear()
    clearPendingApproval(this.providerSessionId)
    const id = this.liveId
    this.liveId = null
    if (id) {
      byLive.delete(id)
      window.api?.session.stop(id)
    }
  }
}

function uniqueControllers(): ChatController[] {
  return [...new Set(controllers.values())]
}

/**
 * 按 CLI 会话 id 找 controller。
 *
 * 「新会话」跑出 id 之后会变成侧栏里的一条已有会话；用户点它时必须复用
 * 同一个 Live，否则会一边还在跑、一边又 --resume 开一条，转写会打架。
 */
function findByProvider(id: string, cwd?: string): ChatController | null {
  const matches = uniqueControllers().filter((c) => !c.isDisposed && c.providerId === id)
  if (matches.length === 0) return null
  if (cwd) {
    const exact = matches.find((c) => sameCwd(c.providerCwd || c.init.cwd, cwd))
    if (exact) return exact
  }
  // 同一个 id 在不同工作区是合法的（会话被换过 cwd）。不唯一就不要猜。
  return matches.length === 1 ? matches[0] : null
}

function disposeController(c: ChatController): void {
  for (const [k, v] of [...controllers]) {
    if (v === c) controllers.delete(k)
  }
  c.dispose()
}

/** 复用已有 controller，没有就新建。key 是会话身份，不是「当前打开了哪条」 */
export function acquireChat(key: string, init: ChatInit): ChatController {
  wireDispatcher()
  const existing = controllers.get(key)
  if (existing) return existing

  if (init.resumeId) {
    const reuse = findByProvider(init.resumeId, init.cwd)
    if (reuse) {
      controllers.set(key, reuse)
      return reuse
    }
  }

  const c = new ChatController(key, init)
  controllers.set(key, c)
  return c
}

/** 只查不建 —— 设置页返回时 enabled 会短暂为 false，但已有会话必须原样复用 */
export function lookupChat(key: string): ChatController | null {
  return controllers.get(key) ?? null
}

export function disposeChat(key: string): void {
  const c = controllers.get(key)
  if (c) disposeController(c)
}

/** 删除已有会话时调用。新会话跑出来的 Live 也能按 provider id 找到 */
export function disposeStoredChat(cli: CliId, cwd: string, id: string): void {
  const c = controllers.get(storedChatKey(cli, cwd, id)) ?? findByProvider(id, cwd)
  if (c) disposeController(c)
}

export function disposeNewChat(cli: CliId, n: number): void {
  disposeChat(newChatKey(cli, n))
}

/**
 * 回收从没发过消息的新会话。
 *
 * 点一次「新会话」就会在主进程建一个 Live（还没发消息，所以不会 spawn 进程）。
 * 切走之后它没有侧栏行，用户再也点不回来；留着只会让注册表越积越多。
 * 有消息 / 有轮次的会话不在这里动 —— 它们可能正在后台跑。
 */
export function disposeIdleNewChats(): void {
  for (const c of uniqueControllers()) {
    if (c.init.resumeId !== null) continue
    // 队列里有东西就不能丢 —— 它们是用户已经打好的字
    if (
      c.snapshot.turns === 0 &&
      c.snapshot.items.length === 0 &&
      c.snapshot.queue.length === 0
    ) {
      disposeController(c)
    }
  }
}

/* ── hook ─────────────────────────────────────────────────── */

const EMPTY_SNAPSHOT: ChatSnapshot = {
  items: [],
  status: 'idle',
  model: '',
  permissionMode: 'standard',
  effort: DEFAULT_EFFORT,
  turns: 0,
  steps: 0,
  usage: undefined,
  queue: [],
  queuePaused: false,
  run: emptyRunState(),
  files: [],
  notice: null
}

const OFFLINE_SNAPSHOT: ChatSnapshot = {
  ...EMPTY_SNAPSHOT,
  status: 'exited',
  notice: '当前不在 Electron 中运行，无法发起会话。'
}

const noopSubscribe = (): (() => void) => () => undefined
const noopSnapshot = (): ChatSnapshot => EMPTY_SNAPSHOT
const noop = (): void => undefined
const noopSend = async (_input: SessionSendInput, _meta?: SendMeta): Promise<void> => undefined
const noopRemoveQueued = (_id: string): void => undefined
const noopTakeQueued = (_id: string): QueuedMessage | null => null
const noopMoveQueued = (_id: string, _dir: -1 | 1): void => undefined
const noopRespond = (_id: string, _allow: boolean, _always: boolean): void => undefined
const noopAnswer = (_id: string, _answer: QuestionAnswer): void => undefined
const noopModel = (_model: string): void => undefined
const noopMode = (_mode: PermissionMode): void => undefined
const noopEffort = (_level: EffortLevel): void => undefined
const noopChannel = (_from: string, _to: string): void => undefined
const noopAuth = (_from: string, _to: string): void => undefined

export function useChat(opts: {
  /** 用哪个 CLI 跑；缺省 claude */
  cli?: CliId
  cwd: string
  permissionMode: PermissionMode
  /** 新会话的思考深度；会话里还能单独改 */
  effort?: EffortLevel
  /** 接着哪条已有会话跑；变化时会复用/重建对应 controller */
  resumeId?: string | null
  /**
   * 新会话的序号，每点一次「新会话」换一个。
   * 它是新会话的身份：同一个 n 就是同一条会话。
   */
  freshKey?: number
  /** 设置还没加载完就别建会话，否则会用到默认的 cwd/权限模式 */
  enabled?: boolean
}): ChatApi {
  const available = typeof window !== 'undefined' && !!window.api
  const cli: CliId = opts.cli ?? 'claude'
  const resumeId = opts.resumeId ?? null

  /**
   * 会话身份。已有会话是 (cli, cwd, id)，新会话是 (cli, n)。
   * cwd / 权限模式 / effort 是**创建参数**，只影响第一次建 controller；
   * 它们变化不应该让一个已经在后台跑的会话重启。
   */
  const key = resumeId
    ? storedChatKey(cli, opts.cwd, resumeId)
    : opts.freshKey !== undefined
      ? newChatKey(cli, opts.freshKey)
      : null

  const enabled = opts.enabled !== false

  const controller = useMemo(() => {
    if (!available || !key) return null
    // 即使 enabled=false 也先复用 —— 从设置页返回时 useSettings 会短暂 loading，
    // 这时候如果返回空快照，用户会看到一帧空转写。
    const existing = lookupChat(key)
    if (existing) return existing
    if (!enabled) return null
    return acquireChat(key, {
      cli,
      cwd: opts.cwd,
      permissionMode: opts.permissionMode,
      effort: opts.effort ?? DEFAULT_EFFORT,
      resumeId
    })
    // 创建参数故意不进依赖：key 已经代表会话身份，默认设置变化不该重建会话
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, key, enabled])

  // 没有 cleanup —— 组件卸载不结束会话。生命周期的终点在 dispose 系列函数里。
  useEffect(() => {
    if (controller) void controller.ensureStarted()
  }, [controller])

  const snapshot = useSyncExternalStore(
    controller ? controller.subscribe : noopSubscribe,
    controller ? controller.getSnapshot : noopSnapshot
  )

  return useMemo<ChatApi>(() => {
    const s = controller ? snapshot : available ? EMPTY_SNAPSHOT : OFFLINE_SNAPSHOT
    return {
      items: s.items,
      status: s.status,
      busy: s.status === 'running' || s.status === 'starting',
      model: s.model,
      permissionMode: s.permissionMode,
      effort: s.effort,
      turns: s.turns,
      steps: s.steps,
      usage: s.usage,
      liveRate: s.liveRate,
      queue: s.queue,
      queuePaused: s.queuePaused,
      run: s.run,
      files: s.files,
      send: controller ? controller.send : noopSend,
      removeQueued: controller ? controller.removeQueued : noopRemoveQueued,
      clearQueue: controller ? controller.clearQueue : noop,
      takeQueued: controller ? controller.takeQueued : noopTakeQueued,
      moveQueued: controller ? controller.moveQueued : noopMoveQueued,
      resumeQueue: controller ? controller.resumeQueue : noop,
      interrupt: controller ? controller.interrupt : noop,
      respond: controller ? controller.respond : noopRespond,
      answerQuestion: controller ? controller.answerQuestion : noopAnswer,
      applyModel: controller ? controller.applyModel : noopModel,
      applyPermissionMode: controller ? controller.applyPermissionMode : noopMode,
      applyEffort: controller ? controller.applyEffort : noopEffort,
      applyChannel: controller ? controller.applyChannel : noopChannel,
      applyAuth: controller ? controller.applyAuth : noopAuth,
      notice: s.notice,
      clearNotice: controller ? controller.clearNotice : noop
    }
  }, [available, controller, snapshot])
}
