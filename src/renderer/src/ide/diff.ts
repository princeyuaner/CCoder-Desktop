/**
 * 统一 diff → 并排视图。
 *
 * 只处理 `git diff` 会产出的标准 hunk：`@@ -a,b +c,d @@`、` `、`-`、`+`。
 * 一对连续的删除/新增按行配对，左右各自编号；多出来的一侧留空。
 */

export interface DiffSide {
  /** 1-based 行号；空行没有 */
  no?: number
  text?: string
}

export interface DiffRow {
  /** ctx 上下文 / change 一对删增 / add 纯新增 / del 纯删除 */
  kind: 'ctx' | 'change' | 'add' | 'del'
  left: DiffSide | null
  right: DiffSide | null
}

export interface DiffHunk {
  header: string
  rows: DiffRow[]
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parseDiff(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let cur: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  const lines = diff.split('\n')

  /** hunk 内的行都以 ' ' / '+' / '-' / '\\' / '@@' 开头 */
  const isHunkBody = (s: string): boolean =>
    s.startsWith(' ') || s.startsWith('+') || s.startsWith('-') || s.startsWith('\\') || s.startsWith('@@')

  /**
   * 文件头 `--- a/x` + `+++ b/x`。
   *
   * 必须排除 hunk 里内容恰好以 `--` / `++` 开头的增删行：文件头前面
   * 一定是 `diff --git` / `index` / `===` 这类元信息，而不是 hunk 内容。
   */
  const isFileHeader = (n: number): boolean =>
    lines[n].startsWith('--- ') &&
    (lines[n + 1]?.startsWith('+++ ') ?? false) &&
    (n === 0 || !isHunkBody(lines[n - 1]))

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // 下一个文件开始了。前面 hunk 的 cur 还挂着，不清掉会把它的
    // `--- a/x` 当成删除行。
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('Index: ')) {
      cur = null
      i++
      continue
    }

    const m = HUNK.exec(line)
    if (m) {
      oldNo = Number(m[1])
      newNo = Number(m[3])
      cur = { header: line, rows: [] }
      hunks.push(cur)
      i++
      continue
    }

    if (!cur) {
      i++
      continue
    }

    if (line.startsWith('\\')) {
      i++
      continue
    }

    // SVN 的多个文件之间没有 `diff --git`，靠 `---`/`+++` 对切分
    if (isFileHeader(i)) {
      cur = null
      i += 2
      continue
    }

    if (line.startsWith('-')) {
      const dels: string[] = []
      while (i < lines.length && lines[i].startsWith('-') && !lines[i].startsWith('---')) {
        dels.push(lines[i].slice(1))
        i++
      }
      const adds: string[] = []
      while (i < lines.length && lines[i].startsWith('+') && !lines[i].startsWith('+++')) {
        adds.push(lines[i].slice(1))
        i++
      }
      // 多文件 diff 里，上一个文件的 hunk 结束后还会出现 `--- a/...` 文件头。
      // 两个内层循环都因为 `---` 前缀不肯消费它，这里必须手动前进，
      // 否则指针原地不动 —— 渲染进程会直接卡死。
      if (dels.length === 0 && adds.length === 0) {
        i++
        continue
      }
      const n = Math.max(dels.length, adds.length)
      for (let k = 0; k < n; k++) {
        cur.rows.push({
          kind: dels.length > 0 && adds.length > 0 ? 'change' : dels.length > 0 ? 'del' : 'add',
          left: k < dels.length ? { no: oldNo++, text: dels[k] } : null,
          right: k < adds.length ? { no: newNo++, text: adds[k] } : null
        })
      }
      continue
    }

    if (line.startsWith('+')) {
      const adds: string[] = []
      while (i < lines.length && lines[i].startsWith('+') && !lines[i].startsWith('+++')) {
        adds.push(lines[i].slice(1))
        i++
      }
      // 同样的文件头 `+++ b/...`：不前进就会死循环
      if (adds.length === 0) {
        i++
        continue
      }
      for (const text of adds) {
        cur.rows.push({ kind: 'add', left: null, right: { no: newNo++, text } })
      }
      continue
    }

    if (line.startsWith(' ') || line === '') {
      // diff 末尾的空行不算上下文；hunk 中间的空行才是
      if (line === '' && i === lines.length - 1) {
        i++
        continue
      }
      cur.rows.push({
        kind: 'ctx',
        left: { no: oldNo++, text: line.slice(1) },
        right: { no: newNo++, text: line.slice(1) }
      })
      i++
      continue
    }

    i++
  }

  return hunks
}

export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}
