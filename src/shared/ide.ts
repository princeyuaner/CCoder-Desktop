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
}

/** 打开 IDE 的结果。失败时 UI 可以原样把 message 顶给用户 */
export interface IdeOpenResult {
  ok: boolean
  message?: string
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

