/**
 * 轻量符号扫描。
 *
 * Monaco 自带的大纲需要语言服务（TS/JS/JSON 有，Python / Go / Rust 没有），
 * 而这里要的是「所有文件都能列出可跳转的符号」。用正则做一个保守的兜底：
 * 只认行首的声明关键字，宁可漏掉一些，也不要把 `if (...)` 之类的控制流
 * 当成函数塞进大纲。
 */

export type OutlineKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'module'
  | 'constant'
  | 'method'
  | 'symbol'

export interface OutlineSymbol {
  name: string
  kind: OutlineKind
  /** 1-based */
  line: number
  /** 1-based，name 在行内的起始列 */
  column: number
  /** 嵌套层级，用于缩进 */
  depth: number
}

const CONTROL = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'else',
  'do',
  'try',
  'finally',
  'return',
  'new',
  'await',
  'yield',
  'throw',
  'case',
  'default',
  'typeof',
  'delete',
  'void',
  'with',
  'super',
  'this'
])

function extOf(rel: string): string {
  const name = rel.split('/').pop() ?? rel
  return name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
}

function indentDepth(line: string): number {
  let n = 0
  for (const ch of line) {
    if (ch === ' ') n += 1
    else if (ch === '\t') n += 4
    else break
  }
  return Math.min(4, Math.floor(n / 2))
}

function push(
  out: OutlineSymbol[],
  name: string | undefined,
  kind: OutlineKind,
  lineText: string,
  lineNo: number,
  depth = 0
): void {
  if (!name || CONTROL.has(name)) return
  const column = lineText.indexOf(name) + 1
  out.push({ name, kind, line: lineNo, column: Math.max(1, column), depth })
  if (out.length > 800) out.length = 800
}

const JS_TOP =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(function\*?|class|interface|type|enum|namespace|module|const|let|var)\s+([A-Za-z_$][\w$]*)/
const JS_METHOD =
  /^\s{2,}(?:(?:public|private|protected|static|readonly|override|async|get|set|constructor)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::[^{=]+)?\{?\s*\}?\s*$/
const PY =
  /^\s*(class|def|async\s+def)\s+([A-Za-z_][\w]*)/
const GO = /^\s*(func|type|var|const)\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/
const RUST =
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(fn|struct|enum|trait|impl|mod|const|static|type)\s+(?:<[^>]*>\s*)?([A-Za-z_][\w]*)/
const JAVA_CLASS =
  /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|value|record|partial)\s+)*(class|interface|enum|record|struct|object|annotation)\s+([A-Za-z_$][\w$]*)/
const METHOD_LIKE =
  /^\s{2,}(?:(?:public|private|protected|internal|static|final|abstract|async|override|virtual|suspend|synchronized|native|get|set|fun)\s+)*(?:[A-Za-z_$][\w$<>[\],.?]*\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{?\s*\}?\s*$/

function kindOf(keyword: string): OutlineKind {
  const k = keyword.replace(/^async\s+/, '').replace('*', '')
  if (k === 'function' || k === 'def' || k === 'func' || k === 'fn' || k === 'fun') {
    return 'function'
  }
  if (k === 'class' || k === 'struct' || k === 'object' || k === 'record') return 'class'
  if (k === 'interface' || k === 'trait' || k === 'annotation') return 'interface'
  if (k === 'type' || k === 'impl') return 'type'
  if (k === 'enum') return 'enum'
  if (k === 'namespace' || k === 'module' || k === 'mod') return 'module'
  if (k === 'const' || k === 'static' || k === 'var' || k === 'let') return 'constant'
  return 'symbol'
}

export function parseOutline(text: string, rel: string): OutlineSymbol[] {
  const ext = extOf(rel)
  const isJs = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte'].includes(ext)
  const isPy = ext === 'py'
  const isGo = ext === 'go'
  const isRust = ext === 'rs'
  const isJvm = ['java', 'kt', 'kts', 'cs', 'scala', 'swift'].includes(ext)
  const out: OutlineSymbol[] = []
  const lines = text.split('\n')

  for (let i = 0; i < lines.length && out.length < 800; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('//') || line.trim().startsWith('#')) continue
    const lineNo = i + 1

    if (isJs) {
      const top = JS_TOP.exec(line)
      if (top) {
        const kind = top[1] === 'function' ? 'function' : kindOf(top[1])
        push(out, top[2], kind, line, lineNo, Math.min(2, indentDepth(line)))
        continue
      }
      const method = JS_METHOD.exec(line)
      if (method) {
        push(out, method[1], 'method', line, lineNo, Math.min(3, indentDepth(line)))
      }
      continue
    }

    if (isPy) {
      const m = PY.exec(line)
      if (m) {
        const kind = m[1] === 'class' ? 'class' : 'function'
        push(out, m[2], kind, line, lineNo, Math.min(4, Math.floor(indentDepth(line) / 2)))
      }
      continue
    }

    if (isGo) {
      const m = GO.exec(line)
      if (m) push(out, m[2], kindOf(m[1]), line, lineNo, 0)
      continue
    }

    if (isRust) {
      const m = RUST.exec(line)
      if (m) push(out, m[2], kindOf(m[1]), line, lineNo, 0)
      continue
    }

    if (isJvm) {
      const top = JAVA_CLASS.exec(line)
      if (top) {
        push(out, top[2], kindOf(top[1]), line, lineNo, 0)
        continue
      }
      const method = METHOD_LIKE.exec(line)
      if (method) {
        push(out, method[1], 'method', line, lineNo, Math.min(3, indentDepth(line)))
      }
      continue
    }

    // 其它语言：只认行首声明关键字，避免把普通语句误判成符号
    const generic =
      /^\s*(?:export\s+|pub\s+)?(function|class|interface|type|enum|struct|def|func|fn|const|let|var)\s+([A-Za-z_$][\w$]*)/
    const m = generic.exec(line)
    if (m) push(out, m[2], kindOf(m[1]), line, lineNo, Math.min(2, indentDepth(line)))
  }

  return out
}
