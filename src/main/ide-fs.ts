import { promises as fs } from 'node:fs'
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import type {
  IdeCreateRequest,
  IdeDeleteRequest,
  IdeDeleteResult,
  IdeEntry,
  IdeEntryChange,
  IdeEol,
  IdeFsErrorCode,
  IdeFsResult,
  IdeImage,
  IdeRenameRequest,
  IdeSaveRequest,
  IdeSearchFile,
  IdeSearchMatch,
  IdeTextFile
} from '../shared/ide'
import { listWorkspaceFiles, WORKSPACE_IGNORE_DIRS } from './workspace-search'

/**
 * 内置 IDE 的主进程侧：文件读写、新建/重命名/删除、代码搜索。
 * 版本控制在 main/vcs 里。
 *
 * 所有入口都收 `(cwd, rel)`，并且先做越界检查 —— 渲染进程拿不到 fs，
 * 但 IPC 参数仍可能被伪造，不能假设它一定传的是工作区内的路径。
 * 写操作还要求调用方是绑定了该工作区的 IDE 窗口（见 main/index.ts）。
 */

/** 文本读取上限；超过就截断并标记，避免一次 IPC 把几 MB 的产物塞进渲染层 */
const MAX_TEXT_BYTES = 2 * 1024 * 1024
/** 单次保存上限；正常编辑远小于这个值 */
const MAX_WRITE_BYTES = 8 * 1024 * 1024
/** 代码搜索单文件上限 */
const MAX_SEARCH_FILE_BYTES = 1024 * 1024
/** 图片上限 */
const MAX_IMAGE_BYTES = 24 * 1024 * 1024
/** 代码搜索的总预算 */
const SEARCH_DEADLINE_MS = 4000
const SEARCH_MAX_FILES = 5000
const SEARCH_MAX_MATCHES = 200
const SEARCH_MAX_FILES_WITH_HITS = 50

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif'
}

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.pdf',
  '.zip', '.gz', '.tar', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.bin',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.mov', '.avi',
  '.wav', '.webm', '.db', '.sqlite', '.class', '.jar', '.pyc', '.node'
])

const LANGUAGE: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript React',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript React',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.json': 'JSON',
  '.jsonc': 'JSON',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.less': 'LESS',
  '.html': 'HTML',
  '.htm': 'HTML',
  '.md': 'Markdown',
  '.mdx': 'Markdown',
  '.py': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.java': 'Java',
  '.c': 'C',
  '.h': 'C',
  '.cpp': 'C++',
  '.hpp': 'C++',
  '.cs': 'C#',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.ps1': 'PowerShell',
  '.yml': 'YAML',
  '.yaml': 'YAML',
  '.toml': 'TOML',
  '.sql': 'SQL',
  '.xml': 'XML',
  '.svg': 'SVG',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.txt': 'Text'
}

function languageOf(rel: string): string {
  const name = basename(rel)
  if (name === 'Dockerfile') return 'Dockerfile'
  if (name === 'Makefile') return 'Makefile'
  return LANGUAGE[extname(name).toLowerCase()] ?? 'Text'
}

function posix(p: string): string {
  return p.replace(/\\/g, '/')
}

function normRel(rel: string): string {
  return posix(rel || '').replace(/^\/+|\/+$/g, '')
}

/** 只做字面比较，不碰 fs —— 用于可能已删除的路径 */
function resolveInside(cwd: string, rel: string): string {
  const root = resolve(cwd)
  const abs = resolve(root, normRel(rel) || '.')
  const r = relative(root, abs)
  if (r.startsWith('..') || isAbsolute(r)) throw new Error('路径不在工作区内')
  return abs
}

/** 真实路径也要在真实根目录下 —— 防止工作区里的符号链接指到外面 */
async function realInside(cwd: string, rel: string): Promise<string> {
  const rootReal = await fs.realpath(resolve(cwd))
  const abs = resolveInside(cwd, rel)
  const real = await fs.realpath(abs)
  const r = relative(rootReal, real)
  if (r.startsWith('..') || isAbsolute(r)) throw new Error('路径不在工作区内')
  return real
}

/* ── 写操作 ───────────────────────────────────────────── */

class IdeFsError extends Error {
  readonly code: IdeFsErrorCode

  constructor(code: IdeFsErrorCode, message: string) {
    super(message)
    this.name = 'IdeFsError'
    this.code = code
  }
}

function ok<T>(data: T): IdeFsResult<T> {
  return { ok: true, data }
}

function failure(code: IdeFsErrorCode, message: string): IdeFsResult<never> {
  return { ok: false, code, message }
}

function errorCode(err: unknown): string {
  return err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : ''
}

function toFailure(err: unknown): IdeFsResult<never> {
  if (err instanceof IdeFsError) return failure(err.code, err.message)
  switch (errorCode(err)) {
    case 'EEXIST':
      return failure('exists', '同名文件或文件夹已经存在')
    case 'ENOENT':
      return failure('missing', '文件或文件夹不存在')
    case 'EACCES':
    case 'EPERM':
      return failure('forbidden', '没有权限修改这个路径')
    case 'ENOSPC':
      return failure('too-large', '磁盘空间不足')
    default:
      return failure('unknown', err instanceof Error ? err.message : String(err))
  }
}

/**
 * 写路径的严格校验：拒绝绝对路径、`..`、空段和控制字符。
 * 只读接口仍走 normRel（兼容旧行为）；写操作不能接受任何歧义。
 */
function writeRel(rel: unknown): string {
  const raw = typeof rel === 'string' ? rel : ''
  if (!raw || raw.includes('\0') || /[\r\n]/.test(raw)) {
    throw new IdeFsError('invalid-path', '文件路径不合法')
  }
  if (isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    throw new IdeFsError('invalid-path', '必须使用工作区相对路径')
  }
  const p = posix(raw).replace(/^\/+|\/+$/g, '')
  const segments = p.split('/')
  if (!p || segments.some((s) => !s || s === '.' || s === '..')) {
    throw new IdeFsError('invalid-path', '文件路径不合法')
  }
  return p
}

function writeTarget(cwd: string, rel: unknown): { rel: string; abs: string } {
  if (!cwd || typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new IdeFsError('invalid-path', '工作区路径不合法')
  }
  const clean = writeRel(rel)
  const root = resolve(cwd)
  const abs = resolve(root, clean)
  const r = relative(root, abs)
  if (!r || r.startsWith('..') || isAbsolute(r)) {
    throw new IdeFsError('invalid-path', '路径不在工作区内')
  }
  return { rel: clean, abs }
}

async function lstatOrNull(abs: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.lstat(abs)
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return null
    throw err
  }
}

/**
 * 新路径的父目录可能还不存在。先找到**已经存在**的最近祖先，确认它的真实
 * 路径仍在工作区内，再递归创建 —— 防止中间某层是符号链接指到工作区外。
 */
async function ensureParentInside(cwd: string, abs: string): Promise<void> {
  const rootReal = await fs.realpath(resolve(cwd))
  const parent = dirname(abs)
  let probe = parent

  for (;;) {
    try {
      const real = await fs.realpath(probe)
      const r = relative(rootReal, real)
      if (r.startsWith('..') || isAbsolute(r)) {
        throw new IdeFsError('invalid-path', '路径不在工作区内')
      }
      break
    } catch (err) {
      if (errorCode(err) === 'ENOENT') {
        const up = dirname(probe)
        if (up === probe) throw err
        probe = up
        continue
      }
      throw err
    }
  }

  if (parent !== probe) await fs.mkdir(parent, { recursive: true })

  const real = await fs.realpath(parent)
  const r = relative(rootReal, real)
  if (r.startsWith('..') || isAbsolute(r)) {
    throw new IdeFsError('invalid-path', '路径不在工作区内')
  }
}

/** 文件必须存在、是普通文件、不是符号链接 */
async function writableFile(cwd: string, rel: string, abs: string): Promise<string> {
  const ls = await lstatOrNull(abs)
  if (!ls) throw new IdeFsError('missing', '文件不存在')
  if (ls.isSymbolicLink()) throw new IdeFsError('invalid-path', '不支持写入符号链接')
  if (!ls.isFile()) throw new IdeFsError('not-file', '目标不是普通文件')
  const real = await realInside(cwd, rel)
  const st = await fs.stat(real)
  if (!st.isFile()) throw new IdeFsError('not-file', '目标不是普通文件')
  return real
}

function eolOf(text: string): IdeEol {
  const crlf = text.match(/\r\n/g)?.length ?? 0
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf
  return crlf > 0 && crlf >= lf ? 'crlf' : 'lf'
}

export async function saveTextFile(req: IdeSaveRequest): Promise<IdeFsResult<IdeTextFile>> {
  try {
    const cwd = req?.cwd
    const { rel, abs } = writeTarget(cwd, req?.rel)
    const raw = typeof req.text === 'string' ? req.text : ''
    if (raw.includes('\0')) throw new IdeFsError('binary', '内容里包含二进制字符，不能按文本保存')

    // 编辑器统一用 LF；落盘时还原原文件的换行风格
    const body = raw.replace(/\r\n?/g, '\n')
    const text = req.eol === 'crlf' ? body.replace(/\n/g, '\r\n') : body
    if (Buffer.byteLength(text, 'utf8') > MAX_WRITE_BYTES) {
      throw new IdeFsError('too-large', '文件超过 8 MB，暂不支持在 IDE 里保存')
    }

    const ls = await lstatOrNull(abs)
    if (ls) {
      const real = await writableFile(cwd, rel, abs)
      const st = await fs.stat(real)
      if (
        !req.force &&
        typeof req.expectedMtimeMs === 'number' &&
        Math.abs(st.mtimeMs - req.expectedMtimeMs) > 0.5
      ) {
        throw new IdeFsError('conflict', '文件已在磁盘上被修改')
      }
      await fs.writeFile(real, text, 'utf8')
    } else {
      if (!req.force && typeof req.expectedMtimeMs === 'number') {
        throw new IdeFsError('missing', '文件已在磁盘上被删除')
      }
      await ensureParentInside(cwd, abs)
      // wx：如果刚好有人抢先建了同名文件，不要覆盖
      await fs.writeFile(abs, text, { encoding: 'utf8', flag: 'wx' })
    }

    return ok(await readTextFile(cwd, rel))
  } catch (err) {
    return toFailure(err)
  }
}

export async function createEntry(
  req: IdeCreateRequest
): Promise<IdeFsResult<IdeEntryChange>> {
  try {
    const cwd = req?.cwd
    const { rel, abs } = writeTarget(cwd, req?.rel)
    if (req.kind !== 'file' && req.kind !== 'dir') {
      throw new IdeFsError('invalid-path', '未知的条目类型')
    }
    if (await lstatOrNull(abs)) throw new IdeFsError('exists', '同名文件或文件夹已经存在')

    await ensureParentInside(cwd, abs)
    if (req.kind === 'dir') {
      await fs.mkdir(abs)
    } else {
      const handle = await fs.open(abs, 'wx')
      await handle.close()
    }

    return ok({ entry: { name: basename(rel), rel, kind: req.kind } })
  } catch (err) {
    return toFailure(err)
  }
}

export async function renameEntry(
  req: IdeRenameRequest
): Promise<IdeFsResult<IdeEntryChange>> {
  try {
    const cwd = req?.cwd
    const from = writeTarget(cwd, req?.rel)
    const to = writeTarget(cwd, req?.to)
    if (from.rel === to.rel) {
      const ls = await lstatOrNull(from.abs)
      if (!ls) throw new IdeFsError('missing', '文件或文件夹不存在')
      return ok({
        entry: {
          name: basename(from.rel),
          rel: from.rel,
          kind: ls.isDirectory() ? 'dir' : 'file'
        }
      })
    }

    const ls = await lstatOrNull(from.abs)
    if (!ls) throw new IdeFsError('missing', '文件或文件夹不存在')
    if (ls.isSymbolicLink()) throw new IdeFsError('invalid-path', '不支持重命名符号链接')
    if (ls.isDirectory() && to.rel.startsWith(`${from.rel}/`)) {
      throw new IdeFsError('invalid-path', '不能把文件夹移动到它自己里面')
    }
    if (await lstatOrNull(to.abs)) throw new IdeFsError('exists', '目标路径已经存在')

    const real = await realInside(cwd, from.rel)
    await ensureParentInside(cwd, to.abs)
    await fs.rename(real, to.abs)

    return ok({
      entry: {
        name: basename(to.rel),
        rel: to.rel,
        kind: ls.isDirectory() ? 'dir' : 'file'
      },
      oldRel: from.rel
    })
  } catch (err) {
    return toFailure(err)
  }
}

export async function deleteEntry(
  req: IdeDeleteRequest
): Promise<IdeFsResult<IdeDeleteResult>> {
  try {
    const cwd = req?.cwd
    const { rel, abs } = writeTarget(cwd, req?.rel)
    const ls = await lstatOrNull(abs)
    if (!ls) throw new IdeFsError('missing', '文件或文件夹不存在')
    if (ls.isSymbolicLink()) throw new IdeFsError('invalid-path', '不支持删除符号链接')

    const real = await realInside(cwd, rel)
    const kind = ls.isDirectory() ? 'dir' : 'file'
    await fs.rm(real, { recursive: kind === 'dir', force: false })
    return ok({ rel, kind })
  } catch (err) {
    return toFailure(err)
  }
}

export async function listDir(cwd: string, rel: string): Promise<IdeEntry[]> {
  const real = await realInside(cwd, rel)
  const st = await fs.stat(real)
  if (!st.isDirectory()) return []

  const entries = await fs.readdir(real, { withFileTypes: true })
  const baseRel = normRel(rel)
  const out: IdeEntry[] = []

  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue
    if (ent.isDirectory() && WORKSPACE_IGNORE_DIRS.has(ent.name)) continue
    if (!ent.isDirectory() && !ent.isFile()) continue
    const childRel = baseRel ? `${baseRel}/${ent.name}` : ent.name
    out.push({
      name: ent.name,
      rel: posix(childRel),
      kind: ent.isDirectory() ? 'dir' : 'file'
    })
  }

  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
  return out.slice(0, 4000)
}

export async function readTextFile(cwd: string, rel: string): Promise<IdeTextFile> {
  const real = await realInside(cwd, rel)
  const st = await fs.stat(real)
  if (!st.isFile()) throw new Error('不是文件')

  const take = Math.min(st.size, MAX_TEXT_BYTES)
  const fd = await fs.open(real, 'r')
  let buf: Buffer
  try {
    buf = Buffer.alloc(take)
    await fd.read(buf, 0, take, 0)
  } finally {
    await fd.close()
  }

  // 前 8KB 里有 NUL 就当二进制；文本文件里出现 NUL 基本只会是数据文件
  const head = buf.subarray(0, Math.min(buf.length, 8192))
  const binary = head.includes(0)
  const decoded = binary ? '' : buf.toString('utf8')
  const eol = eolOf(decoded)
  const text = decoded.replace(/\r\n?/g, '\n')
  const truncated = st.size > take

  return {
    rel: posix(normRel(rel)),
    text,
    size: st.size,
    language: languageOf(rel),
    truncated,
    binary,
    mtimeMs: st.mtimeMs,
    eol,
    editable: !binary && !truncated
  }
}

export async function readImage(cwd: string, rel: string): Promise<IdeImage> {
  const ext = extname(rel).toLowerCase()
  const mime = IMAGE_MIME[ext]
  if (!mime) throw new Error('不是支持的图片格式')

  const real = await realInside(cwd, rel)
  const st = await fs.stat(real)
  if (!st.isFile() || st.size > MAX_IMAGE_BYTES) throw new Error('图片过大或不是文件')

  const buf = await fs.readFile(real)
  return {
    rel: posix(normRel(rel)),
    dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
    size: st.size,
    mime
  }
}

function matchLine(line: string, needle: string): number {
  const i = line.toLowerCase().indexOf(needle)
  return i
}

export async function searchCode(cwd: string, query: string): Promise<IdeSearchFile[]> {
  const needle = query.trim().toLowerCase()
  if (needle.length < 1) return []

  const all = await listWorkspaceFiles(cwd)
  const files = all.filter((f) => f.kind === 'file')
  const started = Date.now()
  const out: IdeSearchFile[] = []
  let scanned = 0
  let total = 0

  for (const f of files) {
    if (scanned++ > SEARCH_MAX_FILES) break
    if (Date.now() - started > SEARCH_DEADLINE_MS) break
    if (BINARY_EXT.has(extname(f.name).toLowerCase())) continue

    const abs = resolveInside(cwd, f.path)
    let st: import('node:fs').Stats
    try {
      st = await fs.stat(abs)
    } catch {
      continue
    }
    if (!st.isFile() || st.size > MAX_SEARCH_FILE_BYTES) continue

    let text: string
    try {
      text = await fs.readFile(abs, 'utf8')
    } catch {
      continue
    }
    if (text.includes('\0')) continue

    const matches: IdeSearchMatch[] = []
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const col = matchLine(lines[i], needle)
      if (col < 0) continue
      const raw = lines[i].trim()
      matches.push({
        line: i + 1,
        column: col + 1,
        text: raw.length > 240 ? `${raw.slice(0, 240)}…` : raw
      })
      total++
      if (total >= SEARCH_MAX_MATCHES) break
    }

    if (matches.length > 0) {
      out.push({ rel: f.path, name: f.name, matches })
      if (out.length >= SEARCH_MAX_FILES_WITH_HITS || total >= SEARCH_MAX_MATCHES) break
    }
  }

  return out
}

