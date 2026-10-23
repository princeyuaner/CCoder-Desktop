/**
 * 自动更新状态。主进程是唯一状态源，渲染进程只订阅。
 *
 * 更新分两步，都由用户手动触发：
 * 1. 后端检查到新版本 → 右下角提示，用户点「下载」；
 * 2. 下载完成 → 提示「重启并安装」。
 * 不会在后台悄悄下载或退出安装。
 */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error'
  | 'unsupported'

export interface UpdateState {
  phase: UpdatePhase
  /** 当前安装的版本，来自 package.json */
  currentVersion: string
  /** 新版本号，仅 available / downloading / downloaded / up-to-date 时有值 */
  version?: string
  /** Release 标题，作为提醒里的补充信息 */
  releaseName?: string
  /** 下载进度 0–100 */
  percent?: number
  error?: string
  /**
   * 出错发生在哪一步。自动检查失败（例如断网）不该弹提示，
   * 只有下载失败需要让用户知道。
   */
  errorScope?: 'check' | 'download'
  /** 不支持自动更新的原因：开发模式 / 便携版 */
  reason?: 'dev' | 'portable'
}

export interface UpdateInstallResult {
  ok: boolean
  message?: string
}
