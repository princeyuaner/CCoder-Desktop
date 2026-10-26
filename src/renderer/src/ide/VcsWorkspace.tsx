import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  VcsCommitDetailData,
  VcsDetectData,
  VcsDiffData,
  VcsDiffSource,
  VcsError,
  VcsFile,
  VcsLogEntry,
  VcsRepo,
  VcsResult,
  VcsStatus,
  VcsWorktree,
  VcsWorktreeListData
} from '@shared/vcs'
import { worktreeSlug } from '@shared/vcs'
import { VcsDiffView } from './VcsDiffView'
import { formatRelativeTime } from '@shared/i18n'
import { getLocale, tr, useI18n } from '../i18n'

const P = {
  branch: 'M4 4.9v6.2M12 6.5c0 2.8-2.6 3.1-4.5 3.6',
  refresh: 'M13 8a5 5 0 1 1-1.6-3.7M13 2.5V5h-2.5',
  down: 'M8 3v9M4.5 8.5L8 12l3.5-3.5',
  up: 'M8 13V4M4.5 7.5L8 4l3.5 3.5',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  file: 'M4 1.8h5l3 3v9.4H4zM9 1.8v3h3',
  diff: 'M4 3v10M4 13l-2-2M4 13l2-2M9 4h4M9 8h4M9 12h2',
  check: 'M3 8.5l3 3L13 4.5',
  warning: 'M8 2l6 11H2zM8 6v3M8 11.5h.01',
  lock: 'M5 7V5a3 3 0 0 1 6 0v2M4 7h8v6H4z',
  plus: 'M8 3v10M3 8h10',
  undo: 'M6 5L3 8l3 3M3 8h6a4 4 0 0 1 0 8H7',
  external: 'M9 3h4v4M13 3L7 9M6 4H3v9h9v-3',
  close: 'M4 4l8 8M12 4l-8 8'
} as const

function Ico({ d, size = 13 }: { d: string; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="ide-ico" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

function makeOpId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function errorOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function when(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  return formatRelativeTime(t, getLocale(), 'ago')
}

function statusLabel(f: VcsFile): string {
  if (f.conflict) return tr('vcs.status.conflict')
  if (f.untracked) return tr('vcs.status.untracked')
  if (f.propertyChange) return tr('vcs.status.property')
  return f.status
}

function baseName(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i >= 0 ? rel.slice(i + 1) : rel
}

/** 两个路径是不是同一个目录（只做字符串归一，不碰 fs） */
function samePath(a: string, b: string): boolean {
  const n = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return n(a) === n(b)
}

/** 绝对路径的粗略判断；最终由主进程拍板 */
function looksAbsolute(p: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(p.trim())
}

/** 分支名 → 目录名。Windows 非法字符、空白、保留名都处理掉 */
function joinPath(root: string, name: string): string {
  const sep = root.includes('\\') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${sep}${name}`
}

interface Props {
  cwd: string
  detect: VcsDetectData | null
  status: VcsStatus | null
  loading: boolean
  error: string | null
  onRefresh: () => void
  onMutated: (filesChanged: boolean) => void
  onNotice: (message: string) => void
  onOpenFile: (rel: string) => void
}

type Tab = 'changes' | 'history' | 'repo' | 'worktrees'
type Active = { rel: string; source: VcsDiffSource }
type Group = {
  key: string
  title: string
  files: VcsFile[]
  source: VcsDiffSource
  /** 组标题右侧的短说明（目前只有外链用） */
  note?: string
}

interface OpState {
  id: string
  label: string
  network: boolean
}

export function VcsWorkspace({
  cwd,
  detect,
  status,
  loading,
  error,
  onRefresh,
  onMutated,
  onNotice,
  onOpenFile
}: Props): JSX.Element {
  const { t, tn } = useI18n()
  const [tab, setTab] = useState<Tab>('changes')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [active, setActive] = useState<Active | null>(null)
  const [diff, setDiff] = useState<VcsDiffData | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [amend, setAmend] = useState(false)
  const [op, setOp] = useState<OpState | null>(null)
  const [opError, setOpError] = useState<VcsError | null>(null)
  const [confirm, setConfirm] = useState<{
    title: string
    body: string
    label: string
    action: () => Promise<void>
  } | null>(null)

  const [log, setLog] = useState<VcsLogEntry[]>([])
  const [logCursor, setLogCursor] = useState<string | undefined>()
  const [logLoading, setLogLoading] = useState(false)
  const [logError, setLogError] = useState<string | null>(null)
  const [commitId, setCommitId] = useState<string | null>(null)
  const [detail, setDetail] = useState<VcsCommitDetailData | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  /* ── 工作树 ─────────────────────────────────────────── */
  const [trees, setTrees] = useState<VcsWorktreeListData | null>(null)
  const [treesLoading, setTreesLoading] = useState(false)
  const [treesError, setTreesError] = useState<string | null>(null)
  const [treeSel, setTreeSel] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({ branch: '', path: '', base: '' })
  /** 用户手动改过位置后，不再跟着分支名自动重算 */
  const [pathEdited, setPathEdited] = useState(false)

  const diffSeq = useRef(0)
  const logSeq = useRef(0)
  const detailSeq = useRef(0)
  const treeSeq = useRef(0)
  /** SVN 第一次拿到状态时自动全选；用户手动「全不选」后不再覆盖 */
  const selectionInit = useRef(false)
  const repo = status?.repo ?? detect?.repo ?? null
  const isGit = repo?.kind === 'git'

  const selectedTree: VcsWorktree | null =
    trees?.worktrees.find((w) => w.path === treeSel) ?? null
  const prunableCount = trees?.worktrees.filter((w) => w.prunable).length ?? 0

  const groups = useMemo<Group[]>(() => {
    if (!status) return []
    const fs = status.files
    if (status.repo.kind === 'git') {
      return [
        {
          key: 'staged',
          title: t('vcs.group.staged'),
          source: 'staged' as VcsDiffSource,
          files: fs.filter((f) => f.staged && !f.conflict)
        },
        {
          key: 'changes',
          title: t('vcs.group.changes'),
          source: 'working' as VcsDiffSource,
          files: fs.filter((f) => f.unstaged && !f.untracked && !f.conflict)
        },
        {
          key: 'untracked',
          title: t('vcs.group.untracked'),
          source: 'working' as VcsDiffSource,
          files: fs.filter((f) => f.untracked && !f.conflict)
        },
        {
          key: 'conflicts',
          title: t('vcs.group.conflicts'),
          source: 'working' as VcsDiffSource,
          files: fs.filter((f) => f.conflict)
        }
      ].filter((g) => g.files.length > 0)
    }
    // 外链是独立的工作副本：单独成组，提交时会分别写进它们自己的仓库
    const externalRoots = [
      ...new Set(fs.filter((f) => f.external && !f.conflict).map((f) => f.externalRoot || ''))
    ]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

    return [
      {
        key: 'changes',
        title: t('vcs.group.commit'),
        source: 'working' as VcsDiffSource,
        files: fs.filter((f) => !f.external && !f.untracked && !f.conflict)
      },
      {
        key: 'untracked',
        title: t('vcs.group.notVersioned'),
        source: 'working' as VcsDiffSource,
        files: fs.filter((f) => !f.external && f.untracked && !f.conflict)
      },
      ...externalRoots.map((root) => ({
        key: `external:${root}`,
        title: t('vcs.group.external', { name: baseName(root) }),
        note: t('vcs.group.externalNote'),
        source: 'working' as VcsDiffSource,
        files: fs.filter((f) => f.external && (f.externalRoot || '') === root && !f.conflict)
      })),
      {
        key: 'conflicts',
        title: t('vcs.group.conflicts'),
        source: 'working' as VcsDiffSource,
        files: fs.filter((f) => f.conflict)
      }
    ].filter((g) => g.files.length > 0)
  }, [status, t])

  const activeFile = status?.files.find((f) => f.rel === active?.rel) ?? null
  const stagedCount = status?.files.filter((f) => f.staged && !f.conflict).length ?? 0
  const conflictCount = status?.counts.conflicts ?? 0
  const selectedCount = selected.size
  // 缺失 / obstructed 的文件不能直接提交，先让用户还原或在外侧处理
  const selectable = useMemo(
    () =>
      status?.files.filter(
        (f) => !f.untracked && !f.conflict && f.status !== '!' && f.status !== '~'
      ) ?? [],
    [status]
  )
  const commitCount = isGit ? stagedCount : selectedCount
  /** 选中的外链文件数：它们会提交到各自的工作副本，产生单独的 revision */
  const externalSelected =
    status?.files.filter((f) => f.external && selected.has(f.rel)).length ?? 0
  const canCommit =
    !!status &&
    !op &&
    conflictCount === 0 &&
    commitCount > 0 &&
    message.trim().length > 0

  /* 状态变化后清掉已不存在的选中项；SVN 默认勾选所有待提交文件 */
  useEffect(() => {
    if (!status) return
    const valid = new Set(status.files.map((f) => f.rel))
    const allowed = new Set(selectable.map((f) => f.rel))
    setSelected((prev) => {
      const next = new Set(
        [...prev].filter(
          (r) => valid.has(r) && (status.repo.kind === 'git' || allowed.has(r))
        )
      )
      if (!selectionInit.current && status.repo.kind === 'svn' && selectable.length > 0) {
        for (const f of selectable) {
          // 外链属于别的仓库：默认不勾选，避免顺手把外链也提交出去
          if (!f.external) next.add(f.rel)
        }
        selectionInit.current = true
      }
      return next
    })
    setActive((prev) => {
      const keep = prev ? status.files.find((f) => f.rel === prev.rel) : null
      if (prev && keep) {
        // 文件从「更改」被暂存、或从暂存区被取消后，当前显示的 diff 来源要跟着换，
        // 否则会停在一个已经没有内容的 working diff 上。
        const nextSource: VcsDiffSource =
          prev.source === 'staged' && !keep.staged
            ? keep.unstaged
              ? 'working'
              : prev.source
            : prev.source === 'working' && !keep.unstaged && keep.staged
              ? 'staged'
              : prev.source
        return nextSource === prev.source ? prev : { rel: prev.rel, source: nextSource }
      }
      const first =
        status.files.find((f) => f.conflict) ??
        status.files.find((f) => f.unstaged && !f.untracked) ??
        status.files.find((f) => f.staged) ??
        status.files[0]
      if (!first) return null
      return {
        rel: first.rel,
        source: status.repo.kind === 'git' && first.staged && !first.unstaged ? 'staged' : 'working'
      }
    })
  }, [status])

  const loadDiff = useCallback(
    async (target: Active): Promise<void> => {
      const id = ++diffSeq.current
      setDiffLoading(true)
      setDiffError(null)
      try {
        const r = await window.api!.vcs.diff({
          cwd,
          rel: target.rel,
          source: target.source
        })
        if (id !== diffSeq.current) return
        if (!r.ok) {
          setDiff(null)
          setDiffError(r.error.message)
        } else {
          setDiff(r.data)
        }
      } catch (err) {
        if (id === diffSeq.current) setDiffError(errorOf(err))
      } finally {
        if (id === diffSeq.current) setDiffLoading(false)
      }
    },
    [cwd]
  )

  useEffect(() => {
    if (tab !== 'changes' || !active) return
    void loadDiff(active)
  }, [tab, active, loadDiff, status])

  const loadLog = useCallback(
    async (reset: boolean): Promise<void> => {
      const id = ++logSeq.current
      setLogLoading(true)
      setLogError(null)
      if (reset) {
        setLog([])
        setLogCursor(undefined)
        setCommitId(null)
        setDetail(null)
      }
      try {
        const r = await window.api!.vcs.log({
          cwd,
          limit: 20,
          cursor: reset ? undefined : logCursor
        })
        if (id !== logSeq.current) return
        if (!r.ok) {
          setLogError(r.error.message)
          return
        }
        setLog((prev) => (reset ? r.data.entries : [...prev, ...r.data.entries]))
        setLogCursor(r.data.nextCursor)
        if (reset && r.data.entries[0]) setCommitId(r.data.entries[0].id)
      } catch (err) {
        if (id === logSeq.current) setLogError(errorOf(err))
      } finally {
        if (id === logSeq.current) setLogLoading(false)
      }
    },
    [cwd, logCursor]
  )

  useEffect(() => {
    if (tab === 'history' && log.length === 0 && !logLoading) void loadLog(true)
    // 只在进入历史页时拉第一页；翻页由按钮触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  const loadDetail = useCallback(
    async (id: string): Promise<void> => {
      const seq = ++detailSeq.current
      setDetailLoading(true)
      setDetailError(null)
      try {
        const r = await window.api!.vcs.commitDetail({ cwd, id })
        if (seq !== detailSeq.current) return
        if (!r.ok) {
          setDetail(null)
          setDetailError(r.error.message)
        } else {
          setDetail(r.data)
        }
      } catch (err) {
        if (seq === detailSeq.current) setDetailError(errorOf(err))
      } finally {
        if (seq === detailSeq.current) setDetailLoading(false)
      }
    },
    [cwd]
  )

  useEffect(() => {
    if (tab === 'history' && commitId) void loadDetail(commitId)
  }, [tab, commitId, loadDetail])

  const run = useCallback(
    async <T,>(
      label: string,
      network: boolean,
      fn: (id: string) => Promise<VcsResult<T>>,
      filesChanged = true,
      describe?: (data: T) => string
    ): Promise<boolean> => {
      if (op) return false
      const id = makeOpId()
      setOp({ id, label, network })
      setOpError(null)
      try {
        const r = await fn(id)
        if (!r.ok) {
          if (r.error.code === 'cancelled') {
            onNotice(t('vcs.notice.cancelled'))
            return false
          }
          setOpError(r.error)
          return false
        }
        onNotice(describe ? describe(r.data) : t('vcs.notice.success', { label }))
        onMutated(filesChanged)
        onRefresh()
        if (tab === 'history') void loadLog(true)
        return true
      } catch (err) {
        setOpError({ code: 'unknown', message: errorOf(err) })
        return false
      } finally {
        setOp(null)
      }
    },
    [op, onNotice, onMutated, onRefresh, tab, loadLog, t]
  )

  const doStage = (paths: string[]): Promise<boolean> =>
    run(t('vcs.op.stage'), false, (id) =>
      window.api!.vcs.stage({ cwd, opId: id, paths })
    )

  const doUnstage = (paths: string[]): Promise<boolean> =>
    run(t('vcs.op.unstage'), false, (id) =>
      window.api!.vcs.unstage({ cwd, opId: id, paths })
    )

  const doResolve = (paths: string[], side: 'ours' | 'theirs' | 'working'): Promise<boolean> =>
    run(t('vcs.op.resolve'), false, (id) =>
      window.api!.vcs.resolve({ cwd, opId: id, paths, side })
    )

  const doDiscard = (paths: string[], includeUntracked = false): void => {
    setConfirm({
      title: includeUntracked
        ? t('vcs.confirm.untrackedTitle')
        : t('vcs.confirm.discardTitle'),
      body: includeUntracked
        ? t('vcs.confirm.untrackedBody')
        : t('vcs.confirm.discardBody'),
      label: includeUntracked ? t('vcs.confirm.delete') : t('vcs.confirm.revert'),
      action: async () => {
        await run(t('vcs.op.revert'), false, (id) =>
          window.api!.vcs.discard({ cwd, opId: id, paths, includeUntracked })
        )
      }
    })
  }

  const doRevert = (paths: string[]): void => {
    setConfirm({
      title: t('vcs.confirm.discardTitle'),
      body: t('vcs.confirm.svnDiscardBody'),
      label: t('vcs.confirm.revert'),
      action: async () => {
        await run(t('vcs.op.revert'), false, (id) =>
          window.api!.vcs.revert({ cwd, opId: id, paths })
        )
      }
    })
  }

  const doCommit = async (): Promise<void> => {
    if (!canCommit) return
    const ok = await run(
      t('vcs.op.commit'),
      false,
      (id) =>
        window.api!.vcs.commit({
          cwd,
          opId: id,
          message,
          ...(isGit ? { amend } : { paths: [...selected] })
        }),
      true,
      // SVN 含外链时会分成多次提交，把每个工作副本的 revision 都显示出来
      (d) => (d.shortId ? t('vcs.commit.success', { id: d.shortId }) : t('vcs.commit.successNoId'))
    )
    if (ok) {
      setMessage('')
      setAmend(false)
      if (!isGit) setSelected(new Set())
    }
  }

  const doFetch = (): Promise<boolean> =>
    run(t('vcs.op.fetch'), true, (id) => window.api!.vcs.fetch({ cwd, opId: id }), false)
  const doPull = (): Promise<boolean> =>
    run(t('vcs.op.pull'), true, (id) =>
      window.api!.vcs.pull({ cwd, opId: id, strategy: 'ff-only' })
    )
  const doPush = (): Promise<boolean> =>
    run(t('vcs.op.push'), true, (id) =>
      window.api!.vcs.push({ cwd, opId: id, setUpstream: !repo?.upstream })
    )
  const doUpdate = (): Promise<boolean> =>
    run(t('vcs.op.update'), true, (id) => window.api!.vcs.update({ cwd, opId: id }))

  const cancel = (): void => {
    if (!op) return
    void window.api!.vcs.cancel({ cwd, opId: op.id })
  }

  /* ── 工作树 ─────────────────────────────────────────── */

  const loadTrees = useCallback(async (): Promise<void> => {
    const seq = ++treeSeq.current
    setTreesLoading(true)
    setTreesError(null)
    try {
      const r = await window.api!.vcs.worktreeList({ cwd })
      if (seq !== treeSeq.current) return
      if (!r.ok) {
        setTreesError(r.error.message)
        return
      }
      setTrees(r.data)
      setTreeSel((prev) => {
        if (prev && r.data.worktrees.some((w) => samePath(w.path, prev))) return prev
        return (r.data.worktrees.find((w) => w.current) ?? r.data.worktrees[0])?.path ?? null
      })
    } catch (err) {
      if (seq === treeSeq.current) setTreesError(errorOf(err))
    } finally {
      if (seq === treeSeq.current) setTreesLoading(false)
    }
  }, [cwd])

  useEffect(() => {
    if (tab === 'worktrees' && isGit) void loadTrees()
  }, [tab, isGit, loadTrees])

  /** 工作树写操作：和 run() 一样走 opId / 取消，但不动文件缓存 */
  const runTree = async <T extends VcsWorktreeListData,>(
    label: string,
    fn: (id: string) => Promise<VcsResult<T>>,
    successNotice = true
  ): Promise<VcsResult<T> | null> => {
    if (op) return null
    const id = makeOpId()
    setOp({ id, label, network: false })
    setOpError(null)
    try {
      const r = await fn(id)
      if (!r.ok) {
        if (r.error.code === 'cancelled') onNotice(t('vcs.notice.cancelled'))
        else setOpError(r.error)
        return r
      }
      setTrees(r.data)
      if (successNotice) onNotice(t('vcs.notice.success', { label }))
      return r
    } catch (err) {
      setOpError({ code: 'unknown', message: errorOf(err) })
      return null
    } finally {
      setOp(null)
    }
  }

  const openCreate = (): void => {
    if (!trees || !status) return
    const base =
      status.repo.kind === 'git' && !status.repo.detached ? status.repo.branch : status.repo.head
    setForm({ branch: '', path: '', base })
    setPathEdited(false)
    setCreateOpen(true)
  }

  const onBranchChange = (value: string): void => {
    setForm((prev) => {
      const next = { ...prev, branch: value }
      if (!pathEdited && trees) {
        const slug = worktreeSlug(value)
        next.path = slug ? joinPath(trees.defaultRoot, slug) : ''
      }
      return next
    })
  }

  const doCreateTree = async (): Promise<void> => {
    const branch = form.branch.trim()
    const path = form.path.trim()
    if (!branch || !path) return
    const r = await runTree(t('vcs.op.createWorktree'), (id) =>
      window.api!.vcs.worktreeAdd({
        cwd,
        opId: id,
        path,
        branch,
        base: form.base.trim() || undefined
      })
    )
    if (!r?.ok) return
    const created = r.data.worktrees.find((w) => samePath(w.path, path))
    setTreeSel(created?.path ?? null)
    setCreateOpen(false)
  }

  const confirmRemoveTree = (w: VcsWorktree, force = false): void => {
    setConfirm({
      title: force
        ? t('vcs.worktree.forceRemoveTitle')
        : t('vcs.worktree.removeTitle'),
      body: force
        ? t('vcs.worktree.forceRemoveBody', { path: w.path, branch: w.branch ?? '' })
        : t('vcs.worktree.removeBody', { path: w.path }),
      label: force ? t('vcs.worktree.forceDelete') : t('vcs.confirm.delete'),
      action: async () => {
        const r = await runTree(t('vcs.op.removeWorktree'), (id) =>
          window.api!.vcs.worktreeRemove({ cwd, opId: id, path: w.path, force })
        )
        if (!r) return
        if (r.ok) {
          setTreeSel(null)
          return
        }
        if (!force && r.error.code === 'dirty') {
          // 第一次只做普通删除；git 明确拒绝后才升级成强制删除
          setOpError(null)
          confirmRemoveTree(w, true)
        }
      }
    })
  }

  const doPruneTrees = (): void => {
    if (!prunableCount) return
    setConfirm({
      title: t('vcs.worktree.pruneTitle'),
      body: t('vcs.worktree.pruneBody', { n: prunableCount }),
      label: t('vcs.worktree.prune'),
      action: async () => {
        const r = await runTree(
          t('vcs.op.pruneWorktrees'),
          (id) => window.api!.vcs.worktreePrune({ cwd, opId: id }),
          false
        )
        if (!r?.ok) return
        onNotice(t('vcs.worktree.pruned', { n: r.data.pruned }))
      }
    })
  }

  const openSessionInWorktree = async (path: string): Promise<void> => {
    const r = await window.api!.workspace.openSession(path)
    if (!r.ok) {
      setOpError({ code: 'unknown', message: r.message || t('vcs.openSessionFailed') })
      return
    }
    onNotice(t('vcs.switchedSession'))
  }

  const openFile = (f: VcsFile, source: VcsDiffSource): void => {
    setActive({ rel: f.rel, source })
    if (tab !== 'changes') setTab('changes')
  }

  const toggleSelected = (rel: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(rel)) next.delete(rel)
      else next.add(rel)
      return next
    })
  }

  /* ── 渲染 ───────────────────────────────────────────── */

  if (loading && !detect && !status) {
    return <div className="ide-vcs-fill">{t('vcs.detecting')}</div>
  }

  if (error) {
    return (
      <div className="ide-vcs-fill">
        <div className="ide-vcs-errorbox">
          <Ico d={P.warning} size={16} />
          <span>{error}</span>
          <button className="ide-vcs-link" onClick={onRefresh}>
            {t('common.retry')}
          </button>
        </div>
      </div>
    )
  }

  if (!detect?.repo) {
    const noCli = !detect?.available.git && !detect?.available.svn
    return (
      <div className="ide-vcs-fill">
        <div className="ide-vcs-empty">
          <div className="ide-vcs-empty-t">
            {noCli ? t('vcs.noCli') : t('vcs.notRepo')}
          </div>
          <div className="ide-vcs-empty-s">
            {noCli
              ? t('vcs.noCliHint')
              : t('vcs.notRepoHint')}
          </div>
          <button className="ide-vcs-btn" onClick={onRefresh}>
            {t('vcs.redetect')}
          </button>
        </div>
      </div>
    )
  }

  if (!status) {
    return <div className="ide-vcs-fill">{t('vcs.loadingStatus')}</div>
  }

  return (
    <section className="ide-vcs">
      <header className="ide-vcs-head">
        <div className="ide-vcs-title">
          <Ico d={P.branch} size={15} />
          <b>{t('vcs.sourceControl')}</b>
          <span className={`ide-vcs-kind is-${status.repo.kind}`}>
            {status.repo.kind === 'git' ? 'Git' : 'SVN'}
          </span>
          <span className="ide-vcs-branch" title={status.repo.branch}>
            {status.repo.kind === 'git' ? status.repo.branch : status.repo.headShort}
          </span>
          {status.repo.kind === 'git' && (status.repo.ahead > 0 || status.repo.behind > 0) && (
            <span className="ide-vcs-sync">
              {status.repo.ahead > 0 ? `↑${status.repo.ahead}` : ''}
              {status.repo.behind > 0 ? ` ↓${status.repo.behind}` : ''}
            </span>
          )}
          {status.repo.kind === 'git' && status.repo.detached && (
            <span className="ide-vcs-warn">detached</span>
          )}
        </div>
        <div className="ide-vcs-headacts">
          {status.repo.kind === 'git' ? (
            <>
              <button className="ide-vcs-btn" disabled={!!op} onClick={() => void doFetch()}>
                {t('vcs.fetch')}
              </button>
              <button className="ide-vcs-btn" disabled={!!op} onClick={() => void doPull()}>
                {t('vcs.pull')}
              </button>
              <button
                className="ide-vcs-btn is-primary"
                disabled={!!op}
                onClick={() => void doPush()}
              >
                {status.repo.upstream ? t('vcs.push') : t('vcs.publish')}
              </button>
            </>
          ) : (
            <button
              className="ide-vcs-btn is-primary"
              disabled={!!op}
              onClick={() => void doUpdate()}
            >
              {t('vcs.update')}
            </button>
          )}
          <button
            className="ide-iconbtn"
            title={t('vcs.refresh')}
            disabled={!!op}
            onClick={() => {
              onRefresh()
              if (active) void loadDiff(active)
            }}
          >
            <Ico d={P.refresh} size={13} />
          </button>
        </div>
      </header>

      <div className="ide-vcs-tabs">
        <button className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>
          {t('vcs.changes')} <span>{status.counts.total}</span>
        </button>
        <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>
          {t('vcs.history')}
        </button>
        <button className={tab === 'repo' ? 'on' : ''} onClick={() => setTab('repo')}>
          {t('vcs.repo')}
        </button>
        {isGit && (
          <button
            className={tab === 'worktrees' ? 'on' : ''}
            onClick={() => setTab('worktrees')}
          >
            {t('vcs.worktrees')}
          </button>
        )}
        <span className="ide-spacer" />
        {op ? (
          <span className="ide-vcs-busy">
            <i className="ide-spin" /> {t('vcs.opRunning', { label: op.label })}
            {op.network && (
              <button className="ide-vcs-link" onClick={cancel}>
                {t('common.cancel')}
              </button>
            )}
          </span>
        ) : (
          <span className="ide-vcs-meta">
            {status.repo.kind === 'git'
              ? t('vcs.counts.staged', {
                  staged: status.counts.staged,
                  unstaged: status.counts.unstaged
                })
              : tn('count.files', status.counts.total)}
          </span>
        )}
      </div>

      {opError && (
        <div className="ide-vcs-banner is-error">
          <Ico d={P.warning} size={12} />
          <span>{opError.message}</span>
          {opError.detail && <code title={opError.detail}>{opError.detail.split('\n')[0]}</code>}
          <button className="ide-vcs-link" onClick={() => setOpError(null)}>
            {t('common.close')}
          </button>
        </div>
      )}

      {status.repo.workspacePrefix && (
        <div className="ide-vcs-banner is-note">
          {t('vcs.subdir', { root: status.repo.root })}
          {status.repo.kind === 'git' ? t('vcs.subdirGit') : t('vcs.subdirSvn')}
        </div>
      )}

      <div className="ide-vcs-body">
        <aside className="ide-vcs-left">
          {tab === 'changes' && (
            <>
              <div className="ide-vcs-msg">
                <div className="ide-vcs-msgh">
                  <span>{t('vcs.commitMessage')}</span>
                  <span>
                    {isGit
                      ? t('vcs.stagedCount', { n: stagedCount })
                      : t('vcs.selectedCount', { n: selectedCount })}
                  </span>
                </div>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={
                    isGit ? t('vcs.commitPlaceholderGit') : t('vcs.commitPlaceholderSvn')
                  }
                  spellCheck={false}
                />
                <div className="ide-vcs-msgf">
                  {isGit && (
                    <label className="ide-vcs-checklabel">
                      <input
                        type="checkbox"
                        checked={amend}
                        onChange={(e) => setAmend(e.target.checked)}
                      />
                      {t('vcs.amend')}
                    </label>
                  )}
                  {!isGit && (
                    <button
                      className="ide-vcs-link"
                      onClick={() =>
                        setSelected(
                          selectedCount === selectable.length
                            ? new Set()
                            : new Set(selectable.map((f) => f.rel))
                        )
                      }
                    >
                      {selectedCount === selectable.length ? t('vcs.selectNone') : t('vcs.selectAll')}
                    </button>
                  )}
                  <span className="ide-spacer" />
                  <span>{tn('count.files', commitCount)}</span>
                </div>
              </div>
              <button
                className="ide-vcs-commit"
                disabled={!canCommit}
                title={
                  conflictCount > 0
                    ? t('vcs.precondition.conflicts')
                    : !message.trim()
                      ? t('vcs.precondition.message')
                      : commitCount === 0
                        ? isGit
                          ? t('vcs.precondition.stage')
                          : t('vcs.precondition.select')
                        : externalSelected > 0
                          ? t('vcs.externalSelected', { n: externalSelected })
                          : ''
                }
                onClick={() => void doCommit()}
              >
                <Ico d={P.check} size={13} />
                {op?.label === t('vcs.op.commit')
                  ? t('vcs.committing')
                  : t('vcs.commitFiles', { n: commitCount })}
              </button>
              <div className="ide-vcs-groups">
                {groups.length === 0 && (
                  <div className="ide-vcs-clean">{t('vcs.clean')}</div>
                )}
                {groups.map((g) => (
                  <div className="ide-vcs-group" key={g.key}>
                    <div className="ide-vcs-grouphead">
                      <span className="ide-vcs-gchev">▾</span>
                      <span>{g.title}</span>
                      <span className="ide-vcs-gcount">{g.files.length}</span>
                      {g.note && (
                        <span
                          className="ide-vcs-gnote"
                          title={t('vcs.externalTitle')}
                        >
                          {g.note}
                        </span>
                      )}
                      <span className="ide-spacer" />
                      {((status.repo.kind === 'git' && g.key !== 'conflicts' && g.key !== 'staged') ||
                        (status.repo.kind === 'svn' && g.files.some((f) => f.untracked))) && (
                        <button
                          className="ide-vcs-mini"
                          title={t('vcs.stageAll')}
                          onClick={() =>
                            void doStage(
                              g.files
                                .filter((f) => status.repo.kind === 'git' || f.untracked)
                                .map((f) => f.rel)
                            )
                          }
                        >
                          <Ico d={P.plus} size={10} />
                        </button>
                      )}
                    </div>
                    {g.files.map((f) => (
                      <VcsRow
                        key={`${g.key}:${f.rel}`}
                        file={f}
                        kind={status.repo.kind}
                        active={active?.rel === f.rel && active.source === g.source}
                        checked={selected.has(f.rel)}
                        onOpen={() => openFile(f, g.source)}
                        onCheck={() => toggleSelected(f.rel)}
                        onStage={() => void doStage([f.rel])}
                        onUnstage={() => void doUnstage([f.rel])}
                        onDiscard={() => doDiscard([f.rel], f.untracked)}
                        onRevert={() => doRevert([f.rel])}
                        onResolve={(side) => void doResolve([f.rel], side)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'history' && (
            <HistoryList
              entries={log}
              loading={logLoading}
              error={logError}
              selected={commitId}
              hasMore={!!logCursor}
              onSelect={setCommitId}
              onMore={() => void loadLog(false)}
              onRefresh={() => void loadLog(true)}
            />
          )}

          {tab === 'repo' && <RepoInfo repo={status.repo} />}

          {tab === 'worktrees' && (
            <div className="ide-vcs-wtlist">
              <div className="ide-vcs-sidehead">
                <span>{t('vcs.worktrees')}</span>
                <button
                  className="ide-vcs-mini is-primary"
                  disabled={!!op || !trees}
                  onClick={openCreate}
                >
                  {t('vcs.new')}
                </button>
                <button
                  className="ide-vcs-mini"
                  disabled={!!op || prunableCount === 0}
                  title={t('vcs.worktree.pruneTitle')}
                  onClick={doPruneTrees}
                >
                  {t('vcs.prune')}
                </button>
                <button
                  className="ide-iconbtn"
                  title={t('vcs.refresh')}
                  disabled={treesLoading}
                  onClick={() => void loadTrees()}
                >
                  <Ico d={P.refresh} size={12} />
                </button>
              </div>

              {treesError && <div className="ide-vcs-inline-error">{treesError}</div>}
              {treesLoading && !trees && (
                <div className="ide-vcs-loadingrow">
                  <i className="ide-spin" /> {t('ide.loading')}
                </div>
              )}

              {trees?.worktrees.map((w) => (
                <button
                  key={w.path}
                  className={`ide-vcs-wtrow ${treeSel === w.path ? 'is-active' : ''}`}
                  title={w.path}
                  onClick={() => setTreeSel(w.path)}
                >
                  <span className="ide-vcs-wtbranch">
                    {w.branch || (w.detached ? 'detached' : '(bare)')}
                  </span>
                  <span className="ide-vcs-wttags">
                    {w.main && <i className="ide-vcs-wttag is-main">{t('vcs.tag.main')}</i>}
                    {w.current && <i className="ide-vcs-wttag is-current">{t('vcs.tag.current')}</i>}
                    {!w.exists && <i className="ide-vcs-wttag is-missing">{t('vcs.tag.missing')}</i>}
                    {w.locked && <i className="ide-vcs-wttag is-locked">{t('vcs.tag.locked')}</i>}
                    {w.bare && <i className="ide-vcs-wttag">bare</i>}
                  </span>
                  <span className="ide-vcs-wtpath">{w.path}</span>
                </button>
              ))}

              {!treesLoading && trees && trees.worktrees.length === 0 && (
                <div className="ide-vcs-clean">{t('vcs.noWorktrees')}</div>
              )}
            </div>
          )}
        </aside>

        <main className="ide-vcs-right">
          {tab === 'changes' && (
            <ChangesDiff
              file={activeFile}
              source={active?.source ?? 'working'}
              diff={diff}
              loading={diffLoading}
              error={diffError}
              repo={status.repo}
              onRetry={() => active && void loadDiff(active)}
              onOpen={() => active && onOpenFile(active.rel)}
              onStage={() => active && void doStage([active.rel])}
              onUnstage={() => active && void doUnstage([active.rel])}
              onDiscard={() =>
                active &&
                (status.repo.kind === 'git'
                  ? doDiscard([active.rel], activeFile?.untracked ?? false)
                  : doRevert([active.rel]))
              }
              onResolve={(side) => active && void doResolve([active.rel], side)}
            />
          )}
          {tab === 'history' && (
            <CommitDetail
              kind={status.repo.kind}
              detail={detail}
              loading={detailLoading}
              error={detailError}
              onRetry={() => commitId && void loadDetail(commitId)}
            />
          )}
          {tab === 'repo' && (
            <div className="ide-vcs-repohelp">
              <div className="ide-vcs-empty-t">{t('vcs.infoTitle')}</div>
              <p>
                {t('vcs.infoBody')}
              </p>
            </div>
          )}

          {tab === 'worktrees' &&
            (selectedTree ? (
              <div className="ide-vcs-wtdetail">
                <div className="ide-vcs-sidehead">
                  <span>{t('vcs.worktreeDetail')}</span>
                </div>
                <dl className="ide-vcs-dl">
                  <div className="ide-vcs-dlrow">
                    <dt>{t('vcs.branch')}</dt>
                    <dd>{selectedTree.branch || (selectedTree.detached ? 'detached' : '(bare)')}</dd>
                  </div>
                  <div className="ide-vcs-dlrow">
                    <dt>HEAD</dt>
                    <dd>{selectedTree.headShort || t('vcs.emptyHead')}</dd>
                  </div>
                  <div className="ide-vcs-dlrow">
                    <dt>{t('vcs.directory')}</dt>
                    <dd title={selectedTree.path}>{selectedTree.path}</dd>
                  </div>
                  {selectedTree.lockReason && (
                    <div className="ide-vcs-dlrow">
                      <dt>{t('vcs.lockReason')}</dt>
                      <dd>{selectedTree.lockReason}</dd>
                    </div>
                  )}
                </dl>

                <div className="ide-vcs-wtactions">
                  {selectedTree.exists && (
                    <>
                      <button
                        className="ide-vcs-btn"
                        onClick={() => void window.api?.ide?.open(selectedTree.path)}
                      >
                        {t('vcs.openIde')}
                      </button>
                      <button
                        className="ide-vcs-btn is-primary"
                        onClick={() => void openSessionInWorktree(selectedTree.path)}
                      >
                        {t('vcs.newSession')}
                      </button>
                    </>
                  )}
                  {selectedTree.exists &&
                    !selectedTree.main &&
                    !selectedTree.current &&
                    !selectedTree.locked && (
                      <button
                        className="ide-vcs-btn is-danger"
                        disabled={!!op}
                        onClick={() => confirmRemoveTree(selectedTree)}
                      >
                        {t('vcs.delete')}
                      </button>
                    )}
                </div>

                {!selectedTree.exists && (
                  <p className="ide-vcs-note">
                    {t('vcs.worktreeMissing')}
                  </p>
                )}
                {selectedTree.locked && (
                  <p className="ide-vcs-note">
                    {t('vcs.worktreeLocked')}
                  </p>
                )}
                <p className="ide-vcs-note">
                  {t('vcs.worktreeDeleteNote')}
                </p>
              </div>
            ) : (
              <div className="ide-vcs-empty">
                <div className="ide-vcs-empty-t">{t('vcs.selectWorktree')}</div>
                <div className="ide-vcs-empty-s">{t('vcs.selectWorktreeHint')}</div>
              </div>
            ))}
        </main>
      </div>

      {createOpen && (
        <div className="ide-vcs-scrim" onClick={() => setCreateOpen(false)}>
          <div className="ide-vcs-confirm is-wide" onClick={(e) => e.stopPropagation()}>
            <div className="ide-vcs-confirm-t">{t('vcs.createWorktree')}</div>
            <div className="ide-vcs-confirm-b">
              <div className="ide-vcs-form">
                <label>
                  {t('vcs.newBranch')}
                  <input
                    value={form.branch}
                    onChange={(e) => onBranchChange(e.target.value)}
                    placeholder="feature/my-change"
                    spellCheck={false}
                    autoFocus
                  />
                </label>
                <label>
                  {t('vcs.baseBranch')}
                  <input
                    value={form.base}
                    onChange={(e) => setForm((prev) => ({ ...prev, base: e.target.value }))}
                    spellCheck={false}
                  />
                </label>
                <label>
                  {t('vcs.worktreeLocation')}
                  <input
                    value={form.path}
                    onChange={(e) => {
                      setPathEdited(true)
                      setForm((prev) => ({ ...prev, path: e.target.value }))
                    }}
                    spellCheck={false}
                  />
                </label>
                <div className="ide-vcs-formhint">
                  {t('vcs.worktreeLocationHint', {
                    root: trees?.defaultRoot || ''
                  })}
                </div>
              </div>
            </div>
            <div className="ide-vcs-confirm-f">
              <button className="ide-vcs-btn" onClick={() => setCreateOpen(false)}>
                {t('common.cancel')}
              </button>
              <button
                className="ide-vcs-btn is-primary"
                disabled={
                  !!op ||
                  !form.branch.trim() ||
                  !form.path.trim() ||
                  !looksAbsolute(form.path) ||
                  !status.repo.head
                }
                title={!status.repo.head ? t('vcs.noCommitsCannotWorktree') : ''}
                onClick={() => void doCreateTree()}
              >
                {t('vcs.create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirm && (
        <div className="ide-vcs-scrim" onClick={() => setConfirm(null)}>
          <div className="ide-vcs-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="ide-vcs-confirm-t">{confirm.title}</div>
            <div className="ide-vcs-confirm-b">{confirm.body}</div>
            <div className="ide-vcs-confirm-f">
              <button className="ide-vcs-btn" onClick={() => setConfirm(null)}>
                {t('common.cancel')}
              </button>
              <button
                className="ide-vcs-btn is-danger"
                onClick={() => {
                  const action = confirm.action
                  setConfirm(null)
                  void action()
                }}
              >
                {confirm.label}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

/* ── 文件行 ───────────────────────────────────────────── */

function VcsRow({
  file,
  kind,
  active,
  checked,
  onOpen,
  onCheck,
  onStage,
  onUnstage,
  onDiscard,
  onRevert,
  onResolve
}: {
  file: VcsFile
  kind: VcsRepo['kind']
  active: boolean
  checked: boolean
  onOpen: () => void
  onCheck: () => void
  onStage: () => void
  onUnstage: () => void
  onDiscard: () => void
  onRevert: () => void
  onResolve: (side: 'ours' | 'theirs' | 'working') => void
}): JSX.Element {
  const { t } = useI18n()
  return (
    <div
      className={`ide-vcs-row ${active ? 'is-active' : ''} ${file.conflict ? 'is-conflict' : ''}`}
      onClick={onOpen}
      title={file.external ? t('vcs.fileExternal', { rel: file.rel }) : file.rel}
    >
      {kind === 'svn' &&
      !file.untracked &&
      !file.conflict &&
      file.status !== '!' &&
      file.status !== '~' ? (
        <input
          className="ide-vcs-cb"
          type="checkbox"
          checked={checked}
          onClick={(e) => e.stopPropagation()}
          onChange={onCheck}
          aria-label={t('vcs.selectFile', { name: file.name })}
        />
      ) : (
        <span className="ide-vcs-cbspace" />
      )}
      <span
        className={`ide-vcs-st is-${file.status.toLowerCase()}${file.conflict ? ' is-conflict' : ''}`}
      >
        {file.status}
      </span>
      <span className="ide-vcs-name">{file.name}</span>
      <span className="ide-vcs-dir">{file.dir}</span>
      {file.changelist && (
        <span className="ide-vcs-cl" title={`changelist: ${file.changelist}`}>
          {file.changelist}
        </span>
      )}
      {file.lock && (
        <span className="ide-vcs-lock" title={t('vcs.lockedBy', { lock: file.lock })}>
          <Ico d={P.lock} size={10} />
        </span>
      )}
      <span className="ide-vcs-rowacts" onClick={(e) => e.stopPropagation()}>
        {file.conflict ? (
          <>
            <button className="ide-vcs-mini" title={t('vcs.resolve.ours')} onClick={() => onResolve('ours')}>
              {t('vcs.resolve.oursShort')}
            </button>
            <button className="ide-vcs-mini" title={t('vcs.resolve.theirs')} onClick={() => onResolve('theirs')}>
              {t('vcs.resolve.theirsShort')}
            </button>
            <button className="ide-vcs-mini" title={t('vcs.resolve.working')} onClick={() => onResolve('working')}>
              {t('vcs.resolve.resolvedShort')}
            </button>
          </>
        ) : kind === 'git' ? (
          file.staged && !file.untracked ? (
            <button className="ide-vcs-mini" title={t('vcs.op.unstage')} onClick={onUnstage}>
              {t('vcs.op.unstage')}
            </button>
          ) : (
            <>
              <button className="ide-vcs-mini" title={t('vcs.op.stage')} onClick={onStage}>
                {t('vcs.op.stage')}
              </button>
              <button className="ide-vcs-mini is-danger" title={t('vcs.op.revert')} onClick={onDiscard}>
                <Ico d={P.undo} size={10} />
              </button>
            </>
          )
        ) : file.untracked ? (
          <button className="ide-vcs-mini" title={t('vcs.addToVcs')} onClick={onStage}>
            {t('vcs.add')}
          </button>
        ) : (
          <button className="ide-vcs-mini is-danger" title={t('vcs.op.revert')} onClick={onRevert}>
            <Ico d={P.undo} size={10} />
          </button>
        )}
      </span>
    </div>
  )
}

/* ── 历史 ─────────────────────────────────────────────── */

function HistoryList({
  entries,
  loading,
  error,
  selected,
  hasMore,
  onSelect,
  onMore,
  onRefresh
}: {
  entries: VcsLogEntry[]
  loading: boolean
  error: string | null
  selected: string | null
  hasMore: boolean
  onSelect: (id: string) => void
  onMore: () => void
  onRefresh: () => void
}): JSX.Element {
  const { t } = useI18n()
  return (
    <div className="ide-vcs-history">
      <div className="ide-vcs-sidehead">
        <span>{t('vcs.history')}</span>
        <button className="ide-iconbtn" title={t('vcs.refresh')} onClick={onRefresh}>
          <Ico d={P.refresh} size={12} />
        </button>
      </div>
      {error && <div className="ide-vcs-inline-error">{error}</div>}
      {entries.map((e) => (
        <button
          key={e.id}
          className={`ide-vcs-logrow ${selected === e.id ? 'is-active' : ''}`}
          onClick={() => onSelect(e.id)}
          title={e.message || e.subject}
        >
          <span className="ide-vcs-logid">{e.shortId}</span>
          <span className="ide-vcs-logmain">
            <span className="ide-vcs-logsub">{e.subject || t('vcs.noCommitMessage')}</span>
            <span className="ide-vcs-logmeta">
              {e.author} · {when(e.date)}
            </span>
          </span>
        </button>
      ))}
      {!loading && entries.length === 0 && !error && (
        <div className="ide-vcs-clean">{t('vcs.historyEmpty')}</div>
      )}
      {loading && <div className="ide-vcs-loadingrow"><i className="ide-spin" /> {t('ide.loading')}</div>}
      {hasMore && !loading && (
        <button className="ide-vcs-more" onClick={onMore}>
          {t('vcs.loadMore')}
        </button>
      )}
    </div>
  )
}

/* ── 仓库信息 ─────────────────────────────────────────── */

function RepoInfo({ repo }: { repo: VcsRepo }): JSX.Element {
  const { t } = useI18n()
  const rows: Array<[string, string]> = [
    [t('vcs.repoType'), repo.kind === 'git' ? t('vcs.repoGit') : t('vcs.repoSvn')],
    [
      repo.kind === 'git' ? t('vcs.repoBranch') : t('vcs.repoRevision'),
      repo.kind === 'git' ? repo.branch : repo.headShort
    ],
    ...(repo.kind === 'git'
      ? ([
          [t('vcs.repoUpstream'), repo.upstream || t('vcs.repoNotSet')],
          [t('vcs.repoRemote'), repo.remote || t('vcs.repoNotSet')],
          [t('vcs.repoCommit'), repo.headShort || t('vcs.repoEmpty')]
        ] as Array<[string, string]>)
      : ([
          [t('vcs.repoUrl'), repo.url || t('vcs.repoUnknown')],
          [t('vcs.repoRoot'), repo.repositoryRoot || t('vcs.repoUnknown')],
          [t('vcs.repoRevision'), repo.headShort]
        ] as Array<[string, string]>)),
    [t('vcs.repoRoot'), repo.root],
    [
      t('vcs.repoWorkspacePrefix'),
      repo.workspacePrefix || t('vcs.repoWorkspaceIsRoot')
    ]
  ]
  return (
    <div className="ide-vcs-repo">
      <div className="ide-vcs-sidehead">
        <span>{t('vcs.repo')}</span>
      </div>
      <dl className="ide-vcs-dl">
        {rows.map(([k, v]) => (
          <div className="ide-vcs-dlrow" key={k}>
            <dt>{k}</dt>
            <dd title={v}>{v}</dd>
          </div>
        ))}
      </dl>
      {repo.kind === 'svn' && (
        <p className="ide-vcs-note">
          {t('vcs.svnNoBranches')}
        </p>
      )}
    </div>
  )
}

/* ── 右侧 diff ────────────────────────────────────────── */

function ChangesDiff({
  file,
  source,
  diff,
  loading,
  error,
  repo,
  onRetry,
  onOpen,
  onStage,
  onUnstage,
  onDiscard,
  onResolve
}: {
  file: VcsFile | null
  source: VcsDiffSource
  diff: VcsDiffData | null
  loading: boolean
  error: string | null
  repo: VcsRepo
  onRetry: () => void
  onOpen: () => void
  onStage: () => void
  onUnstage: () => void
  onDiscard: () => void
  onResolve: (side: 'ours' | 'theirs' | 'working') => void
}): JSX.Element {
  const { t } = useI18n()
  if (!file) {
    return (
      <div className="ide-vcs-empty">
        <div className="ide-vcs-empty-t">{t('vcs.selectFileForDiff')}</div>
        <div className="ide-vcs-empty-s">{t('vcs.selectFileForDiffHint')}</div>
      </div>
    )
  }
  return (
    <div className="ide-vcs-diffpane">
      <div className="ide-vcs-diffhead">
        <Ico d={file.conflict ? P.warning : P.file} size={12} />
        <b>{file.name}</b>
        <span className="ide-vcs-dirdim">{file.dir}</span>
        <span
          className={`ide-vcs-st is-${file.status.toLowerCase()}${file.conflict ? ' is-conflict' : ''}`}
        >
          {statusLabel(file)}
        </span>
        <span className="ide-spacer" />
        {file.conflict ? (
          <>
            <button className="ide-vcs-mini" onClick={() => onResolve('ours')}>{t('vcs.resolve.oursShort')}</button>
            <button className="ide-vcs-mini" onClick={() => onResolve('theirs')}>{t('vcs.resolve.theirsShort')}</button>
            <button className="ide-vcs-mini" onClick={() => onResolve('working')}>{t('vcs.resolve.resolvedShort')}</button>
          </>
        ) : repo.kind === 'git' ? (
          source === 'staged' ? (
            <button className="ide-vcs-mini" onClick={onUnstage}>{t('vcs.op.unstage')}</button>
          ) : (
            <>
              <button className="ide-vcs-mini" onClick={onStage}>{t('vcs.op.stage')}</button>
              <button className="ide-vcs-mini is-danger" onClick={onDiscard}>{t('vcs.op.revert')}</button>
            </>
          )
        ) : file.untracked ? (
          <button className="ide-vcs-mini" onClick={onStage}>{t('vcs.add')}</button>
        ) : (
          <button className="ide-vcs-mini is-danger" onClick={onDiscard}>{t('vcs.op.revert')}</button>
        )}
        <button className="ide-vcs-mini" onClick={onOpen}>
          <Ico d={P.external} size={10} /> {t('vcs.open')}
        </button>
      </div>
      {file.conflict && (
        <div className="ide-vcs-banner is-error">
          <Ico d={P.warning} size={12} />
          {t('vcs.conflictNote')}
        </div>
      )}
      <div className="ide-vcs-diffbody">
        {loading ? (
          <div className="ide-vcs-loadingrow"><i className="ide-spin" /> {t('vcs.readingDiff')}</div>
        ) : error ? (
          <div className="ide-vcs-errorbox">
            <Ico d={P.warning} size={14} />
            <span>{error}</span>
            <button className="ide-vcs-link" onClick={onRetry}>{t('common.retry')}</button>
          </div>
        ) : diff ? (
          <VcsDiffView data={diff} />
        ) : (
          <div className="ide-vcs-empty-s">{t('vcs.noDiff')}</div>
        )}
      </div>
    </div>
  )
}

/* ── 提交详情 ─────────────────────────────────────────── */

function CommitDetail({
  kind,
  detail,
  loading,
  error,
  onRetry
}: {
  kind: VcsRepo['kind']
  detail: VcsCommitDetailData | null
  loading: boolean
  error: string | null
  onRetry: () => void
}): JSX.Element {
  const { t } = useI18n()
  if (loading) {
    return <div className="ide-vcs-loadingrow"><i className="ide-spin" /> {t('vcs.readingCommit')}</div>
  }
  if (error) {
    return (
      <div className="ide-vcs-errorbox">
        <Ico d={P.warning} size={14} />
        <span>{error}</span>
        <button className="ide-vcs-link" onClick={onRetry}>{t('common.retry')}</button>
      </div>
    )
  }
  if (!detail) {
    return (
      <div className="ide-vcs-empty">
        <div className="ide-vcs-empty-t">{t('vcs.selectCommit')}</div>
        <div className="ide-vcs-empty-s">{t('vcs.selectCommitHint')}</div>
      </div>
    )
  }
  const entry = detail.entry
  const diffData: VcsDiffData = {
    repoKind: kind,
    rel: '',
    source: 'revision',
    diff: detail.diff,
    binary: false,
    untracked: false,
    truncated: detail.truncated,
    added: 0,
    removed: 0,
    revision: entry.shortId
  }
  return (
    <div className="ide-vcs-commitdetail">
      <div className="ide-vcs-cdhead">
        <span className={`ide-vcs-kind is-${kind}`}>{entry.shortId}</span>
        <b>{entry.subject || t('vcs.noCommitMessage')}</b>
        <span className="ide-spacer" />
        <span className="ide-vcs-meta">
          {entry.author} · {when(entry.date)}
        </span>
      </div>
      <pre className="ide-vcs-cdmsg">
        {entry.message || t('vcs.noCommitMessage')}
      </pre>
      {detail.files.length > 0 && (
        <div className="ide-vcs-cdfiles">
          {detail.files.map((f) => (
            <span className="ide-vcs-cdfile" key={`${f.status}:${f.rel}`} title={f.oldRel ? `${f.oldRel} → ${f.rel}` : f.rel}>
              <em className={`ide-vcs-st is-${f.status.toLowerCase()}`}>{f.status}</em>
              {f.rel}
              {f.additions != null && <b className="ide-add">+{f.additions}</b>}
              {f.deletions != null && <b className="ide-del">−{f.deletions}</b>}
            </span>
          ))}
        </div>
      )}
      <div className="ide-vcs-diffbody">
        {detail.diff.trim() ? (
          <VcsDiffView data={diffData} />
        ) : (
          <div className="ide-vcs-empty-s">{t('vcs.commitNoDiff')}</div>
        )}
      </div>
    </div>
  )
}
