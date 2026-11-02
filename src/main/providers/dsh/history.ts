import { existsSync, promises as fsp } from 'node:fs'
import { join, normalize } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { AgentEvent } from '../../../shared/events'
import type { StoredSession } from '../../../shared/session'
import { t } from '../../i18n'
import { DshEventTranslator } from './events'
import { decodeZstd, readDshRecords } from './history-read'
import { listDshHomes } from './runner'
import { IO_CONCURRENCY, mapLimit } from '../../concurrency'

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

async function readPrefix(file: string, size: number, maxBytes: number): Promise<string> {
  const bytes = Math.min(size, maxBytes)
  if (bytes <= 0) return ''
  try {
    const fh = await fsp.open(file, 'r')
    try {
      const buf = Buffer.alloc(bytes)
      const { bytesRead } = await fh.read(buf, 0, bytes, 0)
      return decodeZstd(buf.subarray(0, bytesRead))
    } finally {
      await fh.close()
    }
  } catch {
    return ''
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
async function readHeader(
  file: string,
  size: number,
  mtimeMs: number
): Promise<DshHeader | null> {
  const hit = headerCache.get(file)
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.header

  // 头一帧只有几百字节；读 8KB 足够走完帧边界，真遇到异常版本再扩大
  let text = await readPrefix(file, size, 8 * 1024)
  if (!text) text = await readPrefix(file, size, 256 * 1024)
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
async function readProjCache(file: string): Promise<DshProjCache | null> {
  let st
  try {
    st = await fsp.stat(file)
  } catch {
    return null
  }
  const hit = projCache.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.info

  let raw: string
  try {
    raw = await fsp.readFile(file, 'utf8')
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
async function titleFromTranscript(file: string, size: number): Promise<string> {
  const text = await readPrefix(file, size, 256 * 1024)
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

export async function listDshSessionFiles(): Promise<DshSessionFile[]> {
  const seenFiles = new Set<string>()
  const seenProj = new Set<string>()

  /*
   * 先只收候选会话目录（readdir 很便宜），再把「列目录 + stat + 读头 +
   * 读投影缓存 + 必要时解压取标题」按并发上限一起跑。
   *
   * 原来三层循环全部串行：home → 编码目录 → 会话目录，每个文件还要
   * `await stat` / `await readHeader`。侧栏每次刷新都走这里，会话一多，
   * 刷新延迟就是单文件 IO 的线性累加。
   */
  const candidates: Array<{ home: string; id: string; dir: string }> = []
  for (const home of listDshHomes()) {
    const root = join(home, 'sessions')
    let encodings: string[]
    try {
      encodings = await fsp.readdir(root)
    } catch {
      continue // 这个 home 还没跑过 dsh
    }

    for (const encoded of encodings) {
      const encDir = join(root, encoded)
      let ids: string[]
      try {
        ids = await fsp.readdir(encDir)
      } catch {
        continue
      }
      for (const id of ids) candidates.push({ home, id, dir: join(encDir, id) })
    }
  }

  const rows = await mapLimit(candidates, IO_CONCURRENCY, async ({ home, id, dir }) => {
    let files: string[]
    try {
      files = await fsp.readdir(dir)
    } catch {
      return null
    }

    const name = TRANSCRIPT_NAMES.find((n) => files.includes(n))
    if (!name) return null

    const file = join(dir, name)
    let st
    try {
      st = await fsp.stat(file)
    } catch {
      return null
    }
    if (!st.isFile()) return null
    seenFiles.add(file)

    const header = await readHeader(file, st.size, st.mtimeMs)
    if (!header) return null
    // 子代理会话不是用户开的，混进侧栏只会让列表变脏
    if (header.origin === 'subagent' || header.delegationDepth > 0) return null

    const projFile = join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`)
    seenProj.add(projFile)
    const proj = await readProjCache(projFile)

    // 新建但一句话都没说的会话：dsh 自己的 session/list 也不列它
    if (proj?.blank) return null

    // dsh 自己写的 cwd 可能是 `C:/Users/...`，也可能是 `C:\Users\...`
    // （TUI 和 ACP 两条路径不一样）。统一成系统分隔符，否则同一个工作区
    // 会被拆成两组，其中一组在侧栏里根本点不到。
    const cwd = normalize(proj?.cwd || header.cwd)
    if (!cwd) return null

    const title =
      cleanTitle(proj?.title ?? '') ||
      (await titleFromTranscript(file, st.size)) ||
      t('codexHistory.untitled')

    const row: DshSessionFile = {
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
    }
    return row
  })

  // mapLimit 保持候选顺序；最终排序由 session-store 统一做
  const out: DshSessionFile[] = []
  for (const row of rows) if (row) out.push(row)

  // 已经删掉的会话别在缓存里留一辈子
  for (const k of headerCache.keys()) if (!seenFiles.has(k)) headerCache.delete(k)
  for (const k of projCache.keys()) if (!seenProj.has(k)) projCache.delete(k)

  return out
}

/* ── 历史回放 ─────────────────────────────────────────────── */

/**
 * 把整份解压/解析放到 worker。
 *
 * fzstd 是同步整份解压，几 MB 的会话就够卡住主进程的 IPC 和流式事件。
 * worker 代码由构建产物提供；拿不到（例如构建配置没带上）时退回主线程，
 * 功能不受影响，只是大会话会慢一拍。
 */
const WORKER_TIMEOUT_MS = 30_000

interface WorkerReply {
  id: number
  ok: boolean
  records?: Record<string, unknown>[]
  error?: string
}

interface WorkerPending {
  resolve: (records: Record<string, unknown>[]) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

let historyWorker: Worker | null = null
let historyWorkerSeq = 0
const historyWorkerPending = new Map<number, WorkerPending>()

function failHistoryWorker(error: Error): void {
  const worker = historyWorker
  historyWorker = null
  for (const pending of historyWorkerPending.values()) {
    clearTimeout(pending.timer)
    pending.reject(error)
  }
  historyWorkerPending.clear()
  if (worker) {
    try {
      worker.terminate()
    } catch {
      // 已经退出
    }
  }
}

/**
 * worker 文件的真实路径。
 *
 * 打包后 worker 及它的共享 chunk 被复制到 `resources/worker/`（asar 外），
 * 避免 worker_threads 直接从 asar 内加载模块的兼容性问题；开发态则用
 * 构建输出目录里的那份。
 */
function historyWorkerPath(): string {
  const packaged = process.resourcesPath
    ? join(process.resourcesPath, 'worker', 'dsh-history-worker.js')
    : ''
  if (packaged && existsSync(packaged)) return packaged
  return join(__dirname, 'dsh-history-worker.js')
}

function ensureHistoryWorker(): Worker | null {
  if (historyWorker) return historyWorker
  try {
    const workerPath = historyWorkerPath()
    // 构建产物缺失（例如未按 electron.vite.config 的多入口构建）：退回主线程
    if (!existsSync(workerPath)) return null
    const worker = new Worker(workerPath, {
      // 会话异常大时让 worker 自己 OOM，不要拖垮主进程
      resourceLimits: { maxOldGenerationSizeMb: 1024 }
    })
    worker.on('message', (msg: WorkerReply) => {
      const pending = historyWorkerPending.get(msg.id)
      if (!pending) return
      historyWorkerPending.delete(msg.id)
      clearTimeout(pending.timer)
      if (msg.ok && Array.isArray(msg.records)) pending.resolve(msg.records)
      else pending.reject(new Error(msg.error || 'dsh history worker failed'))
    })
    worker.on('error', (err) => {
      if (historyWorker === worker) failHistoryWorker(err)
    })
    worker.on('exit', (code) => {
      if (historyWorker === worker) {
        failHistoryWorker(new Error(`dsh history worker exited (${code})`))
      }
    })
    // 待处理的 worker 不该阻止应用退出
    worker.unref?.()
    historyWorker = worker
    return worker
  } catch {
    return null
  }
}

function readDshRecordsOffThread(file: string): Promise<Record<string, unknown>[]> {
  const worker = ensureHistoryWorker()
  // worker 不可用：退回主线程，至少功能还在
  if (!worker) return readDshRecords(file)

  return new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const id = ++historyWorkerSeq
    const timer = setTimeout(() => {
      failHistoryWorker(new Error('dsh history worker timeout'))
    }, WORKER_TIMEOUT_MS)
    historyWorkerPending.set(id, { resolve, reject, timer })
    try {
      worker.postMessage({ id, file })
    } catch (e) {
      historyWorkerPending.delete(id)
      clearTimeout(timer)
      failHistoryWorker(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

/**
 * 把一份 dsh 会话回放成 AgentEvent。
 *
 * 只认**终态记录**（assistant/message、tool/call、tool/result），忽略
 * *-chunks：后者是逐 token 的流式增量，回放它们既慢又会把界面撑爆，
 * 而 assistant/message 已经带着这一轮的完整内容。
 */
export async function readDshTranscript(
  file: string,
  cwd: string,
  sessionId = ''
): Promise<AgentEvent[]> {
  let records: Record<string, unknown>[]
  try {
    records = await readDshRecordsOffThread(file)
  } catch {
    // 解压失败 / 文件过大 / worker 挂了：当作空会话，不拖垮列表
    return []
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
