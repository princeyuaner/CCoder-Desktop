/**
 * 版本控制（Git / SVN）的跨进程数据形状。
 *
 * UI 只认这里定义的结构，不认 git / svn 的原始输出。路径约定：
 *  - `root` 是仓库 / 工作副本的绝对路径；
 *  - `workspacePrefix` 是当前工作区相对 root 的 POSIX 路径，root === 工作区时为空；
 *  - 所有 `rel` 都是**相对当前工作区**的 POSIX 路径。
 */

export type VcsKind = 'git' | 'svn'

/** 文件状态字母。C = SVN 冲突；Git 的 copied 也会是 C，但 conflict 字段区分。 */
export type VcsChange = 'M' | 'A' | 'D' | 'R' | 'C' | '?' | '!' | 'I' | '~' | 'U'

export interface VcsCapabilities {
  stage: boolean
  unstage: boolean
  discard: boolean
  revert: boolean
  resolve: boolean
  fetch: boolean
  pull: boolean
  push: boolean
  update: boolean
  amend: boolean
  log: boolean
  commitDetail: boolean
  branches: boolean
  /** Git worktree 管理（SVN 为 false） */
  worktrees: boolean
}

export interface VcsRepo {
  kind: VcsKind
  /** 仓库 / 工作副本根目录，绝对路径 */
  root: string
  /** 当前工作区相对 root 的 POSIX 路径；root === 工作区时为空串 */
  workspacePrefix: string
  /** Git 分支名；SVN 为相对仓库根的 URL 路径（如 /trunk） */
  branch: string
  /** Git commit hash；SVN 为 r<revision> */
  head: string
  headShort: string
  ahead: number
  behind: number
  detached: boolean
  upstream?: string
  remote?: string
  /** SVN：工作副本 URL */
  url?: string
  /** SVN：仓库根 URL */
  repositoryRoot?: string
  /** SVN：当前 revision */
  revision?: number
  capabilities: VcsCapabilities
}

export interface VcsConflict {
  kind: 'text' | 'binary' | 'tree' | 'property'
}

export interface VcsFile {
  rel: string
  oldRel?: string
  name: string
  dir: string
  status: VcsChange
  /** Git index 里有改动 */
  staged: boolean
  /** 工作区里有改动；SVN 的本地修改也在这一侧 */
  unstaged: boolean
  untracked: boolean
  conflict: boolean
  /** SVN 锁定者 */
  lock?: string
  /** SVN changelist */
  changelist?: string
  /** SVN 最后修改的 revision */
  revision?: string
  /** SVN 只有属性变化 */
  propertyChange?: boolean
  /** SVN 外链：这个改动属于某个 svn:externals 工作副本 */
  external?: boolean
  /** SVN 外链工作副本根（相对当前工作区）；提交时按它分组、各自提交 */
  externalRoot?: string
}

export interface VcsCounts {
  total: number
  staged: number
  unstaged: number
  untracked: number
  conflicts: number
}

export interface VcsStatus {
  repo: VcsRepo
  files: VcsFile[]
  counts: VcsCounts
  clean: boolean
}

export type VcsDiffSource = 'working' | 'staged' | 'head' | 'revision'

export interface VcsDiffData {
  repoKind: VcsKind
  rel: string
  oldRel?: string
  source: VcsDiffSource
  diff: string
  binary: boolean
  untracked: boolean
  truncated: boolean
  added: number
  removed: number
  revision?: string
  /** SVN 属性变更，diff 里没有 hunk */
  propertyChange?: boolean
}

export interface VcsLogEntry {
  /** Git hash；SVN revision 字符串 */
  id: string
  shortId: string
  revision?: number
  author: string
  email?: string
  /** ISO-8601 */
  date: string
  subject: string
  message: string
  parents?: string[]
  refs?: string[]
}

export interface VcsLogPage {
  entries: VcsLogEntry[]
  nextCursor?: string
}

export interface VcsCommitFile {
  rel: string
  oldRel?: string
  status: VcsChange
  additions?: number
  deletions?: number
  binary?: boolean
}

export interface VcsCommitDetailData {
  entry: VcsLogEntry
  files: VcsCommitFile[]
  diff: string
  truncated: boolean
}

export interface VcsMutationData {
  affected: number
  paths: string[]
  conflicts?: string[]
}

export interface VcsCommitData {
  id: string
  shortId: string
  revision?: number
  /** SVN 一次提交可能跨多个工作副本（外链），每个副本一个 revision */
  revisions?: number[]
  summary: string
  files: number
}

export interface VcsSyncData {
  summary: string
  conflicts?: string[]
  ahead?: number
  behind?: number
  revision?: number
  commit?: string
  remote?: string
  branch?: string
}

export interface VcsDetectData {
  repo: VcsRepo | null
  available: { git: boolean; svn: boolean }
  reason?: 'no-repo' | 'no-cli'
}

/* ── Worktree（Git only） ──────────────────────────────── */

export interface VcsWorktree {
  /** 工作树目录的绝对路径 */
  path: string
  head: string
  headShort: string
  /** 分支短名；detached / bare 时为 null */
  branch: string | null
  detached: boolean
  bare: boolean
  /** `git worktree list` 的第一条 —— 主工作树 */
  main: boolean
  /** 当前 cwd 是否位于这个工作树内 */
  current: boolean
  /** 目录实际存在；false 表示只能在外部清理或用 prune 移除注册 */
  exists: boolean
  locked: boolean
  lockReason?: string
  /** 缺失且未锁定，可以用 prune 清掉注册 */
  prunable: boolean
}

export interface VcsWorktreeListData {
  worktrees: VcsWorktree[]
  /** 主工作树同级的默认根目录，创建新工作树时用 */
  defaultRoot: string
  /** 主工作树路径 */
  mainPath: string
}

/* ── 请求 ─────────────────────────────────────────────── */

export interface VcsRequestBase {
  cwd: string
  /** 写 / 网络操作由渲染层生成，用于取消 */
  opId?: string
}

export interface VcsStatusRequest extends VcsRequestBase {
  includeIgnored?: boolean
}

export interface VcsDiffRequest extends VcsRequestBase {
  rel: string
  source: VcsDiffSource
  /** source === 'revision' 时必填 */
  revision?: string
}

export interface VcsLogRequest extends VcsRequestBase {
  limit?: number
  cursor?: string
  rel?: string
}

export interface VcsCommitDetailRequest extends VcsRequestBase {
  id: string
}

export interface VcsPathsRequest extends VcsRequestBase {
  paths: string[]
}

export interface VcsDiscardRequest extends VcsPathsRequest {
  includeUntracked?: boolean
}

export type VcsRevertRequest = VcsPathsRequest

export interface VcsResolveRequest extends VcsPathsRequest {
  side: 'ours' | 'theirs' | 'working'
}

export interface VcsCommitRequest extends VcsRequestBase {
  message: string
  /** SVN 必填：要提交的路径。Git 可选，仅用于展示。 */
  paths?: string[]
  /** Git only */
  amend?: boolean
}

export interface VcsPullRequest extends VcsRequestBase {
  strategy?: 'ff-only'
}

export interface VcsPushRequest extends VcsRequestBase {
  setUpstream?: boolean
}

export interface VcsUpdateRequest extends VcsRequestBase {
  revision?: string
}

export type VcsWorktreeListRequest = VcsRequestBase

export interface VcsWorktreeAddRequest extends VcsRequestBase {
  /** 新工作树的绝对路径 */
  path: string
  branch: string
  /** 起点；缺省用当前工作区的分支 / HEAD */
  base?: string
  /** MVP 固定为 true；false 预留给将来检出已有分支 */
  createBranch?: boolean
}

export interface VcsWorktreeRemoveRequest extends VcsRequestBase {
  path: string
  /** 有未提交改动时需要显式强制 */
  force?: boolean
}

export type VcsWorktreePruneRequest = VcsRequestBase

export interface VcsWorktreePruneData extends VcsWorktreeListData {
  pruned: number
  prunedPaths: string[]
}

export interface VcsCancelRequest {
  cwd: string
  opId: string
}

/* ── 结果 ─────────────────────────────────────────────── */

export type VcsErrorCode =
  | 'no-repo'
  | 'no-cli'
  | 'unsupported'
  | 'forbidden'
  | 'invalid-path'
  | 'locked'
  | 'conflict'
  | 'needs-update'
  | 'auth-required'
  | 'not-fast-forward'
  | 'dirty'
  | 'branch-in-use'
  | 'timeout'
  | 'cancelled'
  | 'busy'
  | 'output-too-large'
  | 'unknown'

export interface VcsError {
  code: VcsErrorCode
  message: string
  detail?: string
  paths?: string[]
}

export type VcsResult<T> = { ok: true; data: T } | { ok: false; error: VcsError }

export interface VcsApi {
  detect(cwd: string): Promise<VcsResult<VcsDetectData>>
  status(req: VcsStatusRequest): Promise<VcsResult<VcsStatus>>
  diff(req: VcsDiffRequest): Promise<VcsResult<VcsDiffData>>
  log(req: VcsLogRequest): Promise<VcsResult<VcsLogPage>>
  commitDetail(req: VcsCommitDetailRequest): Promise<VcsResult<VcsCommitDetailData>>
  stage(req: VcsPathsRequest): Promise<VcsResult<VcsMutationData>>
  unstage(req: VcsPathsRequest): Promise<VcsResult<VcsMutationData>>
  discard(req: VcsDiscardRequest): Promise<VcsResult<VcsMutationData>>
  revert(req: VcsRevertRequest): Promise<VcsResult<VcsMutationData>>
  resolve(req: VcsResolveRequest): Promise<VcsResult<VcsMutationData>>
  commit(req: VcsCommitRequest): Promise<VcsResult<VcsCommitData>>
  fetch(req: VcsRequestBase): Promise<VcsResult<VcsSyncData>>
  pull(req: VcsPullRequest): Promise<VcsResult<VcsSyncData>>
  push(req: VcsPushRequest): Promise<VcsResult<VcsSyncData>>
  update(req: VcsUpdateRequest): Promise<VcsResult<VcsSyncData>>
  worktreeList(req: VcsWorktreeListRequest): Promise<VcsResult<VcsWorktreeListData>>
  worktreeAdd(req: VcsWorktreeAddRequest): Promise<VcsResult<VcsWorktreeListData>>
  worktreeRemove(req: VcsWorktreeRemoveRequest): Promise<VcsResult<VcsWorktreeListData>>
  worktreePrune(req: VcsWorktreePruneRequest): Promise<VcsResult<VcsWorktreePruneData>>
  cancel(req: VcsCancelRequest): Promise<VcsResult<{ cancelled: boolean }>>
}
