import { createHash, randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { statSync } from 'node:fs'
import { WebSocket } from 'ws'
import type { Channel } from '../../../../shared/settings'
import { pathKey } from '../../../path-key'
import { logMain } from '../../../crash-log'
import { dshChannelEnv, killDshTree, spawnDsh } from '../runner'
import { arr, obj, str, stripAnsi, type Obj } from '../shared'

/**
 * dsh Web 协议的主进程客户端。
 *
 * 这里直接实现 dsh 的 HTTP + WebSocket 线协议，而不是把 dsh 的 Cordis
 * 客户端包塞进 Electron：那些包要求 Node 24/Cordis 树，而 Electron 33
 * 内置的是 Node 20。线协议本身很小，且 dsh 的 Web GUI 就是它的第一个
 * 消费者，见 `dsh-client-connection` / `dsh-api-gateway`。
 *
 * 一个 host = 一个 DSH_HOME 下的一个 `dsh --profile web` 进程。多个会话
 * 共享同一个 host；会话只负责自己的 session/follow 流。
 */

export class DshWebError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: unknown = {}
  ) {
    super(message)
    this.name = 'DshWebError'
  }
}

/** 一个会话需要从 host 接住的回调。避免 host 反向 import session.ts。 */
export interface DshHostSession {
  readonly sessionId: string
  onHostConnected(): void
  onHostDisconnected(): void
  onHostExit(code: number | null, stderr: string): void
  onProjections(values: Record<string, unknown>): void
  onProjection(key: string, value: unknown): void
  onApproval(eventId: string, request: Obj): void
  onQuestion(eventId: string, request: Obj): void
  onEventCancelled(eventId: string): void
}

export interface DshFollowSnapshot {
  header: Obj
  cursor: number
  records: unknown[]
  hasMore: boolean
  projections: { asOfSeq: number; values: Record<string, unknown> }
  assistantStream?: unknown
}

export interface DshStreamHandlers {
  onItem: (value: unknown) => void
  onEnd?: () => void
  onError?: (error: DshWebError) => void
}

export interface DshStream {
  close(): void
}

export interface DshHostOptions {
  home: string
  channel: Channel | null
  /** host 进程的默认 cwd；会话自己带 cwd */
  cwd: string
  /** 复用 acp profile 里的 MCP 行；没有就不传 */
  patchFile?: string
}

const START_TIMEOUT_MS = 90_000
const CONNECT_TIMEOUT_MS = 20_000
const CALL_TIMEOUT_MS = 30_000
const IDLE_SHUTDOWN_MS = 10 * 60_000
const MAX_RECONNECT = 10

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * host 复用指纹：渠道环境（含 key）或 MCP patch 变了，就不能复用旧进程。
 * 只保留哈希，不把明文密钥留在缓存里。
 */
function hostFingerprint(o: DshHostOptions): string {
  let patch = ''
  if (o.patchFile) {
    try {
      const s = statSync(o.patchFile)
      patch = `${s.size}:${s.mtimeMs}`
    } catch {
      patch = 'missing'
    }
  }
  return createHash('sha256')
    .update(JSON.stringify({ env: dshChannelEnv(o.channel), patch }))
    .digest('hex')
}

function errorOf(value: unknown): DshWebError {
  const e = obj(value)
  return new DshWebError(
    str(e.code) || 'gateway/internal',
    str(e.message) || 'DeepSeek Harness 请求失败',
    e.details ?? {}
  )
}

export class DshWebHost {
  private child: ChildProcess | null = null
  private origin = ''
  private token = ''
  private cookie = ''
  private socket: WebSocket | null = null
  private socketGeneration = 0
  private streams = new Map<string, DshStreamHandlers>()
  private sessions = new Map<string, DshHostSession>()
  private projections = new Map<string, Record<string, unknown>>()
  private eventsClientId = ''
  private eventsReady: Promise<void> | null = null
  private controlReady: Promise<void> | null = null
  private resolveEventsReady: (() => void) | null = null
  private resolveControlReady: (() => void) | null = null
  private rejectEventsReady: ((e: Error) => void) | null = null
  private rejectControlReady: ((e: Error) => void) | null = null
  private online: Promise<void> | null = null
  private resolveOnline: (() => void) | null = null
  private rejectOnline: ((e: Error) => void) | null = null
  private reconnecting = false
  private closing = false
  private processExited = false
  private stderr = ''
  private refs = 0
  private idleTimer: NodeJS.Timeout | null = null
  private catalogCache: { at: number; value: Obj } | null = null
  private startedAt = Date.now()

  readonly ready: Promise<void>
  readonly fingerprint: string

  constructor(
    private o: DshHostOptions,
    fingerprint = hostFingerprint(o)
  ) {
    this.fingerprint = fingerprint
    this.ready = this.start()
  }

  get key(): string {
    return pathKey(this.o.home)
  }

  get originUrl(): string {
    return this.origin
  }

  get isConnected(): boolean {
    return !!this.socket && this.socket.readyState === WebSocket.OPEN && !this.closing
  }

  /* ── 启动 ──────────────────────────────────────────────── */

  private async start(): Promise<void> {
    try {
      await this.spawn()
      await this.authenticate()
      await this.connectSocket()
      this.openGlobalStreams()
      this.markOnline()
      await this.waitGlobalStreams()
    } catch (e) {
      this.closing = true
      this.killProcess()
      throw e
    }
  }

  private async spawn(): Promise<void> {
    /*
     * 顺序很重要：dsh 的启动器只解析自己的参数，遇到第一个不认识的 token
     * 就把后面全部原样交给 web app。`--no-open` 属于 web app，所以 `--patch`
     * 必须排在它前面，否则会被 web app 当成自己的参数报
     * `error: unknown option '--patch'`。
     */
    const args = [
      '--profile',
      'web',
      ...(this.o.patchFile ? ['--patch', this.o.patchFile] : []),
      '--no-open',
      '--port',
      '0',
      '--host',
      '127.0.0.1'
    ]
    const env = { ...dshChannelEnv(this.o.channel), DSH_HOME: this.o.home }
    const child = spawnDsh(args, {
      cwd: this.o.cwd,
      env,
      dshHome: this.o.home
    })
    this.child = child
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (d: string) => {
      this.stderr += stripAnsi(d)
      if (this.stderr.length > 16_000) this.stderr = this.stderr.slice(-16_000)
    })
    child.on('exit', (code) => this.onProcessExit(code))
    child.on('error', (err) => this.onProcessExit(null, err.message))

    const url = await new Promise<URL>((resolve, reject) => {
      let buf = ''
      const timer = setTimeout(() => {
        cleanup()
        reject(
          new DshWebError(
            'dsh/web-start-timeout',
            `DeepSeek Harness Web 服务在 ${START_TIMEOUT_MS / 1000} 秒内没有就绪。`
          )
        )
      }, START_TIMEOUT_MS)

      const cleanup = (): void => {
        clearTimeout(timer)
        child.stdout?.off('data', onData)
        child.off('exit', onExit)
      }
      const onExit = (): void => {
        cleanup()
        reject(
          new DshWebError(
            'dsh/web-exit',
            this.stderr.trim() || 'DeepSeek Harness Web 服务启动后立即退出。'
          )
        )
      }
      const onData = (chunk: string): void => {
        buf += chunk
        // 启动行：dsh web: http://127.0.0.1:PORT/?token=...
        const m = buf.match(/(?:^|\r?\n)dsh web: (https?:\/\/[^\s]+)(?:\r?\n|$)/)
        if (!m) return
        cleanup()
        try {
          const u = new URL(m[1].trim())
          resolve(u)
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      }
      child.stdout?.on('data', onData)
      child.once('exit', onExit)
    })

    this.origin = url.origin
    this.token = url.searchParams.get('token') ?? ''
    if (!this.token) {
      throw new DshWebError(
        'dsh/web-token',
        'DeepSeek Harness Web 服务的启动 URL 里没有 token。'
      )
    }
    // 绝不要把 token 写进日志
    logMain('dsh.web.spawn', {
      home: this.o.home,
      origin: this.origin,
      cwd: this.o.cwd
    })
  }

  private async authenticate(): Promise<void> {
    const url = new URL('/connect', this.origin)
    url.searchParams.set('token', this.token)
    url.searchParams.set('interactions', 'answer')
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS)
    })
    if (res.status !== 302) {
      const body = await res.text().catch(() => '')
      throw new DshWebError(
        'dsh/web-auth',
        `DeepSeek Harness Web 认证失败（HTTP ${res.status}）${body ? `：${body.slice(0, 200)}` : ''}`
      )
    }
    const setCookie = res.headers.get('set-cookie') ?? ''
    const pair = setCookie.split(';', 1)[0]?.trim() ?? ''
    if (!pair.includes('=')) {
      throw new DshWebError('dsh/web-auth', 'DeepSeek Harness Web 没有返回认证 Cookie。')
    }
    this.cookie = pair
  }

  private async connectSocket(): Promise<void> {
    const generation = ++this.socketGeneration
    const wsUrl = `${this.origin.replace(/^http/i, 'ws')}/api/remote.mux`
    const socket = new WebSocket(wsUrl, {
      headers: { Cookie: this.cookie },
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      perMessageDeflate: false
    })
    this.socket = socket

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (err?: Error): void => {
        if (settled) return
        settled = true
        if (err) reject(err)
        else resolve()
      }
      socket.once('open', () => finish())
      socket.once('error', (err) =>
        finish(
          new DshWebError(
            'dsh/web-socket',
            `DeepSeek Harness Web WebSocket 连接失败：${err.message}`
          )
        )
      )
      socket.once('unexpected-response', (_req, res) => {
        finish(
          new DshWebError(
            'dsh/web-socket',
            `DeepSeek Harness Web WebSocket 被拒绝（HTTP ${res.statusCode}）`
          )
        )
      })
    })

    socket.on('message', (data) => {
      if (generation !== this.socketGeneration) return
      this.onSocketMessage(data.toString())
    })
    socket.on('close', () => {
      if (generation !== this.socketGeneration) return
      this.onSocketClosed()
    })
    socket.on('error', () => {
      // close 会跟着来；这里只避免未处理的 error 事件
    })
  }

  private openGlobalStreams(): void {
    this.eventsReady = new Promise<void>((resolve, reject) => {
      this.resolveEventsReady = resolve
      this.rejectEventsReady = reject
    })
    this.controlReady = new Promise<void>((resolve, reject) => {
      this.resolveControlReady = resolve
      this.rejectControlReady = reject
    })

    this.openStream('$events', {}, {
      onItem: (value) => this.onEventFrame(value),
      onError: (e) => this.onGlobalStreamLost(e),
      onEnd: () => this.onGlobalStreamLost(
        new DshWebError('dsh/web-events-end', '$events 流意外结束。')
      )
    })
    this.openStream('session/control', {}, {
      onItem: (value) => this.onControlFrame(value),
      onError: (e) => this.onGlobalStreamLost(e),
      onEnd: () => this.onGlobalStreamLost(
        new DshWebError('dsh/web-control-end', 'session/control 流意外结束。')
      )
    })
  }

  private waitGlobalStreams(): Promise<void> {
    return Promise.all([
      this.eventsReady ?? Promise.resolve(),
      this.controlReady ?? Promise.resolve()
    ]).then(() => undefined)
  }

  /** 全局流没了：启动阶段直接失败；已就绪则关 socket 走重连。 */
  private onGlobalStreamLost(e: DshWebError): void {
    if (this.closing || this.processExited) return
    if (this.rejectEventsReady || this.rejectControlReady) {
      this.rejectEventsReady?.(e)
      this.rejectControlReady?.(e)
      return
    }
    try {
      this.socket?.close()
    } catch {
      // close 事件会走 onSocketClosed
    }
  }

  private waitOnline(): Promise<void> {
    if (this.closing || this.processExited) {
      return Promise.reject(
        new DshWebError('dsh/web-closed', 'DeepSeek Harness Web 服务已关闭。')
      )
    }
    if (!this.online) {
      this.online = new Promise<void>((resolve, reject) => {
        this.resolveOnline = resolve
        this.rejectOnline = reject
      })
    }
    return this.online
  }

  private markOnline(): void {
    const resolve = this.resolveOnline
    this.resolveOnline = null
    this.rejectOnline = null
    // 没有等待者时也要留下一个已完成的 promise，后续 call 才不会干等
    this.online = Promise.resolve()
    resolve?.()
  }

  private markOffline(err: Error): void {
    this.rejectOnline?.(err)
    this.resolveOnline = null
    this.rejectOnline = null
    this.online = null
  }

  /* ── 断线重连 ──────────────────────────────────────────── */

  private onSocketClosed(): void {
    if (this.closing || this.processExited) return
    this.socket = null
    this.streams.clear()
    const offline = new DshWebError(
      'dsh/web-offline',
      '与 DeepSeek Harness Web 服务的连接已断开。'
    )
    this.rejectEventsReady?.(offline)
    this.rejectControlReady?.(offline)
    this.rejectEventsReady = null
    this.rejectControlReady = null
    this.markOffline(offline)
    for (const session of this.sessions.values()) session.onHostDisconnected()
    void this.reconnect()
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.closing || this.processExited) return
    this.reconnecting = true
    try {
      for (let attempt = 0; attempt < MAX_RECONNECT && !this.closing; attempt++) {
        const wait = Math.min(10_000, 500 * 2 ** attempt)
        await delay(wait)
        if (this.closing || this.processExited) return
        try {
          await this.authenticate()
          await this.connectSocket()
          this.openGlobalStreams()
          await this.waitGlobalStreams()
          this.markOnline()
          for (const session of this.sessions.values()) session.onHostConnected()
          logMain('dsh.web.reconnected', { home: this.o.home, attempt: attempt + 1 })
          return
        } catch {
          // 继续退避
        }
      }
      if (!this.closing) {
        const stderr = '与 DeepSeek Harness Web 服务重连失败。'
        for (const session of this.sessions.values()) session.onHostExit(null, stderr)
        this.sessions.clear()
        this.shutdown()
      }
    } finally {
      this.reconnecting = false
    }
  }

  /* ── 进程退出 ──────────────────────────────────────────── */

  private onProcessExit(code: number | null, detail?: string): void {
    if (this.processExited) return
    this.processExited = true
    this.closing = true
    const stderr = stripAnsi(`${this.stderr}${detail ?? ''}`)
    logMain('dsh.web.exit', { home: this.o.home, code, stderr: stderr.slice(-2000) })
    this.streams.clear()
    this.socket = null
    this.markOffline(
      new DshWebError(
        'dsh/web-exit',
        `DeepSeek Harness Web 服务已退出（${code ?? 'signal'}）${stderr ? `：${stderr.slice(-500)}` : ''}`
      )
    )
    for (const session of this.sessions.values()) session.onHostExit(code, stderr)
    this.sessions.clear()
    if (hosts.get(this.key) === this) hosts.delete(this.key)
  }

  /* ── 流 ────────────────────────────────────────────────── */

  openStream(
    endpoint: string,
    args: Record<string, unknown>,
    handlers: DshStreamHandlers
  ): DshStream {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new DshWebError('dsh/web-offline', 'DeepSeek Harness Web 连接尚未就绪。')
    }
    const streamId = randomUUID()
    this.streams.set(streamId, handlers)
    socket.send(
      JSON.stringify({
        type: 'open',
        streamId,
        endpoint,
        payload: { args }
      })
    )
    return {
      close: () => {
        if (!this.streams.delete(streamId)) return
        try {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'cancel', streamId }))
          }
        } catch {
          // socket 已经没了
        }
      }
    }
  }

  private onSocketMessage(text: string): void {
    let msg: Obj
    try {
      msg = obj(JSON.parse(text))
    } catch {
      return
    }
    const streamId = str(msg.streamId)
    const handler = this.streams.get(streamId)
    if (!handler) return

    const type = str(msg.type)
    try {
      if (type === 'item') {
        handler.onItem(msg.value)
        return
      }
      if (type === 'error') {
        this.streams.delete(streamId)
        handler.onError?.(errorOf(msg.error))
        return
      }
      if (type === 'end') {
        this.streams.delete(streamId)
        handler.onEnd?.()
      }
    } catch (e) {
      // 一条坏帧不能把主进程带走；记录后让流自然结束
      logMain('dsh.web.stream-error', {
        endpoint: streamId,
        error: e instanceof Error ? e.message : String(e)
      })
    }
  }

  /* ── $events ───────────────────────────────────────────── */

  private onEventFrame(value: unknown): void {
    const frame = obj(value)
    const type = str(frame.type)

    if (type === 'ready') {
      this.eventsClientId = str(frame.clientId)
      this.resolveEventsReady?.()
      this.resolveEventsReady = null
      this.rejectEventsReady = null
      return
    }

    if (type === 'emit') {
      this.onForwardedEvent(str(frame.event), arr(frame.args))
      return
    }

    if (type === 'cancel') {
      const eventId = str(frame.eventId)
      for (const session of this.sessions.values()) session.onEventCancelled(eventId)
      return
    }

    if (type !== 'waterfall') return
    const eventId = str(frame.eventId)
    const agentId = str(frame.agentId)
    const event = str(frame.event)
    const request = obj(frame.request)
    const session =
      this.sessions.get(agentId) ??
      [...this.sessions.values()].find((s) => s.sessionId === agentId)

    if (!session) {
      // 没有对应会话：委托给 Host 的下一个监听器，避免把别的东西卡住
      void this.answerWaterfall(eventId, { kind: 'next' }).catch(() => undefined)
      return
    }
    if (event === 'approval/request') session.onApproval(eventId, request)
    else if (event === 'user-questions/request') session.onQuestion(eventId, request)
    else void this.answerWaterfall(eventId, { kind: 'next' }).catch(() => undefined)
  }

  private onForwardedEvent(event: string, args: unknown[]): void {
    if (event === 'llm/adapters-updated') {
      this.catalogCache = null
      return
    }
    if (event === 'api-session/status') {
      const sessionId = str(args[0])
      // 状态本身已由 session/follow 的 turn/start、turn/end 覆盖；
      // 这里只在会话未登记时忽略，避免误触发。
      const session = this.sessions.get(sessionId)
      if (session) session.onProjection('status', args[1])
      return
    }
    if (event === 'api-session/error') {
      const sessionId = str(args[0])
      const message = str(args[1])
      const session = this.sessions.get(sessionId)
      if (session) session.onProjection('hostError', message)
      return
    }
    if (event === 'commands/change') {
      for (const session of this.sessions.values()) session.onProjection('commandsChanged', true)
    }
  }

  /* ── session/control 投影 ──────────────────────────────── */

  private onControlFrame(value: unknown): void {
    const frame = obj(value)
    if (str(frame.type) === 'baseline') {
      const valueObj = obj(obj(frame.value).projections)
      this.projections.clear()
      for (const [sessionId, block] of Object.entries(valueObj)) {
        const v = obj(obj(block).values)
        this.projections.set(sessionId, v)
      }
      this.resolveControlReady?.()
      this.resolveControlReady = null
      this.rejectControlReady = null
      for (const session of this.sessions.values()) {
        const values = this.projections.get(session.sessionId)
        if (values) session.onProjections(values)
      }
      return
    }
    if (str(frame.type) !== 'projection') return
    const sessionId = str(frame.sessionId)
    const key = str(frame.key)
    if (!sessionId || !key) return
    const current = this.projections.get(sessionId) ?? {}
    current[key] = frame.value
    this.projections.set(sessionId, current)
    this.sessions.get(sessionId)?.onProjection(key, frame.value)
  }

  projectionOf(sessionId: string): Record<string, unknown> {
    return this.projections.get(sessionId) ?? {}
  }

  /* ── HTTP unary ────────────────────────────────────────── */

  /** 等待当前连接恢复；host 正在重连时，send 应该等它而不是直接失败。 */
  whenOnline(): Promise<void> {
    return this.waitOnline()
  }

  async call<T = unknown>(
    method: string,
    args: Record<string, unknown> = {},
    timeoutMs = CALL_TIMEOUT_MS
  ): Promise<T> {
    await this.waitOnline()
    const rpcId = `ccoder-${randomUUID()}`
    const endpoint = method
    const url = `${this.origin}/api/${endpoint}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: this.cookie
        },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method: endpoint,
          payload: { args }
        }),
        signal: controller.signal
      })
      if (res.status === 401) {
        this.markOffline(
          new DshWebError('dsh/web-auth-expired', 'DeepSeek Harness Web 认证已失效。')
        )
        void this.reconnect()
        throw new DshWebError('dsh/web-auth-expired', 'DeepSeek Harness Web 认证已失效。')
      }
      if (!res.ok) {
        throw new DshWebError(
          'dsh/web-http',
          `DeepSeek Harness Web 请求失败（HTTP ${res.status}）`
        )
      }
      const body = obj(await res.json())
      if (body.rpcId !== rpcId) {
        throw new DshWebError('dsh/web-protocol', 'DeepSeek Harness Web 响应 rpcId 不匹配。')
      }
      const result = obj(body.result)
      if (result.ok === true) return result.value as T
      throw errorOf(result.error)
    } finally {
      clearTimeout(timer)
    }
  }

  /** 回答 forwarded waterfall（审批 / 提问）。 */
  async answerWaterfall(eventId: string, outcome: Obj): Promise<void> {
    await this.call(
      '$events/result',
      {
        clientId: this.eventsClientId,
        eventId,
        outcome
      },
      10_000
    )
  }

  async modelCatalog(force = false): Promise<Obj> {
    const now = Date.now()
    if (!force && this.catalogCache && now - this.catalogCache.at < 30_000) {
      return this.catalogCache.value
    }
    const value = await this.call<Obj>('session/modelCatalog', {})
    this.catalogCache = { at: now, value }
    return value
  }

  /* ── 会话注册 / 生命周期 ───────────────────────────────── */

  registerSession(session: DshHostSession): void {
    this.sessions.set(session.sessionId, session)
    const values = this.projections.get(session.sessionId)
    if (values) session.onProjections(values)
  }

  unregisterSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  ref(): void {
    this.refs++
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  unref(): void {
    this.refs = Math.max(0, this.refs - 1)
    if (this.refs > 0 || this.closing) return
    this.idleTimer = setTimeout(() => {
      if (this.refs === 0) this.shutdown()
    }, IDLE_SHUTDOWN_MS)
    this.idleTimer.unref?.()
  }

  shutdown(): void {
    if (this.closing) return
    this.closing = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    for (const [id] of this.streams) this.streams.delete(id)
    const socket = this.socket
    this.socket = null
    try {
      socket?.close()
    } catch {
      // 已经关了
    }
    this.killProcess()
    this.markOffline(new DshWebError('dsh/web-closed', 'DeepSeek Harness Web 服务已关闭。'))
    // 配置热替换 / 空闲回收时，残留会话要收到一次退出，SessionManager 才会
    // 在下一轮重新拉起（正常 app 退出前 sessions.stopAll 已经清空 map）。
    for (const session of this.sessions.values()) {
      session.onHostExit(null, 'DeepSeek Harness Web 服务已关闭。')
    }
    this.sessions.clear()
    if (hosts.get(this.key) === this) hosts.delete(this.key)
    logMain('dsh.web.shutdown', { home: this.o.home, uptimeMs: Date.now() - this.startedAt })
  }

  private killProcess(): void {
    const child = this.child
    this.child = null
    if (!child) return
    // web profile 不监听 stdin EOF；SIGTERM 会走有界关闭，超时再杀树
    try {
      child.kill('SIGTERM')
    } catch {
      // 已经退出
    }
    const timer = setTimeout(() => {
      if (child.exitCode === null) killDshTree(child)
    }, 5_000)
    timer.unref?.()
  }

  get isClosed(): boolean {
    return this.closing
  }
}

/* ── host 池 ─────────────────────────────────────────────── */

const hosts = new Map<string, DshWebHost>()

export function getDshWebHost(o: DshHostOptions): DshWebHost {
  const key = pathKey(o.home)
  const fingerprint = hostFingerprint(o)
  const existing = hosts.get(key)
  if (existing && !existing.isClosed && existing.fingerprint === fingerprint) {
    return existing
  }
  // 渠道 key / MCP patch 变了：旧进程读不到新配置，换一个。
  // 先登记新 host，再关旧 host —— 旧会话的 onExit 可能同步触发 flushQueue，
  // 那时它必须拿到已经换好的新实例，而不是再拉起第三个进程。
  const host = new DshWebHost(o, fingerprint)
  hosts.set(key, host)
  if (existing && !existing.isClosed) existing.shutdown()
  // 启动失败就把池里的坏实例拿掉，下一次 send 重新拉起
  void host.ready.catch(() => {
    if (hosts.get(key) === host) hosts.delete(key)
  })
  return host
}

export function disposeAllDshWebHosts(): void {
  for (const host of [...hosts.values()]) host.shutdown()
  hosts.clear()
}
