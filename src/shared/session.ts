import type { AgentEvent, PermissionMode } from './events'
import type { CliId, EffortLevel } from './settings'
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
   * 拿 claude 去 --resume 一条 codex 的会话是找不到的。
   * 现在只接了 claude 一家，所以这个字段恒为 'claude'；
   * Codex 的存储接进来之后，它就是从扫描结果里带出来的真值。
   */
  cli: CliId
}

/** 对一条审批请求的答复 */
export interface PermissionDecision {
  behavior: 'allow' | 'deny'
  /** deny 时给模型的原因，会显示在它的下一步里 */
  message?: string
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
