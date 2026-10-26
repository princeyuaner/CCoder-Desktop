import { spawn, type ChildProcess } from 'node:child_process'
import type {
  McpProbeResult,
  McpPromptInfo,
  McpResourceInfo,
  McpProbeInput,
  McpToolInfo,
  RuntimeMcpServer
} from '../shared/mcp'

/**
 * 最小 MCP 客户端：只做 initialize → tools/resources/prompts list，然后退出。
 *
 * 不引 SDK：这里只需要一次性的探测，而且 stdio 的 Windows 启动细节
 * （.cmd 必须过 shell、参数要自己引号）在 Claude/Codex 的 runner 里已经
 * 踩过一遍。实现成独立的小客户端比拖一个重依赖更好维护。
 *
 * SSE 传输暂不探测：Claude/DSH 可以自己连，但 CCoder 的探测层只声明
 * “未检测”，避免把“探测没实现”误报成“服务器坏了”。
 */

const IS_WIN = process.platform === 'win32'
const PROBE_TIMEOUT_MS = 12_000
const REQUEST_TIMEOUT_MS = 7_000
const PROTOCOL_VERSION = '2024-11-05'

function quoteWin(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`
}

function killTree(child: ChildProcess): void {
  if (!child.pid) {
    try {
      child.kill()
    } catch {
      // 已经退出
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
      // 回落到普通 kill
    }
  }
  try {
    child.kill('SIGTERM')
  } catch {
    // 已经退出
  }
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function clampText(s: string, max = 500): string {
  const clean = s.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

function toolsOf(result: unknown): McpToolInfo[] {
  return asArr(asObj(result).tools)
    .map((x) => asObj(x))
    .map((x) => ({ name: str(x.name), description: str(x.description) }))
    .filter((x) => x.name)
}

function resourcesOf(result: unknown): McpResourceInfo[] {
  return asArr(asObj(result).resources)
    .map((x) => asObj(x))
    .map((x) => ({
      uri: str(x.uri),
      name: str(x.name) || str(x.uri),
      description: str(x.description),
      mimeType: str(x.mimeType)
    }))
    .filter((x) => x.uri)
}

function promptsOf(result: unknown): McpPromptInfo[] {
  return asArr(asObj(result).prompts)
    .map((x) => asObj(x))
    .map((x) => ({ name: str(x.name), description: str(x.description) }))
    .filter((x) => x.name)
}

interface JsonRpcResponse {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  result?: unknown
  error?: { code?: number; message?: string }
}

class StdioClient {
  private child: ChildProcess
  private buffer = ''
  private seq = 0
  private stderr = ''
  private closed = false
  private pending = new Map<
    number,
    {
      resolve: (v: unknown) => void
      reject: (e: Error) => void
      timer: NodeJS.Timeout
    }
  >()

  constructor(server: RuntimeMcpServer, cwd: string) {
    const env: NodeJS.ProcessEnv = { ...process.env, ...server.env }
    const args = server.args
    this.child = IS_WIN
      ? spawn([quoteWin(server.command), ...args.map(quoteWin)].join(' '), {
          cwd,
          env,
          shell: true,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      : spawn(server.command, args, {
          cwd,
          env,
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })

    this.child.stdin?.on('error', () => undefined)
    this.child.stdout?.on('data', (d: Buffer) => this.onData(d.toString()))
    this.child.stderr?.on('data', (d: Buffer) => {
      this.stderr += d.toString()
      if (this.stderr.length > 8000) this.stderr = this.stderr.slice(-8000)
    })
    this.child.on('error', (e) => {
      this.closed = true
      this.failAll(e)
    })
    this.child.on('close', () => {
      this.closed = true
      this.failAll(new Error(this.stderr || 'MCP server exited'))
    })
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const body = this.nextBody()
      if (body === null) return
      if (!body.trim()) continue
      let msg: JsonRpcResponse
      try {
        msg = JSON.parse(body) as JsonRpcResponse
      } catch {
        // 不是 JSON 的日志行直接丢掉
        continue
      }
      this.onMessage(msg)
    }
  }

  /**
   * 兼容两种 stdio 帧：最常见的按行 JSON，以及老版本的
   * `Content-Length: N\r\n\r\n{...}`。两者混用时逐个消费。
   */
  private nextBody(): string | null {
    if (this.buffer.startsWith('Content-Length:')) {
      const endHeaders = this.buffer.indexOf('\r\n\r\n')
      if (endHeaders < 0) return null
      const m = /^Content-Length:\s*(\d+)/i.exec(this.buffer.slice(0, endHeaders))
      if (!m) {
        this.buffer = this.buffer.slice(endHeaders + 4)
        return ''
      }
      const len = Number(m[1])
      const start = endHeaders + 4
      if (this.buffer.length < start + len) return null
      const body = this.buffer.slice(start, start + len)
      this.buffer = this.buffer.slice(start + len)
      return body
    }

    const idx = this.buffer.indexOf('\n')
    if (idx < 0) return null
    const line = this.buffer.slice(0, idx).replace(/\r$/, '')
    this.buffer = this.buffer.slice(idx + 1)
    return line
  }

  private onMessage(msg: JsonRpcResponse): void {
    if (msg.id !== undefined && msg.id !== null) {
      const key = Number(msg.id)
      const p = this.pending.get(key)
      if (p) {
        this.pending.delete(key)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(str(msg.error.message) || `JSON-RPC error ${msg.error.code ?? ''}`))
        else p.resolve(msg.result)
        return
      }
    }

    // 服务端反向请求：探测阶段不需要 roots / sampling，明确回不支持，
    // 否则某些服务器会一直等回执导致 initialize 挂住。
    if (msg.id !== undefined && msg.id !== null && typeof msg.method === 'string') {
      const id = msg.id
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'CCoder MCP probe does not support server requests' }
      })
    }
  }

  private write(msg: unknown): void {
    if (this.closed) return
    try {
      this.child.stdin?.write(`${JSON.stringify(msg)}\n`)
    } catch {
      // 子进程提前退出，等 close 统一报错
    }
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(this.stderr || 'MCP server not running'))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  close(): void {
    this.closed = true
    this.failAll(new Error('probe closed'))
    killTree(this.child)
  }
}

interface HttpRpcResponse {
  result: unknown
  sessionId: string
  protocolVersion: string
}

async function postRpc(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  sessionId: string,
  protocolVersion: string,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<HttpRpcResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    const nextSession = res.headers.get('mcp-session-id') || sessionId
    const ct = res.headers.get('content-type') || ''
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${clampText(text || res.statusText)}`)
    }
    // Streamable HTTP 常用 SSE 回包，而且一条事件后连接可能一直挂着。
    // 不能等 res.text() 收完再解析，否则服务端不关流就会误判超时。
    const parsed = ct.includes('text/event-stream')
      ? await readSseStream(res, body, controller)
      : parseJson(await res.text())
    if (!parsed) {
      return { result: null, sessionId: nextSession, protocolVersion }
    }
    if (parsed.error) {
      throw new Error(str(parsed.error.message) || `JSON-RPC error ${parsed.error.code ?? ''}`)
    }
    const version = str(asObj(parsed.result).protocolVersion) || protocolVersion
    return { result: parsed.result, sessionId: nextSession, protocolVersion: version }
  } finally {
    clearTimeout(timer)
  }
}

function parseJson(text: string): JsonRpcResponse | null {
  if (!text.trim()) return null
  try {
    return JSON.parse(text) as JsonRpcResponse
  } catch {
    // 有的服务器在 JSON 前打了日志行，尝试最后一个对象行
    const lines = text.split('\n').filter((l) => l.trim().startsWith('{'))
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]) as JsonRpcResponse
      } catch {
        // 继续往前找
      }
    }
    return null
  }
}

function sseChunkToResponse(chunk: string, requestBody: unknown): JsonRpcResponse | null {
  const wanted = asObj(requestBody).id
  const data = chunk
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!data) return null
  try {
    const obj = JSON.parse(data) as JsonRpcResponse
    if (wanted !== undefined ? obj.id === wanted : true) return obj
  } catch {
    // 跳过坏消息
  }
  return null
}

/**
 * 边读边解析 SSE。收到目标 id 的响应就取消 reader 并返回 —— 服务端
 * 之后要一直保持连接也没关系。
 */
async function readSseStream(
  res: Response,
  requestBody: unknown,
  controller: AbortController
): Promise<JsonRpcResponse | null> {
  if (!res.body) return null
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (value) buffer += decoder.decode(value, { stream: true })
      let edge = buffer.search(/\r?\n\r?\n/)
      while (edge >= 0) {
        const sepLen = buffer.startsWith('\r\n\r\n', edge) ? 4 : 2
        const chunk = buffer.slice(0, edge)
        buffer = buffer.slice(edge + sepLen)
        const parsed = sseChunkToResponse(chunk, requestBody)
        if (parsed) {
          void reader.cancel().catch(() => undefined)
          return parsed
        }
        edge = buffer.search(/\r?\n\r?\n/)
      }
      if (done) {
        return sseChunkToResponse(buffer, requestBody)
      }
    }
  } catch (e) {
    if (controller.signal.aborted) throw new Error('request timed out')
    throw e
  }
}

async function probeHttp(server: RuntimeMcpServer): Promise<{
  tools: McpToolInfo[]
  resources: McpResourceInfo[]
  prompts: McpPromptInfo[]
}> {
  const headers = { ...server.headers }
  const init = await postRpc(
    server.url,
    headers,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'CCoder', version: '1.0.4' }
      }
    },
    '',
    ''
  )
  const version = str(asObj(init.result).protocolVersion) || PROTOCOL_VERSION

  await postRpc(
    server.url,
    headers,
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    init.sessionId,
    version
  ).catch(() => undefined)

  const safeList = async (
    id: number,
    method: string
  ): Promise<unknown> => {
    try {
      const r = await postRpc(
        server.url,
        headers,
        { jsonrpc: '2.0', id, method, params: {} },
        init.sessionId,
        version
      )
      return r.result
    } catch {
      return null
    }
  }

  const [tools, resources, prompts] = await Promise.all([
    safeList(2, 'tools/list'),
    safeList(3, 'resources/list'),
    safeList(4, 'prompts/list')
  ])
  return { tools: toolsOf(tools), resources: resourcesOf(resources), prompts: promptsOf(prompts) }
}

async function probeStdio(server: RuntimeMcpServer, cwd: string): Promise<{
  tools: McpToolInfo[]
  resources: McpResourceInfo[]
  prompts: McpPromptInfo[]
}> {
  const client = new StdioClient(server, cwd)
  try {
    await client.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'CCoder', version: '1.0.4' }
    })
    client.notify('notifications/initialized')
    const tools = await client.request('tools/list', {}).catch(() => null)
    const resources = await client.request('resources/list', {}).catch(() => null)
    const prompts = await client.request('prompts/list', {}).catch(() => null)
    return { tools: toolsOf(tools), resources: resourcesOf(resources), prompts: promptsOf(prompts) }
  } finally {
    client.close()
  }
}

function runtimeOf(input: McpProbeInput): RuntimeMcpServer {
  return {
    name: input.name.trim(),
    transport: input.transport,
    command: input.command.trim(),
    args: input.args,
    env: Object.fromEntries(
      input.env.filter((kv) => kv.key.trim()).map((kv) => [kv.key.trim(), kv.value])
    ),
    url: input.url.trim(),
    headers: Object.fromEntries(
      input.headers.filter((kv) => kv.key.trim()).map((kv) => [kv.key.trim(), kv.value])
    )
  }
}

export async function probeMcpServer(input: McpProbeInput): Promise<McpProbeResult> {
  const started = Date.now()
  const server = runtimeOf(input)
  if (!server.name) {
    return {
      ok: false,
      status: 'error',
      error: 'server name is empty',
      latencyMs: 0,
      checkedAt: Date.now(),
      tools: [],
      resources: [],
      prompts: []
    }
  }
  if (server.transport === 'sse') {
    return {
      ok: false,
      status: 'error',
      error: 'SSE transport probe is not implemented yet; the server can still be used by Claude/DSH.',
      latencyMs: 0,
      checkedAt: Date.now(),
      tools: [],
      resources: [],
      prompts: []
    }
  }
  if (server.transport === 'http' && !server.url) {
    return {
      ok: false,
      status: 'error',
      error: 'server URL is empty',
      latencyMs: 0,
      checkedAt: Date.now(),
      tools: [],
      resources: [],
      prompts: []
    }
  }
  if (server.transport === 'stdio' && !server.command) {
    return {
      ok: false,
      status: 'error',
      error: 'server command is empty',
      latencyMs: 0,
      checkedAt: Date.now(),
      tools: [],
      resources: [],
      prompts: []
    }
  }

  try {
    const found = await Promise.race([
      server.transport === 'stdio'
        ? probeStdio(server, input.workingDir.trim() || process.cwd())
        : probeHttp(server),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('probe timed out')), PROBE_TIMEOUT_MS)
      )
    ])
    return {
      ok: true,
      status: 'connected',
      error: '',
      latencyMs: Date.now() - started,
      checkedAt: Date.now(),
      ...found
    }
  } catch (e) {
    return {
      ok: false,
      status: 'error',
      error: clampText(e instanceof Error ? e.message : String(e)),
      latencyMs: Date.now() - started,
      checkedAt: Date.now(),
      tools: [],
      resources: [],
      prompts: []
    }
  }
}
