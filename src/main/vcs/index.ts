import type {
  VcsCancelRequest,
  VcsCommitData,
  VcsCommitDetailData,
  VcsCommitDetailRequest,
  VcsCommitRequest,
  VcsDetectData,
  VcsDiffData,
  VcsDiffRequest,
  VcsDiscardRequest,
  VcsError,
  VcsLogPage,
  VcsLogRequest,
  VcsMutationData,
  VcsPathsRequest,
  VcsPullRequest,
  VcsPushRequest,
  VcsRepo,
  VcsRequestBase,
  VcsResolveRequest,
  VcsResult,
  VcsRevertRequest,
  VcsStatus,
  VcsStatusRequest,
  VcsSyncData,
  VcsUpdateRequest,
  VcsWorktreeAddRequest,
  VcsWorktreeListData,
  VcsWorktreeListRequest,
  VcsWorktreePruneData,
  VcsWorktreePruneRequest,
  VcsWorktreeRemoveRequest
} from '../../shared/vcs'
import { t } from '../i18n'
import { detectVcs, invalidateDetect } from './detect'
import { VcsOpError } from './exec'
import * as git from './git'
import { cancelOp, startOp } from './ops'
import { enqueue } from './queue'
import * as svn from './svn'

function fail(err: unknown): VcsResult<never> {
  if (err instanceof VcsOpError) {
    const error: VcsError = {
      code: err.code,
      message: err.message,
      ...(err.detail ? { detail: err.detail } : {}),
      ...(err.paths ? { paths: err.paths } : {})
    }
    return { ok: false, error }
  }
  return {
    ok: false,
    error: {
      code: 'unknown',
      message: err instanceof Error ? err.message : String(err)
    }
  }
}

async function repoOf(cwd: string): Promise<VcsRepo> {
  const d = await detectVcs(cwd)
  if (d.repo) return d.repo
  throw new VcsOpError(
    d.reason === 'no-cli' ? 'no-cli' : 'no-repo',
    d.reason === 'no-cli'
      ? t('vcsError.noCommand')
      : t('vcsError.notRepo')
  )
}

async function read<T>(fn: () => Promise<T>): Promise<VcsResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (err) {
    return fail(err)
  }
}

interface WriteOptions {
  opId?: string
  label: string
  network?: boolean
}

async function write<T>(
  cwd: string,
  opts: WriteOptions,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<VcsResult<T>> {
  let op: ReturnType<typeof startOp> | null = null
  try {
    op = startOp(opts.opId, cwd)
    const data = await enqueue(cwd, () => fn(op!.signal))
    return { ok: true, data }
  } catch (err) {
    return fail(err)
  } finally {
    op?.done()
    invalidateDetect(cwd)
  }
}

export async function detect(cwd: string): Promise<VcsResult<VcsDetectData>> {
  return read(() => detectVcs(cwd))
}

export async function status(req: VcsStatusRequest): Promise<VcsResult<VcsStatus>> {
  return read(async () => {
    const repo = await repoOf(req.cwd)
    return repo.kind === 'git' ? git.statusGit(repo, req) : svn.statusSvn(repo, req)
  })
}

export async function diff(req: VcsDiffRequest): Promise<VcsResult<VcsDiffData>> {
  return read(async () => {
    const repo = await repoOf(req.cwd)
    return repo.kind === 'git' ? git.diffGit(repo, req) : svn.diffSvn(repo, req)
  })
}

export async function log(req: VcsLogRequest): Promise<VcsResult<VcsLogPage>> {
  return read(async () => {
    const repo = await repoOf(req.cwd)
    return repo.kind === 'git' ? git.logGit(repo, req) : svn.logSvn(repo, req)
  })
}

export async function commitDetail(
  req: VcsCommitDetailRequest
): Promise<VcsResult<VcsCommitDetailData>> {
  return read(async () => {
    const repo = await repoOf(req.cwd)
    return repo.kind === 'git'
      ? git.commitDetailGit(repo, req.id)
      : svn.commitDetailSvn(repo, req.id)
  })
}

export async function stage(req: VcsPathsRequest): Promise<VcsResult<VcsMutationData>> {
  return write(req.cwd, { opId: req.opId, label: t('vcs.op.stage') }, async () => {
    const repo = await repoOf(req.cwd)
    if (repo.kind === 'git') return git.stageGit(repo, req)
    return svn.stageSvn(repo, req)
  })
}

export async function unstage(req: VcsPathsRequest): Promise<VcsResult<VcsMutationData>> {
  return write(req.cwd, { opId: req.opId, label: t('vcs.op.unstage') }, async () => {
    const repo = await repoOf(req.cwd)
    if (repo.kind !== 'git') throw new VcsOpError('unsupported', t('vcsError.svnNoStage'))
    return git.unstageGit(repo, req)
  })
}

export async function discard(req: VcsDiscardRequest): Promise<VcsResult<VcsMutationData>> {
  return write(req.cwd, { opId: req.opId, label: t('vcs.op.revert') }, async () => {
    const repo = await repoOf(req.cwd)
    if (repo.kind !== 'git') throw new VcsOpError('unsupported', t('vcsError.svnUseRevert'))
    return git.discardGit(repo, req)
  })
}

export async function revert(req: VcsRevertRequest): Promise<VcsResult<VcsMutationData>> {
  return write(req.cwd, { opId: req.opId, label: t('vcs.op.revert') }, async () => {
    const repo = await repoOf(req.cwd)
    if (repo.kind !== 'svn') throw new VcsOpError('unsupported', t('vcsError.gitUseRevert'))
    return svn.revertSvn(repo, req)
  })
}

export async function resolve(req: VcsResolveRequest): Promise<VcsResult<VcsMutationData>> {
  return write(req.cwd, { opId: req.opId, label: t('vcs.op.resolve') }, async () => {
    const repo = await repoOf(req.cwd)
    return repo.kind === 'git' ? git.resolveGit(repo, req) : svn.resolveSvn(repo, req)
  })
}

export async function commit(req: VcsCommitRequest): Promise<VcsResult<VcsCommitData>> {
  return write(req.cwd, { opId: req.opId, label: t('vcs.op.commit') }, async () => {
    const repo = await repoOf(req.cwd)
    return repo.kind === 'git' ? git.commitGit(repo, req) : svn.commitSvn(repo, req)
  })
}

export async function fetch(req: VcsRequestBase): Promise<VcsResult<VcsSyncData>> {
  return write(req.cwd, { opId: req.opId, label: t('vcs.op.fetch'), network: true }, async (signal) => {
    const repo = await repoOf(req.cwd)
    if (repo.kind !== 'git') throw new VcsOpError('unsupported', t('vcsError.svnUseUpdate'))
    return git.fetchGit(repo, signal)
  })
}

export async function pull(req: VcsPullRequest): Promise<VcsResult<VcsSyncData>> {
  return write(req.cwd, { opId: req.opId, label: t('vcs.op.pull'), network: true }, async (signal) => {
    const repo = await repoOf(req.cwd)
    if (repo.kind !== 'git') throw new VcsOpError('unsupported', t('vcsError.svnUseUpdate'))
    return git.pullGit(repo, req, signal)
  })
}

export async function push(req: VcsPushRequest): Promise<VcsResult<VcsSyncData>> {
  return write(req.cwd, { opId: req.opId, label: t('vcs.op.push'), network: true }, async (signal) => {
    const repo = await repoOf(req.cwd)
    if (repo.kind !== 'git') throw new VcsOpError('unsupported', t('vcsError.svnNoPush'))
    return git.pushGit(repo, req, signal)
  })
}

export async function update(req: VcsUpdateRequest): Promise<VcsResult<VcsSyncData>> {
  return write(req.cwd, { opId: req.opId, label: t('vcs.op.update'), network: true }, async (signal) => {
    const repo = await repoOf(req.cwd)
    if (repo.kind !== 'svn') throw new VcsOpError('unsupported', t('vcsError.gitUsePull'))
    return svn.updateSvn(repo, req, signal)
  })
}

/* ── Worktree（Git only） ──────────────────────────────── */

export async function worktreeList(
  req: VcsWorktreeListRequest
): Promise<VcsResult<VcsWorktreeListData>> {
  return read(async () => {
    const repo = await repoOf(req.cwd)
    if (repo.kind !== 'git') throw new VcsOpError('unsupported', t('vcsError.svnNoWorktree'))
    return git.worktreeListGit(repo, req)
  })
}

export async function worktreeAdd(
  req: VcsWorktreeAddRequest
): Promise<VcsResult<VcsWorktreeListData>> {
  return write(req.cwd, { opId: req.opId, label: t('vcs.op.createWorktree') }, async (signal) => {
    const repo = await repoOf(req.cwd)
    if (repo.kind !== 'git') throw new VcsOpError('unsupported', t('vcsError.svnNoWorktree'))
    return git.worktreeAddGit(repo, req, signal)
  })
}

export async function worktreeRemove(
  req: VcsWorktreeRemoveRequest
): Promise<VcsResult<VcsWorktreeListData>> {
  return write(req.cwd, { opId: req.opId, label: t('vcs.op.removeWorktree') }, async (signal) => {
    const repo = await repoOf(req.cwd)
    if (repo.kind !== 'git') throw new VcsOpError('unsupported', t('vcsError.svnNoWorktree'))
    return git.worktreeRemoveGit(repo, req, signal)
  })
}

export async function worktreePrune(
  req: VcsWorktreePruneRequest
): Promise<VcsResult<VcsWorktreePruneData>> {
  return write(req.cwd, { opId: req.opId, label: t('vcs.op.pruneWorktrees') }, async (signal) => {
    const repo = await repoOf(req.cwd)
    if (repo.kind !== 'git') throw new VcsOpError('unsupported', t('vcsError.svnNoWorktree'))
    return git.worktreePruneGit(repo, req, signal)
  })
}

export async function cancel(
  req: VcsCancelRequest
): Promise<VcsResult<{ cancelled: boolean }>> {
  return { ok: true, data: { cancelled: cancelOp(req.opId) } }
}
