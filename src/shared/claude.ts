/**
 * Claude Code 官方登录状态。
 *
 * 这些信息只在主进程与设置页之间流动，不进会话事件流 —— 会话本身只关心
 * "能不能跑"，登录状态由设置页单独展示。
 */

export interface ClaudeAuthStatus {
  /** 找没找到 claude 可执行文件 */
  installed: boolean
  /** 解析到的路径（没装时是尝试过的首选路径） */
  path: string
  /** `claude --version` 原文，如 `2.1.303 (Claude Code)` */
  version?: string
  loggedIn: boolean
  /** CLI 报的登录方式，如 oauth_token / api_key / none */
  authMethod: string
  /** firstParty / bedrock / vertex … */
  apiProvider?: string
  /** 有就显示；不同 CLI 版本的字段不完全一样 */
  email?: string
  organizationName?: string
  subscriptionType?: string
  /** 探测失败时的原文（没装不算失败） */
  error?: string
  /** 探测时间，设置页显示「刚刚检测」用 */
  checkedAt: number
}

/**
 * 登录流程的阶段。
 *
 * `waiting` = 已经拿到授权 URL，等用户在浏览器里完成并粘贴授权码；
 * `verifying` = 授权码已写入 CLI，等它校验。
 */
export type ClaudeLoginPhase =
  | 'idle'
  | 'starting'
  | 'waiting'
  | 'verifying'
  | 'success'
  | 'failed'
  | 'cancelled'

/** 重开设置页时用来恢复登录流程的现场 */
export interface ClaudeLoginSnapshot {
  phase: ClaudeLoginPhase
  url: string | null
  running: boolean
  /** 最近一段 CLI 输出（已截断） */
  output: string
}

export type ClaudeAuthEvent =
  /** CLI 的原始输出（已做少量清洗，仅用于显示） */
  | { t: 'output'; text: string }
  /** 首次从输出里认出的授权 URL */
  | { t: 'url'; url: string }
  | { t: 'phase'; phase: ClaudeLoginPhase; message?: string }
  /** 重新探测后的最新状态 */
  | { t: 'status'; status: ClaudeAuthStatus }

export interface ClaudeAuthResult {
  ok: boolean
  message?: string
}
