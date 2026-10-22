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
export type VcsChange = 'M' | 'A' | 'D' | 'R' | 'C' | '?' | '!' | 'I' | 'X' | '~' | 'U'

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
  cancel(req: VcsCancelRequest): Promise<VcsResult<{ cancelled: boolean }>>
}
