/**
 * 目录同步（单向镜像）的跨进程数据形状。
 *
 * 一个工作区一份配置：源目录默认是当前工作区，目标目录由用户选。
 * 主进程负责扫描 / 对账 / 复制 / 删除，渲染层只拿快照和日志。
 *
 * 路径约定：
 *  - `src` / `dst` 是绝对路径，保留用户选择时的分隔符；
 *  - 配置里的 `syncRoots` / `exclude` 与快照里的 `rel` 都是相对源目录的
 *    POSIX 路径（`/` 分隔），比较时大小写不敏感（Windows 语义）。
 */

export type SyncRun = 'disabled' | 'stopped' | 'occupied' | 'running' | 'failed'

/**
 * 配置没配全 / 目录不可用。`disabled` 不是 problem —— 那是 `run`。
 */
export type SyncProblem =
  | 'noSrc'
  | 'noDst'
  | 'srcMissing'
  | 'dstMissing'
  | 'sameDir'
  | 'nested'

export interface SyncConfig {
  /** 总开关。关闭时立即停止监听；已经同步到目标端的文件不会回滚。 */
  enabled: boolean
  /** 本地源目录（绝对路径）。 */
  src: string
  /** 目标目录（绝对路径，本地盘或已映射的网络盘）。 */
  dst: string
  /** 只同步这些顶层子目录（相对源目录）。空 = 整个源目录。 */
  syncRoots: string[]
  /** 用户排除项。含 `/` 按相对路径匹配；不含 `/` 按任意一层名字匹配。 */
  exclude: string[]
  /** 静默期（毫秒）：最后一次文件事件之后安静这么久才开始一轮。 */
  settleMs: number
  /** 巡检周期（毫秒）：距上次完整轮的硬期限。0 = 关闭兜底。 */
  sweepMs: number
  /** 本地删了、目标端也删（镜像删除，只删没被别处改过的那份）。 */
  deleteMissing: boolean
}

export const SYNC_DEFAULTS = {
  settleMs: 1_500,
  sweepMs: 60_000,
  minSettleMs: 100,
  maxSettleMs: 20_000
} as const

/** 快照里最多带多少条「本次改动」与失败 / 提醒项。 */
export const SYNC_CHANGE_LIMIT = 20
export const SYNC_FAILED_LIMIT = 20
export const SYNC_KEPT_LIMIT = 20

/** 日志环形缓冲保留多少行；界面只展示最后 60 行。 */
export const SYNC_LOG_LIMIT = 60

/** 气泡最多列几条路径（与主进程裁剪的 copiedNames / deletedNames 一致）。 */
export const SYNC_BUBBLE_ROWS = 3

export type SyncChangeKind = 'copy' | 'delete' | 'failed' | 'kept'

export interface SyncChange {
  rel: string
  kind: SyncChangeKind
  /** failed 的原因；kept 时为 null。 */
  reason?: string
  /** kept 的原因。 */
  why?: SyncKeptWhy
}

export type SyncKeptWhy = 'targetModified' | 'autoDeleteOff' | 'sourceIncomplete'

export interface SyncFailedItem {
  rel: string
  reason: string
}

export interface SyncKeptItem {
  rel: string
  why: SyncKeptWhy
}

/** 一份自洽的状态快照 —— 界面不会看到「计数新、时刻旧」的半新半旧。 */
export interface SyncSnapshot {
  run: SyncRun
  /** 配置没配全 / 目录不可用时说明原因；运行中为 null。 */
  problem: SyncProblem | null
  /** `run === 'occupied'` 时是另一个窗口的工作区名。 */
  occupiedBy: string | null
  /** 正在跑一轮（首次全量核对可能很久）。 */
  busy: boolean

  lastRoundAtMs: number | null
  lastCostMs: number | null

  copied: number
  deleted: number
  pruned: number
  unchanged: number
  failed: number
  plannedCopies: number
  plannedDeletes: number

  /** 首次运行 / 基线丢失：这一轮是全量核对。 */
  firstRun: boolean
  /** 扫描到的源目录数（用于「已监听 N 个目录」）。 */
  watchedDirs: number
  /** 这次启动以来收到过多少次文件系统提示。 */
  hints: number

  /** 目标端不可访问之类的整轮错误；有失败项时为 null。 */
  error: string | null

  /** 气泡用：真的复制 / 删除成功的路径（各最多 3 条）。 */
  copiedNames: string[]
  deletedNames: string[]
  /** 左栏「本次同步」用：有界的一批改动。 */
  changes: SyncChange[]
  failedItems: SyncFailedItem[]
  keptItems: SyncKeptItem[]
  /** 最近 60 行日志。 */
  log: string[]
}

export interface SyncWorkspaceState {
  cwd: string
  config: SyncConfig
  snapshot: SyncSnapshot
}

/** 主进程 → IDE 渲染进程：一份新快照。 */
export interface SyncStatusPush {
  cwd: string
  snapshot: SyncSnapshot
}

/** 主进程 → IDE 渲染进程：收到系统通知点击后，切到同步视图并打开日志。 */
export interface SyncFocusPayload {
  cwd: string
  openLog: boolean
}

export interface SyncActionResult {
  ok: boolean
  message?: string
}

export interface SyncApi {
  get(cwd: string): Promise<SyncWorkspaceState>
  save(cwd: string, config: SyncConfig): Promise<SyncWorkspaceState>
  /** 弹系统目录选择器。取消返回 null。 */
  pickDir(cwd: string, which: 'src' | 'dst'): Promise<string | null>
  /** 立刻跑一轮完整核对（不等静默期 / 退避）。 */
  syncNow(cwd: string): Promise<SyncActionResult>
  /** 在系统文件管理器里打开目标目录。 */
  openTarget(cwd: string): Promise<SyncActionResult>
  onStatus(cb: (payload: SyncStatusPush) => void): () => void
  onFocus(cb: (payload: SyncFocusPayload) => void): () => void
}

/**
 * 内置噪音规则：四组语义各不相同。
 *
 * - `dirNames` 判祖先目录名（扫描时据此剪枝）
 * - `fileNames` / `suffixes` / `prefixes` 判叶子名
 *
 * 与 CCoder 版保持同一张表；第一版不开放给用户编辑。
 */
export const SYNC_JUNK = {
  dirNames: [
    '__pycache__', '.svn', '.git', '.hg', '.idea', '.vscode', '.vs',
    'node_modules', '.pytest_cache', '.mypy_cache', '.ruff_cache',
    'logs', 'logbak', 'battlevideo', '.venv', 'venv',
    '.gradle', 'build', 'out', 'target', 'dist'
  ],
  fileNames: [
    'thumbs.db', 'desktop.ini', 'tcpserver.txt',
    'watch.log', 'watch.pid', 'watch.log.1'
  ],
  suffixes: [
    '.pyc', '.pyo', '.pyd', '.log', '.tmp', '.temp', '.swp', '.swo',
    '.bak', '.orig', '.rej', '.ds_store'
  ],
  prefixes: ['dblog', 'gatelog', 'gslog', 'proxylog', 'autobattletestlog']
} as const

export function defaultSyncConfig(src: string): SyncConfig {
  return {
    enabled: false,
    src,
    dst: '',
    syncRoots: [],
    exclude: [],
    settleMs: SYNC_DEFAULTS.settleMs,
    sweepMs: SYNC_DEFAULTS.sweepMs,
    deleteMissing: true
  }
}
