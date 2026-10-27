/**
 * CLI 自身的更新状态（和 CCoder 应用本身的自动更新是两件事）。
 *
 * 设置页要回答三个问题：
 *   1. 现在装的是哪个版本？
 *   2. npm 上有没有更新的版本？
 *   3. 能不能替用户把 `npm install -g` 跑掉？
 *
 * 第三条只在「确认是 npm 全局安装」时才为真 —— 官方安装包、brew、自定义路径
 * 装的 CLI 一律降级成「复制命令」，不去碰用户的安装。
 */
import type { CliId } from './settings'

export type CliUpdatePhase =
  /** 还没检查过（或 CLI 没装） */
  | 'unknown'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'updating'
  /** 更新成功，版本已重新探测 */
  | 'done'
  | 'error'

/**
 * 安装方式。
 *
 * - npm-global：可执行文件落在 npm 全局 prefix 下，且对应的包就在那个
 *   `node_modules` 里 —— 这是我们唯一敢自动更新的情况；
 * - other：装了，但不在 npm 全局目录（官方安装包 / brew / 自定义路径）；
 * - missing：没找到可执行文件。
 */
export type CliInstallKind = 'npm-global' | 'other' | 'missing'

export interface CliUpdateState {
  cli: CliId
  phase: CliUpdatePhase
  /** npm 包名，如 `@anthropic-ai/claude-code` */
  packageName: string
  /** 更新说明页；没有就不显示「更新说明」 */
  notesUrl?: string

  installed: boolean
  /** CLI 可执行文件 / bin.js 的绝对路径 */
  path?: string
  /** 从 `--version` 里抓出来的版本号（x.y.z） */
  current?: string
  /** `--version` 的原样输出，解析失败时给用户看 */
  currentRaw?: string
  /** registry 上的最新版本 */
  latest?: string
  /** 最新版的发布时间（毫秒时间戳） */
  publishedAt?: number

  installKind: CliInstallKind
  /** 有新版、且能用 npm 自动更新 */
  canUpdate: boolean
  /** 要执行的命令（不含 npm 的绝对路径），如 `npm install -g pkg@1.2.3` */
  command?: string

  /** 更新过程中最后一行有效输出 */
  line?: string
  /** 更新开始的毫秒时间戳，界面用来算已用时间 */
  startedAt?: number
  /** 走的是管理员提权：输出在另一个窗口里，我们只等版本变化 */
  elevated?: boolean

  error?: string
  /** 出错发生在检查还是更新阶段 —— 检查失败不该报红 */
  errorScope?: 'check' | 'update'
  /** npm 报权限不足 —— 界面给「以管理员身份重试」 */
  needAdmin?: boolean

  checkedAt?: number
  /** 网络失败时用了上一轮缓存的结果 */
  fromCache?: boolean
}

/** 主进程 → 渲染进程：单个 CLI 的状态变化 */
export type CliUpdateEvent = { t: 'state'; state: CliUpdateState }

export interface CliUpdateRunResult {
  ok: boolean
  message?: string
}

export type CliUpdateStates = Record<CliId, CliUpdateState>
