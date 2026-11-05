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
  /** hunk 头里的旧文件起始行（1-based；新增文件为 0） */
  oldStart: number
  oldCount: number
  /** hunk 头里的新文件起始行（1-based；删除文件为 0） */
  newStart: number
  newCount: number
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
      const oldStart = Number(m[1])
      const oldCount = m[2] === undefined ? 1 : Number(m[2])
      const newStart = Number(m[3])
      const newCount = m[4] === undefined ? 1 : Number(m[4])
      oldNo = oldStart
      newNo = newStart
      cur = { header: line, rows: [], oldStart, oldCount, newStart, newCount }
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

export interface DiffSeg {
  text: string
  /** 行内真正变了的那一小段 */
  changed: boolean
}

/** 词级切分：把空白、标点各算一个 token，标识符（含 . _ : * / -）粘在一起 */
const TOKEN = /[A-Za-z0-9_$.*:/@-]+|\s+|[\s\S]/g

/** 两个 token 序列的 LCS 太大时不再逐词比，整行当作改了 —— 免得长行把渲染进程拖死 */
const MAX_CELLS = 250_000

/**
 * 一对改动词的红绿高亮。
 *
 * 长 YAML / JSON 行里真正变的往往只有 `172.16.16.138 → .139` 这种一小段，
 * 整行染色等于没告诉用户改了哪。这里对 token 跑一次 LCS，把不共有的片段标出来。
 * 任一侧为空（纯增 / 纯删）时不比，整行本身就是改动。
 */
export function wordDiff(a: string, b: string): { left: DiffSeg[]; right: DiffSeg[] } {
  const ta = a.match(TOKEN) ?? []
  const tb = b.match(TOKEN) ?? []
  if (ta.length * tb.length > MAX_CELLS) {
    return { left: [{ text: a, changed: true }], right: [{ text: b, changed: true }] }
  }

  // dp[i][j] = ta[i..] 与 tb[j..] 的 LCS 长度，从后往前填，回放时就能正向走
  const width = tb.length + 1
  const dp = new Uint32Array((ta.length + 1) * width)
  for (let i = ta.length - 1; i >= 0; i--) {
    for (let j = tb.length - 1; j >= 0; j--) {
      dp[i * width + j] =
        ta[i] === tb[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }

  const left: DiffSeg[] = []
  const right: DiffSeg[] = []
  const push = (arr: DiffSeg[], text: string, changed: boolean): void => {
    const last = arr[arr.length - 1]
    if (last && last.changed === changed) last.text += text
    else arr.push({ text, changed })
  }

  let i = 0
  let j = 0
  while (i < ta.length || j < tb.length) {
    if (i < ta.length && j < tb.length && ta[i] === tb[j]) {
      push(left, ta[i], false)
      push(right, tb[j], false)
      i++
      j++
    } else if (j < tb.length && (i === ta.length || dp[i * width + j + 1] >= dp[(i + 1) * width + j])) {
      push(right, tb[j], true)
      j++
    } else {
      push(left, ta[i], true)
      i++
    }
  }

  return { left, right }
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

/* ── 整文件视图 ─────────────────────────────────────────── */

export interface FullFileRow {
  kind: DiffRow['kind']
  left: DiffSide | null
  right: DiffSide | null
  /** 属于第几处差异；上下文行为 null */
  change: number | null
}

export interface FullFileChange {
  index: number
  /** 在 rows 里的起始 / 结束下标（含） */
  start: number
  end: number
  added: number
  removed: number
}

export interface FullFileModel {
  rows: FullFileRow[]
  changes: FullFileChange[]
  totalLeft: number
  totalRight: number
}

export interface UnifiedRow {
  kind: 'ctx' | 'add' | 'del'
  oldNo: number | null
  newNo: number | null
  text: string
  /** 一对改动词里另一侧的文字，用来懒算词级高亮；纯增 / 纯删没有 */
  pairText?: string
  change: number | null
}

/** 按行拆文本；末尾换行不算额外一行，CRLF 统一成 LF */
export function splitFileLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n')
  if (!normalized) return []
  const lines = normalized.split('\n')
  if (normalized.endsWith('\n')) lines.pop()
  return lines
}

/**
 * 把两侧完整文本和 unified diff 拼成「整文件」行模型。
 *
 * 不做二次 diff：hunk 头里的 @@ -a,b +c,d @@ 已经把改动区间说清楚了，
 * 未修改的区间按 1:1 从两侧数组直接铺。这样即使文件很大也不会在渲染层
 * 再跑一遍 Myers。
 */
export function buildFullFile(
  before: string,
  after: string,
  hunks: DiffHunk[]
): FullFileModel {
  const left = splitFileLines(before)
  const right = splitFileLines(after)
  const rows: FullFileRow[] = []
  const changes: FullFileChange[] = []
  let li = 0
  let ri = 0
  let current: number | null = null

  const pushCtx = (): void => {
    rows.push({
      kind: 'ctx',
      left: { no: li + 1, text: left[li] },
      right: { no: ri + 1, text: right[ri] },
      change: null
    })
    li++
    ri++
    current = null
  }

  const push = (r: DiffRow): void => {
    const l = r.left
      ? {
          no: r.left.no,
          text:
            r.left.no != null && r.left.no > 0 ? left[r.left.no - 1] ?? r.left.text : r.left.text
        }
      : null
    const rr = r.right
      ? {
          no: r.right.no,
          text:
            r.right.no != null && r.right.no > 0
              ? right[r.right.no - 1] ?? r.right.text
              : r.right.text
        }
      : null

    if (r.kind === 'ctx') {
      rows.push({ kind: 'ctx', left: l, right: rr, change: null })
      current = null
      return
    }

    if (current === null) {
      current = changes.length
      changes.push({
        index: current,
        start: rows.length,
        end: rows.length,
        added: 0,
        removed: 0
      })
    }

    rows.push({ kind: r.kind, left: l, right: rr, change: current })

    const block = changes[current]
    block.end = rows.length - 1
    if (r.kind !== 'del') block.added++
    if (r.kind !== 'add') block.removed++
  }

  for (const h of hunks) {
    // 计数为 0 时，头部行号是「插入点前一行」；边界要往后挪一行
    const oldBoundary = h.oldCount === 0 ? h.oldStart : h.oldStart - 1
    const newBoundary = h.newCount === 0 ? h.newStart : h.newStart - 1
    while (li < oldBoundary && ri < newBoundary && li < left.length && ri < right.length) {
      pushCtx()
    }
    for (const r of h.rows) push(r)
    li = Math.max(li, oldBoundary + h.oldCount)
    ri = Math.max(ri, newBoundary + h.newCount)
    current = null
  }

  while (li < left.length && ri < right.length) pushCtx()
  // 完整 diff 不应剩下单边；真剩了也原样补上，绝不丢行
  while (li < left.length) {
    rows.push({ kind: 'del', left: { no: li + 1, text: left[li] }, right: null, change: null })
    li++
  }
  while (ri < right.length) {
    rows.push({ kind: 'add', left: null, right: { no: ri + 1, text: right[ri] }, change: null })
    ri++
  }

  return { rows, changes, totalLeft: left.length, totalRight: right.length }
}

/** 并排行模型 → 统一视图的扁平行模型（删除行在前，新增行在后） */
export function toUnifiedRows(rows: FullFileRow[]): UnifiedRow[] {
  const out: UnifiedRow[] = []
  for (const r of rows) {
    if (r.kind === 'ctx') {
      out.push({
        kind: 'ctx',
        oldNo: r.left?.no ?? null,
        newNo: r.right?.no ?? null,
        text: r.right?.text ?? r.left?.text ?? '',
        change: null
      })
    } else if (r.kind === 'del') {
      out.push({
        kind: 'del',
        oldNo: r.left?.no ?? null,
        newNo: null,
        text: r.left?.text ?? '',
        change: r.change
      })
    } else if (r.kind === 'add') {
      out.push({
        kind: 'add',
        oldNo: null,
        newNo: r.right?.no ?? null,
        text: r.right?.text ?? '',
        change: r.change
      })
    } else {
      if (r.left) {
        out.push({
          kind: 'del',
          oldNo: r.left.no ?? null,
          newNo: null,
          text: r.left.text ?? '',
          pairText: r.right?.text,
          change: r.change
        })
      }
      if (r.right) {
        out.push({
          kind: 'add',
          oldNo: null,
          newNo: r.right.no ?? null,
          text: r.right.text ?? '',
          pairText: r.left?.text,
          change: r.change
        })
      }
    }
  }
  return out
}
