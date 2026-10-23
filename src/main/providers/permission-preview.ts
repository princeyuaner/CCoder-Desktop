import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { MessageKey } from '../../shared/i18n'
import type { DiffLine, PermissionPreview } from '../../shared/events'
import { msg } from '../i18n'

const MAX_FILE_BYTES = 2 * 1024 * 1024
/** LCS 的 DP 表是 O(n·m)；超过这个规模就退回粗粒度展示，别把内存吃光 */
const MAX_DIFF_CELLS = 4_000_000
const CONTEXT = 3

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function readOrNull(abs: string): string | null {
  try {
    if (statSync(abs).size > MAX_FILE_BYTES) return null
    return readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

/**
 * 行级 LCS diff。返回逐行的 add/del/ctx。
 *
 * 大文件退回"整体删+整体增"，宁可难看也不要把主进程拖死。
 */
export function diffLines(beforeText: string, afterText: string): DiffLine[] {
  const a = beforeText.split('\n')
  const b = afterText.split('\n')

  if (a.length * b.length > MAX_DIFF_CELLS) {
    return [
      ...a.slice(0, 400).map((text) => ({ kind: 'del' as const, text })),
      ...b.slice(0, 400).map((text) => ({ kind: 'add' as const, text }))
    ]
  }

  const n = a.length
  const m = b.length
  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: a[i++] })
    } else {
      out.push({ kind: 'add', text: b[j++] })
    }
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] })
  while (j < m) out.push({ kind: 'add', text: b[j++] })
  return out
}

/** 只保留改动附近 CONTEXT 行，远端上下文折叠成一行省略号 */
export function trimContext(lines: DiffLine[], context = CONTEXT): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((l, idx) => {
    if (l.kind === 'ctx') return
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) {
      keep[k] = true
    }
  })
  const out: DiffLine[] = []
  let skipping = false
  lines.forEach((l, idx) => {
    if (keep[idx]) {
      out.push(l)
      skipping = false
    } else if (!skipping) {
      out.push({ kind: 'ctx', text: '⋯' })
      skipping = true
    }
  })
  return out
}

/** 按工具把改动应用到原文件内容上，得到"改完之后"的样子 */
function applyTool(tool: string, input: Record<string, unknown>, before: string): string | null {
  if (tool === 'Write') return str(input.content)

  if (tool === 'Edit') {
    const oldS = str(input.old_string)
    const newS = str(input.new_string)
    if (!oldS || !before.includes(oldS)) return null
    return input.replace_all === true
      ? before.split(oldS).join(newS)
      : before.replace(oldS, newS)
  }

  if (tool === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : []
    let cur = before
    for (const e of edits) {
      const o = obj(e)
      const oldS = str(o.old_string)
      const newS = str(o.new_string)
      if (!oldS || !cur.includes(oldS)) return null
      cur = o.replace_all === true ? cur.split(oldS).join(newS) : cur.replace(oldS, newS)
    }
    return cur
  }

  return null
}

/** 明显会伤到机器或不可逆的命令，给个提醒 */
const RISKY: { re: RegExp; noteKey: MessageKey }[] = [
  { re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, noteKey: 'preview.risk.rm' },
  { re: /\bsudo\b/, noteKey: 'preview.risk.sudo' },
  { re: /\bgit\s+push\b.*(--force|-f)\b/, noteKey: 'preview.risk.forcePush' },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f)/, noteKey: 'preview.risk.discard' },
  { re: /(curl|wget)[^|]*\|\s*(ba)?sh\b/, noteKey: 'preview.risk.pipeShell' },
  { re: />\s*\/dev\/(sd|nvme|disk)/, noteKey: 'preview.risk.blockDevice' },
  { re: /\bchmod\s+-R\s+777\b/, noteKey: 'preview.risk.chmod' },
  { re: /\b(shutdown|reboot|mkfs)\b/, noteKey: 'preview.risk.machine' }
]

export function buildPreview(tool: string, input: unknown, cwd: string): PermissionPreview {
  const o = obj(input)
  const rawPath = str(o.file_path) || str(o.notebook_path)

  // 1) 文件改动 —— 算真实 diff
  if (rawPath && (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write')) {
    const abs = isAbsolute(rawPath) ? rawPath : join(cwd, rawPath)
    const before = readOrNull(abs)
    const isNew = before === null
    const base = before ?? ''
    const after = applyTool(tool, o, base)

    if (after !== null && !isNew) {
      const lines = trimContext(diffLines(base, after))
      const added = lines.filter((l) => l.kind === 'add').length
      const removed = lines.filter((l) => l.kind === 'del').length
      return {
        kind: 'diff',
        title: msg('preview.edit', { path: rawPath }),
        path: abs,
        lines,
        note: `+${added} −${removed}`
      }
    }

    if (after !== null && isNew) {
      const lines = after.split('\n').slice(0, 200).map((text) => ({ kind: 'add' as const, text }))
      return {
        kind: 'diff',
        title: msg('preview.create', { path: rawPath }),
        path: abs,
        lines,
        note: msg('preview.lines', { n: after.split('\n').length })
      }
    }

    // 应用不上（old_string 找不到，或文件读不到）：退化成原样展示参数
    return {
      kind: 'text',
      title: msg('preview.modify', { path: rawPath }),
      path: abs,
      note: msg('preview.cannotRead')
    }
  }

  // 2) 命令 —— 原样展示 + 危险标注
  if (tool === 'Bash') {
    const command = str(o.command)
    const hit = RISKY.find((r) => r.re.test(command))
    return {
      kind: 'command',
      title: msg('preview.runCommand'),
      command,
      note: hit ? msg(hit.noteKey) : undefined,
      // 界面靠这个字段决定"要不要摘掉回车的快捷放行"，别让它从 note 反推
      danger: !!hit
    }
  }

  // 3) 其它工具 —— 参数原样给出
  return { kind: 'text', title: msg('preview.useTool', { tool }) }
}
