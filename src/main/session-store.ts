import { promises as fsp } from 'node:fs'
import type { Stats } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '../shared/events'
import { sameCwd } from '../shared/settings'
import type {
  SessionSearchHit,
  SessionSearchResult,
  StoredSession
} from '../shared/session'
import { looksInjected, replayRecords } from './providers/claude/history'
import {
  listCodexSessionFiles,
  readCodexTranscript
} from './providers/codex/history'
import { listDshSessionFiles, readDshTranscript } from './providers/dsh/history'
import { t } from './i18n'
import { IO_CONCURRENCY, mapLimit } from './concurrency'

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

/**
 * 首条消息带图片时，一个 JSONL 行就有几百 KB（图片 base64），而 `cwd` 又排在
 * 整条记录的最后 —— 只读 32KB 会停在 base64 中间，既拿不到 cwd 也拿不到标题，
 * 这条会话于是被整个跳过（侧栏里看不到）。头里找不到 cwd 时按需扩大重读。
 */
const MAX_HEAD_BYTES = 8 * 1024 * 1024

/** 文件尾兜底：即使首行超过 MAX_HEAD_BYTES，cwd 也总在最后一条记录末尾附近 */
const TAIL_BYTES = 256 * 1024

/** 单份会话最多回放这么多条记录，防一份异常大的文件把界面拖死 */
const MAX_RECORDS = 20_000

/**
 * 列表扫描时同时处理的文件数。
 *
 * 每个文件可能要读 32KB~8MB 的头，16 路并发在图片多的目录里会同时
 * 放太多 Buffer 在内存里；8 路足够把 400 次 stat/read 的往返延迟摊开。
 */
const SCAN_FILE_CONCURRENCY = 8

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

async function readRange(file: string, start: number, bytes: number): Promise<string> {
  if (bytes <= 0) return ''
  const fh = await fsp.open(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, start)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

async function readHead(file: string, bytes = HEAD_BYTES): Promise<string> {
  return readRange(file, 0, bytes)
}

/**
 * 首条消息可能带着 IDE 代码引用块（<ide_reference>…</ide_reference>）。
 * 引用块动辄几百行，直接拿来当标题会把侧栏撑成一串 XML —— 先剥掉，
 * 只留用户自己写的说明。
 */
function stripIdeRefs(s: string): string {
  return s
    .replace(/<ide_reference\s+[^>]*>[\s\S]*?<\/ide_reference>/g, ' ')
    // 头部被截断时闭合标签可能不在，从开标签一直切到结尾
    .replace(/<ide_reference\b[\s\S]*$/g, ' ')
}

function cleanTitle(s: string): string {
  return stripIdeRefs(s).replace(/\s+/g, ' ').trim().slice(0, 80)
}

/**
 * 文件头的解析缓存，键是绝对路径。
 *
 * 列表现在要**频繁重拉**（每轮跑完、每次窗口重新获得焦点），而每拉一次都要
 * 给 400+ 份文件各读 32KB 头 —— 实测 110ms。文件没变就直接复用上次的解析
 * 结果，只剩一次 stat；扫描本身也已经异步化，不再堵住主进程的 IPC。
 */
const headCache = new Map<
  string,
  { mtimeMs: number; size: number; cwd: string; title: string; createdAt: number }
>()

/** 从文件头里抠出 cwd、标题和创建时间 */
function parseHead(head: string): { cwd: string; title: string; createdAt: number } {
  let cwd = ''
  let title = ''
  let createdAt = 0
  for (const line of head.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(line) as Record<string, unknown>
    } catch {
      // 头部可能截断在半个 JSON 上。第一条用户消息带了一大段 IDE 代码引用时
      // 很容易超过 32KB，整行解析不了 —— 但 cwd 和开头那句人话都在前缀里，
      // 直接抠出来，别让侧栏标题变成「无标题」。
      if (!title && line.includes('"type":"user"') && !line.includes('"isSidechain":true')) {
        if (!cwd) {
          const cm = line.match(/"cwd"\s*:\s*"((?:\\.|[^"\\])*)"/)
          if (cm) {
            try {
              cwd = JSON.parse(`"${cm[1]}"`) as string
            } catch {
              cwd = cm[1]
            }
          }
        }
        // 不要要求闭合引号：第一条消息可能整行都被截断，只取开头一段
        const tm = line.match(/"text"\s*:\s*"((?:\\.|[^"\\]){0,2048})/)
        if (tm) {
          let raw = tm[1]
          try {
            raw = JSON.parse(`"${raw}"`) as string
          } catch {
            // 转义序列本身被截断时直接用原文
          }
          if (raw.trim() && !looksInjected(raw)) title = cleanTitle(raw)
        }
      }
      continue
    }
    // 第一条带时间戳的记录就是会话的创建时间。文件是追加写的，顺序可靠；
    // 首条可能是 queue-operation 而不是用户消息，同样是创建时刻。
    if (!createdAt && typeof rec.timestamp === 'string') {
      const t = Date.parse(rec.timestamp)
      if (Number.isFinite(t)) createdAt = t
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
    else if (!title && hasImage) title = t('chat.title.imageMessage')
  }
  return { cwd, title, createdAt }
}

/**
 * 解析文件头；没拿到 cwd 就按 8 倍扩大重读（32KB → 256KB → 2MB → 8MB）。
 * 图片消息的 base64 把 cwd/标题推到了几百 KB 之外，一次读满 8MB 太浪费。
 */
async function parseHeadExpanding(
  file: string,
  size: number
): Promise<{ head: { cwd: string; title: string; createdAt: number }; text: string }> {
  let bytes = Math.min(size, HEAD_BYTES)
  let text = await readHead(file, bytes)
  let head = parseHead(text)
  while (!head.cwd && bytes < MAX_HEAD_BYTES && bytes < size) {
    bytes = Math.min(bytes * 8, MAX_HEAD_BYTES, size)
    text = await readHead(file, bytes)
    head = parseHead(text)
  }
  return { head, text }
}

/**
 * 从文件尾找 cwd —— 首行大到 8MB 还装不下时（连发多张大图）的兜底。
 * cwd 排在每条记录的最后，所以文件最后 256KB 一定覆盖得到。
 */
async function readTailCwd(file: string, size: number): Promise<string> {
  const bytes = Math.min(TAIL_BYTES, size)
  if (bytes <= 0) return ''
  const text = await readRange(file, size - bytes, bytes)
  const m = text.match(/"cwd"\s*:\s*"((?:\\.|[^"\\])*)"/)
  if (!m) return ''
  try {
    return JSON.parse(`"${m[1]}"`) as string
  } catch {
    return m[1]
  }
}

/**
 * 会话的身份是 **(cwd, id)** 而不是单独的 id ——
 * 同一个 session id 可能同时出现在两个项目目录下（会话被换过 cwd，
 * 或者从别处 resume 过来）。只按 id 索引会互相覆盖，读历史时拿到错的那份。
 */
interface SessionFile {
  file: string
  cli: 'claude' | 'codex' | 'dsh'
  id: string
  /** dsh 的一条会话是一个目录，删除时要把目录整个收掉 */
  dir?: string
}

const pathById = new Map<string, SessionFile>()
const keyOf = (cwd: string, id: string): string => `${cwd}\u0000${id}`

/**
 * 同一时刻只跑一趟扫描。
 *
 * 异步化之后，侧栏刷新和搜索可能同时到达；两边各自 `pathById.clear()` 再
 * 交错填充，会把索引写乱。共用同一个 in-flight Promise：后来的调用直接
 * 等这一趟的结果。
 */
let listInFlight: Promise<StoredSession[]> | null = null

export function listStoredSessions(): Promise<StoredSession[]> {
  if (listInFlight) return listInFlight
  listInFlight = scanStoredSessions().finally(() => {
    listInFlight = null
  })
  return listInFlight
}

async function scanStoredSessions(): Promise<StoredSession[]> {
  const out: StoredSession[] = []
  pathById.clear()
  /** 这一趟见过的文件，用来把缓存里已经删掉的那些清出去 */
  const seen = new Set<string>()

  let projects: string[]
  try {
    projects = await fsp.readdir(ROOT())
  } catch {
    // 还没跑过 claude。**不能直接 return**：Codex / dsh 的会话跟这个目录无关，
    // 没装 Claude Code 的人也该在侧栏里看到自己的 dsh 历史。
    projects = []
  }

  /*
   * Codex / dsh 的扫描和 Claude 的目录扫描互不依赖，先启动、最后再合并。
   * 三个 CLI 各有几百个文件时，串行扫描的墙钟时间就是三者之和。
   */
  const codexScan = listCodexSessionFiles().catch(() => [])
  const dshScan = listDshSessionFiles().catch(() => [])

  // 先并发列出所有项目目录，再按文件并发解析
  const projectDirs = await mapLimit(projects, IO_CONCURRENCY, async (p) => {
    const dir = join(ROOT(), p)
    try {
      return { dir, files: await fsp.readdir(dir) }
    } catch {
      return null
    }
  })
  const fileEntries = projectDirs
    .filter((d): d is { dir: string; files: string[] } => d !== null)
    .flatMap(({ dir, files }) =>
      files
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ dir, f }))
    )

  const scanned = await mapLimit(fileEntries, SCAN_FILE_CONCURRENCY, async ({ dir, f }) => {
    const full = join(dir, f)
    seen.add(full)
    try {
      const st = await fsp.stat(full)
      if (!st.isFile()) return null

      // mtime 和大小都没变 → 上次解析出来的 cwd/标题/创建时间照样成立
      const hit = headCache.get(full)
      let head: { cwd: string; title: string; createdAt: number }
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        head = hit
      } else {
        const parsed = await parseHeadExpanding(full, st.size)
        head = parsed.head
        // 首行超过 8MB（连发多张大图）：cwd 从文件尾兜底，标题退成「图片消息」
        if (!head.cwd) {
          const cwd = await readTailCwd(full, st.size)
          if (cwd) {
            head = {
              cwd,
              title:
                head.title ||
                (parsed.text.includes('"type":"image"') ? t('chat.title.imageMessage') : ''),
              createdAt: head.createdAt
            }
          }
        }
        headCache.set(full, { mtimeMs: st.mtimeMs, size: st.size, ...head })
      }

      const { cwd, title, createdAt } = head
      if (!cwd) return null // 连 cwd 都读不到的文件，列表里没意义
      const id = f.slice(0, -'.jsonl'.length)
      return {
        file: full,
        session: {
          id,
          cwd,
          title: title || t('codexHistory.untitled'),
          // 记录里没时间戳（老文件/被截断）就退回到文件创建时间，再退 mtime
          createdAt: createdAt || st.birthtimeMs || st.mtimeMs,
          updatedAt: st.mtimeMs,
          // 这里只扫 ~/.claude/projects，所以必然是 claude。
          // 接 Codex 时它会有自己的一份扫描，把各自的 cli 填进来即可。
          cli: 'claude' as const
        }
      }
    } catch {
      // 单个文件坏了不该让整份列表崩掉
      return null
    }
  })

  // 并发结果按输入顺序返回，合并顺序和原来的串行遍历一致
  for (const entry of scanned) {
    if (!entry) continue
    const { cwd, id } = entry.session
    const k = keyOf(cwd, id)
    if (pathById.has(k)) continue // 同一份不该出现两次
    pathById.set(k, { file: entry.file, cli: 'claude', id })
    out.push(entry.session)
  }

  // 清掉已经不存在的文件，否则缓存会随着删会话一直涨
  for (const k of headCache.keys()) {
    if (!seen.has(k)) headCache.delete(k)
  }

  /*
   * Codex 的 rollout 自己有一份扫描与缓存（~/.codex/sessions）。
   * 两边都可能出现同一个 cwd，但 id 空间不同，按 (cwd,id) 合并即可；
   * 真撞了也以后者为准 —— 这种概率比文件损坏还低。
   */
  for (const { file, session } of await codexScan) {
    const k = keyOf(session.cwd, session.id)
    if (pathById.has(k)) continue
    pathById.set(k, { file, cli: 'codex', id: session.id })
    out.push(session)
  }

  /*
   * DeepSeek Harness 的会话是 $DSH_HOME/sessions 下的目录，cwd 从投影缓存
   * 或会话头里读（不反解目录名）。子代理会话和空白会话由扫描器过滤掉。
   * dsh home 不可读（权限 / 磁盘）已在启动扫描时吞掉，不影响另外两个 CLI。
   */
  for (const entry of await dshScan) {
    const { session } = entry
    const k = keyOf(session.cwd, session.id)
    if (pathById.has(k)) continue
    pathById.set(k, { file: entry.file, cli: 'dsh', id: session.id, dir: entry.dir })
    out.push(session)
  }

  /*
   * 默认按**创建时间**倒序，而不是 mtime。
   *
   * mtime 在会话运行期间每写一条记录就变一次，而列表会在每个 turn_end
   * 重拉 —— 后台跑着几条会话时，谁刚结束一轮谁就跳到顶部，看起来像在乱序。
   * 创建时间不会变，新会话仍然会出现在顶部，运行中的行则原地不动。
   * 同一毫秒创建（比如批量导入）再用 id 兜底，避免退化成目录遍历顺序。
   */
  return out.sort(
    (a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
  )
}

async function findFile(cwd: string, id: string): Promise<SessionFile | null> {
  const cached = pathById.get(keyOf(cwd, id))
  if (cached) return cached
  // 缓存没命中（比如列表还没拉过），退化成扫一遍
  await listStoredSessions()
  return pathById.get(keyOf(cwd, id)) ?? null
}

/**
 * 一条会话是否已经落盘。
 *
 * 新建会话后，渲染层要盯到它出现在侧栏为止。之前每一轮重试都调用
 * `listStoredSessions()` —— 几百份记录全部 stat + 解析，只为确认一个 id。
 *
 * Claude 的目录布局允许按文件名定向查：`<projects>/<任意编码cwd>/<id>.jsonl`，
 * 不需要反解目录名，也不需要读文件内容 —— 每个项目目录一次 stat 即可。
 * Codex / dsh 的布局不同，定向查找会复制它们的扫描逻辑；这两种 CLI 仍复用
 * 完整列表（本来就有缓存），保证行为和侧栏一致。
 */
export async function storedSessionExists(
  cli: string,
  cwd: string,
  id: string
): Promise<boolean> {
  // id 来自渲染层 / CLI 记录：不能当路径片段用
  if (
    !id ||
    id === '.' ||
    id === '..' ||
    id.includes('/') ||
    id.includes('\\') ||
    id.includes('\0')
  ) {
    return false
  }
  if (cli !== 'claude' && cli !== 'codex' && cli !== 'dsh') return false
  if (pathById.has(keyOf(cwd, id))) return true

  if (cli === 'claude') {
    let projects: string[]
    try {
      projects = await fsp.readdir(ROOT())
    } catch {
      return false
    }
    const file = `${id}.jsonl`
    const hits = await mapLimit(projects, IO_CONCURRENCY, async (p) => {
      try {
        const st = await fsp.stat(join(ROOT(), p, file))
        return st.isFile()
      } catch {
        return false
      }
    })
    return hits.some(Boolean)
  }

  const all = await listStoredSessions()
  return all.some((s) => s.id === id && (!cwd || sameCwd(s.cwd, cwd)))
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
  const found = await findFile(cwd, id)
  if (!found) return { ok: false, message: t('sessionStore.recordMissing') }

  const file = found.file
  // dsh 的会话不只是单文件：整个目录（含未来可能出现的附件）都归它
  const dir = found.cli === 'dsh' ? found.dir : undefined
  for (let i = 0; i < 6; i++) {
    try {
      if (dir) await fsp.rm(dir, { recursive: true })
      else await fsp.unlink(file)
      pathById.delete(keyOf(cwd, id))
      headCache.delete(file)
      invalidateTranscriptCache(cwd, id)
      return { ok: true }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // dsh 可能自己先一步收掉了目录；目标已经不在就算删成功
      if (code === 'ENOENT' && dir) {
        pathById.delete(keyOf(cwd, id))
        return { ok: true }
      }
      // 只对"被占用"重试；路径不存在之类的错误重试多少次都一样
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') {
        return { ok: false, message: String(err) }
      }
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  return { ok: false, message: t('sessionStore.fileBusy') }
}

/**
 * 回放缓存：在两条会话之间来回切时，不必重新读盘和解析。
 * 按**源文件大小**计预算 —— 解析后的事件只多不少，用文件大小兜个底。
 */
const TRANSCRIPT_CACHE_MAX = 4
const TRANSCRIPT_CACHE_BYTES = 48 * 1024 * 1024

/**
 * 大文件先只读尾部：回放本来也只保留最后 `MAX_RECORDS` 条。
 * 从 4MB 起步，条数不够再成倍往前扩，直到覆盖到文件头或攒够条数。
 */
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024
const TRANSCRIPT_TAIL_GROW = 8
/**
 * 尾部最多往前扩到这里。
 *
 * 图片多的会话是「字节多、记录少」：4MB 够不到 20000 条就会 4MB→32MB→256MB
 * 一路读下去，几百 MB 的字符串 + 同步 JSON.parse 会把主进程卡死。
 * 到上限就只回放已经读到的记录 —— 宁可少几条，也不要把内存打爆。
 */
const TRANSCRIPT_TAIL_MAX_BYTES = 32 * 1024 * 1024

interface TranscriptCacheEntry {
  file: string
  mtimeMs: number
  size: number
  events: AgentEvent[]
}

const transcriptCache = new Map<string, TranscriptCacheEntry>()
let transcriptCacheBytes = 0

function invalidateTranscriptCache(cwd: string, id: string): void {
  const key = keyOf(cwd, id)
  const hit = transcriptCache.get(key)
  if (!hit) return
  transcriptCache.delete(key)
  transcriptCacheBytes -= hit.size
}

function cacheTranscript(key: string, entry: TranscriptCacheEntry): void {
  const prev = transcriptCache.get(key)
  if (prev) {
    transcriptCache.delete(key)
    transcriptCacheBytes -= prev.size
  }
  // 超大文件不缓存：一份就几十 MB，留着只会挤占内存
  if (entry.size > TRANSCRIPT_CACHE_BYTES) return
  transcriptCache.set(key, entry)
  transcriptCacheBytes += entry.size
  while (
    transcriptCache.size > TRANSCRIPT_CACHE_MAX ||
    transcriptCacheBytes > TRANSCRIPT_CACHE_BYTES
  ) {
    const oldest = transcriptCache.keys().next().value
    if (oldest === undefined) break
    const evicted = transcriptCache.get(oldest)
    transcriptCache.delete(oldest)
    if (evicted) transcriptCacheBytes -= evicted.size
  }
}

function parseRecordLines(text: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    try {
      const v = JSON.parse(line) as unknown
      const o = obj(v)
      if (o) records.push(o)
    } catch {
      // 截断/损坏的行跳过
    }
  }
  return records
}

async function readClaudeRecords(
  file: string,
  size: number
): Promise<Record<string, unknown>[]> {
  let bytes = Math.min(size, TRANSCRIPT_TAIL_BYTES)
  for (;;) {
    const start = Math.max(0, size - bytes)
    const text = await readRange(file, start, bytes)
    // 从文件中间开始读，第一行很可能是半条记录 —— 丢掉它
    const nl = text.indexOf('\n')
    const body = start > 0 ? (nl >= 0 ? text.slice(nl + 1) : '') : text
    const records = parseRecordLines(body)
    if (start === 0) return records.slice(-MAX_RECORDS)
    if (records.length >= MAX_RECORDS) return records.slice(-MAX_RECORDS)
    const next = Math.min(size, bytes * TRANSCRIPT_TAIL_GROW)
    if (next === bytes || next > TRANSCRIPT_TAIL_MAX_BYTES) {
      return records.slice(-MAX_RECORDS)
    }
    bytes = next
  }
}

/** 读一份会话并把记录回放成事件流。cwd 必须一起给：身份是 (cwd, id)。 */
export interface ReadTranscriptOptions {
  /**
   * 只回放搜索需要的对话正文：跳过图片 base64、工具回执和系统事件。
   * 搜索路径专用 —— 事件不再完整，不能拿去渲染转写区。
   */
  textOnly?: boolean
}

export async function readTranscript(
  cwd: string,
  id: string,
  opts: ReadTranscriptOptions = {}
): Promise<AgentEvent[]> {
  const found = await findFile(cwd, id)
  if (!found) return []

  let st: Stats
  try {
    st = await fsp.stat(found.file)
  } catch {
    return []
  }

  const textOnly = opts.textOnly === true
  const key = keyOf(cwd, id)
  /*
   * textOnly 的事件形状和真实回放不同（无图片、无工具输出），
   * 既不读也不写回放缓存 —— 否则搜索会把用户正开着的会话挤出去，
   * 还可能把残缺事件当成完整回放返回。
   */
  if (!textOnly) {
    const hit = transcriptCache.get(key)
    if (hit && hit.file === found.file && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      // LRU：命中后挪到队尾
      transcriptCache.delete(key)
      transcriptCache.set(key, hit)
      return hit.events
    }
  }

  let events: AgentEvent[]
  try {
    if (found.cli === 'codex') events = await readCodexTranscript(found.file, cwd, id)
    else if (found.cli === 'dsh') events = await readDshTranscript(found.file, cwd, id)
    else events = replayRecords(await readClaudeRecords(found.file, st.size), opts)
  } catch {
    return []
  }

  if (!textOnly) {
    cacheTranscript(key, { file: found.file, mtimeMs: st.mtimeMs, size: st.size, events })
  }
  return events
}

/* ── 会话内容搜索 ─────────────────────────────────────────── */

/**
 * 搜索直接复用 `readTranscript()` 的归一化结果，而不是各自解析 jsonl：
 * 三种 CLI 的记录格式完全不同，历史回放那套逻辑已经处理过图片、子代理、
 * zstd 压缩这些坑，再写一份解析器只会多一份会漂移的真相。
 *
 * 代价是首次搜索要把记录读一遍。按 (mtime, size) 缓存提取出的文本，
 * 会话没变就不会重复解析 —— 后续搜索基本只剩 stat + indexOf。
 */

/** 单份记录超过这个大小就跳过：多半是塞满图片的会话，读进来只会拖慢搜索 */
const SEARCH_MAX_BYTES = 16 * 1024 * 1024
/** 单条会话最多保留这么多字符做匹配，避免一份巨型记录常驻内存 */
const SEARCH_TEXT_MAX = 1_000_000
/** 命中片段前后各取多少字符 */
const SNIPPET_PAD = 48
/** 最多缓存多少条会话的文本；超出后按写入顺序淘汰 */
const SEARCH_CACHE_MAX = 400
/**
 * 文本缓存的总字符预算。
 *
 * 只限条数不够：单条上限 100 万字符 × 400 条，最坏能吃掉近 800MB 内存。
 * 超过预算时从现在最旧的那条开始淘汰。
 */
const SEARCH_CACHE_CHARS = 64 * 1024 * 1024

const searchTextCache = new Map<string, { mtimeMs: number; size: number; text: string }>()
let searchCacheChars = 0

function rememberSearchText(
  file: string,
  entry: { mtimeMs: number; size: number; text: string }
): void {
  const prev = searchTextCache.get(file)
  if (prev) {
    searchTextCache.delete(file)
    searchCacheChars -= prev.text.length
  }
  // 单条就超过整份预算：不缓存，避免一个巨型会话把其他条目全挤掉
  if (entry.text.length > SEARCH_CACHE_CHARS) return
  searchTextCache.set(file, entry)
  searchCacheChars += entry.text.length
  while (
    searchTextCache.size > SEARCH_CACHE_MAX ||
    searchCacheChars > SEARCH_CACHE_CHARS
  ) {
    const oldest = searchTextCache.keys().next().value
    if (oldest === undefined) break
    const evicted = searchTextCache.get(oldest)
    searchTextCache.delete(oldest)
    if (evicted) searchCacheChars -= evicted.text.length
  }
}

/**
 * 只收用户和模型说的话（含思考）。
 *
 * 工具结果动辄几万行，既可能是日志也可能是整份文件；把它们全拼进来会让
 * 缓存膨胀，也让「搜到的是什么」变得难以辨认。用户要找的通常是某轮对话
 * 里提到的那句话。
 */
function extractSearchText(events: AgentEvent[]): string {
  const parts: string[] = []
  let len = 0
  for (const e of events) {
    let text = ''
    if (e.t === 'user_message') text = e.text
    else if (e.t === 'text_delta' || e.t === 'thinking_delta') text = e.text
    if (!text) continue
    parts.push(text)
    len += text.length
    if (len >= SEARCH_TEXT_MAX) break
  }
  return parts.join('\n').slice(0, SEARCH_TEXT_MAX)
}

/** 读一条会话的搜索文本；oversized = 文件太大被跳过 */
async function searchTextOf(
  session: StoredSession
): Promise<{ text: string; oversized: boolean }> {
  const sf = pathById.get(keyOf(session.cwd, session.id))
  if (!sf) return { text: '', oversized: false }

  let size: number
  let mtimeMs: number
  try {
    const st = await fsp.stat(sf.file)
    size = st.size
    mtimeMs = st.mtimeMs
  } catch {
    return { text: '', oversized: false }
  }
  if (size > SEARCH_MAX_BYTES) return { text: '', oversized: true }

  const hit = searchTextCache.get(sf.file)
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
    return { text: hit.text, oversized: false }
  }

  let text: string
  try {
    text = extractSearchText(
      await readTranscript(session.cwd, session.id, { textOnly: true })
    )
  } catch {
    // 单份记录坏了（截断、zstd 损坏）只跳过它，不打断整次搜索
    return { text: '', oversized: false }
  }

  rememberSearchText(sf.file, { mtimeMs, size, text })
  return { text, oversized: false }
}

function snippetAround(text: string, at: number, len: number): string {
  const start = Math.max(0, at - SNIPPET_PAD)
  const end = Math.min(text.length, at + len + SNIPPET_PAD)
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

/** 一批最多占用主进程多久；渲染层拿到 nextOffset 后继续下一批 */
const SEARCH_BUDGET_MS = 600
/** 每扫几条让出一次事件循环，别让一批 1 秒的扫描完全堵住 IPC */
const SEARCH_YIELD_EVERY = 4
/** 多批搜索共用同一份会话快照，避免每批都重新扫目录 */
const SEARCH_SNAPSHOT_MS = 30_000
let searchSnapshot: { at: number; ordered: StoredSession[] } | null = null

/**
 * 在所有 CLI 会话记录里搜内容。
 *
 * 冷启动时几百份记录全解析要十秒以上，一次性做完会让搜索框一直空着、
 * 主进程也长时间无法响应。这里按 offset 分批：每批最多扫约半秒，返回
 * 已经找到的命中和 nextOffset，渲染层追加展示后再要下一批。
 * 提取过的文本按 (mtime, size) 缓存，所以第二批开始会越来越快。
 */
export async function searchStoredSessions(
  query: string,
  limit = 20,
  offset = 0
): Promise<SessionSearchResult> {
  const q = query.trim().toLowerCase()
  const startAt = Math.max(0, Math.floor(Number(offset)) || 0)
  const empty: SessionSearchResult = {
    hits: [],
    truncated: false,
    scanned: 0,
    offset: startAt,
    nextOffset: startAt,
    done: true,
    total: 0
  }
  // 单字符命中太多，既没有区分度又浪费一次全量扫描
  if (q.length < 2) return empty

  const max = Math.max(1, Math.min(200, Math.floor(Number(limit)) || 20))
  /*
   * 第一批重新列一次会话（顺便刷新 pathById / headCache，和侧栏保持一致），
   * 后续批次复用同一份排序结果。否则每批都要重扫几百个目录、重算排序，
   * 而且期间新增会话会让 offset 错位，出现重复或漏搜。
   */
  const now = Date.now()
  if (startAt === 0 || !searchSnapshot || now - searchSnapshot.at > SEARCH_SNAPSHOT_MS) {
    const ordered = (await listStoredSessions())
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
    searchSnapshot = { at: now, ordered }
  }
  const ordered = searchSnapshot.ordered
  const total = ordered.length
  const from = Math.min(startAt, total)
  const startedAt = Date.now()

  const hits: SessionSearchHit[] = []
  /** 只表示"有超大文件被跳过"；单批达到 limit 时渲染层会继续要下一批 */
  let skippedLarge = false
  let scanned = 0
  let i = from

  for (; i < total; i++) {
    if (scanned > 0 && scanned % SEARCH_YIELD_EVERY === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    // 预算用完就先把这一批交回去；下一批从当前这条继续，不丢会话
    if (scanned > 0 && Date.now() - startedAt >= SEARCH_BUDGET_MS) {
      return {
        hits,
        truncated: skippedLarge,
        scanned,
        offset: from,
        nextOffset: i,
        done: false,
        total
      }
    }

    const s = ordered[i]
    scanned++
    const { text, oversized } = await searchTextOf(s)
    if (oversized) skippedLarge = true
    if (!text) continue

    const lower = text.toLowerCase()
    const first = lower.indexOf(q)
    if (first < 0) continue

    // 只数到一个上限：侧栏提示「N 处」不需要精确到几千
    let matches = 0
    let at = first
    while (at >= 0 && matches < 9999) {
      matches++
      at = lower.indexOf(q, at + q.length)
    }

    hits.push({
      id: s.id,
      cwd: s.cwd,
      cli: s.cli,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      snippet: snippetAround(text, first, q.length),
      matches,
      field: 'content'
    })

    if (hits.length >= max) {
      const nextOffset = i + 1
      return {
        hits,
        truncated: skippedLarge,
        scanned,
        offset: from,
        nextOffset,
        done: nextOffset >= total,
        total
      }
    }
  }

  return {
    hits,
    truncated: skippedLarge,
    scanned,
    offset: from,
    nextOffset: total,
    done: true,
    total
  }
}
