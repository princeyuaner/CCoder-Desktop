import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { decompress } from 'fzstd'
import type { AgentEvent } from '../../../shared/events'
import type { StoredSession } from '../../../shared/session'
import { t } from '../../i18n'
import { DshEventTranslator } from './events'
import { listDshHomes } from './runner'

/**
 * DeepSeek Harness 的会话历史。
 *
 * 存储布局（0.2.x 实测）：
 *   $DSH_HOME/sessions/<编码后的 cwd>/<sessionId>/session.v4.jsonl.zstd
 * 旧版本写 `session.v3.jsonl.zstd` / `session.jsonl.zstd`，三种都认，按版本
 * 从高到低取一份 —— **不要按 mtime 挑**：升级后旧的 v3 可能还躺在那里且
 * 更新时间更晚（实测 session-1e003f4f）。
 *
 * 文件是**追加写的多帧 zstd**（每批事件一帧），所以：
 *  - 整份解压用 fzstd（Electron 33 的 Node 20 没有内置 zstd）；
 *  - 会话还在写时最后一帧可能不完整，解压失败就退化成"只解完整帧"。
 *
 * 列表元数据优先读 dsh 自己的投影缓存
 * `$DSH_HOME/storages/session_projcache/sessions/<id>.json`（cwd / createdAt /
 * 标题 / 是否空白），没有缓存时才去解压会话头。这样侧栏刷新不必碰几十份
 * 几百 KB 的压缩文件。
 */

const ZSTD_MAGIC = 0xfd2fb528

/** 优先取版本号最大的那份；老版本只有无后缀的 session.jsonl.zstd */
const TRANSCRIPT_NAMES = [
  'session.v4.jsonl.zstd',
  'session.v3.jsonl.zstd',
  'session.jsonl.zstd'
]

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
/** 标量数字：dsh 里 time / createdAt 都是毫秒时间戳 */
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

function cleanTitle(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 80)
}

function clip(s: string, max = 20_000): string {
  return s.length > max ? `${s.slice(0, max)}\n…（输出已截断）` : s
}

/* ── zstd ─────────────────────────────────────────────────── */

/**
 * 一个 zstd 帧的字节长度；数据不够（文件正在追加）返回 -1。
 *
 * 只需要走完帧头和每个 block 的 3 字节头 —— block 负载直接按长度跳过，
 * 不用真的读它。这样从文件头就能确定第一帧的边界。
 */
function frameLength(buf: Buffer, start: number): number {
  if (buf.length - start < 8) return -1
  if (buf.readUInt32LE(start) !== ZSTD_MAGIC) return -1

  let p = start + 4
  const desc = buf[p++]
  const fcsFlag = desc >> 6
  const singleSegment = (desc >> 5) & 1
  const checksum = (desc >> 2) & 1
  const dictFlag = desc & 3

  if (!singleSegment) {
    if (p >= buf.length) return -1
    p += 1 // Window_Descriptor
  }
  p += [0, 1, 2, 4][dictFlag]
  p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : 1 << fcsFlag
  if (p > buf.length) return -1

  for (;;) {
    if (p + 3 > buf.length) return -1
    const header = buf.readUIntLE(p, 3)
    p += 3
    const last = header & 1
    const type = (header >> 1) & 3
    const size = header >>> 3
    if (type === 3) return -1 // reserved
    p += type === 1 ? 1 : size // RLE 只存 1 字节
    if (p > buf.length) return -1
    if (last) break
  }
  if (checksum) p += 4
  return p > buf.length ? -1 : p - start
}

/** 解压整份文件；尾部帧不完整时只回放已经写完的部分 */
function decodeZstd(buf: Buffer): string {
  if (buf.length === 0) return ''
  try {
    return Buffer.from(decompress(buf)).toString('utf8')
  } catch {
    // 正在写入：跳过最后一个不完整的帧
  }

  const parts: Buffer[] = []
  let p = 0
  while (p < buf.length) {
    const n = frameLength(buf, p)
    if (n <= 0) break
    parts.push(buf.subarray(p, p + n))
    p += n
  }
  if (parts.length === 0) return ''
  try {
    return Buffer.from(decompress(Buffer.concat(parts))).toString('utf8')
  } catch {
    return ''
  }
}

function readPrefix(file: string, size: number, maxBytes: number): string {
  const bytes = Math.min(size, maxBytes)
  if (bytes <= 0) return ''
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return decodeZstd(buf.subarray(0, n))
  } catch {
    return ''
  } finally {
    closeSync(fd)
  }
}

/* ── 列表 ─────────────────────────────────────────────────── */

export interface DshSessionFile {
  /** 会话记录文件（删除时和 dir 一起收掉） */
  file: string
  /** 会话目录 —— dsh 一条会话就是一个目录 */
  dir: string
  session: StoredSession
}

interface DshHeader {
  id: string
  cwd: string
  createdAt: number
  origin: string
  delegationDepth: number
}

const headerCache = new Map<
  string,
  { mtimeMs: number; size: number; header: DshHeader }
>()

/** 会话头记录（第一帧）—— cwd / 创建时间 / 是否子代理 */
function readHeader(file: string, size: number, mtimeMs: number): DshHeader | null {
  const hit = headerCache.get(file)
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.header

  // 头一帧只有几百字节；读 8KB 足够走完帧边界，真遇到异常版本再扩大
  let text = readPrefix(file, size, 8 * 1024)
  if (!text) text = readPrefix(file, size, 256 * 1024)
  const line = text.split('\n')[0]
  if (!line.startsWith('{')) return null

  let rec: Record<string, unknown>
  try {
    rec = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  if (str(rec.type) !== 'session') return null

  const header: DshHeader = {
    id: str(rec.id),
    cwd: str(rec.cwd),
    createdAt: num(rec.createdAt),
    origin: str(rec.origin),
    delegationDepth: num(rec.delegationDepth)
  }
  headerCache.set(file, { mtimeMs, size, header })
  return header
}

interface DshProjCache {
  cwd: string
  createdAt: number
  title: string
  blank: boolean
}

const projCache = new Map<
  string,
  { mtimeMs: number; size: number; info: DshProjCache }
>()

/**
 * 读 dsh 的投影缓存。
 *
 * 字段是嵌套的：`record.identity` / `record.rows.*`，每行还套一层
 * `{ver, seq, val}` —— 直接按 val 取，版本号变了也还能用。
 */
function readProjCache(file: string): DshProjCache | null {
  let st
  try {
    st = statSync(file)
  } catch {
    return null
  }
  const hit = projCache.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.info

  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  let rec: Record<string, unknown>
  try {
    rec = obj(obj(JSON.parse(raw))?.record) ?? {}
  } catch {
    return null
  }

  const identity = obj(rec.identity) ?? {}
  const rows = obj(rec.rows) ?? {}
  // 注意：val 可能是字符串（title）也可能是对象（sessionStats），
  // 这里原样返回，别套 obj —— 套了会把字符串标题吞掉。
  const rowVal = (key: string): unknown => obj(rows[key])?.val
  const metadata = rowVal('sessionListMetadata') ?? {}
  const titleInput = obj(rowVal('titleInput'))
  const first = obj(titleInput?.first)

  const info: DshProjCache = {
    cwd: str(identity.cwd),
    createdAt: num(identity.createdAt),
    // title 行可能是 null（还没生成标题）；titleInput 里存着首条消息原文
    title: str(rowVal('title')) || str(first?.text),
    blank: obj(metadata)?.blank === true
  }
  projCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, info })
  return info
}

/** 没有投影缓存时，从会话前几帧里找第一条真人消息当标题 */
function titleFromTranscript(file: string, size: number): string {
  const text = readPrefix(file, size, 256 * 1024)
  if (!text) return ''
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (str(rec.type) === 'session/title') {
      const title = str(obj(rec.data)?.title)
      if (title) return cleanTitle(title)
    }
    if (str(rec.type) !== 'user/message') continue
    const data = obj(rec.data) ?? {}
    // 系统注入（runtime-context / skill-catalog / agent-instructions…）
    // 的 source.kind 不是 user，不能当标题
    if (str(obj(data.source)?.kind) !== 'user') continue
    const text = arr(data.content)
      .map((b) => (str(obj(b)?.type) === 'text' ? str(obj(b)?.text) : ''))
      .filter(Boolean)
      .join('\n')
    const title = cleanTitle(text)
    if (title) return title
  }
  return ''
}

export function listDshSessionFiles(): DshSessionFile[] {
  const out: DshSessionFile[] = []
  const seenFiles = new Set<string>()
  const seenProj = new Set<string>()

  /*
   * 每个渠道一个 home，另外还有共享的 `~/.dsh`（official 模式 / 旧会话）。
   * 全部扫一遍，侧栏才不会因为换了渠道就"丢历史"。
   */
  const scan = (home: string): void => {
    const root = join(home, 'sessions')
    let encodings: string[]
    try {
      encodings = readdirSync(root)
    } catch {
      return // 这个 home 还没跑过 dsh
    }

    for (const encoded of encodings) {
      const encDir = join(root, encoded)
      let ids: string[]
      try {
        ids = readdirSync(encDir)
      } catch {
        continue
      }

      for (const id of ids) {
        const dir = join(encDir, id)
        let files: string[]
        try {
          files = readdirSync(dir)
        } catch {
          continue
        }

        const name = TRANSCRIPT_NAMES.find((n) => files.includes(n))
        if (!name) continue

        const file = join(dir, name)
        let st
        try {
          st = statSync(file)
        } catch {
          continue
        }
        if (!st.isFile()) continue
        seenFiles.add(file)

        const header = readHeader(file, st.size, st.mtimeMs)
        if (!header) continue
        // 子代理会话不是用户开的，混进侧栏只会让列表变脏
        if (header.origin === 'subagent' || header.delegationDepth > 0) continue

        const projFile = join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`)
        seenProj.add(projFile)
        const proj = readProjCache(projFile)

        // 新建但一句话都没说的会话：dsh 自己的 session/list 也不列它
        if (proj?.blank) continue

        // dsh 自己写的 cwd 可能是 `C:/Users/...`，也可能是 `C:\Users\...`
        // （TUI 和 ACP 两条路径不一样）。统一成系统分隔符，否则同一个工作区
        // 会被拆成两组，其中一组在侧栏里根本点不到。
        const cwd = normalize(proj?.cwd || header.cwd)
        if (!cwd) continue

        const title =
          cleanTitle(proj?.title ?? '') ||
          titleFromTranscript(file, st.size) ||
          t('codexHistory.untitled')

        out.push({
          file,
          dir,
          session: {
            id: header.id || id,
            cwd,
            title,
            // 记录里没有创建时间就退回文件创建时间，再退 mtime
            createdAt: proj?.createdAt || header.createdAt || st.birthtimeMs || st.mtimeMs,
            updatedAt: st.mtimeMs,
            cli: 'dsh'
          }
        })
      }
    }
  }

  for (const home of listDshHomes()) scan(home)

  // 已经删掉的会话别在缓存里留一辈子
  for (const k of headerCache.keys()) if (!seenFiles.has(k)) headerCache.delete(k)
  for (const k of projCache.keys()) if (!seenProj.has(k)) projCache.delete(k)

  return out
}

/* ── 历史回放 ─────────────────────────────────────────────── */

/**
 * 把一份 dsh 会话回放成 AgentEvent。
 *
 * 只认**终态记录**（assistant/message、tool/call、tool/result），忽略
 * *-chunks：后者是逐 token 的流式增量，回放它们既慢又会把界面撑爆，
 * 而 assistant/message 已经带着这一轮的完整内容。
 */
export function readDshTranscript(file: string, cwd: string, sessionId = ''): AgentEvent[] {
  let raw: Buffer
  try {
    raw = readFileSync(file)
  } catch {
    return []
  }
  const text = decodeZstd(raw)
  if (!text) return []

  const records: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      const rec = obj(JSON.parse(line))
      if (rec) records.push(rec)
    } catch {
      // 损坏 / 截断的行跳过
    }
  }
  if (records.length === 0) return []

  // 第一遍：模型和上下文窗口可能出现在 user_message 之后，
  // 而 session_started 要在第一条用户消息前发出 —— 先扫出来。
  let model = ''
  let contextWindow = 0
  let headerCwd = ''
  for (const rec of records) {
    const data = obj(rec.data) ?? {}
    if (str(rec.type) === 'session' && !headerCwd) headerCwd = str(data.cwd)
    if (str(rec.type) === 'request/context') {
      model = str(data.model) || model
      contextWindow = num(data.contextWindow) || contextWindow
    }
    if (str(rec.type) === 'request/header') {
      const config = obj(obj(data.header)?.config) ?? {}
      model = model || str(config.model)
    }
  }

  const out: AgentEvent[] = []
  const translator = new DshEventTranslator({
    sessionId,
    cwd: headerCwd || cwd,
    initialModel: model,
    initialContextWindow: contextWindow,
    headerCwd,
    live: false,
    emitStarted: true,
    onEvent: (e) => out.push(e)
  })

  for (const rec of records) {
    const type = str(rec.type)
    const data = obj(rec.data) ?? {}
    if (type === 'session') {
      if (!headerCwd) headerCwd = str(data.cwd)
      continue
    }
    translator.push({
      type,
      seq: num(rec.seq),
      time: num(rec.time),
      data
    })
  }

  return out
}
