import { promises as fs } from 'node:fs'
import { t } from './i18n'
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
  IdeReplaceData,
  IdeReplaceFileResult,
  IdeReplaceRequest,
  IdeReplaceResult,
  IdeReplaceTotals,
  IdeSaveRequest,
  IdeSearchData,
  IdeSearchFile,
  IdeSearchMatch,
  IdeSearchRequest,
  IdeSearchResult,
  IdeTextFile
} from '../shared/ide'
import {
  listWorkspaceFilesDetailed,
  resetWorkspaceSearchCache,
  WORKSPACE_IGNORE_DIRS
} from './workspace-search'
import {
  collectSpans,
  compileGlobs,
  compileSearch,
  makeSnippet,
  replaceLine,
  SearchPatternError,
  type CompiledSearch
} from './ide-search'

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

/**
 * 全部替换的预算。替换和搜索不同：面板只展示前 200 处，但"全部替换"
 * 必须覆盖整个工作区 —— 所以它有自己的上限，并且一旦触顶就在**写盘前**
 * 整体中止，绝不静默只替换一部分。
 */
const REPLACE_DEADLINE_MS = 15_000
const REPLACE_MAX_FILES = 5000
const REPLACE_MAX_MATCHES = 50_000
const REPLACE_MAX_TOTAL_BYTES = 64 * 1024 * 1024
const REPLACE_MAX_RESULT_FILES = 500
const MAX_REPLACEMENT_CHARS = 100_000

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
  if (r.startsWith('..') || isAbsolute(r)) throw new Error(t('ideError.pathOutside'))
  return abs
}

/** 真实路径也要在真实根目录下 —— 防止工作区里的符号链接指到外面 */
async function realInside(cwd: string, rel: string): Promise<string> {
  const rootReal = await fs.realpath(resolve(cwd))
  const abs = resolveInside(cwd, rel)
  const real = await fs.realpath(abs)
  const r = relative(rootReal, real)
  if (r.startsWith('..') || isAbsolute(r)) throw new Error(t('ideError.pathOutside'))
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
  if (err instanceof SearchPatternError) return failure(err.code, err.message)
  switch (errorCode(err)) {
    case 'EEXIST':
      return failure('exists', t('ideError.exists'))
    case 'ENOENT':
      return failure('missing', t('ideError.missing'))
    case 'EACCES':
    case 'EPERM':
      return failure('forbidden', t('ideError.forbidden'))
    case 'ENOSPC':
      return failure('too-large', t('ideError.diskFull'))
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
    throw new IdeFsError('invalid-path', t('ideError.invalidPath'))
  }
  if (isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    throw new IdeFsError('invalid-path', t('ideError.relativeRequired'))
  }
  const p = posix(raw).replace(/^\/+|\/+$/g, '')
  const segments = p.split('/')
  if (!p || segments.some((s) => !s || s === '.' || s === '..')) {
    throw new IdeFsError('invalid-path', t('ideError.invalidPath'))
  }
  return p
}

function writeTarget(cwd: string, rel: unknown): { rel: string; abs: string } {
  if (!cwd || typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new IdeFsError('invalid-path', t('ideError.invalidWorkspace'))
  }
  const clean = writeRel(rel)
  const root = resolve(cwd)
  const abs = resolve(root, clean)
  const r = relative(root, abs)
  if (!r || r.startsWith('..') || isAbsolute(r)) {
    throw new IdeFsError('invalid-path', t('ideError.pathOutside'))
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
        throw new IdeFsError('invalid-path', t('ideError.pathOutside'))
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
    throw new IdeFsError('invalid-path', t('ideError.pathOutside'))
  }
}

/** 文件必须存在、是普通文件、不是符号链接 */
async function writableFile(cwd: string, rel: string, abs: string): Promise<string> {
  const ls = await lstatOrNull(abs)
  if (!ls) throw new IdeFsError('missing', t('ideError.fileMissing'))
  if (ls.isSymbolicLink()) throw new IdeFsError('invalid-path', t('ideError.symlinkWrite'))
  if (!ls.isFile()) throw new IdeFsError('not-file', t('ideError.notFile'))
  const real = await realInside(cwd, rel)
  const st = await fs.stat(real)
  if (!st.isFile()) throw new IdeFsError('not-file', t('ideError.notFile'))
  return real
}

function eolOf(text: string): IdeEol {
  const crlf = text.match(/\r\n/g)?.length ?? 0
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf
  return crlf > 0 && crlf >= lf ? 'crlf' : 'lf'
}

/**
 * 校验并写回一段文本（LF 输入，按 eol 还原）。保存和全部替换共用，
 * 保证越界 / 符号链接 / mtime 冲突 / 大小限制的行为完全一致。
 */
async function writeTextBody(
  cwd: string,
  rel: string,
  abs: string,
  textLf: string,
  eol: IdeEol | undefined,
  expectedMtimeMs: number | undefined,
  force: boolean
): Promise<void> {
  if (textLf.includes('\0')) {
    throw new IdeFsError('binary', t('ideError.binarySave'))
  }

  // 编辑器统一用 LF；落盘时还原原文件的换行风格
  const body = textLf.replace(/\r\n?/g, '\n')
  const text = eol === 'crlf' ? body.replace(/\n/g, '\r\n') : body
  if (Buffer.byteLength(text, 'utf8') > MAX_WRITE_BYTES) {
    throw new IdeFsError('too-large', t('ideError.tooLargeSave'))
  }

  const ls = await lstatOrNull(abs)
  if (ls) {
    const real = await writableFile(cwd, rel, abs)
    const st = await fs.stat(real)
    if (
      !force &&
      typeof expectedMtimeMs === 'number' &&
      Math.abs(st.mtimeMs - expectedMtimeMs) > 0.5
    ) {
      throw new IdeFsError('conflict', t('ideError.externalModified'))
    }
    await fs.writeFile(real, text, 'utf8')
  } else {
    if (!force && typeof expectedMtimeMs === 'number') {
      throw new IdeFsError('missing', t('ideError.externalDeleted'))
    }
    await ensureParentInside(cwd, abs)
    // wx：如果刚好有人抢先建了同名文件，不要覆盖
    await fs.writeFile(abs, text, { encoding: 'utf8', flag: 'wx' })
  }
}

export async function saveTextFile(req: IdeSaveRequest): Promise<IdeFsResult<IdeTextFile>> {
  try {
    const cwd = req?.cwd
    const { rel, abs } = writeTarget(cwd, req?.rel)
    const raw = typeof req.text === 'string' ? req.text : ''
    await writeTextBody(cwd, rel, abs, raw, req.eol, req.expectedMtimeMs, req.force === true)
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
      throw new IdeFsError('invalid-path', t('ideError.unknownEntry'))
    }
    if (await lstatOrNull(abs)) throw new IdeFsError('exists', t('ideError.exists'))

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
      if (!ls) throw new IdeFsError('missing', t('ideError.missing'))
      return ok({
        entry: {
          name: basename(from.rel),
          rel: from.rel,
          kind: ls.isDirectory() ? 'dir' : 'file'
        }
      })
    }

    const ls = await lstatOrNull(from.abs)
    if (!ls) throw new IdeFsError('missing', t('ideError.missing'))
    if (ls.isSymbolicLink()) throw new IdeFsError('invalid-path', t('ideError.symlinkRename'))
    if (ls.isDirectory() && to.rel.startsWith(`${from.rel}/`)) {
      throw new IdeFsError('invalid-path', t('ideError.moveIntoItself'))
    }
    if (await lstatOrNull(to.abs)) throw new IdeFsError('exists', t('ideError.targetExists'))

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
    if (!ls) throw new IdeFsError('missing', t('ideError.missing'))
    if (ls.isSymbolicLink()) throw new IdeFsError('invalid-path', t('ideError.symlinkDelete'))

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

/** 读文本：预期内的失败用 IdeFsResult 返回，UI 按 code 判断，不靠文案 */
export async function readTextFileResult(
  cwd: string,
  rel: string
): Promise<IdeFsResult<IdeTextFile>> {
  try {
    return ok(await readTextFile(cwd, rel))
  } catch (err) {
    return toFailure(err)
  }
}

export async function readTextFile(cwd: string, rel: string): Promise<IdeTextFile> {
  const real = await realInside(cwd, rel)
  const st = await fs.stat(real)
  if (!st.isFile()) throw new IdeFsError('not-file', t('ideError.notAFile'))

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

/** 读图片：同上，失败返回结构化 code */
export async function readImageResult(
  cwd: string,
  rel: string
): Promise<IdeFsResult<IdeImage>> {
  try {
    return ok(await readImage(cwd, rel))
  } catch (err) {
    return toFailure(err)
  }
}

export async function readImage(cwd: string, rel: string): Promise<IdeImage> {
  const ext = extname(rel).toLowerCase()
  const mime = IMAGE_MIME[ext]
  if (!mime) throw new IdeFsError('not-file', t('ideError.unsupportedImage'))

  const real = await realInside(cwd, rel)
  const st = await fs.stat(real)
  if (!st.isFile()) throw new IdeFsError('not-file', t('ideError.notAFile'))
  if (st.size > MAX_IMAGE_BYTES) throw new IdeFsError('too-large', t('ideError.imageTooLarge'))

  const buf = await fs.readFile(real)
  return {
    rel: posix(normRel(rel)),
    dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
    size: st.size,
    mime
  }
}

type CandidateRead =
  | { ok: true; textLf: string; eol: IdeEol; mtimeMs: number }
  | { ok: false; reason: 'large' | 'binary' | 'io' }

/**
 * 搜索 / 替换的候选文件读取。
 *
 * 必须用 fatal 的 UTF-8 解码：替换会把内容写回磁盘，如果按宽松解码把
 * 非法字节变成 U+FFFD，再写回去就把原文件毁了。BOM 要保留（ignoreBOM），
 * 否则替换会顺手把 BOM 删掉。
 */
async function readCandidateText(abs: string): Promise<CandidateRead> {
  let st: import('node:fs').Stats
  try {
    st = await fs.stat(abs)
  } catch {
    return { ok: false, reason: 'io' }
  }
  if (!st.isFile()) return { ok: false, reason: 'io' }
  if (st.size > MAX_SEARCH_FILE_BYTES) return { ok: false, reason: 'large' }

  let buf: Buffer
  try {
    buf = await fs.readFile(abs)
  } catch {
    return { ok: false, reason: 'io' }
  }
  if (buf.length > MAX_SEARCH_FILE_BYTES) return { ok: false, reason: 'large' }

  let raw: string
  try {
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf)
  } catch {
    return { ok: false, reason: 'binary' }
  }
  if (raw.includes('\0')) return { ok: false, reason: 'binary' }

  return {
    ok: true,
    textLf: raw.replace(/\r\n?/g, '\n'),
    eol: eolOf(raw),
    mtimeMs: st.mtimeMs
  }
}

function candidateFiles(
  files: { path: string; name: string; kind: 'file' | 'dir' }[],
  globs: { test(rel: string): boolean }
): { path: string; name: string; kind: 'file' | 'dir' }[] {
  return files
    .filter((f) => f.kind === 'file')
    .filter((f) => globs.test(f.path))
    .filter((f) => !BINARY_EXT.has(extname(f.name).toLowerCase()))
    .sort((a, b) => a.path.localeCompare(b.path))
}

export async function searchCode(req: IdeSearchRequest): Promise<IdeSearchResult> {
  try {
    const cwd = req?.cwd
    if (!cwd || typeof cwd !== 'string' || !isAbsolute(cwd)) {
      throw new IdeFsError('invalid-path', t('ideError.invalidWorkspace'))
    }

    const search = compileSearch(req?.query, req?.options)
    const globs = compileGlobs(req?.options)

    const scan = await listWorkspaceFilesDetailed(cwd)
    const files = candidateFiles(scan.files, globs)

    const started = Date.now()
    const out: IdeSearchFile[] = []
    let scanned = 0
    let total = 0
    let truncated = scan.truncated || scan.incomplete
    let note = truncated ? t('ideError.searchIncomplete') : undefined

    for (const f of files) {
      if (scanned >= SEARCH_MAX_FILES) {
        truncated = true
        note = t('ideError.searchTooMany')
        break
      }
      if (Date.now() - started > SEARCH_DEADLINE_MS) {
        truncated = true
        note = t('ideError.searchTimeout')
        break
      }
      scanned++

      const abs = resolveInside(cwd, f.path)
      const read = await readCandidateText(abs)
      if (!read.ok) continue

      const matches: IdeSearchMatch[] = []
      const lines = read.textLf.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const { spans } = collectSpans(lines[i], search.regex)
        for (const span of spans) {
          const snippet = makeSnippet(lines[i], span)
          matches.push({
            line: i + 1,
            column: span.index + 1,
            length: span.length,
            text: snippet.text,
            offset: snippet.offset
          })
          total++
          if (total >= SEARCH_MAX_MATCHES) break
        }
        if (total >= SEARCH_MAX_MATCHES) break
      }

      if (matches.length > 0) {
        out.push({ rel: f.path, name: f.name, matches })
        if (out.length >= SEARCH_MAX_FILES_WITH_HITS) {
          truncated = true
          note = t('ideError.searchTruncated', {
        files: SEARCH_MAX_FILES_WITH_HITS,
        matches: SEARCH_MAX_MATCHES
      })
          break
        }
      }
      if (total >= SEARCH_MAX_MATCHES) {
        truncated = true
        note = t('ideError.searchTruncated', {
        files: SEARCH_MAX_FILES_WITH_HITS,
        matches: SEARCH_MAX_MATCHES
      })
        break
      }
    }

    const data: IdeSearchData = {
      files: out,
      matchCount: total,
      scannedFiles: scanned,
      truncated,
      note
    }
    return ok(data)
  } catch (err) {
    return toFailure(err)
  }
}

function emptyTotals(): IdeReplaceTotals {
  return {
    filesScanned: 0,
    filesWithMatches: 0,
    filesChanged: 0,
    filesSkippedDirty: 0,
    filesSkippedBinary: 0,
    filesSkippedLarge: 0,
    filesConflicted: 0,
    filesErrored: 0,
    replacements: 0
  }
}

interface ReplacePlan {
  rel: string
  abs: string
  textLf: string
  originalTextLf: string
  eol: IdeEol
  mtimeMs: number
  count: number
}

/**
 * 工作区全部替换。
 *
 * 分两阶段：先把所有要写的文件读出来、算好新内容；任何上限触发都在
 * **写盘前**整体中止。这样"全部替换"不会出现只替换了一部分的半成品。
 * 有未保存修改的文件由渲染层通过 dirtyRels 传进来，一律跳过。
 */
export async function replaceInWorkspace(
  req: IdeReplaceRequest
): Promise<IdeReplaceResult> {
  try {
    const cwd = req?.cwd
    if (!cwd || typeof cwd !== 'string' || !isAbsolute(cwd)) {
      throw new IdeFsError('invalid-path', t('ideError.invalidWorkspace'))
    }
    if (typeof req?.query !== 'string') {
      throw new SearchPatternError('invalid-query', t('ideError.searchInvalid'))
    }
    const replacement = typeof req.replacement === 'string' ? req.replacement : ''
    if (replacement.length > MAX_REPLACEMENT_CHARS) {
      throw new SearchPatternError(
        'invalid-query',
        t('ideError.replacementLong', { n: MAX_REPLACEMENT_CHARS })
      )
    }
    if (replacement.includes('\0')) {
      throw new IdeFsError('binary', t('ideError.replacementBinary'))
    }

    const search: CompiledSearch = compileSearch(req.query, req.options)
    const globs = compileGlobs(req.options)

    // 脏文件集合：Windows 上路径大小写不敏感
    const dirty = new Set<string>()
    for (const rel of Array.isArray(req.dirtyRels) ? req.dirtyRels : []) {
      if (typeof rel !== 'string') continue
      const norm = posix(rel).replace(/^\/+|\/+$/g, '')
      if (!norm) continue
      dirty.add(process.platform === 'win32' ? norm.toLowerCase() : norm)
      if (dirty.size >= REPLACE_MAX_FILES) break
    }

    // 替换前强制重扫，绝不基于 15 秒内的旧列表写盘
    resetWorkspaceSearchCache()
    const scan = await listWorkspaceFilesDetailed(cwd)
    const totals = emptyTotals()

    if (scan.truncated || scan.incomplete) {
      return ok({
        files: [],
        totals,
        filesTruncated: false,
        aborted: true,
        message: t('ideError.replaceIncomplete2')
      })
    }

    const files = candidateFiles(scan.files, globs)
    const started = Date.now()
    const maxMatches =
      typeof req.maxReplacements === 'number' &&
      Number.isFinite(req.maxReplacements) &&
      req.maxReplacements > 0
        ? Math.min(REPLACE_MAX_MATCHES, Math.floor(req.maxReplacements))
        : REPLACE_MAX_MATCHES

    const plans: ReplacePlan[] = []
    const skippedResults: IdeReplaceFileResult[] = []
    let plannedBytes = 0
    let totalMatches = 0
    let abort: string | null = null

    for (const f of files) {
      if (totals.filesScanned >= REPLACE_MAX_FILES) {
        abort = t('ideError.replaceTooMany', { n: REPLACE_MAX_FILES })
        break
      }
      if (Date.now() - started > REPLACE_DEADLINE_MS) {
        abort = t('ideError.replaceScanTimeout')
        break
      }
      totals.filesScanned++

      const key = process.platform === 'win32' ? f.path.toLowerCase() : f.path
      if (dirty.has(key)) {
        totals.filesSkippedDirty++
        skippedResults.push({
          rel: f.path,
          replacements: 0,
          status: 'skipped',
          message: t('ideError.replaceDirty')
        })
        continue
      }

      const abs = resolveInside(cwd, f.path)
      const read = await readCandidateText(abs)
      if (!read.ok) {
        if (read.reason === 'large') totals.filesSkippedLarge++
        else if (read.reason === 'binary') totals.filesSkippedBinary++
        else totals.filesErrored++
        continue
      }

      const lines = read.textLf.split('\n')
      let count = 0
      const nextLines = lines.map((line) => {
        const r = replaceLine(line, search, replacement)
        count += r.count
        return r.text
      })
      if (count === 0) continue

      if (totalMatches + count > maxMatches) {
        abort = t('ideError.replaceMatchLimit', { n: maxMatches })
        break
      }

      const nextText = nextLines.join('\n')
      const bytes = Buffer.byteLength(nextText, 'utf8')
      if (plannedBytes + bytes > REPLACE_MAX_TOTAL_BYTES) {
        abort = t('ideError.replaceMemory')
        break
      }

      totalMatches += count
      plannedBytes += bytes
      totals.filesWithMatches++
      totals.replacements += count
      plans.push({
        rel: f.path,
        abs,
        textLf: nextText,
        originalTextLf: read.textLf,
        eol: read.eol,
        mtimeMs: read.mtimeMs,
        count
      })
    }

    if (abort) {
      // 中止时把已统计的跳过信息保留下来，方便 UI 解释发生了什么
      const partial = emptyTotals()
      partial.filesScanned = totals.filesScanned
      partial.filesSkippedDirty = totals.filesSkippedDirty
      partial.filesSkippedBinary = totals.filesSkippedBinary
      partial.filesSkippedLarge = totals.filesSkippedLarge
      return ok({
        files: [],
        totals: partial,
        filesTruncated: false,
        aborted: true,
        message: abort
      })
    }

    // ── 阶段 2：写盘 ──────────────────────────────────────
    const results: IdeReplaceFileResult[] = [...skippedResults]
    let wrote = false

    for (const plan of plans) {
      const unchanged = plan.textLf === plan.originalTextLf
      if (unchanged) {
        results.push({ rel: plan.rel, replacements: plan.count, status: 'ok' })
        continue
      }

      try {
        await writeTextBody(
          cwd,
          plan.rel,
          plan.abs,
          plan.textLf,
          plan.eol,
          plan.mtimeMs,
          false
        )
        wrote = true
        totals.filesChanged++
        results.push({ rel: plan.rel, replacements: plan.count, status: 'ok' })
      } catch (err) {
        const code = err instanceof IdeFsError ? err.code : ''
        if (code === 'conflict') {
          totals.filesConflicted++
          results.push({
            rel: plan.rel,
            replacements: 0,
            status: 'conflict',
            message: t('ideError.replaceExternal')
          })
        } else {
          totals.filesErrored++
          results.push({
            rel: plan.rel,
            replacements: 0,
            status: 'error',
            message: err instanceof Error ? err.message : String(err)
          })
          // 磁盘满时继续写只会连续失败，停手
          if (errorCode(err) === 'ENOSPC') {
            totals.filesErrored += plans.length - plans.indexOf(plan) - 1
            break
          }
        }
      }
    }

    if (wrote) resetWorkspaceSearchCache()

    const data: IdeReplaceData = {
      files: results.slice(0, REPLACE_MAX_RESULT_FILES),
      totals,
      filesTruncated: results.length > REPLACE_MAX_RESULT_FILES,
      aborted: false
    }
    return ok(data)
  } catch (err) {
    return toFailure(err)
  }
}

