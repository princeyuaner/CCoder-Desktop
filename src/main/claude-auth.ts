import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { ChildProcess } from 'node:child_process'
import {
  cleanProviderEnv,
  killProcessTree,
  lastJson,
  resolveClaudeBin,
  spawnClaudeBin
} from './claude-runner'
import type {
  ClaudeAuthEvent,
  ClaudeAuthResult,
  ClaudeAuthStatus,
  ClaudeLoginPhase,
  ClaudeLoginSnapshot
} from '../shared/claude'

/**
 * Claude Code 官方登录。
 *
 * 登录是一个**长流程**：CLI 先打印授权 URL，然后阻塞在 stdin 等授权码。
 * 所以这里按"一个主进程单例 + 事件流"来做，而不是一次 IPC 调用等到底：
 *  - start 只负责把进程拉起来，URL / 输出 / 阶段通过事件推给设置页；
 *  - 用户拿到授权码后走 submit；
 *  - 设置页关了也不影响进程，重新进入时用 snapshot 恢复。
 *
 * 这个模块只依赖 `claude-runner`，不直接 import electron —— `openExternal`
 * 由 index.ts 注入，避免把 UI 能力混进登录状态机。
 */

const LOGIN_TIMEOUT_MS = 10 * 60_000
const SUBMIT_TIMEOUT_MS = 90_000
const STATUS_TIMEOUT_MS = 10_000
const VERSION_TIMEOUT_MS = 8_000
const MAX_OUTPUT = 16 * 1024

interface LoginState {
  child: ChildProcess
  /** 还没有换行的尾部 */
  buf: string
  /** 已经推给渲染层的输出（capped） */
  log: string
  url: string | null
  openedUrl: string | null
  phase: ClaudeLoginPhase
  exited: boolean
  done: boolean
  timer: NodeJS.Timeout
  submitTimer: NodeJS.Timeout | null
  pollTimer: NodeJS.Timeout
  polling: boolean
}

type Sink = (e: ClaudeAuthEvent) => void

let sink: Sink = () => undefined
let openExternal: (url: string) => void = () => undefined
let login: LoginState | null = null
let logoutRunning = false
let disposed = false

/** 由 index.ts 在 ready 时注入事件出口与"打开浏览器"能力 */
export function initClaudeAuth(opts: {
  emit: Sink
  openUrl?: (url: string) => void
}): void {
  sink = opts.emit
  if (opts.openUrl) openExternal = opts.openUrl
}

function emit(e: ClaudeAuthEvent): void {
  sink(e)
}

/* ── 状态探测 ───────────────────────────────────────────── */

interface ExecResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  error?: string
}

/**
 * 跑一次 CLI 命令并收集输出。
 *
 * 认证命令统一用 cleanProviderEnv()：宿主环境里可能残留 ANTHROPIC_BASE_URL /
 * API key，那会让 `auth status` 报成 api_key，也会干扰 login 的目标端点。
 */
function execClaude(args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawnClaudeBin(args, { env: cleanProviderEnv(), cwd: homedir() })
    } catch (err) {
      resolve({ stdout: '', stderr: '', code: null, timedOut: false, error: String(err) })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, timeoutMs)

    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    child.stdin?.on('error', () => undefined)
    // auth 子命令都不读 stdin；关掉，免得 CLI 以为还有输入
    try {
      child.stdin?.end()
    } catch {
      // 已经关了
    }

    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code: null, timedOut, error: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code, timedOut })
    })
  })
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const stripAnsi = (s: string): string => s.replace(ANSI, '')

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function firstStr(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

/**
 * 把 `claude auth status --json` 的原始对象解析成界面用的形状。
 *
 * CLI 各版本的账号字段并不统一（顶层 / account / user / oauthAccount 都见过），
 * 所以这里按候选键逐个找；找不到就留空，绝不猜。
 */
export function parseClaudeAuthStatus(raw: Record<string, unknown> | null): {
  loggedIn: boolean
  authMethod: string
  apiProvider: string
  email?: string
  organizationName?: string
  subscriptionType?: string
} {
  if (!raw) {
    return { loggedIn: false, authMethod: '', apiProvider: '' }
  }

  const authMethod = str(raw.authMethod) || str(raw.auth_method)
  const loggedIn =
    raw.loggedIn === true ||
    raw.loggedIn === 'true' ||
    (raw.loggedIn === undefined && authMethod !== '' && authMethod !== 'none')

  const account =
    (raw.account && typeof raw.account === 'object' ? raw.account : null) ??
    (raw.user && typeof raw.user === 'object' ? raw.user : null) ??
    (raw.oauthAccount && typeof raw.oauthAccount === 'object' ? raw.oauthAccount : null) ??
    raw

  const acc = account as Record<string, unknown>
  // 账号字段可能嵌在 account/user 里，也可能直接放在顶层 —— 两边都找
  const pick = (keys: string[]): string | undefined => firstStr(acc, keys) ?? firstStr(raw, keys)
  return {
    loggedIn,
    authMethod: authMethod || 'none',
    apiProvider: str(raw.apiProvider) || str(raw.api_provider),
    email: pick(['email', 'emailAddress', 'accountEmail']),
    organizationName: pick(['organizationName', 'organization', 'orgName']),
    subscriptionType: pick(['subscriptionType', 'subscription', 'planType', 'plan', 'tier'])
  }
}

export async function probeClaudeAuth(): Promise<ClaudeAuthStatus> {
  const path = resolveClaudeBin()
  const checkedAt = Date.now()
  if (!existsSync(path)) {
    return {
      installed: false,
      path,
      loggedIn: false,
      authMethod: 'none',
      checkedAt
    }
  }

  const [ver, st] = await Promise.all([
    execClaude(['--version'], VERSION_TIMEOUT_MS),
    execClaude(['auth', 'status', '--json'], STATUS_TIMEOUT_MS)
  ])
  const version = stripAnsi(ver.stdout).trim().split(/\r?\n/)[0]?.trim() || undefined

  const out = stripAnsi(st.stdout)
  let raw: Record<string, unknown> | null = lastJson(out)
  if (!raw) {
    try {
      const v = JSON.parse(out.trim()) as unknown
      if (v && typeof v === 'object' && !Array.isArray(v)) raw = v as Record<string, unknown>
    } catch {
      // 解析不了就是解析不了，下面会给错误原文
    }
  }

  const parsed = parseClaudeAuthStatus(raw)
  const failure =
    !raw && (st.timedOut || st.error || st.code !== 0 || st.stderr.trim() || out.trim())
      ? [
          st.timedOut ? '读取登录状态超时' : '',
          st.error ?? '',
          st.code !== 0 ? `退出码 ${st.code}` : '',
          st.stderr.trim().slice(-400),
          out.trim().slice(-400)
        ]
          .filter(Boolean)
          .join('\n')
      : undefined

  return {
    installed: true,
    path,
    version,
    loggedIn: parsed.loggedIn,
    authMethod: parsed.authMethod,
    apiProvider: parsed.apiProvider || undefined,
    email: parsed.email,
    organizationName: parsed.organizationName,
    subscriptionType: parsed.subscriptionType,
    error: failure,
    checkedAt
  }
}

/* ── 登录 URL ───────────────────────────────────────────── */

const AUTH_HOSTS = ['claude.com', 'claude.ai', 'anthropic.com']

function allowedAuthHost(host: string): boolean {
  const h = host.toLowerCase()
  return AUTH_HOSTS.some((base) => h === base || h.endsWith(`.${base}`))
}

/**
 * 从 CLI 输出里认出授权 URL。
 *
 * 只认 https + Anthropic 自家域名 —— 这串 URL 会被交给系统浏览器，
 * 不能变成一个"随便打开什么"的通道。行尾常见的 `).,;` 一并去掉。
 */
export function parseClaudeAuthUrl(text: string): string | null {
  const re = /https:\/\/[^\s<>"']+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const raw = m[0].replace(/[).,;!?]+$/g, '')
    try {
      const u = new URL(raw)
      if (u.protocol === 'https:' && allowedAuthHost(u.hostname)) return u.toString()
    } catch {
      // 不完整的 URL，继续找下一个
    }
  }
  return null
}

/* ── 登录状态机 ─────────────────────────────────────────── */

function setPhase(phase: ClaudeLoginPhase, message?: string): void {
  if (!login) return
  login.phase = phase
  emit({ t: 'phase', phase, message })
}

function pushOutput(text: string): void {
  if (!login) return
  login.log = (login.log + text).slice(-MAX_OUTPUT)
  emit({ t: 'output', text })
}

function noteUrl(text: string): void {
  if (!login || login.url) return
  const url = parseClaudeAuthUrl(text)
  if (!url) return
  login.url = url
  emit({ t: 'url', url })
  setPhase('waiting')
  if (login.openedUrl !== url) {
    login.openedUrl = url
    openExternal(url)
  }
}

function onOutput(chunk: string): void {
  if (!login || login.done) return
  const text = stripAnsi(chunk)
  pushOutput(text)

  login.buf += text
  const lines = login.buf.split(/\r?\n/)
  login.buf = lines.pop() ?? ''

  for (const line of lines) {
    noteUrl(line)
    // 授权码提示可能没有换行（"Paste code here if prompted > "）
    if (/paste\s+code/i.test(line) && login.phase !== 'verifying') setPhase('waiting')
  }
  // 尾部没有换行的提示也要认（"Paste code here if prompted > "）
  // URL 只从完整行里认 —— 半截 URL 也可能通过 new URL() 校验，打开它没有意义。
  if (/paste\s+code/i.test(login.buf) && login.phase !== 'verifying') setPhase('waiting')
}

function clearTimers(l: LoginState): void {
  clearTimeout(l.timer)
  clearInterval(l.pollTimer)
  if (l.submitTimer) clearTimeout(l.submitTimer)
}

async function finishLogin(
  phase: ClaudeLoginPhase,
  message?: string
): Promise<void> {
  const cur = login
  if (!cur || cur.done) return
  cur.done = true
  clearTimers(cur)
  login = null
  if (!cur.exited) killProcessTree(cur.child)

  emit({ t: 'phase', phase, message })
  // 取消不需要刷新状态；成功/失败都以 CLI 的真实状态为准
  if (phase !== 'cancelled') {
    const status = await probeClaudeAuth()
    emit({ t: 'status', status })
    if (phase === 'success' && !status.loggedIn) {
      emit({
        t: 'phase',
        phase: 'failed',
        message: '登录命令已结束，但没有检测到登录状态。请重试，或检查浏览器里是否完成授权。'
      })
    }
  }
}

export function startClaudeLogin(): ClaudeAuthResult {
  if (disposed) return { ok: false, message: '应用正在退出' }
  if (login) return { ok: false, message: '登录流程已经进行中' }
  if (logoutRunning) return { ok: false, message: '正在退出登录，请稍候' }

  const path = resolveClaudeBin()
  if (!existsSync(path)) {
    return { ok: false, message: '没有找到 claude 可执行文件，请先安装 Claude Code' }
  }

  let child: ChildProcess
  try {
    child = spawnClaudeBin(['auth', 'login'], {
      // BROWSER=echo 让 CLI 只打印链接，不自己开浏览器；由宿主打开一次，
      // 避免两个窗口同时弹出来。
      env: { ...cleanProviderEnv(), BROWSER: 'echo' },
      cwd: homedir()
    })
  } catch (err) {
    return { ok: false, message: `无法启动登录命令：${String(err)}` }
  }

  const state: LoginState = {
    child,
    buf: '',
    log: '',
    url: null,
    openedUrl: null,
    phase: 'starting',
    exited: false,
    done: false,
    timer: setTimeout(() => {
      void finishLogin('failed', '登录超时（10 分钟），请重试')
    }, LOGIN_TIMEOUT_MS),
    submitTimer: null,
    pollTimer: setInterval(() => {
      void pollLoginStatus()
    }, 2000),
    polling: false
  }
  login = state
  emit({ t: 'phase', phase: 'starting' })

  child.stdout?.on('data', (d: Buffer) => onOutput(d.toString()))
  child.stderr?.on('data', (d: Buffer) => onOutput(d.toString()))
  child.stdin?.on('error', () => undefined)

  child.on('error', (err) => {
    void finishLogin('failed', err.message)
  })
  child.on('close', (code) => {
    if (!login || login.done) return
    state.exited = true
    if (code === 0) {
      void finishLogin('success')
    } else {
      void finishLogin('failed', `登录命令退出码 ${code}`)
    }
  })

  return { ok: true }
}

/**
 * 兜底：某些版本可能在浏览器回调完成后不退出，只是把授权码流程走完了。
 * 每 2 秒探一次状态；确认已登录就收掉等待中的进程。
 */
async function pollLoginStatus(): Promise<void> {
  const cur = login
  if (!cur || cur.done || cur.polling) return
  /*
   * 只在"授权码已提交、等校验"时探。
   *
   * 提前探会有两个假阳性：本来就已经登录（想换账号时会立刻被判定成功），
   * 以及用户还在浏览器里操作。进程自己退出仍然由 close 处理。
   */
  if (!cur.url || cur.phase !== 'verifying') return
  cur.polling = true
  try {
    const st = await probeClaudeAuth()
    if (login === cur && !cur.done && st.loggedIn) {
      await finishLogin('success')
    }
  } finally {
    cur.polling = false
  }
}

export function submitClaudeLoginCode(code: string): ClaudeAuthResult {
  const cur = login
  if (!cur || cur.done) return { ok: false, message: '当前没有进行中的登录流程' }
  const raw = typeof code === 'string' ? code : ''
  if (!raw.trim()) return { ok: false, message: '授权码为空' }
  if (raw.length > 8192) return { ok: false, message: '授权码过长' }

  // 复制来的授权码可能带换行/空格；CLI 只认一整串
  const normalized = raw.replace(/\s+/g, '')
  try {
    cur.child.stdin?.write(`${normalized}\n`)
  } catch {
    return { ok: false, message: '登录进程已经结束，请重新发起登录' }
  }

  if (!cur.submitTimer) {
    cur.submitTimer = setTimeout(() => {
      void finishLogin('failed', '授权码校验超时，请重新登录')
    }, SUBMIT_TIMEOUT_MS)
  }
  setPhase('verifying')
  return { ok: true }
}

export function cancelClaudeLogin(): ClaudeAuthResult {
  const cur = login
  if (!cur || cur.done) return { ok: true }
  cur.done = true
  cur.exited = false
  clearTimers(cur)
  login = null
  killProcessTree(cur.child)
  emit({ t: 'phase', phase: 'cancelled' })
  return { ok: true }
}

export async function logoutClaude(): Promise<ClaudeAuthResult> {
  if (login) return { ok: false, message: '请先取消当前登录流程' }
  if (logoutRunning) return { ok: false, message: '正在退出登录，请稍候' }

  logoutRunning = true
  try {
    const r = await execClaude(['auth', 'logout'], 20_000)
    const status = await probeClaudeAuth()
    emit({ t: 'status', status })

    if (!status.loggedIn) {
      return { ok: true, message: r.code === 0 ? undefined : '已经处于未登录状态' }
    }
    return {
      ok: false,
      message: [
        r.timedOut ? '退出登录超时' : '',
        r.error ?? '',
        r.code !== 0 ? `退出码 ${r.code}` : '',
        stripAnsi(r.stderr).trim().slice(-400)
      ]
        .filter(Boolean)
        .join('\n') || '退出登录失败'
    }
  } finally {
    logoutRunning = false
  }
}

/* ── 重开设置页时恢复 ───────────────────────────────────── */

export function claudeLoginSnapshot(): ClaudeLoginSnapshot {
  return {
    phase: login?.phase ?? 'idle',
    url: login?.url ?? null,
    running: !!login,
    output: login?.log ?? ''
  }
}

export function disposeClaudeAuth(): void {
  disposed = true
  const cur = login
  if (!cur) return
  cur.done = true
  clearTimers(cur)
  login = null
  killProcessTree(cur.child)
}
