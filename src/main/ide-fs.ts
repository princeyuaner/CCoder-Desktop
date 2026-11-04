import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import iconv from 'iconv-lite'
import chardet, { type AnalyseResult } from 'chardet'
import { t } from './i18n'
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import {
  isIdeEncoding,
  type IdeCreateRequest,
  type IdeDeleteRequest,
  type IdeDeleteResult,
  type IdeEncoding,
  type IdeEntry,
  type IdeEntryChange,
  type IdeEol,
  type IdeFsErrorCode,
  type IdeFsResult,
  type IdeImage,
  type IdeListDirOptions,
  type IdeRenameRequest,
  type IdeReplaceData,
  type IdeReplaceFileResult,
  type IdeReplacePreviewFile,
  type IdeReplacePreviewSample,
  type IdeReplaceRequest,
  type IdeReplaceResult,
  type IdeReplaceTotals,
  type IdeSaveRequest,
  type IdeSearchData,
  type IdeSearchFile,
  type IdeSearchMatch,
  type IdeSearchRequest,
  type IdeSearchResult,
  type IdeTextFile,
  type IdeTransferData,
  type IdeTransferItem,
  type IdeTransferRequest,
  type IdeUndoFileResult,
  type IdeUndoReplaceData,
  type IdeUndoReplaceRequest,
  type IdeUndoReplaceResult
} from '../shared/ide'
import { editorConfigGlobToRegExp } from '../shared/editorconfig'
import { listWorkspaceFilesDetailed, resetWorkspaceSearchCache } from './workspace-search'
import { isIgnoredDirName } from './workspace-ignore'
import {
  collectSpans,
  compileGlobs,
  compileSearch,
  makeSnippet,
  replaceLine,
  SearchPatternError,
  type CompiledSearch
} from './ide-search'
import {
  MAX_IMAGE_BYTES,
  MAX_REPLACEMENT_CHARS,
  MAX_SEARCH_FILE_BYTES,
  MAX_TEXT_BYTES,
  MAX_WRITE_BYTES,
  REPLACE_DEADLINE_MS,
  REPLACE_MAX_FILES,
  REPLACE_MAX_MATCHES,
  REPLACE_MAX_RESULT_FILES,
  REPLACE_MAX_TOTAL_BYTES,
  SEARCH_DEADLINE_MS,
  SEARCH_MAX_FILES,
  SEARCH_MAX_FILES_WITH_HITS,
  SEARCH_MAX_MATCHES
} from './search-limits'

/**
 * 内置 IDE 的主进程侧：文件读写、新建/重命名/删除、代码搜索。
 * 版本控制在 main/vcs 里。
 *
 * 所有入口都收 `(cwd, rel)`，并且先做越界检查 —— 渲染进程拿不到 fs，
 * 但 IPC 参数仍可能被伪造，不能假设它一定传的是工作区内的路径。
 * 写操作还要求调用方是绑定了该工作区的 IDE 窗口（见 main/index.ts）。
 */

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
  '.lua': 'Lua',
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

/**
 * 把工作区相对路径换成绝对路径，并拒绝越界。
 * 只做字面检查、不碰 fs —— 「在系统文件管理器中显示」的目标可能刚被删除。
 */
export function workspaceAbsolutePath(cwd: string, rel: string): string {
  return resolveInside(cwd, rel)
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
      return failure(
        'unknown',
        (err instanceof Error && err.message) || errorCode(err) || String(err) || 'unknown'
      )
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

/* ── 文本编码 ─────────────────────────────────────────── */

/** IdeEncoding → iconv-lite 的编码名 */
const ICONV_CODEC: Record<IdeEncoding, string> = {
  utf8: 'utf8',
  utf8bom: 'utf8',
  gbk: 'gb18030',
  big5: 'big5',
  shiftjis: 'shiftjis',
  eucjp: 'eucjp',
  euckr: 'euckr',
  utf16le: 'utf16-le',
  utf16be: 'utf16-be',
  utf32le: 'utf32-le',
  utf32be: 'utf32-be',
  windows1252: 'win1252',
  windows1251: 'win1251',
  windows1250: 'win1250',
  windows1253: 'win1253',
  windows1254: 'win1254',
  windows1255: 'win1255',
  windows1256: 'win1256',
  windows1257: 'win1257',
  windows1258: 'win1258',
  windows874: 'win874',
  iso88592: 'iso88592',
  iso88595: 'iso88595',
  iso88596: 'iso88596',
  iso88597: 'iso88597',
  iso88598: 'iso88598',
  iso88599: 'iso88599',
  koi8r: 'koi8r'
}

/** chardet 的识别结果 → 编辑器编码；空值表示这种编码暂不支持 */
const DETECTED_ENCODING: Record<string, IdeEncoding | undefined> = {
  ASCII: 'utf8',
  'UTF-8': 'utf8',
  'UTF-16LE': 'utf16le',
  'UTF-16BE': 'utf16be',
  'UTF-32LE': 'utf32le',
  'UTF-32BE': 'utf32be',
  GB18030: 'gbk',
  Big5: 'big5',
  Shift_JIS: 'shiftjis',
  'EUC-JP': 'eucjp',
  'EUC-KR': 'euckr',
  'windows-1250': 'windows1250',
  'windows-1251': 'windows1251',
  'windows-1252': 'windows1252',
  'windows-1253': 'windows1253',
  'windows-1254': 'windows1254',
  'windows-1255': 'windows1255',
  'windows-1256': 'windows1256',
  'windows-1257': 'windows1257',
  'windows-1258': 'windows1258',
  'windows-874': 'windows874',
  'ISO-8859-1': 'windows1252',
  'ISO-8859-2': 'iso88592',
  'ISO-8859-5': 'iso88595',
  'ISO-8859-6': 'iso88596',
  'ISO-8859-7': 'iso88597',
  'ISO-8859-8': 'iso88598',
  'ISO-8859-9': 'iso88599',
  'KOI8-R': 'koi8r'
}

/** 自动识别时最多看 128KB；chardet 扫完整 2MB 要接近 1 秒 */
const DETECT_SAMPLE_BYTES = 128 * 1024
/** chardet 达到这个置信度就直接采用；低于它先看 GB18030 是否解得干净 */
const DETECT_MIN_CONFIDENCE = 50

interface BomInfo {
  encoding: IdeEncoding
  size: number
}

/** BOM 检查；UTF-32LE 的 BOM 以 FF FE 开头，必须排在 UTF-16LE 前面 */
function bomOf(buf: Buffer): BomInfo | null {
  if (buf.length >= 4) {
    if (buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0 && buf[3] === 0) {
      return { encoding: 'utf32le', size: 4 }
    }
    if (buf[0] === 0 && buf[1] === 0 && buf[2] === 0xfe && buf[3] === 0xff) {
      return { encoding: 'utf32be', size: 4 }
    }
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: 'utf8bom', size: 3 }
  }
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return { encoding: 'utf16le', size: 2 }
    if (buf[0] === 0xfe && buf[1] === 0xff) return { encoding: 'utf16be', size: 2 }
  }
  return null
}

/** 解码正文；文件带 BOM 且与目标编码一致时跳过 BOM */
function decodeBuffer(buf: Buffer, encoding: IdeEncoding): string {
  const bom = bomOf(buf)
  const utf8 = encoding === 'utf8' || encoding === 'utf8bom'
  const skip =
    bom && (utf8 ? bom.encoding === 'utf8bom' : bom.encoding === encoding)
      ? bom.size
      : 0
  if (utf8) return buf.subarray(skip).toString('utf8')
  return iconv.decode(buf.subarray(skip), ICONV_CODEC[encoding])
}

/**
 * 无 BOM 的 UTF-16 / UTF-32。
 *
 * 这类文件的特征是高字节里大量出现 0。按 4 字节窗口统计 NUL 落在哪个
 * 位置，就能把 LE / BE 和 16 / 32 位区分开；再解码一小段确认不是二进制，
 * 避免把恰好带 NUL 的压缩包误判成文本。
 */
function guessWideNoBom(buf: Buffer): IdeEncoding | null {
  const n = Math.min(buf.length, 4096)
  if (n < 8) return null
  const count = [0, 0, 0, 0]
  let nul = 0
  for (let i = 0; i < n; i += 1) {
    if (buf[i] === 0) {
      nul += 1
      count[i & 3] += 1
    }
  }
  if (nul / n < 0.25) return null
  const q = n / 4
  const high = (v: number): boolean => v > q * 0.7
  const low = (v: number): boolean => v < q * 0.2
  let encoding: IdeEncoding | null = null
  if (high(count[2]) && high(count[3]) && low(count[0])) encoding = 'utf32le'
  else if (high(count[0]) && high(count[1]) && low(count[3])) encoding = 'utf32be'
  else if (high(count[1]) && high(count[3]) && low(count[0]) && low(count[2])) {
    encoding = 'utf16le'
  } else if (high(count[0]) && high(count[2]) && low(count[1]) && low(count[3])) {
    encoding = 'utf16be'
  }
  if (!encoding) return null
  return plausibleDecode(buf, encoding) ? encoding : null
}

/** 解码一小段，确认没有替换字符或大量控制字符 */
function plausibleDecode(buf: Buffer, encoding: IdeEncoding): boolean {
  const unit = encoding === 'utf32le' || encoding === 'utf32be' ? 4 : 2
  const take = Math.min(buf.length, 4096)
  const sample = buf.subarray(0, take - (take % unit))
  if (sample.length === 0) return false
  const text = iconv.decode(sample, ICONV_CODEC[encoding])
  let bad = 0
  let chars = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    chars += 1
    if (code === 0xfffd) return false
    if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) bad += 1
  }
  return chars > 0 && bad / chars < 0.01
}

function hasNonAscii(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] >= 0x80) return true
  }
  return false
}

/**
 * 严格 UTF-8 校验。截断的大文件可能在末尾把一个多字节字符切成两半，
 * 这时允许丢掉最后 1–3 个字节再判断——不能因此把 GBK 整篇当成 UTF-8。
 */
function isValidUtf8(buf: Buffer): boolean {
  if (!hasNonAscii(buf)) return true
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let cut = 0; cut <= 3 && cut < buf.length; cut += 1) {
    try {
      decoder.decode(cut === 0 ? buf : buf.subarray(0, buf.length - cut))
      return true
    } catch {
      // 继续尝试去掉结尾的不完整字符
    }
  }
  return false
}

/**
 * 取样做传统编码识别。
 *
 * 只有整篇不是合法 UTF-8 时才会走到这里；从第一个非 ASCII 字节附近取
 * 128KB，避免长段 ASCII 前缀让 chardet 只看到 ASCII。
 */
function detectionSample(buf: Buffer): Buffer {
  if (buf.length <= DETECT_SAMPLE_BYTES) return buf
  let firstHigh = -1
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] >= 0x80) {
      firstHigh = i
      break
    }
  }
  const start =
    firstHigh < 0
      ? 0
      : Math.max(0, Math.min(firstHigh - 4096, buf.length - DETECT_SAMPLE_BYTES))
  return buf.subarray(start, start + DETECT_SAMPLE_BYTES)
}

/** 解码结果里是否有替换字符或不可打印控制符 */
function hasBadChars(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0xfffd) return true
    if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) return true
  }
  return false
}

function detectLegacyEncoding(buf: Buffer): {
  strong: IdeEncoding | null
  weak: IdeEncoding | null
} {
  let matches: AnalyseResult
  try {
    matches = chardet.analyse(detectionSample(buf))
  } catch {
    return { strong: null, weak: null }
  }
  let weak: IdeEncoding | null = null
  for (const match of matches) {
    const encoding = DETECTED_ENCODING[match.name]
    if (!encoding) continue
    if (!weak) weak = encoding
    if (match.confidence >= DETECT_MIN_CONFIDENCE) {
      return { strong: encoding, weak }
    }
  }
  return { strong: null, weak }
}

function decodeForced(buf: Buffer, encoding: IdeEncoding): string {
  return decodeBuffer(buf, encoding)
}

/**
 * 自动识别编码。
 *
 * 顺序：BOM → 无 BOM 的 UTF-16/32 → 严格 UTF-8 → chardet → GB18030。
 * 前两步是确定性的；chardet 只用于没有 BOM 的旧编码（GBK、Big5、
 * Shift-JIS 等）。置信度不够时先看 GB18030 能否干净解码（照顾中文旧文件），
 * 解出来满是替换字符再采用 chardet 的弱候选（西欧 / 俄文等）。
 */
function decodeAuto(buf: Buffer): { text: string; encoding: IdeEncoding } {
  const bom = bomOf(buf)
  if (bom) return { text: decodeBuffer(buf, bom.encoding), encoding: bom.encoding }
  const wide = guessWideNoBom(buf)
  if (wide) return { text: iconv.decode(buf, ICONV_CODEC[wide]), encoding: wide }
  if (isValidUtf8(buf)) return { text: buf.toString('utf8'), encoding: 'utf8' }

  const { strong, weak } = detectLegacyEncoding(buf)
  if (strong) {
    return { text: iconv.decode(buf, ICONV_CODEC[strong]), encoding: strong }
  }
  const gbkText = iconv.decode(buf, 'gb18030')
  if (!hasBadChars(gbkText)) return { text: gbkText, encoding: 'gbk' }
  if (weak) {
    const text = iconv.decode(buf, ICONV_CODEC[weak])
    if (!hasBadChars(text)) return { text, encoding: weak }
  }
  return { text: gbkText, encoding: 'gbk' }
}

function encodeText(text: string, encoding: IdeEncoding): Buffer {
  switch (encoding) {
    case 'utf8':
      return Buffer.from(text, 'utf8')
    case 'utf8bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(text, 'utf16-le')])
    case 'utf16be':
      return Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(text, 'utf16-be')])
    case 'utf32le':
      return Buffer.concat([
        Buffer.from([0xff, 0xfe, 0x00, 0x00]),
        iconv.encode(text, 'utf32-le')
      ])
    case 'utf32be':
      return Buffer.concat([
        Buffer.from([0x00, 0x00, 0xfe, 0xff]),
        iconv.encode(text, 'utf32-be')
      ])
    default: {
      const codec = ICONV_CODEC[encoding]
      const bytes = iconv.encode(text, codec)
      // iconv 遇到无法表示的字符会静默写 '?'，这里宁可报错也不要毁文件
      if (iconv.decode(bytes, codec) !== text) {
        throw new IdeFsError('unknown', t('ideError.encodingLossy'))
      }
      return bytes
    }
  }
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
  encoding: IdeEncoding | undefined,
  expectedMtimeMs: number | undefined,
  force: boolean,
  mustCreate = false
): Promise<void> {
  if (textLf.includes('\0')) {
    throw new IdeFsError('binary', t('ideError.binarySave'))
  }

  // 编辑器统一用 LF；落盘时还原原文件的换行风格
  const body = textLf.replace(/\r\n?/g, '\n')
  const text = eol === 'crlf' ? body.replace(/\n/g, '\r\n') : body
  const bytes = encodeText(text, encoding ?? 'utf8')
  if (bytes.length > MAX_WRITE_BYTES) {
    throw new IdeFsError('too-large', t('ideError.tooLargeSave'))
  }

  const ls = await lstatOrNull(abs)
  if (ls) {
    if (mustCreate) throw new IdeFsError('exists', t('ideError.exists'))
    const real = await writableFile(cwd, rel, abs)
    const st = await fs.stat(real)
    if (
      !force &&
      typeof expectedMtimeMs === 'number' &&
      Math.abs(st.mtimeMs - expectedMtimeMs) > 0.5
    ) {
      throw new IdeFsError('conflict', t('ideError.externalModified'))
    }
    await fs.writeFile(real, bytes)
  } else {
    if (!force && typeof expectedMtimeMs === 'number') {
      throw new IdeFsError('missing', t('ideError.externalDeleted'))
    }
    await ensureParentInside(cwd, abs)
    // wx：如果刚好有人抢先建了同名文件，不要覆盖
    await fs.writeFile(abs, bytes, { flag: 'wx' })
  }
}

export async function saveTextFile(req: IdeSaveRequest): Promise<IdeFsResult<IdeTextFile>> {
  try {
    const cwd = req?.cwd
    const { rel, abs } = writeTarget(cwd, req?.rel)
    const raw = typeof req.text === 'string' ? req.text : ''
    const encoding = isIdeEncoding(req.encoding) ? req.encoding : undefined
    await writeTextBody(
      cwd,
      rel,
      abs,
      raw,
      req.eol,
      encoding,
      req.expectedMtimeMs,
      req.force === true,
      req.mustCreate === true
    )
    return ok(await readTextFile(cwd, rel, encoding))
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

/** 复制时目标已存在：`a.ts` → `a copy.ts` / `a copy 2.ts` */
async function uniqueCopyTarget(abs: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  let candidate = `${stem} copy${ext}`
  let n = 2
  while (await lstatOrNull(resolve(dirname(abs), candidate))) {
    candidate = `${stem} copy ${n}${ext}`
    n += 1
    if (n > 500) throw new IdeFsError('exists', t('ideError.exists'))
  }
  return candidate
}

/**
 * 移动 / 复制一批文件或目录。
 *
 * 只处理工作区内的路径；被选中的嵌套项收敛到最外层（同时选中目录和它的
 * 子文件时只搬目录）。移动遇到同名目标报错，复制则自动生成 `x copy`，
 * 绝不静默覆盖。
 */
export async function transferEntries(
  req: IdeTransferRequest
): Promise<IdeFsResult<IdeTransferData>> {
  try {
    const cwd = req?.cwd
    if (!cwd || typeof cwd !== 'string' || !isAbsolute(cwd)) {
      throw new IdeFsError('invalid-path', t('ideError.invalidWorkspace'))
    }
    const mode = req.mode === 'copy' ? 'copy' : 'move'
    const targetDirRaw = typeof req.targetDir === 'string' ? req.targetDir : ''
    const targetDir = targetDirRaw ? writeTarget(cwd, targetDirRaw).rel : ''
    const targetReal = await realInside(cwd, targetDir || '.')
    const targetStat = await fs.stat(targetReal)
    if (!targetStat.isDirectory()) {
      throw new IdeFsError('not-file', t('ideError.notAFile'))
    }

    const items: IdeTransferItem[] = []
    const seen = new Set<string>()
    for (const raw of Array.isArray(req.rels) ? req.rels.slice(0, 200) : []) {
      if (typeof raw === 'string' && raw && !seen.has(raw)) {
        seen.add(raw)
        items.push({ from: raw, ok: false })
      }
    }

    // 去掉被另一个选中项包含的路径，避免「先搬目录、再搬目录里的文件」
    const sources = items
      .map((item) => item.from)
      .sort((a, b) => a.length - b.length)
      .filter(
        (rel, _i, list) =>
          !list.some((other) => other !== rel && (rel === other || rel.startsWith(`${other}/`)))
      )

    const results: IdeTransferItem[] = []
    for (const from of sources) {
      try {
        const source = writeTarget(cwd, from)
        const ls = await lstatOrNull(source.abs)
        if (!ls) throw new IdeFsError('missing', t('ideError.fileMissing'))
        if (ls.isSymbolicLink()) throw new IdeFsError('invalid-path', t('ideError.symlinkWrite'))
        if (!ls.isFile() && !ls.isDirectory()) {
          throw new IdeFsError('not-file', t('ideError.notFile'))
        }
        if (
          ls.isDirectory() &&
          (targetDir === source.rel || targetDir.startsWith(`${source.rel}/`))
        ) {
          throw new IdeFsError('invalid-path', t('ideError.moveIntoItself'))
        }

        const realSource = await realInside(cwd, source.rel)
        const name = basename(source.rel)
        let toRel = targetDir ? `${targetDir}/${name}` : name
        let dest = writeTarget(cwd, toRel)
        // 原地「移动」是空操作；原地「复制」仍要生成 a copy.ts
        if (dest.abs === source.abs && mode === 'move') {
          results.push({ from: source.rel, to: source.rel, ok: true })
          continue
        }

        if (await lstatOrNull(dest.abs)) {
          if (mode === 'move') throw new IdeFsError('exists', t('ideError.targetExists'))
          const unique = await uniqueCopyTarget(dest.abs, name)
          toRel = targetDir ? `${targetDir}/${unique}` : unique
          dest = writeTarget(cwd, toRel)
        }

        await ensureParentInside(cwd, dest.abs)
        if (mode === 'copy') {
          await fs.cp(realSource, dest.abs, {
            recursive: true,
            errorOnExist: true,
            force: false,
            preserveTimestamps: true
          })
        } else {
          try {
            await fs.rename(realSource, dest.abs)
          } catch (err) {
            if (errorCode(err) !== 'EXDEV') throw err
            // 跨卷：复制后再删源；复制失败时源保持不动
            await fs.cp(realSource, dest.abs, { recursive: true, errorOnExist: true, force: false })
            await fs.rm(realSource, { recursive: ls.isDirectory(), force: false })
          }
        }
        results.push({ from: source.rel, to: posix(toRel), ok: true })
      } catch (err) {
        const failure = toFailure(err)
        results.push({
          from,
          ok: false,
          code: failure.ok ? 'unknown' : failure.code,
          message: failure.ok ? '' : failure.message
        })
      }
    }

    return ok({ items: results })
  } catch (err) {
    return toFailure(err)
  }
}

export async function listDir(
  cwd: string,
  rel: string,
  options?: IdeListDirOptions
): Promise<IdeEntry[]> {
  const real = await realInside(cwd, rel)
  const st = await fs.stat(real)
  if (!st.isDirectory()) return []

  const showHidden = options?.showHidden !== false
  const showIgnored = options?.showIgnored === true
  const ignoreMatchers = compileExplorerIgnores(options?.ignore)

  const entries = await fs.readdir(real, { withFileTypes: true })
  const baseRel = normRel(rel)
  const out: IdeEntry[] = []

  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue
    if (!ent.isDirectory() && !ent.isFile()) continue
    // Git worktree 里 `.git` 是文件而不是目录，也不应该出现在文件树里
    if (ent.isFile() && ent.name.toLowerCase() === '.git') continue
    if (!showHidden && ent.name.startsWith('.')) continue
    if (ent.isDirectory()) {
      // 版本控制元数据即使打开「显示忽略项」也不列，避免误操作
      if (VCS_META_DIRS.has(ent.name.toLowerCase())) continue
      if (!showIgnored && isIgnoredDirName(ent.name)) continue
    }
    const childRel = baseRel ? `${baseRel}/${ent.name}` : ent.name
    if (ignoreMatchers.some((re) => re.test(ent.name) || re.test(posix(childRel)))) continue
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

/** 版本控制目录：不受「显示忽略项」影响 */
const VCS_META_DIRS = new Set(['.git', '.svn', '_svn', '.hg', '.bzr', '.jj', '_darcs'])

const explorerIgnoreCache = new Map<string, RegExp>()

function compileExplorerIgnores(patterns: unknown): RegExp[] {
  if (!Array.isArray(patterns)) return []
  const out: RegExp[] = []
  for (const raw of patterns.slice(0, 100)) {
    if (typeof raw !== 'string') continue
    const pattern = raw.trim()
    if (!pattern || pattern.startsWith('!') || pattern.length > 200) continue
    const anchored = pattern.includes('/') && !pattern.startsWith('/')
    const key = anchored ? `/${pattern}` : pattern
    let re = explorerIgnoreCache.get(key)
    if (!re) {
      try {
        const bare = editorConfigGlobToRegExp(key)
        // Windows 文件系统不区分大小写，忽略规则也按不区分处理
        re = process.platform === 'win32' ? new RegExp(bare.source, 'i') : bare
        explorerIgnoreCache.set(key, re)
      } catch {
        continue
      }
    }
    out.push(re)
  }
  return out
}

/** 读文本：预期内的失败用 IdeFsResult 返回，UI 按 code 判断，不靠文案 */
export async function readTextFileResult(
  cwd: string,
  rel: string,
  encoding?: IdeEncoding
): Promise<IdeFsResult<IdeTextFile>> {
  try {
    return ok(await readTextFile(cwd, rel, encoding))
  } catch (err) {
    return toFailure(err)
  }
}

export async function readTextFile(
  cwd: string,
  rel: string,
  encoding?: IdeEncoding
): Promise<IdeTextFile> {
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

  const forced = isIdeEncoding(encoding) ? encoding : undefined
  const head = buf.subarray(0, Math.min(buf.length, 8192))
  /*
   * 前 8KB 里有 NUL 就当二进制。UTF-16 / UTF-32 天然带 NUL：有 BOM、
   * 用户强制指定了宽字符编码，或者无 BOM 文件被识别出来时，不按二进制处理。
   */
  const bom = bomOf(buf)
  const forcedWide =
    forced === 'utf16le' ||
    forced === 'utf16be' ||
    forced === 'utf32le' ||
    forced === 'utf32be'
  const detectedWide =
    !forced &&
    ((bom !== null && bom.encoding !== 'utf8bom') || guessWideNoBom(buf) !== null)
  const binary = !forcedWide && !detectedWide && head.includes(0)
  const truncated = st.size > take

  let decoded = ''
  let detected: IdeEncoding = forced ?? 'utf8'
  if (!binary) {
    if (forced) {
      decoded = decodeForced(buf, forced)
      detected = forced
    } else {
      const auto = decodeAuto(buf)
      decoded = auto.text
      detected = auto.encoding
    }
  }

  const eol = eolOf(decoded)
  const text = decoded.replace(/\r\n?/g, '\n')

  return {
    rel: posix(normRel(rel)),
    text,
    size: st.size,
    language: languageOf(rel),
    truncated,
    binary,
    mtimeMs: st.mtimeMs,
    eol,
    encoding: detected,
    encodingAuto: !forced,
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

export interface SearchStreamStats {
  matchCount: number
  scannedFiles: number
  truncated: boolean
  note?: string
}

export interface SearchStreamHooks {
  signal?: AbortSignal
  /** 替换/回退重跑时等待新文件列表 */
  freshScan?: boolean
  /** 每完成一批文件回调一次，供流式搜索推送 */
  onBatch?: (files: IdeSearchFile[], stats: SearchStreamStats) => void
}

/** 一批并发读多少个文件；太大会让主进程一次占满 libuv 线程池 */
const SEARCH_READ_CONCURRENCY = 8
/** 流式批次：最多攒这么多文件或这么久就推送 */
const SEARCH_BATCH_FILES = 20
const SEARCH_BATCH_MS = 80

interface MatchedFile {
  file: IdeSearchFile
  matches: IdeSearchMatch[]
  aborted: boolean
}

/**
 * 读一个文件并逐行匹配。`maxMatches` 只用于限制单文件的内存占用；
 * 全局上限由调用方在合并结果时控制。
 */
async function matchCandidate(
  cwd: string,
  f: { path: string; name: string; kind: 'file' | 'dir' },
  search: CompiledSearch,
  signal: AbortSignal | undefined,
  maxMatches: number
): Promise<MatchedFile> {
  const empty = (aborted = false): MatchedFile => ({
    file: { rel: f.path, name: f.name, matches: [] },
    matches: [],
    aborted
  })

  if (signal?.aborted) return empty(true)

  const abs = resolveInside(cwd, f.path)
  const read = await readCandidateText(abs)
  if (!read.ok) return empty(signal?.aborted === true)

  const matches: IdeSearchMatch[] = []
  const lines = read.textLf.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if ((i & 255) === 0 && signal?.aborted) return empty(true)
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
      if (matches.length >= maxMatches) {
        return {
          file: { rel: f.path, name: f.name, matches },
          matches,
          aborted: signal?.aborted === true
        }
      }
    }
  }

  return {
    file: { rel: f.path, name: f.name, matches },
    matches,
    aborted: signal?.aborted === true
  }
}

/**
 * 内置 JS 搜索，支持流式批次和中途取消。
 *
 * 保留原有语义：序列为候选文件路径顺序，上限、跳过规则、note 文案都
 * 与旧版一致。`searchCode` 是它的无流式包装，供旧 IPC / 测试使用。
 */
export async function searchCodeStreaming(
  req: IdeSearchRequest,
  hooks: SearchStreamHooks = {}
): Promise<IdeSearchResult> {
  try {
    const cwd = req?.cwd
    if (!cwd || typeof cwd !== 'string' || !isAbsolute(cwd)) {
      throw new IdeFsError('invalid-path', t('ideError.invalidWorkspace'))
    }

    const search = compileSearch(req?.query, req?.options)
    const globs = compileGlobs(req?.options)

    const scan = await listWorkspaceFilesDetailed(cwd, { fresh: hooks.freshScan })
    const files = candidateFiles(scan.files, globs)

    const started = Date.now()
    const out: IdeSearchFile[] = []
    let scanned = 0
    let total = 0
    let truncated = scan.truncated || scan.incomplete
    let note = truncated ? t('ideError.searchIncomplete') : undefined
    let batch: IdeSearchFile[] = []
    let lastEmit = Date.now()
    let stop = false

    const stats = (): SearchStreamStats => ({
      matchCount: total,
      scannedFiles: scanned,
      truncated,
      ...(note ? { note } : {})
    })

    const emit = (): void => {
      if (!hooks.onBatch || batch.length === 0) return
      const payload = batch
      batch = []
      lastEmit = Date.now()
      if (hooks.signal?.aborted) return
      try {
        hooks.onBatch(payload, stats())
      } catch {
        // 推送失败不能打断搜索本身
      }
    }

    const maybeEmit = (): void => {
      if (batch.length >= SEARCH_BATCH_FILES || Date.now() - lastEmit >= SEARCH_BATCH_MS) {
        emit()
      }
    }

    const markTruncated = (message: string): void => {
      truncated = true
      note = message
      stop = true
    }

    for (let i = 0; i < files.length && !stop; i += SEARCH_READ_CONCURRENCY) {
      if (hooks.signal?.aborted) break
      if (scanned >= SEARCH_MAX_FILES) {
        markTruncated(t('ideError.searchTooMany'))
        break
      }
      if (Date.now() - started > SEARCH_DEADLINE_MS) {
        markTruncated(t('ideError.searchTimeout'))
        break
      }

      const chunk = files.slice(i, i + SEARCH_READ_CONCURRENCY)
      const budget = Math.max(1, SEARCH_MAX_MATCHES - total)
      const results = await Promise.all(
        chunk.map((f) => matchCandidate(cwd, f, search, hooks.signal, budget))
      )

      for (const result of results) {
        if (hooks.signal?.aborted) {
          stop = true
          break
        }
        if (result.aborted) {
          stop = true
          break
        }
        if (scanned >= SEARCH_MAX_FILES) {
          markTruncated(t('ideError.searchTooMany'))
          break
        }
        scanned++

        if (result.matches.length === 0) continue

        const room = SEARCH_MAX_MATCHES - total
        if (room <= 0) {
          markTruncated(
            t('ideError.searchTruncated', {
              files: SEARCH_MAX_FILES_WITH_HITS,
              matches: SEARCH_MAX_MATCHES
            })
          )
          break
        }

        const take = result.matches.slice(0, room)
        if (take.length > 0) {
          const file = { rel: result.file.rel, name: result.file.name, matches: take }
          out.push(file)
          batch.push(file)
          total += take.length
          maybeEmit()
        }

        if (take.length < result.matches.length) {
          markTruncated(
            t('ideError.searchTruncated', {
              files: SEARCH_MAX_FILES_WITH_HITS,
              matches: SEARCH_MAX_MATCHES
            })
          )
          break
        }
        if (out.length >= SEARCH_MAX_FILES_WITH_HITS) {
          markTruncated(
            t('ideError.searchTruncated', {
              files: SEARCH_MAX_FILES_WITH_HITS,
              matches: SEARCH_MAX_MATCHES
            })
          )
          break
        }
        if (total >= SEARCH_MAX_MATCHES) {
          markTruncated(
            t('ideError.searchTruncated', {
              files: SEARCH_MAX_FILES_WITH_HITS,
              matches: SEARCH_MAX_MATCHES
            })
          )
          break
        }
      }
    }

    emit()

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

export async function searchCode(req: IdeSearchRequest): Promise<IdeSearchResult> {
  return searchCodeStreaming(req, {})
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

/** 预览里最多展示多少个文件 / 每个文件几行 / 每行多少字符 */
const REPLACE_PREVIEW_FILES = 40
const REPLACE_PREVIEW_SAMPLES = 3
const REPLACE_PREVIEW_CHARS = 220

/**
 * 上一次真正写盘的全部替换。
 *
 * 只保存在主进程内存里：撤销是「刚才那次操作」的补救，不跨应用重启。
 * 按工作区分开，避免多开 IDE 窗口时撤销到另一个仓库。
 */
interface ReplaceUndoFile {
  rel: string
  abs: string
  textLf: string
  eol: IdeEol
  /** 替换写盘后的 mtime；撤销时用它发现外部改动 */
  mtimeMs: number
  matches: number
}

interface ReplaceUndoEntry {
  token: string
  files: ReplaceUndoFile[]
}

const replaceUndoByWorkspace = new Map<string, ReplaceUndoEntry>()
/** 最多保留几个工作区的撤销快照，避免多开时内存无上限增长 */
const REPLACE_UNDO_WORKSPACES = 8

function workspaceKey(cwd: string): string {
  return process.platform === 'win32' ? cwd.toLowerCase() : cwd
}

function storeReplaceUndo(cwd: string, entry: ReplaceUndoEntry): void {
  const key = workspaceKey(cwd)
  replaceUndoByWorkspace.delete(key)
  replaceUndoByWorkspace.set(key, entry)
  while (replaceUndoByWorkspace.size > REPLACE_UNDO_WORKSPACES) {
    const oldest = replaceUndoByWorkspace.keys().next().value
    if (typeof oldest !== 'string') break
    replaceUndoByWorkspace.delete(oldest)
  }
}

function clipPreviewLine(line: string): string {
  return line.length > REPLACE_PREVIEW_CHARS
    ? `${line.slice(0, REPLACE_PREVIEW_CHARS)}…`
    : line
}

/**
 * 撤销上一次工作区全部替换。
 *
 * 只恢复主进程内存里记录的那批文件；替换之后又被外部修改过（mtime 变了）
 * 或删掉的文件会跳过，绝不覆盖用户的新改动。一次替换只能撤销一次。
 */
export async function undoReplace(
  req: IdeUndoReplaceRequest
): Promise<IdeUndoReplaceResult> {
  try {
    const cwd = req?.cwd
    if (!cwd || typeof cwd !== 'string' || !isAbsolute(cwd)) {
      throw new IdeFsError('invalid-path', t('ideError.invalidWorkspace'))
    }
    if (typeof req?.token !== 'string' || !req.token) {
      throw new IdeFsError('invalid-path', t('ideError.undoMissing'))
    }

    const key = workspaceKey(cwd)
    const entry = replaceUndoByWorkspace.get(key)
    if (!entry || entry.token !== req.token) {
      throw new IdeFsError('unknown', t('ideError.undoMissing'))
    }
    // 先移除：撤销过程中即使部分文件失败，也不允许再次触发
    replaceUndoByWorkspace.delete(key)

    const files: IdeUndoFileResult[] = []
    let restoredFiles = 0
    let restoredMatches = 0

    for (const file of entry.files) {
      try {
        await writeTextBody(
          cwd,
          file.rel,
          file.abs,
          file.textLf,
          file.eol,
          undefined,
          file.mtimeMs,
          false
        )
        restoredFiles += 1
        restoredMatches += file.matches
        files.push({ rel: file.rel, status: 'ok' })
      } catch (err) {
        const code = err instanceof IdeFsError ? err.code : ''
        if (code === 'conflict') {
          files.push({
            rel: file.rel,
            status: 'conflict',
            message: t('ideError.replaceExternal')
          })
        } else if (code === 'missing') {
          files.push({
            rel: file.rel,
            status: 'missing',
            message: t('ideError.missing')
          })
        } else {
          files.push({
            rel: file.rel,
            status: 'error',
            message: err instanceof Error ? err.message : String(err)
          })
        }
      }
    }

    if (restoredFiles > 0) resetWorkspaceSearchCache(cwd)
    return ok({ files, restoredFiles, restoredMatches })
  } catch (err) {
    return toFailure(err)
  }
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

    // 替换前强制重扫，绝不基于 15 秒内的旧列表写盘。
    // 只失效当前工作区，其它打开窗口的缓存不受影响。
    resetWorkspaceSearchCache(cwd)
    const scan = await listWorkspaceFilesDetailed(cwd, { fresh: true })
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
    const previewFiles: IdeReplacePreviewFile[] = []
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
      const samples: IdeReplacePreviewSample[] = []
      const nextLines = lines.map((line, i) => {
        const r = replaceLine(line, search, replacement)
        count += r.count
        if (r.count > 0 && samples.length < REPLACE_PREVIEW_SAMPLES) {
          samples.push({
            line: i + 1,
            before: clipPreviewLine(line),
            after: clipPreviewLine(r.text)
          })
        }
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
      if (previewFiles.length < REPLACE_PREVIEW_FILES) {
        previewFiles.push({
          rel: f.path,
          replacements: count,
          samples,
          more: count > samples.length
        })
      }
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

    if (req.preview === true) {
      const previewResults: IdeReplaceFileResult[] = [
        ...skippedResults,
        ...plans.map((plan) => ({
          rel: plan.rel,
          replacements: plan.count,
          status: 'ok' as const
        }))
      ]
      return ok({
        files: previewResults.slice(0, REPLACE_MAX_RESULT_FILES),
        totals,
        filesTruncated: previewResults.length > REPLACE_MAX_RESULT_FILES,
        aborted: false,
        preview: previewFiles,
        previewTruncated: plans.length > previewFiles.length
      })
    }

    // ── 阶段 2：写盘 ──────────────────────────────────────
    const results: IdeReplaceFileResult[] = [...skippedResults]
    const undoFiles: ReplaceUndoFile[] = []
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
          undefined,
          plan.mtimeMs,
          false
        )
        wrote = true
        totals.filesChanged++
        results.push({ rel: plan.rel, replacements: plan.count, status: 'ok' })
        try {
          const st = await fs.stat(plan.abs)
          undoFiles.push({
            rel: plan.rel,
            abs: plan.abs,
            textLf: plan.originalTextLf,
            eol: plan.eol,
            mtimeMs: st.mtimeMs,
            matches: plan.count
          })
        } catch {
          // 刚写完就被外部删掉：这个文件无法通过撤销恢复
        }
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

    if (wrote) resetWorkspaceSearchCache(cwd)

    let undoToken: string | undefined
    if (undoFiles.length > 0) {
      undoToken = randomUUID()
      storeReplaceUndo(cwd, { token: undoToken, files: undoFiles })
    }

    const data: IdeReplaceData = {
      files: results.slice(0, REPLACE_MAX_RESULT_FILES),
      totals,
      filesTruncated: results.length > REPLACE_MAX_RESULT_FILES,
      aborted: false,
      undoToken,
      undoFiles: undoFiles.length
    }
    return ok(data)
  } catch (err) {
    return toFailure(err)
  }
}

