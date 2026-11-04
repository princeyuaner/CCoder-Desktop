/**
 * `.editorconfig` 解析与匹配。
 *
 * 纯函数，不碰 fs：主进程负责沿目录向上收集配置文件，这里只做语法解析和
 * glob 匹配。支持编辑器最常用的几项（缩进、换行、行尾空白、末尾空行），
 * 未识别的键直接忽略 —— 不能让一份别人的配置把编辑器搞崩。
 */

export type EditorConfigEol = 'lf' | 'crlf'

export interface EditorConfigProperties {
  indentStyle?: 'space' | 'tab'
  /** `tab` 表示缩进宽度跟 tab_width 走 */
  indentSize?: number | 'tab'
  tabWidth?: number
  endOfLine?: EditorConfigEol
  insertFinalNewline?: boolean
  trimTrailingWhitespace?: boolean
}

export interface EditorConfigSection {
  /** 已去掉首尾空白的 glob，保留大小写 */
  pattern: string
  properties: EditorConfigProperties
}

export interface ParsedEditorConfig {
  /** 顶层 `root = true`：不再向上合并 */
  root: boolean
  sections: EditorConfigSection[]
}

const TRUE_VALUES = new Set(['true'])
const FALSE_VALUES = new Set(['false'])

function normalizeKey(key: string): string {
  return key.trim().toLowerCase()
}

function parsePositiveInt(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 && n <= 64 ? n : undefined
}

const PROPERTY_KEY: Record<string, keyof EditorConfigProperties> = {
  indent_style: 'indentStyle',
  indent_size: 'indentSize',
  tab_width: 'tabWidth',
  end_of_line: 'endOfLine',
  insert_final_newline: 'insertFinalNewline',
  trim_trailing_whitespace: 'trimTrailingWhitespace'
}

function applyProperty(
  props: EditorConfigProperties,
  key: string,
  rawValue: string
): void {
  const value = rawValue.trim().toLowerCase()
  if (value === 'unset' || value === '') {
    // 保留一个 undefined 标记：合并时要真的删掉前面 section 设置的值
    const prop = PROPERTY_KEY[key]
    if (prop) (props as Record<string, unknown>)[prop] = undefined
    return
  }
  switch (key) {
    case 'indent_style':
      if (value === 'space' || value === 'tab') props.indentStyle = value
      return
    case 'indent_size':
      if (value === 'tab') props.indentSize = 'tab'
      else {
        const n = parsePositiveInt(value)
        if (n !== undefined) props.indentSize = n
      }
      return
    case 'tab_width': {
      const n = parsePositiveInt(value)
      if (n !== undefined) props.tabWidth = n
      return
    }
    case 'end_of_line':
      if (value === 'lf' || value === 'crlf') props.endOfLine = value
      return
    case 'insert_final_newline':
      if (TRUE_VALUES.has(value)) props.insertFinalNewline = true
      else if (FALSE_VALUES.has(value)) props.insertFinalNewline = false
      return
    case 'trim_trailing_whitespace':
      if (TRUE_VALUES.has(value)) props.trimTrailingWhitespace = true
      else if (FALSE_VALUES.has(value)) props.trimTrailingWhitespace = false
      return
    default:
      // charset / max_line_length 等暂不支持；静默忽略
      return
  }
}

/** 逐行解析；注释只在行首（允许前导空白），行内 `#` 不当注释 */
export function parseEditorConfig(text: string): ParsedEditorConfig {
  const result: ParsedEditorConfig = { root: false, sections: [] }
  let current: EditorConfigSection | null = null
  let sawSection = false

  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue

    if (line.startsWith('[') && line.endsWith(']')) {
      sawSection = true
      current = { pattern: line.slice(1, -1).trim(), properties: {} }
      result.sections.push(current)
      continue
    }

    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = normalizeKey(line.slice(0, eq))
    const value = line.slice(eq + 1).trim()

    if (!sawSection) {
      if (key === 'root' && TRUE_VALUES.has(value.toLowerCase())) result.root = true
      continue
    }
    if (current) applyProperty(current.properties, key, value)
  }

  return result
}

function escapeRegExp(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch
}

/**
 * editorconfig glob → RegExp。
 *
 * 规范里 `/` 是路径分隔符：
 *  - 不含 `/` 的 pattern 匹配任意层级下的文件名（`*.ts` 匹配 `a/b/c.ts`）；
 *  - 含 `/`（或以 `/` 开头）的 pattern 从配置文件所在目录开始锚定；
 *  - `**` 跨目录，`*` / `?` 不跨目录；
 *  - 支持 `[abc]` / `[!abc]` 与 `{a,b}`。
 */
export function editorConfigGlobToRegExp(pattern: string): RegExp {
  let glob = pattern.trim().replace(/\\/g, '/')
  const anchored = glob.startsWith('/')
  if (anchored) glob = glob.slice(1)
  const hasSlash = glob.includes('/')

  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` 也匹配「零层目录」，否则 `**/x.ts` 匹配不到根目录的 x.ts
        if (glob[i + 2] === '/') {
          source += '(?:.*/)?'
          i += 2
        } else {
          source += '.*'
          i += 1
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (ch === '?') {
      source += '[^/]'
      continue
    }
    if (ch === '[') {
      const end = glob.indexOf(']', i + 1)
      if (end > i + 1) {
        let body = glob.slice(i + 1, end)
        if (body.startsWith('!')) body = `^${body.slice(1)}`
        // 只转义会破坏字符组的字符
        body = body.replace(/\\/g, '\\\\').replace(/\]/g, '\\]')
        source += `[${body}]`
        i = end
        continue
      }
    }
    if (ch === '{') {
      const end = glob.indexOf('}', i + 1)
      if (end > i + 1) {
        const parts = glob
          .slice(i + 1, end)
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
        if (parts.length > 1) {
          source += `(?:${parts.map((part) => globPartToSource(part)).join('|')})`
          i = end
          continue
        }
      }
    }
    source += escapeRegExp(ch)
  }

  if (!anchored && !hasSlash) {
    // 没有目录部分：匹配任意层级的 basename
    return new RegExp(`(?:^|/)${source}$`)
  }
  return new RegExp(`^${source}$`)
}

/** `{a,b}` 里的单个分支仍然允许通配符，做一个最小转换 */
function globPartToSource(part: string): string {
  let out = ''
  for (const ch of part) {
    if (ch === '*') out += '[^/]*'
    else if (ch === '?') out += '[^/]'
    else out += escapeRegExp(ch)
  }
  return out
}

/** 合并一个 section：undefined 表示 unset，必须删掉之前的值 */
function mergeProperties(
  target: EditorConfigProperties,
  source: EditorConfigProperties
): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) delete (target as Record<string, unknown>)[key]
    else (target as Record<string, unknown>)[key] = value
  }
}

/** 把相对某个 .editorconfig 目录的文件路径套到它的 sections 上 */
export function matchEditorConfig(
  relFromConfigDir: string,
  sections: EditorConfigSection[]
): EditorConfigProperties {
  const out: EditorConfigProperties = {}
  const rel = relFromConfigDir.replace(/\\/g, '/').replace(/^\/+/, '')
  for (const section of sections) {
    if (!section.pattern) continue
    // 以 `/` 结尾的 pattern 只匹配目录；文件路径不会命中
    if (section.pattern.endsWith('/')) continue
    let re: RegExp
    try {
      re = editorConfigGlobToRegExp(section.pattern)
    } catch {
      continue
    }
    if (!re.test(rel)) continue
    mergeProperties(out, section.properties)
  }
  return out
}

export interface EditorConfigSource {
  /** 相对工作区的目录，'' 表示工作区根 */
  dirRel: string
  text: string
}

/**
 * 从工作区根到文件所在目录依次合并。`root = true` 的配置由主进程在收集
 * 阶段截断，这里只负责按「离文件越近越优先」的顺序应用。
 */
export function resolveEditorConfig(
  rel: string,
  sources: EditorConfigSource[]
): EditorConfigProperties {
  const out: EditorConfigProperties = {}
  const fileRel = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  for (const source of sources) {
    const parsed = parseEditorConfig(source.text)
    const prefix = source.dirRel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    let local = fileRel
    if (prefix) {
      if (fileRel === prefix) local = ''
      else if (fileRel.startsWith(`${prefix}/`)) local = fileRel.slice(prefix.length + 1)
      else continue
    }
    mergeProperties(out, matchEditorConfig(local, parsed.sections))
  }
  return out
}
