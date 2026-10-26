import { spawn, type ChildProcess } from 'node:child_process'
import { t } from './i18n'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CodexAccountInfo, CodexPermissionProfile, CodexStatus } from '../shared/codex'
import type { Channel, ChannelTestResult } from '../shared/settings'
import type { RuntimeMcpServer } from '../shared/mcp'
import { NdjsonDecoder, parseLine } from './ndjson'

const IS_WIN = process.platform === 'win32'

/** 渠道凭据注入到这个环境变量里；不写进命令行，也不落进 config.toml */
export const CODEX_KEY_ENV = 'CCCODER_CODEX_API_KEY'

/**
 * Codex 的日志带 ANSI 颜色（`\x1b[2m` 之类）。这些字节直接进设置页
 * 会原样显示成 `[2m...[31mERROR`，所以对外给文本前先剥掉。
 */
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

/**
 * 解析 `codex` 可执行文件。
 *
 * 独立安装器、npm 全局包、PATH 三种来源都要认。和 claude-runner 一样，
 * Windows 上拿到 `.cmd` 之后必须经 shell 才能执行。
 */
let cachedBin: string | null = null

export function resolveCodexBin(): string {
  if (cachedBin) return cachedBin

  const override = process.env.CODEX_BIN?.trim()
  if (override) return (cachedBin = override)

  const names = IS_WIN ? ['codex.cmd', 'codex.exe', 'codex'] : ['codex']
  const dirs: string[] = []

  if (IS_WIN) {
    if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'npm'))
    if (process.env.LOCALAPPDATA) {
      dirs.push(join(process.env.LOCALAPPDATA, 'Programs', 'codex'))
      dirs.push(join(process.env.LOCALAPPDATA, 'codex', 'bin'))
    }
    const home = process.env.USERPROFILE || homedir()
    dirs.push(join(home, '.codex', 'bin'))
    if (process.env.ProgramFiles) dirs.push(join(process.env.ProgramFiles, 'codex'))
  } else {
    const home = homedir()
    dirs.push(join(home, '.local', 'bin'))
    dirs.push(join(home, '.codex', 'bin'))
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin')
  }
  dirs.push(...(process.env.PATH ?? '').split(IS_WIN ? ';' : ':').filter(Boolean))

  for (const d of dirs) {
    for (const n of names) {
      const p = join(d, n)
      try {
        if (existsSync(p)) return (cachedBin = p)
      } catch {
        // 单个目录不可读就跳过
      }
    }
  }
  // 没找到也返回一个具体路径：设置页要能告诉用户「去哪儿找过了」，
  // 裸命令名对排查没有帮助。
  return (cachedBin = dirs.length > 0 ? join(dirs[0], names[0]) : names[0])
}

/** 测试 / 换安装位置时把缓存清掉 */
export function resetCodexBinCache(): void {
  cachedBin = null
}

function quoteWin(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`
}

export function spawnCodex(
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}
): ChildProcess {
  const bin = resolveCodexBin()
  const env = { ...process.env, ...opts.env }
  return IS_WIN
    ? spawn([quoteWin(bin), ...args.map(quoteWin)].join(' '), {
        env,
        cwd: opts.cwd,
        shell: true,
        windowsHide: true
      })
    : spawn(bin, args, { env, cwd: opts.cwd, shell: false, windowsHide: true })
}

/**
 * Windows 上 shell:true 拿到的是 cmd.exe 的 pid；只 kill 它会把 codex.exe
 * 留成孤儿。整棵树一起收。
 */
export function killCodexTree(child: ChildProcess): void {
  if (!child.pid) {
    try {
      child.kill()
    } catch {
      // 已经没了
    }
    return
  }
  if (IS_WIN) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      return
    } catch {
      // 退回到普通 kill
    }
  }
  try {
    child.kill('SIGTERM')
  } catch {
    // 已经没了
  }
}

/**
 * 渠道 → Codex 的 `-c` 覆盖项。
 *
 * 关键点：**不写用户的 config.toml**。Codex 支持 `-c key=value` 临时覆盖，
 * 这样每个渠道可以有自己的 provider，退出进程就恢复原样。
 *
 * 值不加引号：Codex 会先按 TOML 解析，解析不了就当原始字符串。URL、模型名、
 * `chat` 这类值都不是合法 TOML，正好按字面量使用；同时规避了 Windows
 * shell 里嵌套引号的麻烦。
 */
export function codexConfigOverrides(ch: Channel): string[] {
  const base = ch.baseUrl.trim().replace(/\/+$/, '')
  if (!base) return []

  const out = [
    'model_provider=ccoder',
    'model_providers.ccoder.name=CCoder',
    `model_providers.ccoder.base_url=${base}`,
    // Codex 0.163 起只认 Responses API；旧版的 chat wire 已经被上游移除。
    'model_providers.ccoder.wire_api=responses',
    'model_providers.ccoder.requires_openai_auth=false'
  ]
  if (ch.authToken.trim()) {
    if (ch.authMode === 'key') {
      out.push(`model_providers.ccoder.env_http_headers.x-api-key=${CODEX_KEY_ENV}`)
    } else {
      out.push(`model_providers.ccoder.env_key=${CODEX_KEY_ENV}`)
    }
  }
  return out
}

function channelEnv(ch: Channel): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const kv of ch.extraEnv) {
    const k = kv.key.trim()
    if (k) env[k] = kv.value
  }
  if (ch.authToken.trim()) env[CODEX_KEY_ENV] = ch.authToken.trim()
  return env
}

/** TOML 基本字符串；JSON 的转义规则在这里是兼容的 */
function tomlString(s: string): string {
  return JSON.stringify(s)
}

/** 带引号的 TOML key，给 inline table 的 env / header 名用 */
function tomlKey(s: string): string {
  return JSON.stringify(s)
}

/**
 * `-c` 的 dotted path 里不能直接塞带引号的服务器名 —— Codex 会把引号
 * 当成名字的一部分（实测 mcp_servers."local" 会得到名叫 `"local"` 的
 * 服务器）。简单名字用裸 key；含空格 / 点号的名字做确定性清洗并加短哈希，
 * 保证同一个名字每次都映射到同一把 key，且不同名字不撞车。
 */
function codexServerKey(name: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(name)) return name
  const cleaned = name.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'mcp'
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return `${cleaned}-${hash.toString(36).slice(0, 4)}`
}

/**
 * CCoder 托管的 MCP 服务器 → Codex 的 `-c` 覆盖项。
 *
 * 与写 config.toml 的区别同渠道：`-c` 只影响这一次 app-server 进程，
 * 用户在终端里改的 MCP 配置不会被我们覆盖。
 */
function codexHeaderEnv(serverName: string, header: string, index: number): string {
  const clean = `${serverName}_${header}_${index}`.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()
  return `CODER_MCP_${clean}`.slice(0, 120)
}

/**
 * Codex 的 MCP 自定义请求头不走命令行：`-c` 会被进程列表看到。
 * Codex 支持 env_http_headers（header → 环境变量名），所以这里只把
 * 环境变量名写进参数，真正的值通过 app-server 的 env 注入。
 */
export function codexMcpEnv(servers: RuntimeMcpServer[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const s of servers) {
    if (s.transport !== 'http') continue
    Object.entries(s.headers).forEach(([name, value], i) => {
      if (name) env[codexHeaderEnv(s.name, name, i)] = value
    })
  }
  return env
}

export function codexMcpOverrides(servers: RuntimeMcpServer[]): string[] {
  const out: string[] = []
  for (const s of servers) {
    const name = s.name.trim()
    if (!name) continue
    const base = `mcp_servers.${codexServerKey(name)}`
    if (s.transport === 'stdio') {
      if (!s.command) continue
      out.push(`${base}.command=${tomlString(s.command)}`)
      if (s.args.length) out.push(`${base}.args=${JSON.stringify(s.args)}`)
      const env = Object.entries(s.env).filter(([k]) => k)
      if (env.length) {
        out.push(
          `${base}.env={${env
            .map(([k, v]) => `${tomlKey(k)}=${tomlString(v)}`)
            .join(',')}}`
        )
      }
    } else if (s.transport === 'http') {
      if (!s.url) continue
      out.push(`${base}.url=${tomlString(s.url)}`)
      const headers = Object.entries(s.headers).filter(([k]) => k)
      if (headers.length) {
        out.push(
          `${base}.env_http_headers={${headers
            .map(([k], i) => `${tomlKey(k)}=${tomlString(codexHeaderEnv(name, k, i))}`)
            .join(',')}}`
        )
      }
    }
  }
  return out
}

export function buildCodexAppServerArgs(
  ch: Channel | null,
  mcpServers: RuntimeMcpServer[] = []
): string[] {
  const args = ['app-server', '--listen', 'stdio://']
  if (ch) {
    for (const c of codexConfigOverrides(ch)) args.push('-c', c)
  }
  for (const c of codexMcpOverrides(mcpServers)) args.push('-c', c)
  return args
}

export interface CodexRpcOptions {
  channel?: Channel | null
  /** CCoder 托管的 MCP 服务器；用 -c 注入，不写 config.toml */
  mcpServers?: RuntimeMcpServer[]
  cwd?: string
  onNotification?: (method: string, params: Record<string, unknown>) => void
  onServerRequest?: (id: string | number, method: string, params: Record<string, unknown>) => void
  onExit?: (code: number | null, stderr: string) => void
}

/**
 * Codex app-server 的 JSON-RPC 客户端（NDJSON over stdio）。
 *
 * app-server 的消息有两种：
 *  - 我们发出去的请求（有 id）→ 等 result / error
 *  - 服务端主动发来的请求（审批、提问）→ 交给 onServerRequest
 * 通知没有 id，按 method 分发。
 */
export class CodexRpc {
  readonly child: ChildProcess
  private decoder = new NdjsonDecoder()
  private seq = 0
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >()
  private stderr = ''
  private closed = false
  private disposed = false
  private notificationHandler:
    | ((method: string, params: Record<string, unknown>) => void)
    | undefined
  private serverRequestHandler:
    | ((id: string | number, method: string, params: Record<string, unknown>) => void)
    | undefined

  constructor(private o: CodexRpcOptions = {}) {
    this.notificationHandler = o.onNotification
    this.serverRequestHandler = o.onServerRequest
    const args = buildCodexAppServerArgs(o.channel ?? null, o.mcpServers ?? [])
    const mcpEnv = codexMcpEnv(o.mcpServers ?? [])
    const extraEnv = { ...(o.channel ? channelEnv(o.channel) : {}), ...mcpEnv }
    this.child = spawnCodex(args, {
      cwd: o.cwd,
      env: Object.keys(extraEnv).length ? extraEnv : undefined
    })

    // 子进程退出后再写 stdin 会异步抛 EPIPE；没有监听就是未捕获的流错误，
    // 会直接结束主进程。收尾交给 close 事件。
    this.child.stdin?.on('error', () => undefined)

    this.child.stdout?.on('data', (d: Buffer) => this.onStdout(d.toString()))
    this.child.stderr?.on('data', (d: Buffer) => {
      this.stderr += d.toString()
      if (this.stderr.length > 16_000) this.stderr = this.stderr.slice(-16_000)
    })
    this.child.on('error', (err) => {
      this.failAll(err)
      if (!this.closed) {
        this.closed = true
        o.onExit?.(null, `${stripAnsi(this.stderr)}${err.message}`)
      }
    })
    this.child.on('close', (code) => {
      try {
        for (const line of this.decoder.flush()) this.onLine(line)
      } catch {
        // 收尾解析失败不改变退出事实
      }
      this.failAll(new Error(t('codexRunner.exited', { code: code ?? 'signal' })))
      if (!this.closed) {
        this.closed = true
        o.onExit?.(code, stripAnsi(this.stderr))
      }
    })
  }

  get stderrText(): string {
    return stripAnsi(this.stderr)
  }

  /** 替换通知回调（构造之后、initialize 之前调用） */
  setNotificationHandler(
    cb: (method: string, params: Record<string, unknown>) => void
  ): void {
    this.notificationHandler = cb
  }

  /** 替换服务端请求回调（审批 / 提问） */
  setServerRequestHandler(
    cb: (id: string | number, method: string, params: Record<string, unknown>) => void
  ): void {
    this.serverRequestHandler = cb
  }

  private onStdout(chunk: string): void {
    try {
      for (const line of this.decoder.push(chunk)) this.onLine(line)
    } catch (e) {
      // app-server 的输出不可信；坏掉一行最多丢一个通知
      this.stderr += `\n[parse error] ${e instanceof Error ? e.message : String(e)}`
      if (this.stderr.length > 16_000) this.stderr = this.stderr.slice(-16_000)
    }
  }

  private onLine(line: string): void {
    const msg = parseLine(line)
    if (!msg) return

    const id = msg.id
    const method = typeof msg.method === 'string' ? msg.method : ''
    const params =
      msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params)
        ? (msg.params as Record<string, unknown>)
        : {}

    // 服务端请求：有 method 也有 id
    if (method && id !== undefined && id !== null) {
      const rid = id as string | number
      if (this.serverRequestHandler) this.serverRequestHandler(rid, method, params)
      else this.respondError(rid, -32601, t('codexRunner.unsupported', { method }))
      return
    }

    if (id !== undefined && id !== null) {
      const key = String(id)
      const p = this.pending.get(key)
      if (!p) return
      this.pending.delete(key)
      clearTimeout(p.timer)
      if (msg.error) {
        const e = msg.error as Record<string, unknown>
        p.reject(new Error(typeof e.message === 'string' ? e.message : JSON.stringify(e)))
      } else {
        p.resolve(msg.result)
      }
      return
    }

    if (method) this.notificationHandler?.(method, params)
  }

  request<T = Record<string, unknown>>(
    method: string,
    params: unknown,
    timeoutMs = 30_000
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error(t('codexRunner.exited', { code: 'signal' })))
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id))
        reject(new Error(t('codexRunner.timeout', { method })))
      }, timeoutMs)
      this.pending.set(String(id), {
        resolve: (v) => resolve(v as T),
        reject,
        timer
      })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown = {}): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  respond(id: string | number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result })
  }

  respondError(id: string | number, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  private write(msg: Record<string, unknown>): void {
    if (this.closed || this.disposed) return
    try {
      this.child.stdin?.write(`${JSON.stringify(msg)}\n`)
    } catch {
      // 子进程已退，close 事件会收尾
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.failAll(new Error(t('codexRunner.closed')))
    try {
      this.child.stdin?.end()
    } catch {
      // ignore
    }
    killCodexTree(this.child)
  }
}

/** 初始化握手；成功后服务端才接受其它方法 */
export async function initializeCodex(rpc: CodexRpc): Promise<void> {
  await rpc.request('initialize', {
    clientInfo: { name: 'ccoder-desktop', title: 'CCoder Desktop', version: '1.0.0' },
    capabilities: { experimentalApi: true, requestAttestation: false }
  })
  rpc.notify('initialized', {})
}

/* ── 安装 / 账号探测 ─────────────────────────────────────── */

interface VersionResult {
  ok: boolean
  version: string
  error: string
}

function readVersion(timeoutMs = 8000): Promise<VersionResult> {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let done = false
    let child: ChildProcess
    try {
      child = spawnCodex(['--version'])
    } catch (e) {
      resolve({ ok: false, version: '', error: String(e) })
      return
    }
    const timer = setTimeout(() => {
      if (done) return
      done = true
      killCodexTree(child)
      resolve({ ok: false, version: '', error: t('codexTest.versionTimeout') })
    }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', (e) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, version: '', error: e.message })
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      const text = (out || err).trim()
      resolve({
        ok: code === 0,
        version: text.split('\n')[0] ?? '',
        error: code === 0 ? '' : text || t('codexTest.exitCode', { code: code ?? 'signal' })
      })
    })
  })
}

function accountInfo(raw: Record<string, unknown> | null): CodexAccountInfo | null {
  if (!raw) return null
  const type = typeof raw.type === 'string' ? raw.type : ''
  if (type === 'chatgpt') {
    return {
      kind: 'chatgpt',
      email: typeof raw.email === 'string' ? raw.email : undefined,
      plan: typeof raw.planType === 'string' ? raw.planType : undefined
    }
  }
  if (type === 'apiKey') return { kind: 'apiKey' }
  if (type === 'amazonBedrock') return { kind: 'amazonBedrock' }
  return { kind: 'unknown' }
}

function permissionProfiles(raw: unknown): CodexPermissionProfile[] {
  const data =
    raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)
      ? ((raw as { data: unknown[] }).data as Record<string, unknown>[])
      : []
  const out: CodexPermissionProfile[] = []
  for (const p of data) {
    const id = typeof p.id === 'string' ? p.id : ''
    if (!id) continue
    out.push({
      id,
      description: typeof p.description === 'string' ? p.description : null,
      allowed: p.allowed !== false
    })
  }
  return out
}

export async function checkCodexStatus(): Promise<CodexStatus> {
  const checkedAt = Date.now()
  // 用户可能刚装完就点「重新检测」；不清缓存会一直拿着启动时那份路径
  resetCodexBinCache()
  const path = resolveCodexBin()
  const v = await readVersion()

  if (!v.ok) {
    return {
      installed: false,
      path,
      version: '',
      appServerOk: false,
      error: v.error || t('codexTest.binNotFound'),
      account: null,
      permissionProfiles: [],
      checkedAt
    }
  }

  const rpc = new CodexRpc()
  try {
    await initializeCodex(rpc)
    const [acc, profiles] = await Promise.all([
      rpc.request<{ account: Record<string, unknown> | null; requiresOpenaiAuth: boolean }>(
        'account/read',
        { refreshToken: false },
        15_000
      ),
      rpc
        .request<Record<string, unknown>>('permissionProfile/list', {}, 15_000)
        .catch(() => ({ data: [] }))
    ])
    const account = accountInfo(acc.account)
    if (account) account.requiresOpenaiAuth = acc.requiresOpenaiAuth === true
    return {
      installed: true,
      path,
      version: v.version,
      appServerOk: true,
      account,
      permissionProfiles: permissionProfiles(profiles),
      checkedAt
    }
  } catch (e) {
    return {
      installed: true,
      path,
      version: v.version,
      appServerOk: false,
      error: String(e),
      account: null,
      permissionProfiles: [],
      checkedAt
    }
  } finally {
    rpc.dispose()
  }
}

/* ── 渠道连通性测试 ─────────────────────────────────────── */

/**
 * 真跑一轮最小对话。不是只做握手 —— 握手成功只能说明 app-server 起来了，
 * 端点地址、密钥、模型名错一个都测不出来。
 *
 * 用 `ephemeral: true`：不往用户的 Codex 历史里塞测试会话。
 */
export async function testCodexChannel(ch: Channel): Promise<ChannelTestResult> {
  const started = Date.now()
  const model = ch.model.trim()
  if (!model) {
    return { ok: false, message: t('codexTest.noModel'), latencyMs: 0 }
  }

  const rpc = new CodexRpc({ channel: ch, cwd: homedir() })
  let threadId = ''
  let text = ''
  let note = ''
  /** app-server 启动时若 config.toml 读不进来，会先推一条 configWarning */
  let configWarning = ''
  let wake: () => void = () => undefined

  rpc.setNotificationHandler((method, params) => {
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      text += params.delta
      return
    }
    if (method === 'configWarning' && typeof params.summary === 'string') {
      configWarning = params.summary.trim()
      return
    }
    if (method === 'error') {
      const err = params.error as Record<string, unknown> | undefined
      if (err && typeof err.message === 'string') note = err.message
      return
    }
    if (method === 'turn/completed' && params.threadId === threadId) {
      const turn = params.turn as Record<string, unknown> | undefined
      const err = turn?.error as Record<string, unknown> | undefined
      if (turn && turn.status === 'failed' && err && typeof err.message === 'string') {
        note = err.message
      }
      wake()
    }
  })
  // 测试只观察，不真要权限：审批统一拒绝，提问给空答案
  rpc.setServerRequestHandler((id, method) => {
    if (method === 'item/commandExecution/requestApproval') {
      rpc.respond(id, { decision: 'decline' })
    } else if (method === 'item/fileChange/requestApproval') {
      rpc.respond(id, { decision: 'decline' })
    } else if (method === 'item/tool/requestUserInput') {
      rpc.respond(id, { answers: {} })
    } else if (method === 'item/permissions/requestApproval') {
      rpc.respond(id, { permissions: {}, scope: 'turn' })
    } else {
      rpc.respondError(id, -32601, t('codexTest.unsupported', { method }))
    }
  })

  try {
    await initializeCodex(rpc)
    const thread = await rpc.request<{ thread: { id: string }; model: string }>(
      'thread/start',
      {
        cwd: homedir(),
        model,
        approvalPolicy: 'never',
        permissions: ':read-only',
        ephemeral: true
      },
      30_000
    )
    threadId = thread.thread.id

    let doneResolve: () => void = () => undefined
    let doneReject: (e: Error) => void = () => undefined
    const done = new Promise<void>((resolve, reject) => {
      doneResolve = resolve
      doneReject = reject
    })
    const timer = setTimeout(
      () => doneReject(new Error(t('codexTest.noTurnCompleted'))),
      60_000
    )
    timer.unref()
    wake = () => {
      clearTimeout(timer)
      doneResolve()
    }

    const turn = await rpc.request<{ turn: { id: string; status: string; error: unknown } }>(
      'turn/start',
      {
        threadId,
        input: [
          {
            type: 'text',
            text: 'Reply with exactly OK. Do not call any tools.',
            text_elements: []
          }
        ],
        effort: 'low'
      },
      30_000
    )

    // 已经完成（极快的端点）时不会再有通知
    if (turn.turn.status !== 'inProgress') wake()
    await done

    const latencyMs = Date.now() - started
    const reply = text.trim().slice(0, 200)
    if (!reply) {
      return {
        ok: false,
        message: note || t('codexTest.noText'),
        latencyMs
      }
    }
    return {
      ok: true,
      message: t('codexTest.ok', { model, reply }),
      latencyMs
    }
  } catch (e) {
    const detail = note || String(e)
    const stderr = rpc.stderrText.trim()
    // Codex 自己的配置坏了时，app-server 还能握手（initialize 正常），
    // 但 thread/start 会回 -32600；不解释一句的话用户只会看到 os error 2。
    const configBroken =
      /failed to load configuration/i.test(`${detail}\n${configWarning}\n${stderr}`) ||
      /invalid configuration/i.test(`${configWarning}\n${stderr}`)
    const hint = configBroken
      ? t('codexTest.configHint')
      : ''
    return {
      ok: false,
      message: `${detail}${stderr ? `\n${stderr.slice(-600)}` : ''}${hint}`,
      latencyMs: Date.now() - started
    }
  } finally {
    rpc.dispose()
  }
}
