import { baseName, dirName, shortDir } from './path'

/**
 * 工具调用的**展示层**数据。
 *
 * 折叠行不该直接摊命令原文 —— Bash 的 `input` 里有一句现成的
 * `description`（模型写给人看的摘要，实测 1055/1055 都有），
 * 文件工具则显示文件名。命令和完整路径都留着，只进 title 和展开区。
 */

export interface ToolStat {
  /** 增加的行数 */
  added: number
  /** 减少的行数 */
  removed: number
}

/** 工具族 —— 只用来决定图标、颜色和那个小标签，不参与业务逻辑 */
export type ToolFamily = 'bash' | 'read' | 'edit' | 'write' | 'search' | 'task' | 'ask' | 'other'

export interface ToolDisplay {
  family: ToolFamily
  /** 折叠行上的主题 */
  subject: string
  /** 文件工具的父目录（已缩短） */
  dir?: string
  /** 文件工具的完整路径 —— 只用于 title */
  path?: string
  /** Bash 的命令原文 —— 只在展开时显示 */
  command?: string
  /** 这次调用增删了多少行（Edit / MultiEdit / Write） */
  stat?: ToolStat
}

const FAMILY: Record<string, ToolFamily> = {
  Bash: 'bash',
  Read: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'write',
  Grep: 'search',
  Glob: 'search',
  WebSearch: 'search',
  WebFetch: 'search',
  Task: 'task',
  Agent: 'task',
  TaskCreate: 'task',
  TaskUpdate: 'task',
  TaskList: 'task',
  TaskGet: 'task',
  TaskStop: 'task',
  TodoWrite: 'task',
  AskUserQuestion: 'ask'
}

export function toolFamily(name: string): ToolFamily {
  return FAMILY[name] ?? 'other'
}

/**
 * 这个工具会不会写文件。
 *
 * 只用来决定「要不要记一笔修改」—— 真正落盘的是 CLI，我们只统计。
 * 注意这**不**包括 Bash：命令里有没有重定向、脚本有没有写文件，
 * 从工具名看不出来，那部分交给轮末的磁盘快照兜底。
 */
export function isFileEditTool(name: string): boolean {
  const family = toolFamily(name)
  return family === 'edit' || family === 'write'
}

/* ── 行数统计 ─────────────────────────────────────────────── */

/** 按行切开；结尾那个换行不算多出来的一行 */
function linesOf(t: string): string[] {
  if (!t) return []
  return t.replace(/\n$/, '').split('\n')
}

function countLines(t: string): number {
  return linesOf(t).length
}

/**
 * 两段文本的行级 diff —— 只用来算 Edit 的 +N −M。
 *
 * 先剥掉公共前后缀，只对中间做 LCS：Edit 的 old/new 通常只有几行，
 * 这一步能让绝大多数调用落在很小的矩阵上。中间仍然太大时退化成
 * "整段替换"，上下界都是真实行数，只是把相邻的改动算得更粗。
 */
export function diffStat(oldText: string, newText: string): ToolStat {
  const a = linesOf(oldText)
  const b = linesOf(newText)

  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++
  }

  const am = a.slice(pre, a.length - suf)
  const bm = b.slice(pre, b.length - suf)
  if (am.length === 0) return { added: bm.length, removed: 0 }
  if (bm.length === 0) return { added: 0, removed: am.length }

  // O(n·m) 的上限，别让一次大段粘贴把主线程占住
  if (am.length * bm.length > 200_000) {
    return { added: bm.length, removed: am.length }
  }

  const W = bm.length + 1
  const dp = new Uint32Array((am.length + 1) * W)
  for (let i = 1; i <= am.length; i++) {
    for (let j = 1; j <= bm.length; j++) {
      dp[i * W + j] =
        am[i - 1] === bm[j - 1]
          ? dp[(i - 1) * W + (j - 1)] + 1
          : Math.max(dp[(i - 1) * W + j], dp[i * W + (j - 1)])
    }
  }
  const same = dp[am.length * W + bm.length]
  return { added: bm.length - same, removed: am.length - same }
}

/**
 * 从 CLI 的 `structuredPatch` 精确统计增删行数。
 *
 * 这是 Edit 的**账本**：replace_all 到底替换了几处、一次 large edit 的
 * 真实 hunks，全都只在这里。live 流（tool_use_result）和历史回放
 * （jsonl 的 toolUseResult）都带这个字段，形状一致。
 *
 * 返回 null = "这条结果里没有可用的 patch"（Bash，或者空 patch）。
 *
 * **空 patch 必须返回 null，不能返 {0,0}**：Write 新建文件时 CLI 给的
 * structuredPatch 就是空的（它不把整份新文件算成 +N），返 0 会把
 * tool_call 时按 content 行数算好的 +N 覆盖掉，界面上就什么都不显示了。
 */
export function statFromPatch(patch: unknown): ToolStat | null {
  if (!Array.isArray(patch)) return null
  let added = 0
  let removed = 0
  for (const hunk of patch) {
    if (!hunk || typeof hunk !== 'object') continue
    const lines = (hunk as { lines?: unknown }).lines
    if (!Array.isArray(lines)) continue
    for (const line of lines) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return added || removed ? { added, removed } : null
}

/* ── 折叠行显示什么 ───────────────────────────────────────── */

function firstLine(s: string, max = 120): string {
  const t = (s.split('\n').find((l) => l.trim()) ?? '').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

function sumEdits(v: unknown): ToolStat | undefined {
  if (!Array.isArray(v)) return undefined
  let added = 0
  let removed = 0
  for (const e of v) {
    if (!e || typeof e !== 'object') continue
    const r = e as Record<string, unknown>
    const s = diffStat(
      typeof r.old_string === 'string' ? r.old_string : '',
      typeof r.new_string === 'string' ? r.new_string : ''
    )
    added += s.added
    removed += s.removed
  }
  return added || removed ? { added, removed } : undefined
}

export function toolDisplay(name: string, input: unknown): ToolDisplay {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const pick = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '')
  const family = toolFamily(name)

  switch (name) {
    case 'Bash': {
      const command = pick('command')
      return {
        family,
        // 主题 = 模型写的 description；没有才退回命令首行
        subject: pick('description') || firstLine(command) || '执行命令',
        command
      }
    }

    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const path = pick('file_path') || pick('notebook_path')
      let stat: ToolStat | undefined
      if (name === 'Write') {
        const n = countLines(pick('content'))
        stat = n ? { added: n, removed: 0 } : undefined
      } else if (name === 'MultiEdit') {
        stat = sumEdits(o.edits)
      } else if (name === 'Edit') {
        const s = diffStat(pick('old_string'), pick('new_string'))
        // replace_all 的真实次数只有结果里的 patch 知道，这里先按一次算，
        // tool_result 到达后会被精确值覆盖（见 reduce）
        stat = s.added || s.removed ? s : undefined
      }
      return {
        family,
        subject: baseName(path) || path || '文件',
        dir: shortDir(dirName(path)) || undefined,
        path: path || undefined,
        stat
      }
    }

    case 'Grep':
    case 'Glob': {
      const dir = shortDir(pick('path'))
      return { family, subject: pick('pattern') || '搜索', dir: dir || undefined }
    }

    case 'WebSearch':
      return { family, subject: pick('query') || '搜索网页' }

    case 'WebFetch':
      return { family, subject: pick('url') || '抓取网页' }

    case 'AskUserQuestion': {
      const qs = Array.isArray(o.questions) ? o.questions : []
      const first = qs[0] && typeof qs[0] === 'object' ? (qs[0] as Record<string, unknown>) : {}
      const q =
        (typeof first.question === 'string' && first.question) ||
        (typeof first.header === 'string' && first.header) ||
        ''
      return { family, subject: q || '向你提问' }
    }

    case 'Task':
    case 'Agent':
    case 'TaskCreate':
    case 'TaskUpdate':
      return {
        family,
        subject: pick('subject') || pick('description') || pick('taskId') || '任务'
      }

    case 'TodoWrite':
      return { family, subject: '更新任务清单' }

    default: {
      const first = Object.values(o).find((v) => typeof v === 'string')
      return { family, subject: typeof first === 'string' && first ? first : name }
    }
  }
}
