import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '../shared/events'
import type { StoredSession } from '../shared/session'
import { looksInjected, replayRecords } from './providers/claude/history'

/**
 * 读 CLI 自己的会话存储。
 *
 * **不自己建一套会话存储**：`~/.claude/projects/<编码后的cwd>/<session-id>.jsonl`
 * 是权威数据，终端里跑的 `claude` 和这里看到的是同一份。自己再存一份只会
 * 制造两个真相。
 *
 * 也不去反解目录名（`C--Users-CY-...` 那套编码）—— **从记录里读 cwd** 更可靠，
 * 编码规则变了也不会错。
 */

const ROOT = (): string => join(homedir(), '.claude', 'projects')

/** 只读文件头。首条用户消息几乎总在前几 KB，没必要把 1MB 的文件全读进来。 */
const HEAD_BYTES = 32 * 1024

/** 单份会话最多回放这么多条记录，防一份异常大的文件把界面拖死 */
const MAX_RECORDS = 20_000

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function readHead(file: string): string {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(HEAD_BYTES)
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function cleanTitle(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 80)
}

/**
 * 文件头的解析缓存，键是绝对路径。
 *
 * 列表现在要**频繁重拉**（每轮跑完、每次窗口重新获得焦点），而每拉一次都要
 * 给 400+ 份文件各读 32KB 头 —— 实测 110ms，而且是同步读，期间主进程
 * 一个 IPC 都处理不了。文件没变就直接复用上次的解析结果，只剩 statSync。
 */
const headCache = new Map<string, { mtimeMs: number; size: number; cwd: string; title: string }>()

/** 从文件头里抠出 cwd 和标题 */
function parseHead(head: string): { cwd: string; title: string } {
  let cwd = ''
  let title = ''
  for (const line of head.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue // 头部可能截断在半个 JSON 上，正常
    }
    if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd
    if (title) continue
    if (rec.type !== 'user' || rec.isSidechain === true) continue

    const c = obj(rec.message)?.content
    let text = ''
    let hasImage = false
    if (typeof c === 'string') text = c
    else if (Array.isArray(c)) {
      text = c
        .map((b) => (obj(b)?.type === 'text' ? str(obj(b)?.text) : ''))
        .filter(Boolean)
        .join('\n')
      hasImage = c.some((b) => obj(b)?.type === 'image')
    }
    // 工具结果和系统注入都不是"用户说的话"，不能当标题
    if (text.trim() && !looksInjected(text)) title = cleanTitle(text)
    // 图片-only 的首条消息没有文字，给它一个能认出来的标题
    else if (!title && hasImage) title = '图片消息'
  }
  return { cwd, title }
}

/**
 * 会话的身份是 **(cwd, id)** 而不是单独的 id ——
 * 同一个 session id 可能同时出现在两个项目目录下（会话被换过 cwd，
 * 或者从别处 resume 过来）。只按 id 索引会互相覆盖，读历史时拿到错的那份。
 */
const pathById = new Map<string, string>()
const keyOf = (cwd: string, id: string): string => `${cwd}\u0000${id}`

export function listStoredSessions(): StoredSession[] {
  const out: StoredSession[] = []
  pathById.clear()
  /** 这一趟见过的文件，用来把缓存里已经删掉的那些清出去 */
  const seen = new Set<string>()

  let projects: string[]
  try {
    projects = readdirSync(ROOT())
  } catch {
    return [] // 还没跑过 claude，目录不存在
  }

  for (const p of projects) {
    const dir = join(ROOT(), p)
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }

    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const full = join(dir, f)
      seen.add(full)
      try {
        const st = statSync(full)
        if (!st.isFile()) continue

        // mtime 和大小都没变 → 上次解析出来的 cwd/标题照样成立
        const hit = headCache.get(full)
        let head: { cwd: string; title: string }
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
          head = hit
        } else {
          head = parseHead(readHead(full))
          headCache.set(full, { mtimeMs: st.mtimeMs, size: st.size, ...head })
        }

        const { cwd, title } = head
        if (!cwd) continue // 连 cwd 都读不到的文件，列表里没意义
        const id = f.slice(0, -'.jsonl'.length)
        const k = keyOf(cwd, id)
        if (pathById.has(k)) continue // 同一份不该出现两次
        pathById.set(k, full)
        out.push({
          id,
          cwd,
          title: title || '(无标题)',
          updatedAt: st.mtimeMs,
          // 这里只扫 ~/.claude/projects，所以必然是 claude。
          // 接 Codex 时它会有自己的一份扫描，把各自的 cli 填进来即可。
          cli: 'claude'
        })
      } catch {
        // 单个文件坏了不该让整份列表崩掉
      }
    }
  }

  // 清掉已经不存在的文件，否则缓存会随着删会话一直涨
  for (const k of headCache.keys()) {
    if (!seen.has(k)) headCache.delete(k)
  }

  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

function findFile(cwd: string, id: string): string | null {
  const cached = pathById.get(keyOf(cwd, id))
  if (cached) return cached
  // 缓存没命中（比如列表还没拉过），退化成扫一遍
  listStoredSessions()
  return pathById.get(keyOf(cwd, id)) ?? null
}

/**
 * 删掉一条会话的记录文件。**不可恢复** —— 调用方负责先问过用户。
 *
 * Windows 上文件被进程占着时 `unlink` 会 EPERM，而刚收掉的 CLI 进程
 * 不是立刻松手（dispose 里先关 stdin、超时才 kill）。所以给它几次机会 ——
 * 直接报失败的话，用户会看到"删了但没删掉"。
 */
export async function deleteStoredSession(
  cwd: string,
  id: string
): Promise<{ ok: boolean; message?: string }> {
  const file = findFile(cwd, id)
  if (!file) return { ok: false, message: '找不到这条会话的记录文件' }

  for (let i = 0; i < 6; i++) {
    try {
      unlinkSync(file)
      pathById.delete(keyOf(cwd, id))
      headCache.delete(file)
      return { ok: true }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // 只对"被占用"重试；路径不存在之类的错误重试多少次都一样
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') {
        return { ok: false, message: String(err) }
      }
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  return { ok: false, message: '文件还被占用着 —— 可能有正在跑的 CLI 开着它' }
}

/** 读一份会话并把记录回放成事件流。cwd 必须一起给：身份是 (cwd, id)。 */
export function readTranscript(cwd: string, id: string): AgentEvent[] {
  const file = findFile(cwd, id)
  if (!file) return []

  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }

  const records: Record<string, unknown>[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    try {
      const v = JSON.parse(line) as unknown
      const o = obj(v)
      if (o) records.push(o)
    } catch {
      // 截断/损坏的行跳过
    }
  }

  const trimmed = records.length > MAX_RECORDS ? records.slice(-MAX_RECORDS) : records
  return replayRecords(trimmed)
}
