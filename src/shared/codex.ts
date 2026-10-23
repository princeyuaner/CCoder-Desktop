/**
 * Codex CLI 的运行时状态。
 *
 * 设置页需要区分三种"能不能用"：
 *   1. 根本没装 CLI           → 给安装引导
 *   2. 装了但 app-server 起不来 → 版本太旧 / 配置坏了
 *   3. app-server 正常但没登录 → 用渠道 API Key，或在终端 `codex login`
 *
 * 这些信息只放在主进程与设置页之间，不进入会话事件流。
 */

export type CodexAccountKind = 'chatgpt' | 'apiKey' | 'amazonBedrock' | 'unknown'

export interface CodexAccountInfo {
  kind: CodexAccountKind
  /** ChatGPT 账号才有 */
  email?: string
  /** ChatGPT 套餐（plus / pro / team …） */
  plan?: string
  /** 该账号是否还需要 OpenAI 登录 */
  requiresOpenaiAuth?: boolean
}

export interface CodexPermissionProfile {
  id: string
  description: string | null
  allowed: boolean
}

export interface CodexStatus {
  installed: boolean
  /** 解析到的可执行文件路径（没装时是尝试过的首选路径） */
  path: string
  /** `codex --version` 的原文，如 `codex-cli 0.163.0` */
  version: string
  /** app-server 能完成 initialize 握手 */
  appServerOk: boolean
  /** app-server 握手失败时的真实错误 */
  error?: string
  account: CodexAccountInfo | null
  /** Codex 自带的权限档（:read-only / :workspace / :danger-full-access …） */
  permissionProfiles: CodexPermissionProfile[]
  /** 探测耗时，设置页显示「刚刚检测」用 */
  checkedAt: number
}
