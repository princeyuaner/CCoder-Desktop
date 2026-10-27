import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { IPC } from '../../shared/ipc'
import type {
  LspDiagnosticsEvent,
  LspErrorCode,
  LspNotification,
  LspRequest,
  LspResponse,
  LspStartResult,
  LspStateEvent
} from '../../shared/lsp'
import { pathKey } from '../path-key'
import { JsonRpcConnection } from './jsonrpc'
import { detectServer, serversFor, type DetectedServer } from './registry'

/**
 * LSP 宿主。
 *
 * 每个 IDE 窗口 + 工作区 + 服务器一个子进程。渲染层只发方法名和参数，
 * 这里负责：探测服务器、initialize 握手、把 server→client 的通知
 * （主要是诊断）转给对应的 webContents、窗口关闭时结束进程。
 *
 * 会话按 senderId 隔离 —— A 窗口不能读到 B 窗口的语言服务器。
 */

interface Session {
  key: string
  senderId: number
  cwd: string
  server: DetectedServer
  proc: ChildProcessWithoutNullStreams
  conn: JsonRpcConnection
  capabilities: unknown
  state: 'starting' | 'ready' | 'error' | 'stopped'
  stopping: boolean
  /** 另一个语言（TS / JS 共用服务器）并发 start 时等这一次初始化 */
  ready: Promise<LspStartResult>
}

type SendToSender = (senderId: number, channel: string, payload: unknown) => void
type LogFn = (scope: string, detail?: unknown) => void

let sendToSender: SendToSender = () => {}
let log: LogFn = () => {}

/**
 * 由主进程注入「怎么把事件送回窗口」和「怎么记日志」。
 *
 * 不直接 import ide-window / crash-log，是为了让这个模块能脱离 Electron
 * 单独跑验证脚本；也让 LSP 宿主不依赖窗口实现的细节。
 */
export function configureLspHost(options: { send: SendToSender; log?: LogFn }): void {
  sendToSender = options.send
  if (options.log) log = options.log
}

const sessions = new Map<string, Session>()
const senderSessions = new Map<number, Set<string>>()
/** 同一 (窗口, 工作区, 语言) 的并发 start 合并成一次 */
const starting = new Map<string, Promise<LspStartResult>>()
/**
 * 窗口关闭时正在 initialize 的启动请求没法直接取消；用一个代数标记，
 * 初始化完成后再发现窗口已经关了，就直接收掉进程，别留孤儿。
 */
const senderEpoch = new Map<number, number>()
let shuttingDown = false

function epochOf(senderId: number): number {
  return senderEpoch.get(senderId) ?? 0
}

const MAX_DIAGNOSTICS_PER_FILE = 2_000
const MAX_DIAGNOSTIC_MESSAGE = 4_000

/** 渲染层能直接调用的方法白名单；别让一个参数拼错就把任意 RPC 发给服务器 */
const REQUEST_METHODS = new Set([
  'textDocument/definition',
  'textDocument/declaration',
  'textDocument/implementation',
  'textDocument/typeDefinition',
  'textDocument/references',
  'textDocument/rename',
  'textDocument/prepareRename',
  'textDocument/hover',
  'textDocument/completion',
  'textDocument/completionItem/resolve',
  'textDocument/documentSymbol',
  'textDocument/documentHighlight',
  'textDocument/formatting',
  'textDocument/rangeFormatting',
  'textDocument/signatureHelp',
  'textDocument/codeAction',
  'codeAction/resolve',
  'textDocument/semanticTokens/full',
  'workspace/symbol'
])

const NOTIFY_METHODS = new Set([
  'textDocument/didOpen',
  'textDocument/didChange',
  'textDocument/didClose'
])

function sessionKey(senderId: number, cwd: string, serverId: string): string {
  return `${senderId}|${pathKey(cwd)}|${serverId}`
}

function track(senderId: number, key: string): void {
  let set = senderSessions.get(senderId)
  if (!set) {
    set = new Set()
    senderSessions.set(senderId, set)
  }
  set.add(key)
}

function untrack(senderId: number, key: string): void {
  const set = senderSessions.get(senderId)
  if (!set) return
  set.delete(key)
  if (set.size === 0) senderSessions.delete(senderId)
}

/** 一个服务器可能服务多种语言；状态事件按每种语言各发一条，UI 才能对得上。 */
function emitStateFor(
  senderId: number,
  cwd: string,
  server: DetectedServer,
  state: LspStateEvent['state'],
  message?: string,
  capabilities?: unknown
): void {
  for (const language of server.languages) {
    sendToSender(senderId, IPC.lspState, {
      cwd,
      language,
      state,
      server: server.name,
      ...(message ? { message } : {}),
      ...(capabilities ? { capabilities } : {})
    } satisfies LspStateEvent)
  }
}

function emitStateForLanguages(session: Session, state: LspStateEvent['state'], message?: string): void {
  emitStateFor(
    session.senderId,
    session.cwd,
    session.server,
    state,
    message,
    state === 'ready' ? session.capabilities : undefined
  )
}

function spawnServer(server: DetectedServer, cwd: string): ChildProcessWithoutNullStreams {
  const env = { ...process.env }
  if (server.node) env.ELECTRON_RUN_AS_NODE = '1'
  else delete env.ELECTRON_RUN_AS_NODE

  const options = {
    cwd,
    windowsHide: true,
    env
  }
  // 项目里的 `.mjs` 不是可执行文件：用 Electron 自带的 Node 跑，
  // 这样打包版也不需要用户另外安装 node。
  if (server.node) {
    return spawn(process.execPath, [server.file, ...server.args], options)
  }
  // Windows 的 .cmd / .bat 不能直接 spawn；交给 cmd.exe。路径可能带空格
  // （用户名 / npm 全局目录），所以手动给每一段加引号。
  if (server.shell) {
    const command = [server.file, ...server.args]
      .map((part) => (/[\s"]/.test(part) ? `"${part.replace(/"/g, '""')}"` : part))
      .join(' ')
    return spawn(command, [], { ...options, shell: true })
  }
  return spawn(server.file, server.args, options)
}

/** 退出应用时用同步版本，保证 taskkill 已经发出去再让进程退出。 */
function killProcSync(proc: ChildProcessWithoutNullStreams): void {
  if (process.platform === 'win32' && proc.pid) {
    try {
      spawnSync(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', `taskkill /pid ${proc.pid} /T /F`],
        { windowsHide: true, stdio: 'ignore', timeout: 2_000 }
      )
      return
    } catch {
      // 回落到普通 kill
    }
  }
  try {
    proc.kill()
  } catch {
    // 进程可能已经退出
  }
}

function killProc(proc: ChildProcessWithoutNullStreams): void {
  if (proc.killed) return
  if (process.platform === 'win32' && proc.pid) {
    try {
      const killer = spawn(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', `taskkill /pid ${proc.pid} /T /F`],
        { windowsHide: true, stdio: 'ignore' }
      )
      killer.on('error', () => {
        try {
          proc.kill()
        } catch {
          // 进程可能已经退出
        }
      })
      return
    } catch {
      // 回落到普通 kill
    }
  }
  try {
    proc.kill('SIGTERM')
  } catch {
    // 进程可能已经退出
  }
}

function sanitizeDiagnostics(params: unknown, cwd: string): LspDiagnosticsEvent | null {
  if (!params || typeof params !== 'object') return null
  const p = params as {
    uri?: unknown
    version?: unknown
    diagnostics?: unknown
  }
  if (typeof p.uri !== 'string' || !Array.isArray(p.diagnostics)) return null
  if (!p.uri.startsWith('file:')) return null

  let path: string
  try {
    path = fileURLToPath(p.uri)
  } catch {
    return null
  }
  // 工作区外的诊断（node_modules、标准库）不往界面里塞
  const abs = path.replace(/\\/g, '/')
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const absKey = process.platform === 'win32' ? abs.toLowerCase() : abs
  const rootKey = process.platform === 'win32' ? root.toLowerCase() : root
  if (absKey !== rootKey && !absKey.startsWith(`${rootKey}/`)) return null

  const diagnostics = p.diagnostics
    .slice(0, MAX_DIAGNOSTICS_PER_FILE)
    .map((raw) => {
      if (!raw || typeof raw !== 'object') return null
      const d = raw as {
        range?: { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } }
        severity?: unknown
        code?: unknown
        source?: unknown
        message?: unknown
        tags?: unknown
      }
      const range = d.range
      const start = range?.start
      const end = range?.end
      if (
        !start ||
        !end ||
        typeof start.line !== 'number' ||
        typeof start.character !== 'number' ||
        typeof end.line !== 'number' ||
        typeof end.character !== 'number'
      ) {
        return null
      }
      const message = typeof d.message === 'string' ? d.message : ''
      if (!message) return null
      const severity =
        typeof d.severity === 'number' && d.severity >= 1 && d.severity <= 4 ? d.severity : 1
      const code =
        typeof d.code === 'string' || typeof d.code === 'number' ? d.code : undefined
      return {
        range: {
          start: { line: start.line, character: start.character },
          end: { line: end.line, character: end.character }
        },
        severity,
        ...(code !== undefined ? { code } : {}),
        ...(typeof d.source === 'string' ? { source: d.source } : {}),
        message: message.slice(0, MAX_DIAGNOSTIC_MESSAGE),
        ...(Array.isArray(d.tags)
          ? { tags: d.tags.filter((t): t is number => typeof t === 'number') }
          : {})
      }
    })
    .filter((d): d is NonNullable<typeof d> => !!d)

  return {
    cwd,
    uri: p.uri,
    ...(typeof p.version === 'number' ? { version: p.version } : {}),
    diagnostics
  }
}

function handleNotification(session: Session, method: string, params: unknown): void {
  if (method === 'textDocument/publishDiagnostics') {
    const event = sanitizeDiagnostics(params, session.cwd)
    if (event) sendToSender(session.senderId, IPC.lspDiagnostics, event)
    return
  }
  if (method === 'window/showMessage') {
    const p = params as { type?: number; message?: unknown } | null
    log(`lsp[${session.server.id}].showMessage`, {
      type: p?.type,
      message: typeof p?.message === 'string' ? p.message.slice(0, 500) : ''
    })
    return
  }
  if (method === 'window/logMessage') {
    const p = params as { message?: unknown } | null
    if (typeof p?.message === 'string') {
      log(`lsp[${session.server.id}].log`, p.message.slice(0, 1_000))
    }
  }
}

function handleServerRequest(session: Session, method: string, params: unknown): unknown {
  switch (method) {
    case 'workspace/configuration': {
      const p = params as { items?: unknown } | null
      const items = Array.isArray(p?.items) ? p.items : []
      return items.map(() => ({}))
    }
    case 'workspace/workspaceFolders':
      return [
        {
          uri: pathToFileURL(session.cwd).href,
          name: basename(session.cwd)
        }
      ]
    case 'client/registerCapability':
    case 'client/unregisterCapability':
    case 'window/workDoneProgress/create':
    case 'window/showMessageRequest':
      return null
    case 'workspace/applyEdit':
      // 重命名走的是响应里的 WorkspaceEdit，不依赖 server→client 的 applyEdit。
      // 直接拒绝，避免服务器在后台改文件却不经过渲染层的保存/冲突流程。
      return {
        applied: false,
        failureReason: 'CCoder applies workspace edits through the editor'
      }
    default:
      return null
  }
}

function removeSession(session: Session): void {
  if (sessions.get(session.key) === session) sessions.delete(session.key)
  untrack(session.senderId, session.key)
}

async function disposeSession(session: Session, reason = 'stopped'): Promise<void> {
  if (session.stopping) return
  session.stopping = true
  session.state = 'stopped'
  removeSession(session)
  emitStateForLanguages(session, 'stopped', reason)

  try {
    if (!session.conn.isClosed) await session.conn.request('shutdown', null, 1_000)
  } catch {
    // 服务器可能已经退出
  }
  try {
    if (!session.conn.isClosed) session.conn.notify('exit')
  } catch {
    // 忽略
  }
  session.conn.dispose('stopped')
  const timer = setTimeout(() => killProc(session.proc), 400)
  timer.unref?.()
}

function installSessionHandlers(session: Session): void {
  const conn = session.conn
  conn.onNotification = (method, params) => handleNotification(session, method, params)
  conn.onRequest = (method, params) => handleServerRequest(session, method, params)
  conn.onClose = (reason) => {
    if (session.stopping) return
    session.state = 'error'
    removeSession(session)
    emitStateForLanguages(session, 'error', reason)
    log(`lsp[${session.server.id}].closed`, { cwd: session.cwd, reason })
  }
}

async function createSession(
  senderId: number,
  cwd: string,
  server: DetectedServer
): Promise<LspStartResult> {
  const epoch = epochOf(senderId)
  let proc: ChildProcessWithoutNullStreams
  try {
    log('lsp.spawn', {
      server: server.name,
      file: server.file,
      args: server.args,
      node: server.node,
      shell: server.shell,
      execPath: process.execPath
    })
    proc = spawnServer(server, cwd)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log('lsp.spawn-failed', { server: server.name, error: message })
    return { ok: false, code: 'spawn-failed', error: message }
  }

  let resolveReady!: (result: LspStartResult) => void
  const ready = new Promise<LspStartResult>((resolve) => {
    resolveReady = resolve
  })
  const session: Session = {
    key: sessionKey(senderId, cwd, server.id),
    senderId,
    cwd,
    server,
    proc,
    conn: new JsonRpcConnection(proc, {
      onLog: (kind, detail) => log(`lsp[${server.id}].${kind}`, detail)
    }),
    capabilities: null,
    state: 'starting',
    stopping: false,
    ready
  }
  sessions.set(session.key, session)
  track(senderId, session.key)
  installSessionHandlers(session)

  const rootUri = pathToFileURL(cwd).href
  const params = {
    processId: process.pid,
    clientInfo: { name: 'CCoder IDE' },
    rootUri,
    rootPath: cwd,
    workspaceFolders: [{ uri: rootUri, name: basename(cwd) }],
    capabilities: {
      general: { positionEncodings: ['utf-16'] },
      workspace: {
        applyEdit: true,
        workspaceEdit: { documentChanges: true },
        configuration: true,
        workspaceFolders: true,
        didChangeConfiguration: { dynamicRegistration: true },
        symbol: {
          symbolKind: {
            valueSet: [
              1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
              24, 25, 26
            ]
          }
        }
      },
      textDocument: {
        synchronization: { dynamicRegistration: false, willSave: false, didSave: false },
        publishDiagnostics: { relatedInformation: true, versionSupport: true },
        definition: { linkSupport: false },
        declaration: { linkSupport: false },
        implementation: { linkSupport: false },
        typeDefinition: { linkSupport: false },
        references: {},
        documentHighlight: {},
        rename: { prepareSupport: false },
        hover: { contentFormat: ['markdown', 'plaintext'] },
        completion: {
          completionItem: {
            snippetSupport: true,
            documentationFormat: ['markdown', 'plaintext'],
            insertReplaceSupport: false,
            resolveSupport: { properties: [] }
          },
          contextSupport: true
        },
        formatting: {},
        rangeFormatting: {},
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        signatureHelp: {
          signatureInformation: { documentationFormat: ['markdown', 'plaintext'] }
        },
        semanticTokens: {
          requests: { range: false, full: true },
          tokenTypes: [
            'namespace',
            'type',
            'class',
            'enum',
            'interface',
            'struct',
            'typeParameter',
            'parameter',
            'variable',
            'property',
            'enumMember',
            'event',
            'function',
            'method',
            'macro',
            'keyword',
            'modifier',
            'comment',
            'string',
            'number',
            'regexp',
            'operator',
            'decorator',
            'label',
            'angleBracket',
            'arithmetic',
            'attribute',
            'bitwise',
            'boolean',
            'brace',
            'bracket',
            'builtinType',
            'character',
            'colon',
            'comma',
            'comparison',
            'deprecated',
            'escapeSequence',
            'formatSpecifier',
            'lifetime',
            'logical',
            'parenthesis',
            'punctuation',
            'selfKeyword',
            'selfTypeKeyword',
            'semicolon',
            'stringEscape',
            'toolCommand',
            'typeArgument'
          ],
          tokenModifiers: [
            'declaration',
            'definition',
            'readonly',
            'static',
            'deprecated',
            'abstract',
            'async',
            'modification',
            'documentation',
            'defaultLibrary'
          ],
          formats: ['relative'],
          overlappingTokenSupport: false,
          multilineTokenSupport: false,
          serverCancelSupport: false,
          augmentsSyntaxTokens: true
        },
        codeAction: {
          codeActionLiteralSupport: {
            codeActionKind: {
              valueSet: [
                'quickfix',
                'refactor',
                'refactor.extract',
                'refactor.inline',
                'refactor.rewrite',
                'source',
                'source.organizeImports',
                'source.fixAll'
              ]
            }
          },
          isPreferredSupport: true,
          disabledSupport: true,
          dataSupport: true,
          resolveSupport: { properties: ['edit'] }
        }
      },
      window: { workDoneProgress: false }
    },
    initializationOptions: {}
  }

  try {
    const init = await session.conn.request('initialize', params, 30_000)
    if (shuttingDown || epochOf(senderId) !== epoch) {
      session.stopping = true
      removeSession(session)
      session.conn.dispose('sender closed')
      killProc(proc)
      const result: LspStartResult = {
        ok: false,
        code: 'stopped',
        error: 'window closed while the language server was starting'
      }
      resolveReady(result)
      return result
    }
    session.capabilities =
      init && typeof init === 'object'
        ? ((init as { capabilities?: unknown }).capabilities ?? null)
        : null
    session.state = 'ready'
    session.conn.notify('initialized', {})
    emitStateForLanguages(session, 'ready')
    log('lsp.started', {
      senderId,
      cwd,
      server: server.name,
      file: server.file
    })
    const result: LspStartResult = {
      ok: true,
      server: server.name,
      capabilities: session.capabilities
    }
    resolveReady(result)
    return result
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    session.state = 'error'
    removeSession(session)
    emitStateForLanguages(session, 'error', error)
    session.conn.dispose('initialize failed')
    killProc(proc)
    log('lsp.initialize-failed', { cwd, server: server.name, error })
    const result: LspStartResult = { ok: false, code: 'initialize-failed', error }
    resolveReady(result)
    return result
  }
}

async function doStart(senderId: number, cwd: string, language: string): Promise<LspStartResult> {
  const defs = serversFor(language)
  if (defs.length === 0) {
    return {
      ok: false,
      code: 'unsupported',
      error: `no language server is known for "${language}"`
    }
  }

  // 已经有一个同 id 的会话（例如 TS / JS 共用 typescript-language-server）
  for (const def of defs) {
    const existing = sessions.get(sessionKey(senderId, cwd, def.id))
    if (!existing || existing.stopping || existing.conn.isClosed) continue
    if (existing.state === 'ready') {
      return {
        ok: true,
        server: existing.server.name,
        capabilities: existing.capabilities
      }
    }
    if (existing.state === 'starting') return existing.ready
  }

  let lastError = ''
  let lastFailure: LspStartResult | null = null
  for (const def of defs) {
    const detected = detectServer(def, cwd)
    if (!detected) {
      lastError = lastError || `${def.name} not found`
      continue
    }
    emitStateFor(senderId, cwd, detected, 'starting')
    const result = await createSession(senderId, cwd, detected)
    if (result.ok) return result
    lastFailure = result
    lastError = result.error
  }

  // 找到了但起不来（rustup shim 缺组件、权限、初始化超时）时保留真实错误，
  // 不要伪装成「没安装」。
  if (lastFailure) return lastFailure
  return {
    ok: false,
    code: 'not-found',
    error:
      lastError ||
      `no language server found for "${language}"; install it or add it to the project's node_modules`
  }
}

export function startLsp(senderId: number, cwd: string, language: string): Promise<LspStartResult> {
  if (shuttingDown) {
    return Promise.resolve({ ok: false, code: 'stopped', error: 'application is quitting' })
  }
  const key = `${senderId}|${pathKey(cwd)}|${language}`
  const pending = starting.get(key)
  if (pending) return pending
  const task = doStart(senderId, cwd, language).finally(() => {
    if (starting.get(key) === task) starting.delete(key)
  })
  starting.set(key, task)
  return task
}

function findSession(senderId: number, cwd: string, language: string): Session | null {
  for (const def of serversFor(language)) {
    const session = sessions.get(sessionKey(senderId, cwd, def.id))
    if (session && !session.stopping && !session.conn.isClosed) return session
  }
  return null
}

export async function requestLsp(
  senderId: number,
  req: LspRequest
): Promise<LspResponse> {
  if (!REQUEST_METHODS.has(req.method)) {
    return { ok: false, code: 'unsupported', error: `method not allowed: ${req.method}` }
  }
  if (!findSession(senderId, req.cwd, req.language)) {
    const started = await startLsp(senderId, req.cwd, req.language)
    if (!started.ok) return { ok: false, code: started.code, error: started.error }
  }
  const session = findSession(senderId, req.cwd, req.language)
  if (!session) {
    return { ok: false, code: 'stopped', error: 'language server is not running' }
  }
  try {
    const result = await session.conn.request(req.method, req.params, req.timeoutMs)
    return { ok: true, result }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const code: LspErrorCode = /timed out/i.test(message) ? 'timeout' : 'unknown'
    return { ok: false, code, error: message }
  }
}

export function notifyLsp(senderId: number, req: LspNotification): void {
  if (!NOTIFY_METHODS.has(req.method)) return
  const session = findSession(senderId, req.cwd, req.language)
  if (!session) return
  session.conn.notify(req.method, req.params)
}

/** 关闭某个窗口 / 工作区的会话；不传 language 时全部关闭。 */
export function stopLsp(senderId: number, cwd: string, language?: string): void {
  // 先让在飞的 start 失效；否则它初始化完成后又会把会话加回来
  senderEpoch.set(senderId, epochOf(senderId) + 1)
  const keys = senderSessions.get(senderId)
  if (!keys) return
  const targetCwd = pathKey(cwd)
  for (const key of [...keys]) {
    const session = sessions.get(key)
    if (!session) {
      keys.delete(key)
      continue
    }
    if (pathKey(session.cwd) !== targetCwd) continue
    if (language && !session.server.languages.includes(language)) continue
    void disposeSession(session)
  }
}

/** 渲染进程崩溃 / 窗口关闭 */
export function stopLspForSender(senderId: number): void {
  senderEpoch.set(senderId, epochOf(senderId) + 1)
  const keys = senderSessions.get(senderId)
  if (!keys) return
  for (const key of [...keys]) {
    const session = sessions.get(key)
    if (session) void disposeSession(session)
    else untrack(senderId, key)
  }
}

/** 应用退出：不走 shutdown 握手，直接收进程，避免拖慢退出。 */
export function killAllLsp(): void {
  shuttingDown = true
  for (const session of [...sessions.values()]) {
    session.stopping = true
    session.state = 'stopped'
    removeSession(session)
    session.conn.dispose('app quitting')
    killProcSync(session.proc)
  }
  sessions.clear()
  senderSessions.clear()
  starting.clear()
}

/** 调试 / 验证用：当前活动会话数 */
export function lspSessionCount(): number {
  return sessions.size
}
