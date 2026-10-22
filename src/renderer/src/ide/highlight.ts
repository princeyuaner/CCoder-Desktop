/**
 * 轻量语法着色。
 *
 * 只用于「大文件 / 二进制」的只读兜底预览：正常编辑走 Monaco，
 * 这个正则不参与编辑器渲染。块注释/字符串跨行时先对整段文本着色，
 * 再按换行拆回每一行，所以跨行 token 不会断。
 */

export interface Tok {
  text: string
  cls?: string
}

const KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
  'false', 'finally', 'for', 'from', 'function', 'get', 'if', 'implements',
  'import', 'in', 'instanceof', 'interface', 'keyof', 'let', 'new', 'null',
  'of', 'private', 'protected', 'public', 'readonly', 'return', 'satisfies',
  'set', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'type',
  'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield',
  'def', 'elif', 'except', 'lambda', 'None', 'True', 'False', 'pass', 'raise',
  'and', 'or', 'not', 'is', 'with', 'print',
  'fn', 'mut', 'pub', 'struct', 'impl', 'match', 'mod', 'use', 'crate', 'where',
  'package', 'func', 'chan', 'defer', 'go', 'map', 'range', 'select', 'var'
])

const HASH_COMMENT = new Set(['Python', 'Shell', 'YAML', 'TOML', 'PowerShell'])

function build(language: string): RegExp | null {
  if (language === 'Text' || language === 'Markdown') return null
  const hash = HASH_COMMENT.has(language)
  const parts = [
    '\\/\\*[\\s\\S]*?\\*\\/',
    '//[^\\n]*',
    hash ? '#[^\\n]*' : null,
    '"(?:\\\\.|[^"\\\\])*"',
    "'(?:\\\\.|[^'\\\\])*'",
    '`(?:\\\\.|[^`\\\\])*`',
    '\\b\\d+(?:\\.\\d+)?\\b',
    `\\b(?:${[...KEYWORDS].join('|')})\\b`,
    '[A-Za-z_$][\\w$]*(?=\\s*\\()',
    '\\b[A-Z][A-Za-z0-9_]*\\b'
  ].filter(Boolean) as string[]
  return new RegExp(parts.join('|'), 'g')
}

const RE = new Map<string, RegExp | null>()

function regexFor(language: string): RegExp | null {
  if (!RE.has(language)) RE.set(language, build(language))
  const re = RE.get(language) ?? null
  if (re) re.lastIndex = 0
  return re
}

export function highlight(code: string, language: string): Tok[] {
  // 太大的文件不着色，避免正则回溯把渲染进程拖住
  if (code.length > 700_000) return [{ text: code }]
  const re = regexFor(language)
  if (!re) return [{ text: code }]

  const out: Tok[] = []
  let last = 0
  let m: RegExpExecArray | null

  while ((m = re.exec(code)) !== null) {
    if (m.index > last) out.push({ text: code.slice(last, m.index) })
    const text = m[0]
    let cls = 'tok-fn'
    if (text.startsWith('/*') || text.startsWith('//') || text.startsWith('#')) cls = 'tok-cm'
    else if (/^["'`]/.test(text)) cls = 'tok-str'
    else if (/^\d/.test(text)) cls = 'tok-num'
    else if (KEYWORDS.has(text)) cls = 'tok-k'
    else if (/^[A-Z]/.test(text)) cls = 'tok-ty'
    out.push({ text, cls })
    last = m.index + text.length
    // 防御零宽匹配
    if (text.length === 0) re.lastIndex++
  }

  if (last < code.length) out.push({ text: code.slice(last) })
  return out
}

/** 把一个可能跨行的 token 流拆成「每行一个 token 数组」 */
export function toLines(tokens: Tok[]): Tok[][] {
  const lines: Tok[][] = [[]]
  for (const t of tokens) {
    const parts = t.text.split('\n')
    parts.forEach((p, i) => {
      if (i > 0) lines.push([])
      if (p) lines[lines.length - 1].push({ text: p, cls: t.cls })
    })
  }
  return lines
}
