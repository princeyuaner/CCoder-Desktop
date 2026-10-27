import type { ChildProcessWithoutNullStreams } from 'node:child_process'

/**
 * LSP 的 JSON-RPC 2.0 传输层。
 *
 * 协议本身很薄：每个消息前是 `Content-Length: N\r\n\r\n`，正文是 UTF-8
 * JSON。麻烦的地方都在边界上 —— 一次 stdout data 可能是半条消息、两条
 * 消息，或者只有 header；服务器退出时要让所有在飞的请求 reject，不能
 * 留一排永远不 resolve 的 Promise。
 *
 * 这里只管协议，不关心窗口 / 工作区 / 文档同步，那些在 host.ts。
 */

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  method: string
}

export interface JsonRpcOptions {
  /** stderr / 协议错误；主进程用它写 main.log */
  onLog?: (message: string, detail?: unknown) => void
}

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024
const MAX_HEADER_BYTES = 16 * 1024
const MAX_STDERR_CHARS = 8 * 1024

type JsonValue = Record<string, unknown>

export class JsonRpcConnection {
  private readonly proc: ChildProcessWithoutNullStreams
  private readonly options: JsonRpcOptions
  private buffer: Buffer = Buffer.alloc(0)
  private nextId = 1
  private pending = new Map<number, Pending>()
  private closed = false
  private closeReason = 'connection closed'
  private stderrChars = 0
  /** server → client 通知 */
  onNotification: (method: string, params: unknown) => void = () => {}
  /** server → client 请求；返回值会作为 result 发回去 */
  onRequest: (method: string, params: unknown) => unknown | Promise<unknown> = () => null
  onClose: (reason: string) => void = () => {}

  constructor(proc: ChildProcessWithoutNullStreams, options: JsonRpcOptions = {}) {
    this.proc = proc
    this.options = options
    proc.stdout.on('data', (chunk: Buffer) => this.feed(chunk))
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (text: string) => {
      if (this.stderrChars >= MAX_STDERR_CHARS) return
      const slice = text.slice(0, MAX_STDERR_CHARS - this.stderrChars)
      this.stderrChars += slice.length
      this.log('stderr', slice.trimEnd())
    })
    proc.on('error', (err) => this.fail(`server error: ${err.message}`))
    proc.on('close', (code, signal) => {
      this.fail(`server exited (${code ?? signal ?? 'unknown'})`)
    })
    // stdin 被服务器提前关掉时，下一次 write 会抛；提前接住，避免 EPIPE 冒到主进程
    proc.stdin.on('error', (err) => this.log('stdin', err.message))
  }

  get isClosed(): boolean {
    return this.closed
  }

  request(method: string, params: unknown, timeoutMs = 20_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(this.closeReason))
    const id = this.nextId++
    const safeTimeout = Math.max(1_000, Math.min(60_000, Math.round(timeoutMs)))
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`LSP request timed out: ${method}`))
      }, safeTimeout)
      this.pending.set(id, { resolve, reject, timer, method })
      this.send({ jsonrpc: '2.0', id, method, params: params ?? null })
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return
    this.send({ jsonrpc: '2.0', method, params: params ?? null })
  }

  respond(id: number | string, result: unknown): void {
    if (this.closed) return
    this.send({ jsonrpc: '2.0', id, result: result ?? null })
  }

  respondError(id: number | string, code: number, message: string): void {
    if (this.closed) return
    this.send({ jsonrpc: '2.0', id, error: { code, message } })
  }

  /** 只清理本地状态；进程由 host 负责结束。 */
  dispose(reason = 'disposed'): void {
    this.fail(reason)
  }

  private send(message: JsonValue): void {
    if (this.closed) return
    try {
      const body = JSON.stringify(message)
      this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
    } catch (e) {
      this.fail(`write failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private feed(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    while (!this.closed) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) {
        if (this.buffer.length > MAX_HEADER_BYTES) this.fail('LSP header too large')
        return
      }
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header)
      if (!match) {
        // 没有长度头的消息无法定位下一条，丢掉这段 header 继续找
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      const length = Number(match[1])
      if (!Number.isFinite(length) || length <= 0 || length > MAX_MESSAGE_BYTES) {
        this.fail(`invalid LSP message length: ${match[1]}`)
        return
      }
      const start = headerEnd + 4
      if (this.buffer.length < start + length) return
      const body = this.buffer.subarray(start, start + length).toString('utf8')
      this.buffer = this.buffer.subarray(start + length)
      let message: Record<string, unknown>
      try {
        message = JSON.parse(body) as Record<string, unknown>
      } catch (e) {
        this.log('parse', e instanceof Error ? e.message : String(e))
        continue
      }
      this.dispatch(message)
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    const id = message.id
    const hasId = typeof id === 'number' || typeof id === 'string'
    const method = typeof message.method === 'string' ? message.method : null

    if (hasId && (('result' in message) || ('error' in message))) {
      const pending = this.pending.get(id as number)
      if (!pending) return
      this.pending.delete(id as number)
      clearTimeout(pending.timer)
      if ('error' in message) {
        const err = message.error as { message?: string; code?: number } | undefined
        pending.reject(new Error(err?.message || `LSP error in ${pending.method}`))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (hasId && method) {
      // server → client 请求
      Promise.resolve()
        .then(() => this.onRequest(method, message.params))
        .then((result) => {
          if (typeof id === 'number' || typeof id === 'string') this.respond(id, result)
        })
        .catch((e: unknown) => {
          if (typeof id === 'number' || typeof id === 'string') {
            this.respondError(id, -32603, e instanceof Error ? e.message : String(e))
          }
        })
      return
    }

    if (method) this.onNotification(method, message.params)
  }

  private fail(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.closeReason = reason
    this.buffer = Buffer.alloc(0)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.pending.clear()
    this.onClose(reason)
  }

  private log(kind: string, detail?: unknown): void {
    try {
      this.options.onLog?.(kind, detail)
    } catch {
      // 日志失败不能反过来影响语言服务器
    }
  }
}
