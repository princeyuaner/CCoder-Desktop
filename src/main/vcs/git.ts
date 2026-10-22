import { readFile } from 'node:fs/promises'
import type {
  VcsChange,
  VcsCommitData,
  VcsCommitDetailData,
  VcsCommitRequest,
  VcsDiffData,
  VcsDiffRequest,
  VcsDiffSource,
  VcsFile,
  VcsLogPage,
  VcsLogRequest,
  VcsMutationData,
  VcsPathsRequest,
  VcsPullRequest,
  VcsPushRequest,
  VcsRepo,
  VcsResolveRequest,
  VcsDiscardRequest,
  VcsStatus,
  VcsStatusRequest,
  VcsSyncData
} from '../../shared/vcs'
import { mapCliError, runGit, VcsOpError } from './exec'
import {
  absPath,
  assertRealInside,
  checkRevision,
  countDiff,
  dirOf,
  nameOf,
  normRel,
  rootRel,
  toWorkspaceRel
} from './paths'
import { readCapped } from './read'

const FORMAT_LOG = '%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%B%x00%P%x00%D%x1e'
const FORMAT_META = '%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%B%x1e%P%x00%D'

function restAfterSpaces(s: string, n: number): string {
  let idx = -1
  for (let i = 0; i < n; i++) {
    idx = s.indexOf(' ', idx + 1)
    if (idx < 0) return ''
  }
  return s.slice(idx + 1)
}

function changeLetter(x: string, y: string, conflict: boolean): VcsChange {
  if (conflict) return 'U'
  const raw = x !== '.' && x !== ' ' && x !== '?' ? x : y
  if (raw === 'A' || raw === 'D' || raw === 'M' || raw === 'R' || raw === 'C') return raw
  if (raw === '?') return '?'
  return 'M'
}

function isConflictXY(x: string, y: string): boolean {
  return (
    x === 'U' ||
    y === 'U' ||
    (x === 'A' && y === 'A') ||
    (x === 'D' && y === 'D') ||
    (x === 'D' && y === 'U') ||
    (x === 'U' && y === 'D')
  )
}

function parseStatus(repo: VcsRepo, raw: string): VcsStatus {
  const nextRepo: VcsRepo = { ...repo }
  const files: VcsFile[] = []
  const records = raw.split('\0')
  let head = nextRepo.head
  let headShort = nextRepo.headShort
  let upstream = nextRepo.upstream
  let ahead = nextRepo.ahead
  let behind = nextRepo.behind
  let detached = nextRepo.detached
  let branch = nextRepo.branch

  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    if (!rec) continue
    if (rec.startsWith('# ')) {
      if (rec.startsWith('# branch.oid ')) head = rec.slice('# branch.oid '.length).trim()
      else if (rec.startsWith('# branch.head ')) {
        const v = rec.slice('# branch.head '.length).trim()
        if (v && v !== '(unknown)') {
          detached = v === '(detached)'
          branch = detached ? 'detached' : v
        }
      } else if (rec.startsWith('# branch.upstream ')) {
        upstream = rec.slice('# branch.upstream '.length).trim() || undefined
      } else if (rec.startsWith('# branch.ab ')) {
        const m = /\+(\d+)\s+-(\d+)/.exec(rec)
        if (m) {
          ahead = Number(m[1])
          behind = Number(m[2])
        }
      }
      continue
    }

    const kind = rec[0]
    if (kind === '?') {
      const rel = toWorkspaceRel(repo, rec.slice(2))
      if (!rel) continue
      files.push({
        rel,
        name: nameOf(rel),
        dir: dirOf(rel),
        status: '?',
        staged: false,
        unstaged: false,
        untracked: true,
        conflict: false
      })
      continue
    }
    if (kind === '!') continue

    if (kind === '1' || kind === '2' || kind === 'u') {
      const parts = rec.split(' ')
      const xy = parts[1] ?? '..'
      const x = xy[0] ?? '.'
      const y = xy[1] ?? '.'
      const conflict = kind === 'u' || isConflictXY(x, y)
      let rootPath = ''
      let oldRootPath = ''
      if (kind === '1') {
        rootPath = restAfterSpaces(rec, 8)
      } else if (kind === '2') {
        rootPath = restAfterSpaces(rec, 9)
        oldRootPath = records[++i] ?? ''
      } else {
        rootPath = restAfterSpaces(rec, 10)
      }
      const rel = toWorkspaceRel(repo, rootPath)
      if (!rel) continue
      const oldRel = oldRootPath ? toWorkspaceRel(repo, oldRootPath) ?? undefined : undefined
      const staged = !conflict && x !== '.' && x !== ' ' && x !== '?'
      const unstaged = !conflict && y !== '.' && y !== ' '
      files.push({
        rel,
        oldRel,
        name: nameOf(rel),
        dir: dirOf(rel),
        status: changeLetter(x, y, conflict),
        staged,
        unstaged: conflict ? true : unstaged,
        untracked: false,
        conflict
      })
    }
  }

  files.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }))
  const counts = {
    total: files.length,
    staged: files.filter((f) => f.staged).length,
    unstaged: files.filter((f) => f.unstaged).length,
    untracked: files.filter((f) => f.untracked).length,
    conflicts: files.filter((f) => f.conflict).length
  }

  return {
    repo: { ...nextRepo, head, headShort, upstream, ahead, behind, detached, branch },
    files,
    counts,
    clean: files.length === 0
  }
}

export async function statusGit(repo: VcsRepo, _req: VcsStatusRequest): Promise<VcsStatus> {
  const r = await runGit(repo.root, [
    'status',
    '--porcelain=v2',
    '--branch',
    '-z',
    '--untracked-files=all'
  ], { timeoutMs: 30_000, maxStdoutBytes: 16 * 1024 * 1024 })
  if (r.code !== 0) throw mapCliError('git', r)
  return parseStatus(repo, r.stdout)
}

async function untrackedDiff(
  repo: VcsRepo,
  rel: string,
  source: VcsDiffSource = 'working'
): Promise<VcsDiffData> {
  const full = rootRel(repo, rel)
  const abs = absPath(repo, rel)
  await assertRealInside(repo.root, abs)
  const f = await readCapped(abs)
  if (f.directory) {
    return {
      repoKind: 'git',
      rel,
      source,
      diff: '',
      binary: false,
      untracked: true,
      truncated: false,
      added: 0,
      removed: 0
    }
  }
  if (f.binary) {
    return {
      repoKind: 'git',
      rel,
      source,
      diff: `Binary files /dev/null and b/${full} differ\n`,
      binary: true,
      untracked: true,
      truncated: f.truncated,
      added: 0,
      removed: 0
    }
  }
  const lines = f.text.replace(/\n$/, '').split('\n')
  const cap = 5000
  const shown = lines.slice(0, cap)
  const body = shown.map((l) => `+${l}`).join('\n')
  const diff = shown.length
    ? `diff --git a/${full} b/${full}\nnew file mode 100644\n--- /dev/null\n+++ b/${full}\n@@ -0,0 +1,${shown.length} @@\n${body}\n`
    : ''
  return {
    repoKind: 'git',
    rel,
    source,
    diff,
    binary: false,
    untracked: true,
    truncated: f.truncated || lines.length > cap,
    added: shown.length,
    removed: 0
  }
}

export async function diffGit(repo: VcsRepo, req: VcsDiffRequest): Promise<VcsDiffData> {
  const rel = normRel(req.rel)
  const full = rootRel(repo, rel)
  const revision = req.source === 'revision' ? checkRevision('git', req.revision) : undefined
  if (req.source === 'revision' && !revision) {
    throw new VcsOpError('invalid-path', '缺少 commit')
  }

  if (req.source === 'working' || req.source === 'head') {
    const tracked = await runGit(repo.root, ['ls-files', '--error-unmatch', '--', full], {
      timeoutMs: 8_000
    })
    if (tracked.code !== 0) return untrackedDiff(repo, rel, req.source)
  }

  const base = ['--no-color', '--no-ext-diff', '--no-textconv', '--unified=3']
  const args =
    req.source === 'staged'
      ? ['diff', '--cached', ...base, '--', full]
      : req.source === 'revision'
        ? ['show', ...base, '--format=', revision!, '--', full]
        : req.source === 'head'
          ? ['diff', 'HEAD', ...base, '--', full]
          : ['diff', ...base, '--', full]

  const r = await runGit(repo.root, args, { timeoutMs: 30_000, maxStdoutBytes: 4 * 1024 * 1024 })
  if (r.code !== 0) throw mapCliError('git', r)

  const diff = r.stdout
  const binary = /^Binary files /m.test(diff) || /^GIT binary patch/m.test(diff)
  const stat = countDiff(diff)
  return {
    repoKind: 'git',
    rel,
    source: req.source,
    diff,
    binary,
    untracked: false,
    truncated: r.stdoutTruncated,
    added: stat.added,
    removed: stat.removed,
    revision
  }
}

function parseLogRecords(raw: string, limit: number, skip: number): VcsLogPage {
  const entries = raw
    .split('\x1e')
    .map((s) => s.replace(/^\r?\n/, '').trimEnd())
    .filter(Boolean)
    .map((rec) => {
      const [id, shortId, author, email, date, subject, message, parents, refs] = rec.split('\x00')
      return {
        id: id ?? '',
        shortId: shortId ?? '',
        author: author ?? '',
        email: email || undefined,
        date: date ?? '',
        subject: subject ?? '',
        message: message ?? '',
        parents: parents ? parents.split(' ').filter(Boolean) : undefined,
        refs: refs ? refs.split(',').map((s) => s.trim()).filter(Boolean) : undefined
      }
    })
  return {
    entries,
    nextCursor: entries.length === limit ? String(skip + entries.length) : undefined
  }
}

export async function logGit(repo: VcsRepo, req: VcsLogRequest): Promise<VcsLogPage> {
  const limit = Math.min(Math.max(req.limit ?? 20, 1), 100)
  const skip = Math.max(0, Number(req.cursor) || 0)
  const args = ['log', `-n${limit}`, '--no-color', `--pretty=format:${FORMAT_LOG}`]
  if (skip > 0) args.push(`--skip=${skip}`)
  if (req.rel) args.push('--', rootRel(repo, req.rel))
  const r = await runGit(repo.root, args, { timeoutMs: 20_000, maxStdoutBytes: 8 * 1024 * 1024 })
  if (r.code !== 0) {
    if (/does not have any commits yet|unknown revision/.test(r.stderr)) return { entries: [] }
    throw mapCliError('git', r)
  }
  return parseLogRecords(r.stdout, limit, skip)
}

function parseLogMeta(raw: string): {
  entry: VcsCommitDetailData['entry']
  parents?: string[]
} {
  const rec = raw.split('\x1e')[0]?.replace(/^\r?\n/, '') ?? ''
  const [id, shortId, author, email, date, subject, message, parents, refs] = rec.split('\x00')
  return {
    entry: {
      id: id ?? '',
      shortId: shortId ?? '',
      author: author ?? '',
      email: email || undefined,
      date: date ?? '',
      subject: subject ?? '',
      message: message ?? '',
      refs: refs ? refs.split(',').map((s) => s.trim()).filter(Boolean) : undefined
    },
    parents: parents ? parents.split(' ').filter(Boolean) : undefined
  }
}

export async function commitDetailGit(
  repo: VcsRepo,
  id: string
): Promise<VcsCommitDetailData> {
  const rev = checkRevision('git', id)
  if (!rev) throw new VcsOpError('invalid-path', '缺少 commit')

  const metaR = await runGit(repo.root, ['show', '-s', '--no-color', `--format=${FORMAT_META}`, rev], {
    timeoutMs: 15_000
  })
  if (metaR.code !== 0) throw mapCliError('git', metaR)
  const meta = parseLogMeta(metaR.stdout)

  const [nameR, numR, diffR] = await Promise.all([
    runGit(repo.root, ['diff-tree', '--no-commit-id', '--name-status', '-r', rev], {
      timeoutMs: 15_000
    }),
    runGit(repo.root, ['diff-tree', '--no-commit-id', '--numstat', '-r', rev], {
      timeoutMs: 15_000
    }),
    runGit(
      repo.root,
      ['show', '--no-color', '--no-ext-diff', '--no-textconv', '--format=', '--unified=3', rev],
      { timeoutMs: 30_000, maxStdoutBytes: 4 * 1024 * 1024 }
    )
  ])
  if (nameR.code !== 0) throw mapCliError('git', nameR)

  const stats = new Map<string, { additions?: number; deletions?: number; binary?: boolean }>()
  for (const line of numR.stdout.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    if (!m) continue
    const binary = m[1] === '-' || m[2] === '-'
    stats.set(m[3], {
      additions: binary ? undefined : Number(m[1]),
      deletions: binary ? undefined : Number(m[2]),
      binary
    })
  }

  const files = []
  for (const line of nameR.stdout.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    const code = parts[0]?.[0] ?? 'M'
    const oldPath = parts.length > 2 ? parts[1] : ''
    const newPath = parts.length > 2 ? parts[2] : parts[1] ?? ''
    const rel = toWorkspaceRel(repo, newPath)
    if (!rel) continue
    const s = stats.get(newPath)
    files.push({
      rel,
      oldRel: oldPath ? toWorkspaceRel(repo, oldPath) ?? undefined : undefined,
      status: (['A', 'D', 'M', 'R', 'C'].includes(code) ? code : 'M') as VcsChange,
      additions: s?.additions,
      deletions: s?.deletions,
      binary: s?.binary
    })
  }

  return {
    entry: { ...meta.entry, parents: meta.parents },
    files,
    diff: diffR.code === 0 ? diffR.stdout : '',
    truncated: diffR.stdoutTruncated
  }
}

/* ── 写操作 ───────────────────────────────────────────── */

function mutation(paths: string[], conflicts?: string[]): VcsMutationData {
  return { affected: paths.length, paths, ...(conflicts ? { conflicts } : {}) }
}

async function checkedPaths(repo: VcsRepo, paths: string[]): Promise<{ rels: string[]; fulls: string[] }> {
  const rels = paths.map(normRel).filter(Boolean)
  if (!rels.length) throw new VcsOpError('invalid-path', '没有选中文件')
  return { rels, fulls: rels.map((p) => rootRel(repo, p)) }
}

export async function stageGit(repo: VcsRepo, req: VcsPathsRequest): Promise<VcsMutationData> {
  const { rels, fulls } = await checkedPaths(repo, req.paths)
  const r = await runGit(repo.root, ['add', '--', ...fulls], { timeoutMs: 60_000 })
  if (r.code !== 0) throw mapCliError('git', r)
  return mutation(rels)
}

export async function unstageGit(repo: VcsRepo, req: VcsPathsRequest): Promise<VcsMutationData> {
  const { rels, fulls } = await checkedPaths(repo, req.paths)
  const head = await runGit(repo.root, ['rev-parse', '--verify', 'HEAD'], { timeoutMs: 8_000 })
  const args =
    head.code === 0
      ? ['restore', '--staged', '--', ...fulls]
      : ['rm', '--cached', '--ignore-unmatch', '--', ...fulls]
  const r = await runGit(repo.root, args, { timeoutMs: 60_000 })
  if (r.code !== 0) throw mapCliError('git', r)
  return mutation(rels)
}

export async function discardGit(repo: VcsRepo, req: VcsDiscardRequest): Promise<VcsMutationData> {
  const { rels, fulls } = await checkedPaths(repo, req.paths)
  const tracked: string[] = []
  const removed: string[] = []

  for (let i = 0; i < fulls.length; i++) {
    const check = await runGit(repo.root, ['ls-files', '--error-unmatch', '--', fulls[i]], {
      timeoutMs: 8_000
    })
    if (check.code === 0) {
      tracked.push(fulls[i])
    } else if (req.includeUntracked) {
      const { rm } = await import('node:fs/promises')
      await rm(absPath(repo, rels[i]), { force: true })
      removed.push(rels[i])
    }
  }

  if (tracked.length) {
    const r = await runGit(
      repo.root,
      ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked],
      { timeoutMs: 60_000 }
    )
    if (r.code !== 0) {
      // 暂存区里的新文件不在 HEAD 中，restore 会失败；退化成取消暂存，保留工作区文件
      const unstage = await runGit(repo.root, ['rm', '--cached', '--ignore-unmatch', '--', ...tracked], {
        timeoutMs: 60_000
      })
      if (unstage.code !== 0) throw mapCliError('git', r)
    }
  }

  return mutation([...rels.filter((r) => !removed.includes(r)), ...removed])
}

export async function resolveGit(repo: VcsRepo, req: VcsResolveRequest): Promise<VcsMutationData> {
  const { rels, fulls } = await checkedPaths(repo, req.paths)
  for (let i = 0; i < fulls.length; i++) {
    if (req.side === 'working') {
      try {
        const buf = await readFile(absPath(repo, rels[i]), 'utf8')
        if (/^<{7}|^={7}|^>{7}/m.test(buf)) {
          throw new VcsOpError('conflict', '文件里还有冲突标记，请先在外部编辑器里解决')
        }
      } catch (err) {
        if (err instanceof VcsOpError) throw err
      }
    } else {
      const r = await runGit(
        repo.root,
        ['checkout', req.side === 'ours' ? '--ours' : '--theirs', '--', fulls[i]],
        { timeoutMs: 30_000 }
      )
      if (r.code !== 0) throw mapCliError('git', r)
    }
    const add = await runGit(repo.root, ['add', '--', fulls[i]], { timeoutMs: 30_000 })
    if (add.code !== 0) throw mapCliError('git', add)
  }
  return mutation(rels)
}

export async function commitGit(repo: VcsRepo, req: VcsCommitRequest): Promise<VcsCommitData> {
  const message = req.message.trim()
  if (!message) throw new VcsOpError('unknown', '提交信息不能为空')
  const args = ['commit', '-F', '-']
  if (req.amend) args.push('--amend')
  const r = await runGit(repo.root, args, {
    stdin: message.endsWith('\n') ? message : `${message}\n`,
    timeoutMs: 300_000
  })
  if (r.code !== 0) throw mapCliError('git', r)

  const [headR, shortR, filesR] = await Promise.all([
    runGit(repo.root, ['rev-parse', 'HEAD'], { timeoutMs: 8_000 }),
    runGit(repo.root, ['rev-parse', '--short', 'HEAD'], { timeoutMs: 8_000 }),
    runGit(repo.root, ['show', '--name-only', '--format=', 'HEAD'], { timeoutMs: 15_000 })
  ])
  const files = filesR.code === 0 ? filesR.stdout.split('\n').filter(Boolean).length : 0
  return {
    id: headR.stdout.trim(),
    shortId: shortR.stdout.trim(),
    summary: message.split('\n')[0],
    files
  }
}

export async function fetchGit(repo: VcsRepo, signal?: AbortSignal): Promise<VcsSyncData> {
  if (!repo.remote) throw new VcsOpError('unknown', '没有配置远端仓库')
  const r = await runGit(repo.root, ['fetch', repo.remote, '--prune'], {
    timeoutMs: 300_000,
    signal
  })
  if (r.code !== 0) throw mapCliError('git', r)
  return { summary: '已获取最新引用' }
}

export async function pullGit(
  repo: VcsRepo,
  _req: VcsPullRequest,
  signal?: AbortSignal
): Promise<VcsSyncData> {
  if (!repo.remote) throw new VcsOpError('unknown', '没有配置远端仓库')
  const args = repo.upstream
    ? ['pull', '--ff-only']
    : ['pull', '--ff-only', repo.remote, repo.branch]
  const r = await runGit(repo.root, args, { timeoutMs: 300_000, signal })
  if (r.code !== 0) throw mapCliError('git', r)
  const status = await statusGit(repo, { cwd: repo.root })
  return {
    summary: '已拉取最新提交',
    conflicts: status.files.filter((f) => f.conflict).map((f) => f.rel),
    ahead: status.repo.ahead,
    behind: status.repo.behind
  }
}

export async function pushGit(
  repo: VcsRepo,
  req: VcsPushRequest,
  signal?: AbortSignal
): Promise<VcsSyncData> {
  if (repo.detached) throw new VcsOpError('unknown', '当前是 detached HEAD，不能推送')
  if (!repo.remote) throw new VcsOpError('unknown', '没有配置远端仓库')
  const args =
    req.setUpstream || !repo.upstream
      ? ['push', '--set-upstream', repo.remote, repo.branch]
      : ['push']
  const r = await runGit(repo.root, args, { timeoutMs: 300_000, signal })
  if (r.code !== 0) throw mapCliError('git', r)
  return { summary: '已推送', remote: 'origin', branch: repo.branch }
}

export async function updateGit(): Promise<VcsSyncData> {
  throw new VcsOpError('unsupported', 'Git 使用 pull 更新')
}
