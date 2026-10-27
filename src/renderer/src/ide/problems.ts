import { monaco } from './monaco-setup'

/**
 * 问题面板的数据源。
 *
 * Monaco 的语言 worker（TS 语法、JSON / CSS / HTML 校验）会把诊断写进
 * marker service；这里只做汇总和路径换算，不自己跑任何检查。
 * 语义诊断当前是关掉的（见 monaco-setup.ts 的注释），所以 C/C++ 等
 * 没有内置 worker 的语言不会出现在这里。
 */

export type ProblemSeverity = 'error' | 'warning' | 'info' | 'hint'

export interface IdeProblem {
  rel: string
  /** 1-based */
  line: number
  /** 1-based */
  column: number
  severity: ProblemSeverity
  message: string
  source: string
}

export function relFromUri(uri: monaco.Uri, cwd: string): string | null {
  if (uri.scheme === 'ccoder') {
    const raw = uri.path.replace(/^\/+/, '')
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  if (uri.scheme === 'file') {
    const abs = uri.fsPath.replace(/\\/g, '/')
    const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
    if (abs.toLowerCase() === root.toLowerCase()) return ''
    if (abs.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
      return abs.slice(root.length + 1)
    }
  }
  return null
}

function severityOf(severity: monaco.MarkerSeverity): ProblemSeverity {
  if (severity === monaco.MarkerSeverity.Error) return 'error'
  if (severity === monaco.MarkerSeverity.Warning) return 'warning'
  if (severity === monaco.MarkerSeverity.Info) return 'info'
  return 'hint'
}

export function collectProblems(cwd: string): IdeProblem[] {
  const out: IdeProblem[] = []
  for (const marker of monaco.editor.getModelMarkers({})) {
    const rel = relFromUri(marker.resource, cwd)
    if (!rel) continue
    out.push({
      rel,
      line: marker.startLineNumber,
      column: marker.startColumn,
      severity: severityOf(marker.severity),
      message: marker.message,
      source: marker.source || 'monaco'
    })
  }
  out.sort(
    (a, b) =>
      a.rel.localeCompare(b.rel) ||
      a.line - b.line ||
      a.column - b.column ||
      a.message.localeCompare(b.message)
  )
  return out
}

/** 订阅 marker 变化；语言 worker 的诊断是异步的，事件到了就重新汇总一次 */
export function subscribeProblems(cwd: string, cb: (problems: IdeProblem[]) => void): () => void {
  let timer: number | null = null
  const flush = (): void => {
    timer = null
    cb(collectProblems(cwd))
  }
  const schedule = (): void => {
    if (timer !== null) return
    timer = window.setTimeout(flush, 120)
  }
  const disposable = monaco.editor.onDidChangeMarkers(schedule)
  schedule()
  return () => {
    disposable.dispose()
    if (timer !== null) window.clearTimeout(timer)
  }
}
