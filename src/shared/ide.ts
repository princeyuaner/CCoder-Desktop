/**
 * 内置 IDE 的数据形状。
 *
 * 文件内容由 IDE 窗口读写；Git / SVN 的提交、还原、更新走
 * `shared/vcs.ts` 的独立 IPC，不混在这里。
 * 路径统一用 `/` 分隔、相对工作区（`rel`），跨平台比较不用再处理反斜杠。
 */

export interface IdeEntry {
  /** 文件名（不含父目录） */
  name: string
  /** 相对工作区的路径，正斜杠 */
  rel: string
  kind: 'file' | 'dir'
}

/** 要在 IDE 里打开的目标。主进程负责把绝对路径换算成 rel 并做越界检查。 */
export interface IdeTarget {
  /** 相对工作区的路径，正斜杠 */
  rel: string
  /** 1-based 行号；只对文本文件有意义 */
  line?: number
  /**
   * 打开 diff 页签，而不是文件本身。
   *
   * 审阅本轮改动时要看的是「相对 HEAD 改了什么」，文件本身（尤其被删掉的
   * 文件）打不开也看不出差异。diff 页签由 IDE 自己按 `source: 'head'` 拉取。
   */
  diff?: boolean
  /**
   * 同一批里其余的 diff 文件。
   *
   * 「审阅本轮改动」一次要看多个文件；一条 IPC 带一批，避免连发 N 条时
   * 窗口还在创建、早到的那几条被 `pendingReveal` 覆盖掉。
   */
  more?: string[]
}

/** 打开 IDE 的结果。失败时 UI 可以原样把 message 顶给用户 */
export interface IdeOpenResult {
  ok: boolean
  message?: string
}

/**
 * 把一批「本轮改动」的路径收敛成 IDE 认的工作区相对路径。
 *
 * 纯函数，主进程和渲染层共用（也是 `verify:changed-review` 的断言对象）：
 *  - 反斜杠转正斜杠、去掉 `./` 前缀、折叠多余的分隔符；
 *  - 拒绝绝对路径（盘符 / UNC / 以 `/` 开头）与 `..` 段 —— diff 页签按
 *    rel 取，越界没有意义；开头带 `/` 的路径在 Windows 上还是「当前盘根
 *    相对」，语义不唯一，一律不收；
 *  - 精确去重（Windows 上同一目录里不可能同时存在只差大小写的两个文件，
 *    而 POSIX 上它们可能是两个，所以这里不做大小写折叠）。
 */
export function normalizeReviewRels(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const rel = raw.replace(/\\/g, '/').replace(/^\.\//, '')
    // 盘符 / UNC / 根路径：都不能当工作区相对路径
    if (/^([a-zA-Z]:\/|\/\/|\/)/.test(rel)) continue
    // 折叠 `a//b`、去掉尾斜杠；空段不参与判断
    const parts = rel.split('/').filter(Boolean)
    if (parts.length === 0) continue
    if (parts.includes('..')) continue
    const clean = parts.join('/')
    if (seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
  }
  return out
}

/**
 * 主进程 → IDE 渲染进程：一批磁盘变化。
 *
 * 已经在主进程里去抖、合并、过滤过忽略目录；`rels` 相对工作区、
 * 正斜杠，可能是文件也可能是目录。
 */
export interface IdeFsChanged {
  rels: string[]
  /** 超出路径数 / 字符上限，`rels` 不完整，渲染层应重读所有打开的文件 */
  truncated: boolean
  /** filename 为 null、根事件或无法换算成相对路径，变化范围未知 */
  generic: boolean
}

/* ── 内置终端 ─────────────────────────────────────────────── */

export interface IdeTerminalStartRequest {
  cwd: string
  /** 渲染层生成，窗口内唯一；主进程按 webContents 隔离 */
  id: string
  cols?: number
  rows?: number
}

export type IdeTerminalStartResult =
  | { ok: true; shell: string }
  | { ok: false; error: string }

export interface IdeTerminalDataEvent {
  id: string
  data: string
}

export interface IdeTerminalExitEvent {
  id: string
  code: number | null
}

export type IdeEol = 'lf' | 'crlf'

/** 编辑器支持的文本编码；GBK 用 GB18030 解码 / 编码（GBK 的超集） */
export const IDE_ENCODINGS = ['utf8', 'utf8bom', 'gbk', 'utf16le', 'utf16be'] as const
export type IdeEncoding = (typeof IDE_ENCODINGS)[number]

export function isIdeEncoding(value: unknown): value is IdeEncoding {
  return typeof value === 'string' && (IDE_ENCODINGS as readonly string[]).includes(value)
}

export interface IdeTextFile {
  rel: string
  /**
   * 文本内容。统一用 `\n` 换行，保存时按 `eol` 还原。
   * 这样编辑器里不用到处处理 CRLF。
   */
  text: string
  /** 原始文件大小（字节） */
  size: number
  /** 展示用语言名，如 TypeScript / JSON */
  language: string
  /** 超过读取上限，只返回了前半段 */
  truncated: boolean
  /** 看起来是二进制，text 为空 */
  binary: boolean
  /** 读取时的修改时间，保存时用于发现外部改动 */
  mtimeMs?: number
  /** 原文件的换行风格 */
  eol?: IdeEol
  /** 读取时识别（或用户指定）的编码；保存时按它写回 */
  encoding: IdeEncoding
  /** 可以安全地整体写回（非二进制且未截断） */
  editable?: boolean
}

export type IdeFsErrorCode =
  | 'forbidden'
  | 'invalid-path'
  | 'invalid-query'
  | 'invalid-regex'
  | 'invalid-glob'
  | 'exists'
  | 'missing'
  | 'conflict'
  | 'not-file'
  | 'too-large'
  | 'binary'
  | 'unknown'

/** 写操作的统一返回值：预期内的失败不抛异常，UI 能按 code 决定怎么处理 */
export type IdeFsResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: IdeFsErrorCode; message: string }

export interface IdeSaveRequest {
  cwd: string
  rel: string
  /** 编辑器里的完整文本，`\n` 换行 */
  text: string
  /** 上次读取 / 保存时的 mtime；不一致就返回 conflict */
  expectedMtimeMs?: number
  /** 保留原文件的换行风格；默认 LF */
  eol?: IdeEol
  /** 写回时使用的编码；省略时按 UTF-8 */
  encoding?: IdeEncoding
  /** 用户确认覆盖外部改动 / 重建已删除文件时置 true */
  force?: boolean
}

export interface IdeCreateRequest {
  cwd: string
  /** 相对工作区的新路径，可以带尚不存在的父目录 */
  rel: string
  kind: 'file' | 'dir'
}

export interface IdeRenameRequest {
  cwd: string
  rel: string
  /** 新的工作区相对路径 */
  to: string
}

export interface IdeDeleteRequest {
  cwd: string
  rel: string
}

export interface IdeEntryChange {
  /** 操作后的条目 */
  entry: IdeEntry
  /** 重命名前的旧路径；新建/删除时为空 */
  oldRel?: string
}

export interface IdeDeleteResult {
  rel: string
  kind: 'file' | 'dir'
}

export interface IdeImage {
  rel: string
  /** data URL，渲染进程直接塞进 img.src */
  dataUrl: string
  size: number
  mime: string
}

export interface IdeSearchOptions {
  /** false / 省略 = 不区分大小写（保持旧行为） */
  caseSensitive?: boolean
  /** false / 省略 = 普通子串 */
  wholeWord?: boolean
  /** false / 省略 = 字面量；true 时 query 按 JS 正则解释 */
  regex?: boolean
  /** 工作区相对 POSIX glob，任一命中即可；空 = 全部文件 */
  include?: string[]
  /** 任一命中即排除 */
  exclude?: string[]
}

export interface IdeSearchRequest {
  cwd: string
  query: string
  options?: IdeSearchOptions
}

/** 流式搜索的启动请求；requestId 由渲染层生成，用于取消和丢弃迟到事件 */
export interface IdeSearchStartRequest extends IdeSearchRequest {
  requestId: string
}

export interface IdeSearchBatchEvent {
  type: 'batch'
  requestId: string
  files: IdeSearchFile[]
  matchCount: number
  scannedFiles: number
  truncated: boolean
  note?: string
  /** 渲染层应丢弃已有结果（回退重跑时使用） */
  reset?: boolean
  /** 本次结果来自内置搜索 */
  fallback?: boolean
}

export interface IdeSearchDoneEvent {
  type: 'done'
  requestId: string
  matchCount: number
  scannedFiles: number
  truncated: boolean
  note?: string
  fallback?: boolean
}

export interface IdeSearchErrorEvent {
  type: 'error'
  requestId: string
  message: string
}

export type IdeSearchStreamEvent =
  | IdeSearchBatchEvent
  | IdeSearchDoneEvent
  | IdeSearchErrorEvent

export type IdeSearchStartResult = IdeFsResult<{
  mode: 'rg' | 'js'
  /** 因为 rg 不可用 / 启动失败而回退 */
  fallback: boolean
}>

export interface IdeSearchMatch {
  /** 1-based */
  line: number
  /** 1-based，UTF-16 code unit */
  column: number
  /** 命中长度，UTF-16 code unit */
  length: number
  /** 命中附近的片段，可能带首尾 … */
  text: string
  /** 命中在 text 中的 0-based 偏移，UTF-16 code unit */
  offset: number
}

export interface IdeSearchFile {
  rel: string
  name: string
  matches: IdeSearchMatch[]
}

export interface IdeSearchData {
  files: IdeSearchFile[]
  /** 实际返回的命中数（可能被截断） */
  matchCount: number
  scannedFiles: number
  /** 展示上限、扫描超时或工作区扫描不完整 */
  truncated: boolean
  /** 直接展示给用户的截断原因 */
  note?: string
}

export type IdeSearchResult = IdeFsResult<IdeSearchData>

export type IdeReplaceFileStatus = 'ok' | 'conflict' | 'skipped' | 'error'

export interface IdeReplaceFileResult {
  rel: string
  /** 这个文件里替换掉的处数 */
  replacements: number
  status: IdeReplaceFileStatus
  message?: string
}

export interface IdeReplaceTotals {
  filesScanned: number
  filesWithMatches: number
  filesChanged: number
  filesSkippedDirty: number
  filesSkippedBinary: number
  filesSkippedLarge: number
  filesConflicted: number
  filesErrored: number
  replacements: number
}

export interface IdeReplaceData {
  /** 每个文件的处理结果；无命中 / 二进制 / 过大文件不列出 */
  files: IdeReplaceFileResult[]
  totals: IdeReplaceTotals
  /** files 被截断，totals 仍然完整 */
  filesTruncated: boolean
  /** 扫描不完整或触发上限：一个文件都没写 */
  aborted: boolean
  message?: string
}

export type IdeReplaceResult = IdeFsResult<IdeReplaceData>

export interface IdeReplaceRequest {
  cwd: string
  query: string
  replacement: string
  options?: IdeSearchOptions
  /** IDE 里有未保存修改的文件；这些文件一律跳过 */
  dirtyRels?: string[]
  /** 测试 / 安全阀；服务端还会再夹一次硬上限 */
  maxReplacements?: number
}

