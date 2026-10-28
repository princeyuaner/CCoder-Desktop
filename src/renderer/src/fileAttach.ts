import type { IdeCodeRef } from '@shared/ide-chat'

/**
 * 拖进 / 选进输入框的**文本文件** → 一条代码引用。
 *
 * 为什么复用 IdeCodeRef 而不是给附件再造一套结构：
 *  - 发给模型的编码（`<ide_reference>`）已经写好、模型也认；
 *  - 渲染层已经有了引用卡（折叠、展开、移除），文件卡长得一样；
 *  - 历史回放时它和 IDE 引用走同一条解析路径，刷新后还在。
 * 区别只在 `origin: 'file'` —— 卡片上不写「来自 IDE」。
 *
 * 图片不走这里：它们有自己的一套（缩放 + base64 + 视觉输入）。
 */

/** 单个文件最多读这么多字节；再大就截断（模型也不需要整份 10MB 日志） */
const MAX_BYTES = 512 * 1024
/** 最多保留多少行 —— 和 IDE 引用卡的上限对齐 */
const MAX_LINES = 500
/** 一次最多几个文件 */
export const MAX_FILES = 5

export type FileAttachSkip =
  | { kind: 'binary'; name: string }
  | { kind: 'tooBig'; name: string }
  | { kind: 'unreadable'; name: string }

export interface FileAttachResult {
  refs: IdeCodeRef[]
  skipped: FileAttachSkip[]
}

/** 看起来像图片的扩展名 —— 这些交给图片那套处理，不要当文本读 */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/i

/** 常见的"不是给人读的"扩展名。猜错的代价只是多读一次，所以只列高频的 */
const BINARY_EXT =
  /\.(zip|7z|rar|gz|tgz|bz2|xz|exe|dll|so|dylib|bin|o|a|lib|class|jar|war|pyc|pyo|whl|ttf|otf|woff2?|eot|mp3|mp4|mov|avi|mkv|wav|flac|pdf|doc[x]?|xls[x]?|ppt[x]?|sqlite|db|pack|idx)$/i

function newId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** 文件名 → 围栏语言。用扩展名就够了，这里不引 Monaco 的语言表 */
const FENCE: Record<string, string> = {
  ts: 'ts',
  tsx: 'tsx',
  mts: 'ts',
  cts: 'ts',
  js: 'js',
  jsx: 'jsx',
  mjs: 'js',
  cjs: 'js',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  md: 'md',
  mdx: 'md',
  py: 'py',
  rs: 'rs',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'cs',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  sql: 'sql',
  xml: 'xml',
  vue: 'vue',
  svelte: 'svelte',
  txt: 'text',
  log: 'text',
  csv: 'text',
  env: 'text'
}

function langOf(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return FENCE[ext] ?? (/^[a-z0-9+#-]+$/.test(ext) ? ext : 'text')
}

/** 二进制探测：前 8KB 里出现 NUL 就当二进制（和 git / grep 一个判据） */
function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192)
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true
  return false
}

function readBytes(file: File, max: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const r = new FileReader()
    r.onerror = () => resolve(null)
    r.onload = () => {
      const buf = r.result
      resolve(buf instanceof ArrayBuffer ? new Uint8Array(buf) : null)
    }
    // 只读前 max 字节；拖进来的 100MB 日志不该把主进程卡住
    r.readAsArrayBuffer(file.size > max ? file.slice(0, max) : file)
  })
}

/** 目录在拖拽时会给出 size 0 且没有 type —— 这是唯一能廉价识别它们的地方 */
function isDirectoryLike(file: File): boolean {
  return file.size === 0 && file.type === ''
}

export async function readFileAttachments(
  files: File[],
  cwd: string
): Promise<FileAttachResult> {
  const out: FileAttachResult = { refs: [], skipped: [] }
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')

  for (const file of files) {
    const name = file.name || 'file'
    if (IMAGE_EXT.test(name)) {
      // 图片由 Composer 的图片通道接走；走到这里说明调用方没分拣
      out.skipped.push({ kind: 'unreadable', name })
      continue
    }
    if (BINARY_EXT.test(name) || isDirectoryLike(file)) {
      out.skipped.push({ kind: 'binary', name })
      continue
    }

    const bytes = await readBytes(file, MAX_BYTES)
    if (!bytes) {
      out.skipped.push({ kind: 'unreadable', name })
      continue
    }
    if (looksBinary(bytes)) {
      out.skipped.push({ kind: 'binary', name })
      continue
    }

    const truncated = file.size > MAX_BYTES
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\r\n?/g, '\n')
    const allLines = text.split('\n')
    const kept = allLines.slice(0, MAX_LINES)
    const didTrim = truncated || allLines.length > MAX_LINES

    out.refs.push({
      id: newId(),
      origin: 'file',
      kind: 'file',
      // 拖进来的文件没有工作区相对路径可言，用文件名当 rel；
      // path 留空 —— 它不在这个工作区里，没有「在 IDE 中打开」的意义
      rel: name,
      path: '',
      name,
      lang: langOf(name),
      code: kept.join('\n'),
      totalLines: allLines.length,
      ...(didTrim ? { truncated: true } : {}),
      cwd: root
    })

    if (truncated) out.skipped.push({ kind: 'tooBig', name })
  }

  return out
}

export { MAX_BYTES as FILE_ATTACH_MAX_BYTES }
