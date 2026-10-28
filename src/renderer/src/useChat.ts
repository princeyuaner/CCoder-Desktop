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
import type { CliAuthMode, CliId, EffortLevel } from '@shared/settings'
import { DEFAULT_EFFORT, sameCwd } from '@shared/settings'
import type { NativeCommand } from '@shared/commands'
import { toolDisplay, type ToolFallback, type ToolStat } from '@shared/tool'
import { stripAnsi } from '@shared/ansi'
import { ltext, type LocalizedText } from '@shared/i18n'
import { applyFileChange, filesAfterLastTurn, type ChangedFile } from './changedFiles'
import type { ImageAttachment } from '@shared/attachment'
import type { IdeCodeRef } from '@shared/ide-chat'
import type {
  QuestionAnswer,
  SessionSendInput,
  SessionSendResult,
  SessionStatus,
  SessionStatusPayload
} from '@shared/session'
import {
  emptyRunState,
  isBackgroundAgent,
  reduceRun,
  startRun,
  type RunState
} from './run-state'
import {
  approvalFromEvent,
  clearPendingApproval,
  setPendingApproval
} from './pending-approvals'
import { clearBackgroundRunning, setBackgroundRunning } from './background-tasks'
import { notifyTurnDone } from './done-notify'

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

/** 渠道 / 凭据来源的展示数据。渲染时再按语言翻译，不能提前烤成中文。 */
export type ChannelLabel = { kind: 'official' } | { kind: 'channel'; name: string }

/**
 * 会话级渠道切换的目标。
 *
 * `label` 只用于转写区留痕；`authMode` / `channelId` 才是真正下发给这条
 * 会话的东西 —— 渠道是会话级选择，不进设置，所以不能只传一个渠道 id。
 */
export interface ChannelTarget {
  label: ChannelLabel
  authMode: CliAuthMode
  channelId: string | null
}

/**
 * 设置切换的留痕数据。存枚举 / 原始值，不存已经翻译好的文案 ——
 * 这样切换语言后历史留痕也会跟着变。
 */
export type SystemChange =
  | { key: 'model'; from: string; to: string }
  | { key: 'permissionMode'; from: PermissionMode; to: PermissionMode }
  | { key: 'effort'; from: EffortLevel; to: EffortLevel }
  | { key: 'channel'; from: ChannelLabel; to: ChannelLabel }
  | { key: 'auth'; from: ChannelLabel; to: ChannelLabel }

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
      /** subject 为空时，渲染层按类型取兜底文案 */
      fallback?: ToolFallback
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
  | ({
      kind: 'system'
      id: string
      at: string
    } & SystemChange)
  | { kind: 'error'; id: string; at: string; message: LocalizedText }
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
  /**
   * CLI 自己的会话 id；新会话要等第一条消息发出后才有。
   * 会话级设置（如模型）要靠它回写到 session-meta。
   */
  sessionId: string | null
  /** CLI 实际报的 cwd —— 回写元数据时要用它做键的第二段 */
  sessionCwd: string
  permissionMode: PermissionMode
  /** 本会话的思考深度（CLI 的 --effort） */
  effort: EffortLevel
  /**
   * 本会话自己的凭据来源 / 渠道。`undefined` = 还没选过，跟随设置里的默认值。
   *
   * 渠道是会话级的：A 工作区的对话切了渠道，B 工作区不该跟着变。
   */
  authMode?: CliAuthMode
  channelId?: string | null
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
  /** 当前 CLI 上报的原生指令；Codex / dsh 的静态子集在渲染层合入 */
  nativeCommands: NativeCommand[]
  /**
   * 当前"等待占位行"的起点（Date.now()）；不在等待时为 undefined。
   * 放在会话状态里，切走再切回来计时能续上。
   */
  waitingSince?: number
  /**
   * 发送。会话忙时不会立刻发给 CLI，而是进等待队列；
   * `meta` 用于把原话和引用一并存下来，供队列里的「编辑」恢复。
   */
  send(input: SessionSendInput, meta?: SendMeta): Promise<void>
  /** 执行 CLI 原生指令（如 Codex 的 compact）；不支持时返回 ok=false */
  runCommand(name: string, args?: string): Promise<SessionSendResult>
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
   * 只改**这条会话**：别的对话各有各的渠道，设置里的默认值也不动。
   */
  applyChannel(from: ChannelLabel, to: ChannelTarget): void
  /** 切换凭据来源（官方登录 ↔ 渠道）。和换渠道一样，下一轮换进程生效。 */
  applyAuth(from: ChannelLabel, to: ChannelTarget): void
  notice: LocalizedText | null
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

/**
 * 统一存 ISO 时间串，展示时再按当前语言格式化。
 * 之前这里直接烤成「10月20日 21:15」，切换语言后老消息不会变。
 */
function atIso(iso?: string): string {
  if (iso) {
    const d = new Date(iso)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  return new Date().toISOString()
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
  return [...closeOpen(items), { kind, id: uid(), at: atIso(), text, streaming: true }]
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
function pushSystem(items: ChatItem[], change: SystemChange): ChatItem[] {
  const idOf = (v: string | ChannelLabel): string =>
    typeof v === 'string' ? v : v.kind === 'official' ? '@official' : `#${v.name}`
  if (idOf(change.from) === idOf(change.to)) return items

  const last = items[items.length - 1]
  if (last?.kind === 'system' && last.key === change.key) {
    const copy = items.slice()
    if (idOf(last.from) === idOf(change.to)) copy.pop()
    else copy[copy.length - 1] = { ...last, to: change.to } as ChatItem
    return copy
  }

  return [...closeOpen(items), { kind: 'system', id: uid(), at: atIso(), ...change } as ChatItem]
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
        { kind: 'user', id: uid(), text: e.text, at: atIso(e.at), images: e.images }
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
        copy[idx] = {
          ...prev,
          subject: d.subject,
          fallback: d.fallback,
          dir: d.dir,
          path: d.path
        }
        return copy
      }
      const d = toolDisplay(e.name, e.path ? { file_path: e.path } : {})
      return [
        ...closeOpen(items),
        {
          kind: 'tool',
          id: e.id,
          at: atIso(),
          name: e.name,
          summary: e.path ?? '',
          subject: d.subject,
          fallback: d.fallback,
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
        at: atIso(),
        name: e.name,
        summary: toolSummary(e.name, e.input),
        subject: d.subject,
        fallback: d.fallback,
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
              // 工具输出带终端颜色码（类型检查 / 构建日志最多），
              // 直接进 <pre> 会显示成 [2m、[39m 之类的乱码
              content: stripAnsi(e.content),
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
          at: atIso(),
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
          at: atIso(),
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
          at: atIso(),
          durationMs: e.durationMs,
          steps: e.steps,
          usage: e.usage
        }
      ]

    case 'error':
      return [...closeOpen(items), { kind: 'error', id: uid(), at: atIso(), message: e.message }]

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

/**
 * 什么时候算"轮到模型了但还没吐字"。
 *
 * 判据是**最后一条是什么**：只要最后一条是"已经落定、且不该再往下长"的东西，
 * 就说明球在模型那边。反过来，正在流式的正文/思考、正在跑的工具、
 * 等人点同意的审批卡，都各自有活着的表现，不用再叠一个占位。
 *
 * 放在这里而不是 Transcript 里：等待计时由 controller 跟着会话状态维护，
 * 这样切走再切回来能续上，而不是跟着组件挂载从 0 重来。
 */
export function waitingOnModel(last: ChatItem | undefined): boolean {
  if (!last) return false
  switch (last.kind) {
    case 'user': // 刚发出去，第一个 token 还没回来
    case 'turn': // 上一轮结束，这一轮还没开始吐
      return true
    case 'tool':
      return last.status !== 'running' // 工具跑完了，等模型接着说
    case 'permission':
      return last.state !== 'pending' // 审批已答复，等模型接着跑
    case 'question':
      return last.state !== 'pending' // 提问已答复，等模型接着说
    case 'text':
    case 'thinking':
      return !last.streaming // 这一段说完了，等下一段
    default:
      return false // 出错之类：不是在等模型
  }
}

/** 快照 = ChatApi 去掉方法后的部分。每次变化换一个新对象，供 useSyncExternalStore 比较 */
export interface ChatSnapshot {
  items: ChatItem[]
  status: SessionStatus
  model: string
  permissionMode: PermissionMode
  effort: EffortLevel
  /**
   * 本会话自己的凭据来源 / 渠道。`undefined` = 还没选过，跟随设置里的默认值。
   *
   * 渠道是会话级的：A 工作区的对话切了渠道，B 工作区不该跟着变。
   */
  authMode?: CliAuthMode
  channelId?: string | null
  turns: number
  steps: number
  usage?: Usage
  liveRate?: number
  queue: QueuedMessage[]
  queuePaused: boolean
  run: RunState
  files: ChangedFile[]
  /** 当前 CLI 上报的原生指令；会话级缓存，切换会话不会串 */
  nativeCommands: NativeCommand[]
  notice: LocalizedText | null
  /**
   * 当前"等待占位行"的起点（Date.now()）；不在等待时为 undefined。
   *
   * 计时起点放在会话状态里而不是占位行组件里：切到别的会话再切回来，
   * 组件会重新挂载，但这段等待没有结束，计时不能从 0 重来。
   */
  waitingSince?: number
}

interface ChatInit {
  cli: CliId
  cwd: string
  permissionMode: PermissionMode
  effort: EffortLevel
  resumeId: string | null
  /** 这条会话自己选过的模型（来自 session-meta）；空 = 用默认值 */
  model: string
  /**
   * 这条会话自己的凭据来源与渠道（来自 session-meta）。undefined = 还没选过，
   * 跟随设置里的默认值。
   */
  authMode?: CliAuthMode
  channelId?: string | null
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

/**
 * CLI 原生指令表缓存，按 cli + cwd 隔离。
 *
 * 已有会话在首次发送前 CLI 还没启动，拿不到 Claude 的原生表；只要同
 * 工作区有一条会话上报过，后面的会话就能立刻用它填弹层。
 */
const nativeCommandCache = new Map<string, NativeCommand[]>()
const nativeCommandKey = (cli: CliId, cwd: string): string => `${cli}${SEP}${normCwd(cwd)}`

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
  /** 本轮还在等结果 —— 跑完时用它决定要不要弹系统通知 */
  private turnNotified = false
  /** liveId 还没就绪时改的启动参数，attach 之后补发 */
  private pendingReconfigure:
    | {
        model?: string
        permissionMode?: PermissionMode
        effort?: EffortLevel
        authMode?: CliAuthMode
        channelId?: string | null
      }
    | null = null

  constructor(key: string, init: ChatInit) {
    this.key = key
    this.init = { ...init }
    this.providerSessionId = init.resumeId
    this.providerCwd = init.cwd
    this.snap = {
      items: [],
      status: 'idle',
      model: init.model,
      permissionMode: init.permissionMode,
      effort: init.effort,
      authMode: init.authMode,
      channelId: init.channelId,
      turns: 0,
      steps: 0,
      usage: undefined,
      queue: [],
      queuePaused: false,
      run: emptyRunState(),
      files: [],
      nativeCommands: nativeCommandCache.get(nativeCommandKey(init.cli, init.cwd)) ?? [],
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
    const next: ChatSnapshot = { ...this.snap, ...p }
    /*
     * 占位行的计时起点跟着会话状态走，而不是跟着组件挂载走。
     * 组件切走再切回来会重新挂载，但这段等待并没有结束 —— 时间要续上。
     * 真正进入下一次等待（流式开始、工具跑起来、审批待答复…）时才换起点。
     */
    const waiting =
      (next.status === 'running' || next.status === 'starting') &&
      waitingOnModel(next.items[next.items.length - 1])
    if (!waiting) next.waitingSince = undefined
    else if (next.waitingSince === undefined) next.waitingSince = Date.now()

    this.snap = next
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
        notice: ltext('errors.notElectronSession')
      })
      return
    }

    try {
      const id = await api.session.start({
        cli: this.init.cli,
        cwd: this.init.cwd,
        permissionMode: this.init.permissionMode,
        effort: this.init.effort,
        // 会话级模型选择：重开这条会话时接着用它自己的模型，而不是当时的全局默认
        model: this.init.model || undefined,
        resumeId: this.init.resumeId,
        // 会话自己的渠道 / 来源；undefined 时主进程回落到设置里的默认值
        authMode: this.init.authMode,
        channelId: this.init.channelId
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
      if (!this.disposed) {
        this.patch({ notice: ltext('errors.sessionCreateNoResponse') })
      }
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
     * 权限模式的实际生效值。点选时已经乐观改过胶囊；CLI 拒绝或自己回落时，
     * 这里把它校回来。不画转写项 —— 用户的切换动作已经有一条系统记录了。
     */
    if (e.t === 'permission_mode_changed') {
      if (e.mode !== this.snap.permissionMode) this.patch({ permissionMode: e.mode })
      return
    }

    /*
     * CLI 原生指令表是替换语义：收到就整份覆盖。
     * 缓存按 cli + cwd 存，同工作区后续会话在 CLI 启动前也能显示。
     */
    if (e.t === 'native_commands') {
      const key = nativeCommandKey(this.init.cli, this.providerCwd || this.init.cwd)
      nativeCommandCache.set(key, e.commands)
      this.patch({ nativeCommands: e.commands })
      return
    }

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

    /*
     * 后台任务的状态只有 run-state 知道；侧栏只认 CLI session id，
     * 这里转存一份「还在跑的任务 id」，它据此续着显示「后台运行中」。
     */
    if (
      e.t === 'tool_result' ||
      e.t === 'task_started' ||
      e.t === 'task_progress' ||
      e.t === 'task_updated' ||
      e.t === 'task_notification'
    ) {
      this.syncBackground()
    }
  }

  /**
   * 把当前还在跑的后台工作同步给侧栏；空 = 收掉标记。
   *
   * 后台命令和「后台启动的子代理」都算 —— 主对话这一轮结束时它们都可能
   * 还没跑完，界面上不能写「已完成」。
   */
  private syncBackground(): void {
    const ids = [
      ...this.snap.run.background
        .filter((b) => b.status === 'running')
        .map((b) => b.taskId),
      ...this.snap.run.agents
        // startedAt=0 是历史回放，那时进程早没了，不能当成还在跑
        .filter((a) => a.status === 'running' && a.startedAt > 0 && isBackgroundAgent(a))
        .map((a) => a.taskId ?? a.id)
    ]
    setBackgroundRunning(this.providerSessionId, ids)
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
    // 进程退出 = 后台任务也没了；idle 不能清 —— 后台命令这时可能还在跑
    if (p.status === 'exited') clearBackgroundRunning(this.providerSessionId)
    if (p.message) next.notice = p.message
    this.patch(next)

    /*
     * 一轮跑完 → 系统通知。
     *
     * 放在 idle 上而不是 turn_end 事件里：打断 / 异常退出也可能没有
     * turn_end，但用户同样在等一个「结束了」的信号。进程退出（exited）
     * 不通知 —— 那是坏消息，界面上有更明确的错误，不需要再弹一个窗。
     *
     * 必须用 `turnNotified` 把「刚打开会话的那次 idle」挡掉：主进程建会话
     * 时就会推一条 idle，那不是任何一轮的结束，弹通知就是纯噪音。
     */
    if (p.status === 'idle' && this.turnNotified && this.providerSessionId) {
      this.turnNotified = false
      notifyTurnDone({
        cli: this.init.cli,
        cwd: this.providerCwd,
        id: this.providerSessionId,
        errored: p.errored === true,
        backgroundRunning: this.backgroundTaskCount()
      })
    }

    // 本轮真的结束了才发下一条 —— 用 status 而不是 turn_end，
    // 因为进程退出 / 打断也可能没有 turn_end
    if (p.status === 'idle') this.flushQueue()
  }

  /** 还在跑的后台任务数 —— 通知里要说准「活干完了没有」 */
  private backgroundTaskCount(): number {
    const run = this.snap.run
    if (!run) return 0
    return (
      run.background.filter((b) => b.status === 'running').length +
      run.agents.filter((a) => a.status === 'running' && a.startedAt > 0 && isBackgroundAgent(a))
        .length
    )
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
      this.patch({ notice: ltext('errors.sessionNotReady') })
      if (item) this.requeueFront(item)
      return
    }

    this.turnOpen = true
    // 从这一刻起，下一次 idle 就是"这一轮跑完了"，值得提醒
    this.turnNotified = true
    this.patch({
      items: [
        ...this.snap.items,
        { kind: 'user', id: uid(), text: input.text, at: atIso(), images: input.images }
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
      this.patch({ queuePaused: true, notice: r.message ?? ltext('errors.sendFailed') })
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

  /**
   * 执行 CLI 原生指令（如 Codex 的 compact）。
   *
   * 指令不是发给模型的正文字，所以不能走 send。主进程会判断 provider
   * 有没有对应能力；失败时原样带回提示，由输入框 toast。
   */
  runCommand = async (name: string, args = ''): Promise<SessionSendResult> => {
    await this.ensureStarted()
    if (this.disposed) return { ok: false }
    const id = this.liveId
    if (!id) return { ok: false }
    const api = window.api?.session
    if (!api?.command) return { ok: false }
    try {
      return await api.command(id, name, args)
    } catch {
      return { ok: false }
    }
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
    authMode?: CliAuthMode
    channelId?: string | null
  }): void {
    if (this.liveId) {
      window.api?.session.reconfigure(this.liveId, patch)
      return
    }
    this.pendingReconfigure = { ...this.pendingReconfigure, ...patch }
  }

  applyModel = (m: string): void => {
    const next = m.trim()
    // '' = 回到渠道 / CLI 的默认模型；这是选择器里的「默认」项，必须能清掉
    // 之前的显式选择，所以不能用 `!next` 拦掉
    if (next === this.snap.model) return
    this.patch({
      model: next,
      items: pushSystem(this.snap.items, { key: 'model', from: this.snap.model, to: next })
    })
    this.reconfigure({ model: next })
  }

  applyPermissionMode = (p: PermissionMode): void => {
    if (p === this.snap.permissionMode) return
    this.patch({
      permissionMode: p,
      items: pushSystem(this.snap.items, {
        key: 'permissionMode',
        from: this.snap.permissionMode,
        to: p
      })
    })
    this.reconfigure({ permissionMode: p })
  }

  applyEffort = (level: EffortLevel): void => {
    if (level === this.snap.effort) return
    this.patch({
      effort: level,
      items: pushSystem(this.snap.items, {
        key: 'effort',
        from: this.snap.effort,
        to: level
      })
    })
    this.reconfigure({ effort: level })
  }

  applyChannel = (from: ChannelLabel, to: ChannelTarget): void => {
    this.patch({
      authMode: to.authMode,
      channelId: to.channelId,
      items: pushSystem(this.snap.items, { key: 'channel', from, to: to.label })
    })
    // 渠道只是启动参数：主进程记住的是**这条会话**的选择，下次 spawn 用它
    this.reconfigure({ authMode: to.authMode, channelId: to.channelId })
  }

  applyAuth = (from: ChannelLabel, to: ChannelTarget): void => {
    this.patch({
      authMode: to.authMode,
      channelId: to.channelId,
      // 来源变了，旧模型可能不属于新来源 —— 主进程会清掉会话里的显式模型
      model: '',
      items: pushSystem(this.snap.items, { key: 'auth', from, to: to.label })
    })
    this.reconfigure({ authMode: to.authMode, channelId: to.channelId })
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
    clearBackgroundRunning(this.providerSessionId)
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
  nativeCommands: [],
  notice: null
}

const OFFLINE_SNAPSHOT: ChatSnapshot = {
  ...EMPTY_SNAPSHOT,
  status: 'exited',
  notice: ltext('errors.notElectronSession')
}

const noopSubscribe = (): (() => void) => () => undefined
const noopSnapshot = (): ChatSnapshot => EMPTY_SNAPSHOT
const noop = (): void => undefined
const noopSend = async (_input: SessionSendInput, _meta?: SendMeta): Promise<void> => undefined
const noopRunCommand = async (_name: string, _args?: string): Promise<SessionSendResult> => ({
  ok: false
})
const noopRemoveQueued = (_id: string): void => undefined
const noopTakeQueued = (_id: string): QueuedMessage | null => null
const noopMoveQueued = (_id: string, _dir: -1 | 1): void => undefined
const noopRespond = (_id: string, _allow: boolean, _always: boolean): void => undefined
const noopAnswer = (_id: string, _answer: QuestionAnswer): void => undefined
const noopModel = (_model: string): void => undefined
const noopMode = (_mode: PermissionMode): void => undefined
const noopEffort = (_level: EffortLevel): void => undefined
const noopChannel = (_from: ChannelLabel, _to: ChannelTarget): void => undefined
const noopAuth = (_from: ChannelLabel, _to: ChannelTarget): void => undefined

export function useChat(opts: {
  /** 用哪个 CLI 跑；缺省 claude */
  cli?: CliId
  cwd: string
  permissionMode: PermissionMode
  /** 新会话的思考深度；会话里还能单独改 */
  effort?: EffortLevel
  /**
   * 这条会话自己的模型（打开已有会话时从 session-meta 读出来）。
   * 只作为**创建参数**使用：会话一旦建好，就由 reconfigure 自己维护。
   */
  model?: string
  /**
   * 这条会话自己的凭据来源 / 渠道（同样是 session-meta 里记的）。
   * 不传 = 跟随设置里的默认值；会话一旦建好就由 reconfigure 自己维护。
   */
  authMode?: CliAuthMode
  channelId?: string | null
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
      model: opts.model ?? '',
      authMode: opts.authMode,
      channelId: opts.channelId,
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
      sessionId: controller ? controller.providerId : null,
      sessionCwd: controller ? controller.providerCwd : opts.cwd,
      permissionMode: s.permissionMode,
      effort: s.effort,
      authMode: s.authMode,
      channelId: s.channelId,
      turns: s.turns,
      steps: s.steps,
      usage: s.usage,
      liveRate: s.liveRate,
      queue: s.queue,
      queuePaused: s.queuePaused,
      run: s.run,
      files: s.files,
      nativeCommands: s.nativeCommands,
      waitingSince: s.waitingSince,
      send: controller ? controller.send : noopSend,
      runCommand: controller ? controller.runCommand : noopRunCommand,
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
