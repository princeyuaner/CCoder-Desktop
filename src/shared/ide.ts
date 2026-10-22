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

export type IdeEol = 'lf' | 'crlf'

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
  /** 可以安全地整体写回（非二进制且未截断） */
  editable?: boolean
}

export type IdeFsErrorCode =
  | 'forbidden'
  | 'invalid-path'
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

export interface IdeSearchMatch {
  /** 1-based */
  line: number
  /** 1-based */
  column: number
  /** 命中所在行的内容（已压缩空白、截断） */
  text: string
}

export interface IdeSearchFile {
  rel: string
  name: string
  matches: IdeSearchMatch[]
}

