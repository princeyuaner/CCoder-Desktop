import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
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
  const abs = absOf(cwd, raw)
  const rel = posix(relative(resolve(cwd), abs))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel
}

/** svn 的 XML 里 path 可能是相对当前 cwd 的 */
function absOf(base: string, raw: string): string {
  return isAbsolute(raw) ? resolve(raw) : resolve(base, raw)
}

/** 绝对路径 → 相对 workspace 的 POSIX 路径；不在 workspace 里返回 null */
function relUnder(workspace: string, abs: string): string | null {
  const rel = posix(relative(resolve(workspace), resolve(abs)))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel
}

/** 路径比较用的键：Windows 上大小写不敏感 */
function absKey(p: string): string {
  const r = resolve(p)
  return process.platform === 'win32' ? r.toLowerCase() : r
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
  incomplete: '!',
  merged: 'M'
}

/**
 * 解析一次 `svn status --xml`。
 *
 * status 默认会递归到外链工作副本里，所以外链里的改动和父工作副本的改动
 * 在同一次输出里；外链目录本身额外有一条 item=external 记录，只用来标记
 * 「哪些路径属于外链」，不能当成文件改动。
 */
function parseStatusXml(
  xml: string,
  base: string,
  workspace: string
): { files: VcsFile[]; externals: string[] } {
  const files: VcsFile[] = []
  const externals: string[] = []

  for (const ent of allEntries(xml)) {
    const rawPath = attr(ent.attrs, 'path')
    const abs = absOf(base, rawPath)
    const rel = relUnder(workspace, abs)
    if (!rel) continue

    const wc = /<wc-status\b([^>]*)>/.exec(ent.body)?.[1] ?? ''
    const item = attr(wc, 'item')
    if (item === 'external') {
      externals.push(rel)
      continue
    }
    if (item === 'ignored') continue

    const props = attr(wc, 'props')
    const treeConflicted = attr(wc, 'tree-conflicted') === 'true'
    const propertyChange = props === 'modified' || props === 'conflicted'
    if (item === 'normal' || item === 'none') {
      if (!propertyChange && !treeConflicted) continue
    }

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

  return { files, externals }
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

  const { files, externals } = parseStatusXml(r.stdout, workspace, workspace)
  // 按路径前缀判断文件属于哪个外链；外链可以嵌套，取最深的那个
  const roots = externals.sort((a, b) => b.length - a.length)
  for (const f of files) {
    const root = roots.find((ext) => f.rel === ext || f.rel.startsWith(`${ext}/`))
    if (!root) continue
    f.external = true
    f.externalRoot = root
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

/**
 * 求某个提交路径应该用哪个目录去问工作副本根。
 *
 * 目录（尤其是外链根目录）必须用自己 —— 外链根就是它自己工作副本的根；
 * 文件用所在目录；已删除 / 不存在的路径向上找到最近仍存在的目录。
 */
function wcTargetFor(abs: string): string {
  try {
    if (statSync(abs).isDirectory()) return abs
  } catch {
    // 删除 / 不存在的路径走下面的兜底
  }
  let dir = dirname(abs)
  for (let i = 0; i < 64; i++) {
    if (existsSync(dir)) return dir
    const up = dirname(dir)
    if (up === dir) return dir
    dir = up
  }
  return dir
}

async function svnInfoRoot(repo: VcsRepo, dir: string): Promise<string | null> {
  const r = await runSvn(repo.root, ['info', '--xml', '--', dir], { timeoutMs: 15_000 })
  if (r.code !== 0) return null
  const ent = allEntries(r.stdout)[0]
  return ent ? textTag(ent.body, 'wcroot-abspath') || null : null
}

/**
 * 按工作副本根给待提交路径分组。
 *
 * 外链是独立的工作副本（自己的 .svn、自己的仓库），svn 不允许一次提交里
 * 混合多个工作副本（E200007），所以必须拆成多次 commit。
 */
async function groupByWcRoot(
  repo: VcsRepo,
  abs: string[]
): Promise<Array<{ root: string; abs: string[] }>> {
  const dirs = [...new Set(abs.map(wcTargetFor))]
  const roots = new Map<string, string>()

  if (dirs.length) {
    const r = await runSvn(repo.root, ['info', '--xml', '--', ...dirs], {
      timeoutMs: 20_000,
      maxStdoutBytes: 4 * 1024 * 1024
    })
    if (r.code === 0) {
      for (const ent of allEntries(r.stdout)) {
        const p = attr(ent.attrs, 'path')
        const root = textTag(ent.body, 'wcroot-abspath')
        if (!p || !root) continue
        roots.set(absKey(absOf(repo.root, p)), resolve(root))
      }
    }
  }

  // 批量 info 会因个别目录未纳入版本控制而整体非 0；漏掉的目录再逐个问一次
  const missing = dirs.filter((d) => !roots.has(absKey(d)))
  if (missing.length) {
    const found = await Promise.all(missing.map((d) => svnInfoRoot(repo, d)))
    missing.forEach((d, i) => {
      const root = found[i]
      if (root) roots.set(absKey(d), resolve(root))
    })
  }

  const groups = new Map<string, { root: string; abs: string[] }>()
  for (const p of abs) {
    const root = roots.get(absKey(wcTargetFor(p))) ?? resolve(repo.root)
    const key = absKey(root)
    const group = groups.get(key) ?? { root, abs: [] }
    group.abs.push(p)
    groups.set(key, group)
  }
  return [...groups.values()]
}

function wcLabel(repo: VcsRepo, root: string): string {
  if (absKey(root) === absKey(repo.root)) return '主工作副本'
  return posix(relative(repo.root, root)) || root
}

export async function commitSvn(repo: VcsRepo, req: VcsCommitRequest): Promise<VcsCommitData> {
  const message = req.message.trim()
  if (!message) throw new VcsOpError('unknown', '提交信息不能为空')
  const { rels, abs } = checked(repo, req.paths ?? [])
  const groups = await groupByWcRoot(repo, abs)
  // 父工作副本先提交，外链按路径排序，失败时更容易判断进行到哪一步
  groups.sort((a, b) => {
    const ap = absKey(a.root) === absKey(repo.root) ? 0 : 1
    const bp = absKey(b.root) === absKey(repo.root) ? 0 : 1
    return ap - bp || a.root.localeCompare(b.root)
  })

  const stdin = message.endsWith('\n') ? message : `${message}\n`
  const revisions: number[] = []
  const done: string[] = []

  for (const group of groups) {
    const r = await runSvn(
      group.root,
      ['commit', '-F', '-', '--encoding', 'UTF-8', '--', ...group.abs],
      { stdin, timeoutMs: 300_000 }
    )
    if (r.code !== 0) {
      const err = mapCliError('svn', r)
      if (done.length) {
        throw new VcsOpError(
          err.code,
          `部分提交已完成（${done.join('、')}），${wcLabel(repo, group.root)} 提交失败：${err.message}`,
          err.detail
        )
      }
      throw err
    }
    const m = /Committed revision (\d+)/i.exec(`${r.stdout}\n${r.stderr}`)
    if (m) {
      revisions.push(Number(m[1]))
      done.push(`r${m[1]}`)
    } else {
      // 没有实际改动时 svn 不输出 Committed；记下是哪个工作副本处理过了
      done.push(wcLabel(repo, group.root))
    }
  }

  if (!revisions.length) {
    const head = await svnHeadRevision(repo)
    if (head) revisions.push(head)
  }
  const revision = revisions[revisions.length - 1] ?? 0
  return {
    id: String(revision),
    shortId: revisions.map((n) => `r${n}`).join(' / '),
    revision,
    revisions,
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
