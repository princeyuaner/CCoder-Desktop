import type { AgentEvent, PermissionMode } from './events'
import type { CliAuthMode, CliId, EffortLevel } from './settings'
import type { ImageAttachment } from './attachment'

export interface SessionStartOptions {
  /** 用哪个 CLI 跑这条会话；缺省是 claude */
  cli?: CliId
  /** 工作目录 —— 决定会话归属哪个工作区，也决定 CLI 读写哪里 */
  cwd: string
  permissionMode: PermissionMode
  /** 留空则用当前渠道的模型 */
  model?: string
  /** 思考深度（CLI 的 --effort）。不传就用默认档 */
  effort?: EffortLevel
  addDirs?: string[]
  /** 要接着哪条已有会话跑（CLI 的 --resume）。不传就是全新会话。 */
  resumeId?: string | null
  /**
   * 这条会话自己的凭据来源。不传 = 跟随设置里的默认值。
   *
   * 渠道 / 官方登录是**会话级**选择：A 工作区的对话切了渠道，B 工作区的
   * 对话不该跟着换。设置里的那一份只是「新会话默认」。
   */
  authMode?: CliAuthMode
  /** 这条会话自己的渠道 id；null = 无渠道（官方登录）。不传 = 跟随默认 */
  channelId?: string | null
}

/** 磁盘上一条已有会话（CLI 自己写的记录） */
export interface StoredSession {
  id: string
  /** 会话所属项目目录 */
  cwd: string
  /** 首条用户消息，当标题用 */
  title: string
  /**
   * 会话创建时间（毫秒）—— 取文件里第一条记录的时间戳。
   *
   * 侧栏默认按它排序。**不能用 `updatedAt` 排**：会话运行期间 CLI 每写一条
   * 记录 mtime 就会变，后台会话一轮结束就跳到顶部，列表会来回跳。
   */
  createdAt: number
  /** 文件最后修改时间（毫秒）—— 表示"最近活动"，只在切到该排序时用 */
  updatedAt: number
  /**
   * 这条会话是哪个 CLI 写的。
   *
   * 会话身份是 **(cli, cwd, id)** 三样：各家 CLI 读各自那份存储，
   * 拿 claude 去 resume 一条 codex 的会话是找不到的。这个字段由
   * 各自的扫描器带出来（~/.claude/projects 或 ~/.codex/sessions）。
   */
  cli: CliId
}

/**
 * 应用本地维护的会话元数据。
 *
 * **不写回 CLI 的记录文件** —— 那些 jsonl 归 CLI 所有，重命名 / 置顶 /
 * 归档只影响本应用的侧栏。身份和会话本身一样是 (cli, cwd, id)。
 */
export interface SessionMeta {
  /** 用户设置的显示标题；空 = 继续用 CLI 记录里的首条消息 */
  title?: string
  /** 置顶：同一工作区内排在前面 */
  pinned?: boolean
  /** 归档：默认从侧栏收起，可临时显示 */
  archived?: boolean
  /**
   * 这条会话自己选的模型。
   *
   * 模型是**会话级**选择：同一 CLI 的两个对话可以各用各的模型。
   * 缺省 = 用渠道配置或 CLI 的默认模型。
   */
  model?: string
  /**
   * 这条会话自己选的凭据来源（渠道 / 官方登录）。
   *
   * 和模型同理：设置里那一份只是「新会话默认」，两条对话可以各走各的渠道。
   * 缺省 = 沿用设置里的默认值（老会话没有这个字段，行为不变）。
   */
  authMode?: CliAuthMode
  /** 这条会话自己选的渠道 id；空 = 没有显式选择，回到官方登录 / 默认渠道 */
  channelId?: string
}

/** 键是 `sessionMetaKey()` 生成的字符串 */
export type SessionMetaMap = Record<string, SessionMeta>

/**
 * 会话元数据的键。
 *
 * 用 JSON 数组而不是冒号拼接：Windows 路径本身带冒号和反斜杠，拼出来的
 * 字符串可能撞车；JSON 还顺带把键变成合法的对象属性。
 */
export function sessionMetaKey(cli: CliId, cwd: string, id: string): string {
  return JSON.stringify([cli, cwd, id])
}

/** 修改一条会话的元数据；只传要改的字段 */
export interface SessionMetaUpdate {
  cli: CliId
  cwd: string
  id: string
  /** `title: ''` 表示恢复 CLI 原标题；pinned / archived 传 false 即取消 */
  patch: SessionMeta
}

/** 一条搜索命中。只带展示需要的字段，不把整份会话记录传给渲染层。 */
export interface SessionSearchHit {
  id: string
  cwd: string
  cli: CliId
  /** CLI 记录里的标题；用户重命名由渲染层按 SessionMeta 覆盖 */
  title: string
  createdAt: number
  updatedAt: number
  /** 命中位置附近的一行上下文；标题命中时为空串 */
  snippet: string
  /** 内容命中次数；标题命中固定为 1 */
  matches: number
  /** 命中来源：标题由渲染层本地匹配，内容由主进程扫描 */
  field: 'title' | 'content'
}

export interface SessionSearchResult {
  /** 这一批找到的命中 */
  hits: SessionSearchHit[]
  /**
   * 有超大文件被跳过。
   *
   * 单批达到 limit **不算**截断 —— 渲染层会拿 nextOffset 继续要下一批，
   * 真正的"结果已截断"由渲染层的展示上限决定。
   */
  truncated: boolean
  /** 这一批实际扫描了多少条会话 */
  scanned: number
  /** 这一批从第几条会话开始（按 updatedAt 倒序的偏移） */
  offset: number
  /** 下一次从哪继续；done=true 时忽略 */
  nextOffset: number
  /** 所有会话都扫完了 */
  done: boolean
  /** 本次快照里的会话总数 */
  total: number
}

/** 对一条审批请求的答复 */
export interface PermissionDecision {
  behavior: 'allow' | 'deny'
  /** deny 时给模型的原因，会显示在它的下一步里 */
  message?: string
  /**
   * 本会话内同类操作不再询问。由 SessionManager 在调用 provider 前补上；
   * Claude 的控制协议里没有这个概念（它靠宿主侧的 autoAllow 代答），
   * Codex 则能把它翻译成 `acceptForSession`。
   */
  always?: boolean
}

/**
 * 对一次 AskUserQuestion 的答复。
 *
 * answers 的 key 必须是**问题原文**（CLI 用它把答案对回题目），
 * value 是选项的 label；多选题给数组，自由输入（「其他」）给字符串。
 */
export interface QuestionAnswer {
  answers: Record<string, string | string[]>
  /** 整组跳过。CLI 会收到 deny，模型知道这次提问被放弃了 */
  skipped?: boolean
}

export interface SessionEventPayload {
  sessionId: string
  event: AgentEvent
}

export type SessionStatus = 'starting' | 'running' | 'idle' | 'exited'

export interface SessionStatusPayload {
  sessionId: string
  status: SessionStatus
  /** CLI 自己的 session id，用于 --resume */
  providerSessionId: string | null
  /** 进程退出码（exited 时有意义） */
  code?: number | null
  /** 出错时的说明 */
  message?: string
  /**
   * 刚结束的那一轮是否以错误收尾。
   *
   * 侧栏据此把「已完成」换成「错误」—— 只看 idle 分不清跑成功还是跑失败。
   * 只在 idle 状态上有意义；下一次开跑要重新清掉。
   */
  errored?: boolean
}

/**
 * 一条用户消息的内容。
 *
 * 图片和文本可以同时存在；只有图片、没有文本也是合法的
 * （比如“看这张截图”直接发图）。
 */
export interface SessionSendInput {
  text: string
  images?: ImageAttachment[]
}

export interface SessionSendResult {
  ok: boolean
  message?: string
}

/** 点开系统通知后要切到哪条会话 */
export interface SessionFocusTarget {
  cli: CliId
  cwd: string
  /** CLI 自己的 session id —— 侧栏行的身份 */
  id: string
  title: string
}

/**
 * 一轮跑完后主进程弹的系统通知。
 *
 * 文案在渲染层拼好再传过来：只有渲染层知道当前语言、CLI 名字和会话标题。
 */
export interface SessionNotifyPayload {
  title: string
  body: string
  target: SessionFocusTarget
}
