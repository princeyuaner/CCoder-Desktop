import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type {
  VcsChange,
  VcsCommitData,
  VcsCommitDetailData,
  VcsCommitFile,
  VcsCommitRequest,
  VcsDiffData,
  VcsDiffRequest,
  VcsDiffSource,
  VcsFile,
  VcsLogEntry,
  VcsLogPage,
  VcsLogRequest,
  VcsMutationData,
  VcsPathsRequest,
  VcsRepo,
  VcsResolveRequest,
  VcsStatus,
  VcsStatusRequest,
  VcsSyncData,
  VcsUpdateRequest
} from '../../shared/vcs'
import { mapCliError, runSvn, VcsOpError } from './exec'
import { absPath, assertRealInside, countDiff, dirOf, nameOf, normRel, posix } from './paths'
import { readCapped } from './read'

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
}

function attr(attrs: string, name: string): string {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)
  return m ? decodeXml(m[1]) : ''
}

function textTag(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml)
  return m ? decodeXml(m[1].trim()) : ''
}

function allEntries(xml: string, tag = 'entry'): Array<{ attrs: string; body: string }> {
  const out: Array<{ attrs: string; body: string }> = []
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) out.push({ attrs: m[1], body: m[2] })
  return out
}

function toRel(cwd: string, raw: string): string | null {
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw)
  const rel = posix(relative(resolve(cwd), abs))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel
}

const ITEM_MAP: Record<string, VcsChange> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  replaced: 'R',
  conflicted: 'U',
  unversioned: '?',
  missing: '!',
  obstructed: '~',
  external: 'X',
  incomplete: '!',
  merged: 'M'
}

export async function statusSvn(repo: VcsRepo, _req: VcsStatusRequest): Promise<VcsStatus> {
  // 工作区可能是工作副本的子目录；从子目录跑 status，rel 才是相对工作区的，
  // 也不会把工作区外的改动混进来。
  const workspace = repo.workspacePrefix ? resolve(repo.root, repo.workspacePrefix) : repo.root
  const r = await runSvn(workspace, ['status', '--xml'], {
    timeoutMs: 30_000,
    maxStdoutBytes: 16 * 1024 * 1024
  })
  if (r.code !== 0) throw mapCliError('svn', r)

  const files: VcsFile[] = []
  for (const ent of allEntries(r.stdout)) {
    const rawPath = attr(ent.attrs, 'path')
    const rel = toRel(workspace, rawPath)
    if (!rel) continue
    const wc = /<wc-status\b([^>]*)>/.exec(ent.body)?.[1] ?? ''
    const item = attr(wc, 'item')
    const props = attr(wc, 'props')
    const treeConflicted = attr(wc, 'tree-conflicted') === 'true'
    const propertyChange = props === 'modified' || props === 'conflicted'
    if (item === 'normal' || item === 'none') {
      if (!propertyChange && !treeConflicted) continue
    }
    if (item === 'ignored') continue

    const conflict = item === 'conflicted' || treeConflicted || props === 'conflicted'
    const untracked = item === 'unversioned'
    // SVN 用 C 表示冲突；Git 用 U。UI 另外有 conflict 布尔字段，不靠字母猜。
    const status = conflict ? 'C' : ITEM_MAP[item] ?? 'M'
    const lockBody = /<lock\b[^>]*>([\s\S]*?)<\/lock>/.exec(ent.body)?.[1]
    const lock = lockBody ? textTag(lockBody, 'owner') : undefined
    const revision = attr(wc, 'revision') || undefined

    files.push({
      rel,
      name: nameOf(rel),
      dir: dirOf(rel),
      status,
      staged: false,
      unstaged: !untracked,
      untracked,
      conflict,
      lock: lock || undefined,
      changelist: attr(ent.attrs, 'changelist') || attr(wc, 'changelist') || undefined,
      revision,
      propertyChange
    })
  }

  files.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }))
  const counts = {
    total: files.length,
    staged: 0,
    unstaged: files.filter((f) => f.unstaged).length,
    untracked: files.filter((f) => f.untracked).length,
    conflicts: files.filter((f) => f.conflict).length
  }
  return { repo, files, counts, clean: files.length === 0 }
}

async function svnItem(repo: VcsRepo, rel: string): Promise<string | null> {
  const r = await runSvn(repo.root, ['status', '--xml', '--', absPath(repo, rel)], {
    timeoutMs: 10_000
  })
  if (r.code !== 0) return null
  const ent = allEntries(r.stdout)[0]
  return ent ? attr(/<wc-status\b([^>]*)>/.exec(ent.body)?.[1] ?? '', 'item') || null : null
}

async function untrackedDiff(
  repo: VcsRepo,
  rel: string,
  source: VcsDiffSource = 'working'
): Promise<VcsDiffData> {
  const abs = absPath(repo, rel)
  await assertRealInside(repo.root, abs)
  const f = await readCapped(abs)
  if (f.directory) {
    return {
      repoKind: 'svn',
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
      repoKind: 'svn',
      rel,
      source,
      diff: 'Cannot display: file marked as a binary type.\n',
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
  const diff = shown.length
    ? `Index: ${rel}\n===================================================================\n--- ${rel}\t(revision 0)\n+++ ${rel}\t(working copy)\n@@ -0,0 +1,${shown.length} @@\n${shown.map((l) => `+${l}`).join('\n')}\n`
    : ''
  return {
    repoKind: 'svn',
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

export async function diffSvn(repo: VcsRepo, req: VcsDiffRequest): Promise<VcsDiffData> {
  const rel = normRel(req.rel)
  const abs = absPath(repo, rel)
  const rev = req.source === 'revision' ? Number(req.revision) : NaN
  if (req.source === 'revision' && (!Number.isFinite(rev) || rev <= 0)) {
    throw new VcsOpError('invalid-path', '缺少 revision')
  }

  if (req.source === 'working' || req.source === 'head') {
    const item = await svnItem(repo, rel)
    if (item === 'unversioned') return untrackedDiff(repo, rel, req.source)
  }

  const args =
    req.source === 'revision'
      ? ['diff', '--internal-diff', '-c', String(rev), '--', abs]
      : ['diff', '--internal-diff', '--', abs]
  const r = await runSvn(repo.root, args, { timeoutMs: 30_000, maxStdoutBytes: 4 * 1024 * 1024 })
  if (r.code !== 0) throw mapCliError('svn', r)

  const diff = r.stdout
  const binary = /Cannot display: file marked as a binary type|^Binary files /m.test(diff)
  const propertyChange = /^Property changes on:/m.test(diff) && !/^@@ /m.test(diff)
  const stat = countDiff(diff)
  return {
    repoKind: 'svn',
    rel,
    source: req.source,
    diff,
    binary,
    untracked: false,
    truncated: r.stdoutTruncated,
    added: stat.added,
    removed: stat.removed,
    revision: req.source === 'revision' ? String(rev) : undefined,
    propertyChange
  }
}

function parseLogEntry(attrs: string, body: string): VcsLogEntry {
  const revision = Number(attr(attrs, 'revision')) || 0
  const message = textTag(body, 'msg')
  const paths = [...body.matchAll(/<path\b[^>]*>([\s\S]*?)<\/path>/g)].map((m) =>
    decodeXml(m[1].trim())
  )
  return {
    id: String(revision),
    shortId: `r${revision}`,
    revision,
    author: textTag(body, 'author'),
    date: textTag(body, 'date'),
    subject: message.split('\n')[0] ?? '',
    message,
    refs: paths.length ? paths : undefined
  }
}

export async function logSvn(repo: VcsRepo, req: VcsLogRequest): Promise<VcsLogPage> {
  const limit = Math.min(Math.max(req.limit ?? 20, 1), 100)
  const cursor = Math.max(0, Number(req.cursor) || 0)
  const range = cursor > 1 ? `${cursor}:1` : 'HEAD:1'
  const args = ['log', '--xml', '-l', String(limit), '-r', range]
  if (req.rel) args.push('--', absPath(repo, req.rel))
  const r = await runSvn(repo.root, args, { timeoutMs: 30_000, maxStdoutBytes: 8 * 1024 * 1024 })
  if (r.code !== 0) throw mapCliError('svn', r)

  const entries = allEntries(r.stdout, 'logentry').map((e) => parseLogEntry(e.attrs, e.body))
  const last = entries[entries.length - 1]?.revision ?? 0
  return {
    entries,
    nextCursor: entries.length === limit && last > 1 ? String(last - 1) : undefined
  }
}

export async function commitDetailSvn(
  repo: VcsRepo,
  id: string
): Promise<VcsCommitDetailData> {
  const rev = Number(id)
  if (!Number.isFinite(rev) || rev <= 0) throw new VcsOpError('invalid-path', 'revision 不合法')

  const [logR, sumR, diffR] = await Promise.all([
    runSvn(repo.root, ['log', '--xml', '-c', String(rev), '-v'], { timeoutMs: 20_000 }),
    runSvn(repo.root, ['diff', '--summarize', '-c', String(rev), repo.root], {
      timeoutMs: 20_000
    }),
    runSvn(repo.root, ['diff', '--internal-diff', '-c', String(rev), repo.root], {
      timeoutMs: 30_000,
      maxStdoutBytes: 4 * 1024 * 1024
    })
  ])
  if (logR.code !== 0) throw mapCliError('svn', logR)
  const ent = allEntries(logR.stdout, 'logentry')[0]
  const entry = ent
    ? parseLogEntry(ent.attrs, ent.body)
    : {
        id: String(rev),
        shortId: `r${rev}`,
        revision: rev,
        author: '',
        date: '',
        subject: '',
        message: ''
      }

  const files: VcsCommitFile[] = []
  if (sumR.code === 0) {
    for (const line of sumR.stdout.split('\n')) {
      const m = /^([AMDR])\s+(.+)$/.exec(line.trim())
      if (!m) continue
      const rel = toRel(repo.root, m[2])
      if (!rel) continue
      files.push({ rel, status: m[1] as VcsChange })
    }
  }

  return {
    entry,
    files,
    diff: diffR.code === 0 ? diffR.stdout : '',
    truncated: diffR.stdoutTruncated
  }
}

/* ── 写操作 ───────────────────────────────────────────── */

function mutation(paths: string[], conflicts?: string[]): VcsMutationData {
  return { affected: paths.length, paths, ...(conflicts ? { conflicts } : {}) }
}

function checked(repo: VcsRepo, paths: string[]): { rels: string[]; abs: string[] } {
  const rels = paths.map(normRel).filter(Boolean)
  if (!rels.length) throw new VcsOpError('invalid-path', '没有选中文件')
  return { rels, abs: rels.map((p) => absPath(repo, p)) }
}

/** 工作副本根的 revision 可能是 0（mixed revision）；仓库 HEAD 用 log 取最稳 */
async function svnHeadRevision(repo: VcsRepo): Promise<number> {
  const r = await runSvn(repo.root, ['log', '--xml', '-l', '1'], { timeoutMs: 15_000 })
  if (r.code !== 0) return 0
  const ent = allEntries(r.stdout, 'logentry')[0]
  return ent ? Number(attr(ent.attrs, 'revision')) || 0 : 0
}

export async function stageSvn(repo: VcsRepo, req: VcsPathsRequest): Promise<VcsMutationData> {
  const { rels, abs } = checked(repo, req.paths)
  const r = await runSvn(repo.root, ['add', '--force', '--parents', '--', ...abs], {
    timeoutMs: 60_000
  })
  if (r.code !== 0) throw mapCliError('svn', r)
  return mutation(rels)
}

export async function revertSvn(repo: VcsRepo, req: VcsPathsRequest): Promise<VcsMutationData> {
  const { rels, abs } = checked(repo, req.paths)
  const r = await runSvn(repo.root, ['revert', '-R', '--', ...abs], { timeoutMs: 60_000 })
  if (r.code !== 0) throw mapCliError('svn', r)
  return mutation(rels)
}

export async function resolveSvn(repo: VcsRepo, req: VcsResolveRequest): Promise<VcsMutationData> {
  const { rels, abs } = checked(repo, req.paths)
  if (req.side === 'working') {
    for (const path of abs) {
      try {
        const text = await readFile(path, 'utf8')
        if (/^<{7}|^={7}|^>{7}/m.test(text)) {
          throw new VcsOpError('conflict', '文件里还有冲突标记，请先在外侧编辑器里解决')
        }
      } catch (err) {
        if (err instanceof VcsOpError) throw err
      }
    }
  }
  const accept =
    req.side === 'ours' ? 'mine-full' : req.side === 'theirs' ? 'theirs-full' : 'working'
  const r = await runSvn(repo.root, ['resolve', '--accept', accept, '--', ...abs], {
    timeoutMs: 60_000
  })
  if (r.code !== 0) throw mapCliError('svn', r)
  return mutation(rels)
}

export async function commitSvn(repo: VcsRepo, req: VcsCommitRequest): Promise<VcsCommitData> {
  const message = req.message.trim()
  if (!message) throw new VcsOpError('unknown', '提交信息不能为空')
  const { rels, abs } = checked(repo, req.paths ?? [])
  const r = await runSvn(repo.root, ['commit', '-F', '-', '--encoding', 'UTF-8', '--', ...abs], {
    stdin: message.endsWith('\n') ? message : `${message}\n`,
    timeoutMs: 300_000
  })
  if (r.code !== 0) throw mapCliError('svn', r)
  const fromOutput = /Committed revision (\d+)/i.exec(`${r.stdout}\n${r.stderr}`)
  const revision = fromOutput ? Number(fromOutput[1]) : await svnHeadRevision(repo)
  return {
    id: String(revision),
    shortId: `r${revision}`,
    revision,
    summary: message.split('\n')[0],
    files: rels.length
  }
}

export async function updateSvn(
  repo: VcsRepo,
  req: VcsUpdateRequest,
  signal?: AbortSignal
): Promise<VcsSyncData> {
  const rev = req.revision && /^\d+$/.test(req.revision) ? req.revision : undefined
  const args = ['update', '--accept', 'postpone']
  if (rev) args.push('-r', rev)
  args.push(repo.root)
  const r = await runSvn(repo.root, args, { timeoutMs: 300_000, signal })
  if (r.code !== 0) throw mapCliError('svn', r)
  const status = await statusSvn(repo, { cwd: repo.root })
  return {
    summary: rev ? `已更新到 r${rev}` : '已更新到最新版本',
    conflicts: status.files.filter((f) => f.conflict).map((f) => f.rel),
    revision: await svnHeadRevision(repo)
  }
}

export async function fetchSvn(): Promise<VcsSyncData> {
  throw new VcsOpError('unsupported', 'SVN 使用「更新」获取最新版本')
}

export async function pullSvn(): Promise<VcsSyncData> {
  throw new VcsOpError('unsupported', 'SVN 使用「更新」获取最新版本')
}

export async function pushSvn(): Promise<VcsSyncData> {
  throw new VcsOpError('unsupported', 'SVN 没有单独的推送，提交即上传')
}

export async function unstageSvn(): Promise<VcsMutationData> {
  throw new VcsOpError('unsupported', 'SVN 没有暂存区')
}

export async function discardSvn(): Promise<VcsMutationData> {
  throw new VcsOpError('unsupported', 'SVN 使用「还原」')
}
