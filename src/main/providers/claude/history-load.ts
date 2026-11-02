import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { AgentEvent } from '../../../shared/events'
import { mainLocale } from '../../i18n'
import { replayRecords } from './history'
import { readClaudeRecords } from './history-read'

/**
 * Claude 历史回放的 off-thread 入口。
 *
 * 大会话的读盘 + `JSON.parse` + 回放是同步的，放在主线程会卡住所有窗口
 * 的 IPC 和流式事件。小文件仍走主线程 —— 起 worker 的成本比解析还高。
 */

/** 低于这个大小直接在主线程解析：几 MB 以下的文件通常几十毫秒内完成 */
const WORKER_MIN_BYTES = 2 * 1024 * 1024
const WORKER_TIMEOUT_MS = 30_000

interface WorkerReply {
  id: number
  ok: boolean
  events?: AgentEvent[]
  error?: string
}

interface WorkerPending {
  resolve: (events: AgentEvent[]) => void
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
    ? join(process.resourcesPath, 'worker', 'claude-history-worker.js')
    : ''
  if (packaged && existsSync(packaged)) return packaged
  return join(__dirname, 'claude-history-worker.js')
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
      if (msg.ok && Array.isArray(msg.events)) pending.resolve(msg.events)
      else pending.reject(new Error(msg.error || 'claude history worker failed'))
    })
    worker.on('error', (err) => {
      if (historyWorker === worker) failHistoryWorker(err)
    })
    worker.on('exit', (code) => {
      if (historyWorker === worker) {
        failHistoryWorker(new Error(`claude history worker exited (${code})`))
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

/** 返回 null = worker 不可用；抛错 = worker 中途失败 */
function readOffThread(
  file: string,
  size: number,
  textOnly: boolean
): Promise<AgentEvent[]> | null {
  const worker = ensureHistoryWorker()
  if (!worker) return null

  return new Promise<AgentEvent[]>((resolve, reject) => {
    const id = ++historyWorkerSeq
    const timer = setTimeout(() => {
      failHistoryWorker(new Error('claude history worker timeout'))
    }, WORKER_TIMEOUT_MS)
    historyWorkerPending.set(id, { resolve, reject, timer })
    try {
      worker.postMessage({ id, file, size, textOnly, locale: mainLocale() })
    } catch (e) {
      historyWorkerPending.delete(id)
      clearTimeout(timer)
      failHistoryWorker(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

/**
 * 读一份 Claude 会话并回放成事件流。
 *
 * 大会话优先交给 worker；worker 不可用或失败时退回主线程，保证功能仍然
 * 可用，只是这一次会卡一下。
 */
export async function readClaudeTranscript(
  file: string,
  size: number,
  opts: { textOnly?: boolean } = {}
): Promise<AgentEvent[]> {
  if (size >= WORKER_MIN_BYTES) {
    try {
      const events = readOffThread(file, size, opts.textOnly === true)
      if (events) return await events
    } catch {
      // worker 失败：退回主线程
    }
  }
  return replayRecords(await readClaudeRecords(file, size), opts)
}
