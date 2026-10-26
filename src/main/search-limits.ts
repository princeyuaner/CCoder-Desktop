/**
 * 搜索 / 替换的预算常量。
 *
 * 单独放一个文件，避免 `rg-search`、`ide-fs`、`workspace-search` 之间为了
 * 共用这些数字而互相 import 形成环。
 */

/** 文本读取上限；超过就截断并标记，避免一次 IPC 把几 MB 的产物塞进渲染层 */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024
/** 单次保存上限；正常编辑远小于这个值 */
export const MAX_WRITE_BYTES = 8 * 1024 * 1024
/** 代码搜索单文件上限 */
export const MAX_SEARCH_FILE_BYTES = 1024 * 1024
/** 图片上限 */
export const MAX_IMAGE_BYTES = 24 * 1024 * 1024

/** 代码搜索的总预算 */
export const SEARCH_DEADLINE_MS = 4000
export const SEARCH_MAX_FILES = 5000
export const SEARCH_MAX_MATCHES = 200
export const SEARCH_MAX_FILES_WITH_HITS = 50

/**
 * 全部替换的预算。替换和搜索不同：面板只展示前 200 处，但"全部替换"
 * 必须覆盖整个工作区 —— 所以它有自己的上限，并且一旦触顶就在**写盘前**
 * 整体中止，绝不静默只替换一部分。
 */
export const REPLACE_DEADLINE_MS = 15_000
export const REPLACE_MAX_FILES = 5000
export const REPLACE_MAX_MATCHES = 50_000
export const REPLACE_MAX_TOTAL_BYTES = 64 * 1024 * 1024
export const REPLACE_MAX_RESULT_FILES = 500
export const MAX_REPLACEMENT_CHARS = 100_000

/** 工作区扫描上限：目录条目数和深度 */
export const WORKSPACE_MAX_ENTRIES = 50_000
export const WORKSPACE_MAX_DEPTH = 12
