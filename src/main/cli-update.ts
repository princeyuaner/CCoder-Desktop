import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, writeFileSync, rmSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { CLI_IDS, type CliId } from '../shared/settings'
import type {
  CliInstallKind,
  CliUpdateEvent,
  CliUpdateRunResult,
  CliUpdateState,
  CliUpdateStates
} from '../shared/cli-update'
import { t } from './i18n'
import { killProcessTree } from './kill-process'
import { cleanProviderEnv, resolveClaudeBin, spawnClaudeBin } from './claude-runner'
import { resolveCodexBin, spawnCodex, stripAnsi } from './codex-runner'
import { resolveDshBinJs, resolveNodeBin } from './providers/dsh/runner'

/**
 * CLI 自身的版本检查与更新。
 *
 * 边界写死在这里，别的地方不要另起一套：
 *  - 只**读** npm registry 的版本号，检查不产生任何安装行为；
 *  - 只有确认是「npm 全局安装」的 CLI 才提供自动更新，其余降级成复制命令；
 *  - 更新永远由用户点击触发，不做静默升级；
 *  - 更新进程归主进程所有，设置页只是它的一层视图（关掉设置页不会中断）。
 *
 * 不直接 import electron：事件出口由 index.ts 注入，这个模块可以单独
 * 打包跑验证脚本。
 */

const IS_WIN = process.platform === 'win32'

/** 每个 CLI 对应的 npm 包与更新说明页 */
export const CLI_PACKAGES: Record<CliId, { pkg: string; notes?: string }> = {
  claude: {
    pkg: '@anthropic-ai/claude-code',
    notes: 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md'
  },
  codex: {
    pkg: '@openai/codex',
    notes: 'https://github.com/openai/codex/releases'
  },
  dsh: {
    pkg: '@deepseek-ai/dsh',
    notes: 'https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions'
  }
}

/** 一块儿检查结果的新鲜度：6 小时内不重复问 registry */
const CHECK_TTL_MS = 6 * 60 * 60_000
/** registry 版本号缓存 */
const REGISTRY_TTL_MS = 6 * 60 * 60_000
/** npm 环境（全局目录 / registry）缓存 */
const NPM_ENV_TTL_MS = 10 * 60_000
const AUTO_INTERVAL_MS = 6 * 60 * 60_000
/** 启动后晚一点再查，别跟窗口创建抢 I/O */
const AUTO_FIRST_DELAY_MS = 20_000
const AUTO_GAP_MS = 1_500

const VERSION_TIMEOUT_MS = 8_000
const DSH_VERSION_TIMEOUT_MS = 15_000
const NPM_TIMEOUT_MS = 20_000
const REGISTRY_TIMEOUT_MS = 8_000
const UPDATE_TIMEOUT_MS = 10 * 60_000
const ELEVATED_TIMEOUT_MS = 3 * 60_000
const ELEVATED_POLL_MS = 3_000
const MAX_LOG = 4 * 1024

/* ── 纯函数（验证脚本直接测这些） ─────────────────────────── */

const SEMVER_RE = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)\b/

/** 从 `claude --version` 这类输出里抓第一个 x.y.z；抓不到返回 undefined */
export function parseVersion(text: string): string | undefined {
  const m = SEMVER_RE.exec(stripAnsi(text))
  return m?.[1]
}

/**
 * 比较两个 x.y.z（可带 -pre）。
 * 返回 <0 / 0 / >0，语义同 subtraction；正式版永远大于同号预发布版。
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { nums: number[]; pre: string } => {
    const dash = v.indexOf('-')
    const core = dash >= 0 ? v.slice(0, dash) : v
    const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0)
    while (nums.length < 3) nums.push(0)
    return { nums, pre: dash >= 0 ? v.slice(dash + 1) : '' }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1
  }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre < y.pre ? -1 : 1
}

/** child 是否在 parent 目录里（大小写不敏感，Windows 语义） */
export function isUnder(child: string, parent: string): boolean {
  const a = resolve(child).toLowerCase()
  const b = resolve(parent).toLowerCase()
  if (a === b) return true
  return a.startsWith(b.endsWith(sep) ? b : b + sep)
}

/** `<prefix>/node_modules` → `<prefix>`；POSIX 的 `<prefix>/lib/node_modules` 同理 */
export function nodeModulesPrefix(root: string): string {
  const parent = dirname(root)
  return basename(parent).toLowerCase() === 'lib' ? dirname(parent) : parent
}

/**
 * 判定安装来源。
 *
 * 两个条件都要满足才算 npm 全局：
 *  1. 对应的包真的在那个全局 `node_modules` 里；
 *  2. 可执行文件落在同一个 prefix 下（防止「包在 A 目录、跑的是 B 目录的 exe」）。
 */
export function guessInstallKind(
  binPath: string | undefined,
  nodeModulesRoots: string[],
  pkg: string
): CliInstallKind {
  if (!binPath || !existsSync(binPath)) return 'missing'
  const pkgDir = (...parts: string[]): string => join(...parts)
  for (const root of nodeModulesRoots) {
    const installed = pkgDir(root, ...pkg.split('/'))
    if (!existsSync(installed)) continue
    // dsh 的可执行入口就是包里的 lib/bin.js
    if (isUnder(binPath, installed)) return 'npm-global'
    if (isUnder(binPath, nodeModulesPrefix(root))) return 'npm-global'
  }
  return 'other'
}

/** 安装命令（展示与复制都用它） */
export function installCommand(pkg: string, version: string): string {
  return `npm install -g ${pkg}@${version}`
}

/** npm 输出里挑一行给人看：去掉进度条、空行和 deprecate 噪音 */
export function lastMeaningfulLine(text: string): string | undefined {
  const lines = stripAnsi(text)
    .split(/\r\n|\n|\r/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^npm (warn|notice) /i.test(l))
  return lines.length > 0 ? lines[lines.length - 1] : undefined
}

/* ── 进程工具 ─────────────────────────────────────────────── */

function quoteWin(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`
}

interface CaptureResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  error?: string
}

function capture(child: ChildProcess, timeoutMs: number): Promise<CaptureResult> {
  return new Promise((settle) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, timeoutMs)

    child.stdout?.on('data', (d: Buffer) => {
      stdout = (stdout + d.toString()).slice(-MAX_LOG * 4)
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-MAX_LOG * 4)
    })
    child.stdin?.on('error', () => undefined)
    try {
      child.stdin?.end()
    } catch {
      // 已经关了
    }

    child.on('error', (err) => {
      clearTimeout(timer)
      settle({ stdout, stderr, code: null, timedOut, error: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      settle({ stdout, stderr, code, timedOut })
    })
  })
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let cachedNpm: string | null = null

/** 找 npm 可执行文件。Windows 上必须是 .cmd，且只能经 shell 启动 */
function resolveNpmBin(): string {
  if (cachedNpm) return cachedNpm
  const names = IS_WIN ? ['npm.cmd', 'npm.exe', 'npm'] : ['npm']
  const dirs = (process.env.PATH ?? '')
    .split(IS_WIN ? ';' : ':')
    .map((s) => s.trim())
    .filter(Boolean)
  if (IS_WIN && process.env.ProgramFiles) dirs.push(join(process.env.ProgramFiles, 'nodejs'))
  for (const dir of dirs) {
    for (const name of names) {
      const p = join(dir, name)
      try {
        if (existsSync(p)) return (cachedNpm = p)
      } catch {
        // 单个目录不可读就跳过
      }
    }
  }
  return (cachedNpm = IS_WIN ? 'npm.cmd' : 'npm')
}

function spawnNpm(args: string[]): ChildProcess {
  const npm = resolveNpmBin()
  const opts = { env: process.env, cwd: homedir(), windowsHide: true }
  return IS_WIN
    ? spawn([quoteWin(npm), ...args.map(quoteWin)].join(' '), { ...opts, shell: true })
    : spawn(npm, args, opts)
}

/* ── npm 环境：全局目录 + registry ────────────────────────── */

interface NpmEnv {
  roots: string[]
  registry: string
}

let npmEnvCache: (NpmEnv & { at: number }) | null = null

function staticGlobalRoots(): string[] {
  const out: string[] = []
  const add = (p: string | undefined): void => {
    if (p) out.push(join(p, 'node_modules'))
  }
  if (IS_WIN) {
    add(process.env.APPDATA ? join(process.env.APPDATA, 'npm') : undefined)
    add(process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'npm') : undefined)
    add(process.env.ProgramFiles ? join(process.env.ProgramFiles, 'nodejs') : undefined)
  } else {
    out.push('/usr/local/lib/node_modules', '/opt/homebrew/lib/node_modules', '/usr/lib/node_modules')
    out.push(join(homedir(), '.npm-global', 'lib', 'node_modules'))
  }
  return out
}

function firstHttpLine(text: string): string {
  const line = stripAnsi(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^https?:\/\//i.test(l))
  return line ? line.replace(/\/+$/, '') : ''
}

async function npmEnvironment(): Promise<NpmEnv> {
  const cached = npmEnvCache
  if (cached && Date.now() - cached.at < NPM_ENV_TTL_MS) return cached
  const [root, registry] = await Promise.all([
    capture(spawnNpm(['root', '-g']), NPM_TIMEOUT_MS),
    capture(spawnNpm(['config', 'get', 'registry']), NPM_TIMEOUT_MS)
  ])
  const roots = new Set<string>(staticGlobalRoots())
  if (root.code === 0) {
    const line = stripAnsi(root.stdout).split(/\r?\n/).map((l) => l.trim()).find(Boolean)
    if (line && /^[A-Za-z]:[\\/]|^\//.test(line)) roots.add(resolve(line))
  }
  const reg = registry.code === 0 ? firstHttpLine(registry.stdout) : ''
  npmEnvCache = {
    roots: [...roots],
    registry: reg || 'https://registry.npmjs.org',
    at: Date.now()
  }
  return npmEnvCache
}

interface LatestInfo {
  version: string
  publishedAt?: number
}

const latestCache = new Map<string, { info: LatestInfo; at: number }>()

function fetchJson(url: string, timeoutMs: number, depth = 0): Promise<unknown> {
  return new Promise((settle, fail) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      fail(new Error(`bad url: ${url}`))
      return
    }
    const mod = parsed.protocol === 'http:' ? httpGet : httpsGet
    const req = mod(
      parsed,
      { headers: { accept: 'application/json', 'user-agent': 'CCoder' } },
      (res) => {
        const status = res.statusCode ?? 0
        const location = res.headers.location
        if (status >= 300 && status < 400 && location && depth < 3) {
          res.resume()
          const next = new URL(location, parsed).toString()
          void fetchJson(next, timeoutMs, depth + 1).then(settle, fail)
          return
        }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body = (body + chunk).slice(-2_000_000)
        })
        res.on('end', () => {
          if (status < 200 || status >= 300) {
            fail(new Error(`HTTP ${status}`))
            return
          }
          try {
            settle(JSON.parse(body))
          } catch {
            fail(new Error('registry 返回了无法解析的内容'))
          }
        })
      }
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error('连接超时')))
    req.on('error', fail)
  })
}

/**
 * 问 registry 要最新版。
 *
 * 网络失败时退回上一次的结果（标记 stale），这样离线时界面还能显示已知版本，
 * 而不是把整张卡变成错误态。
 */
async function latestVersion(
  pkg: string
): Promise<{ info?: LatestInfo; error?: string; stale?: boolean }> {
  const cached = latestCache.get(pkg)
  if (cached && Date.now() - cached.at < REGISTRY_TTL_MS) return { info: cached.info }

  const { registry } = await npmEnvironment()
  const url = `${registry}/${encodeURIComponent(pkg)}/latest`
  try {
    const raw = (await fetchJson(url, REGISTRY_TIMEOUT_MS)) as {
      version?: unknown
      time?: unknown
    } | null
    const version = typeof raw?.version === 'string' ? parseVersion(raw.version) : undefined
    if (!version) {
      if (cached) return { info: cached.info, stale: true, error: `registry 没有返回版本号：${url}` }
      return { error: `registry 没有返回版本号：${url}` }
    }
    const publishedAt =
      typeof raw?.time === 'string' ? Date.parse(raw.time) || undefined : undefined
    const info: LatestInfo = { version, publishedAt }
    latestCache.set(pkg, { info, at: Date.now() })
    return { info }
  } catch (e) {
    const message = `${errText(e)}（${url}）`
    if (cached) return { info: cached.info, stale: true, error: message }
    return { error: message }
  }
}

/* ── 当前安装的版本 ───────────────────────────────────────── */

interface Probe {
  installed: boolean
  path?: string
  version?: string
  raw?: string
  error?: string
}

function probeFrom(bin: string, r: CaptureResult): Probe {
  const text = stripAnsi(`${r.stdout}\n${r.stderr}`)
  const first = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)[0]
  const version = first ? parseVersion(first) : undefined
  const failed = r.error || r.timedOut || (r.code !== null && r.code !== 0)
  return {
    installed: true,
    path: bin,
    version,
    raw: first || undefined,
    error: failed ? (r.error ?? (r.timedOut ? '版本命令超时' : `退出码 ${r.code ?? 'signal'}`)) : undefined
  }
}

async function probeInstall(cli: CliId): Promise<Probe> {
  if (cli === 'claude') {
    const bin = resolveClaudeBin()
    if (!existsSync(bin)) return { installed: false, path: bin }
    return probeFrom(
      bin,
      await capture(spawnClaudeBin(['--version'], { env: cleanProviderEnv(), cwd: homedir() }), VERSION_TIMEOUT_MS)
    )
  }
  if (cli === 'codex') {
    const bin = resolveCodexBin()
    if (!existsSync(bin)) return { installed: false, path: bin }
    return probeFrom(bin, await capture(spawnCodex(['--version'], { cwd: homedir() }), VERSION_TIMEOUT_MS))
  }
  const binJs = resolveDshBinJs()
  if (!binJs) return { installed: false, path: 'dsh' }
  const node = resolveNodeBin()
  const child = spawn(node, [binJs, '--version'], {
    env: process.env,
    cwd: homedir(),
    windowsHide: true
  })
  return probeFrom(binJs, await capture(child, DSH_VERSION_TIMEOUT_MS))
}

/* ── 状态 ─────────────────────────────────────────────────── */

function initialState(cli: CliId): CliUpdateState {
  return {
    cli,
    phase: 'unknown',
    packageName: CLI_PACKAGES[cli].pkg,
    notesUrl: CLI_PACKAGES[cli].notes,
    installed: false,
    installKind: 'missing',
    canUpdate: false
  }
}

function emptyStates(): CliUpdateStates {
  const out = {} as CliUpdateStates
  for (const cli of CLI_IDS) out[cli] = initialState(cli)
  return out
}

let states: CliUpdateStates = emptyStates()
let emit: (e: CliUpdateEvent) => void = () => undefined
const checking = new Set<CliId>()
let disposed = false

/** 正在进行的命令更新（含提权） */
interface RunningUpdate {
  cli: CliId
  child: ChildProcess | null
  target: string
  startedAt: number
  timer: NodeJS.Timeout
  poll: NodeJS.Timeout | null
  cancelled: boolean
  elevated: boolean
  log: string
}

let running: RunningUpdate | null = null

function setState(cli: CliId, patch: Partial<CliUpdateState>): CliUpdateState {
  const next: CliUpdateState = { ...states[cli], ...patch, cli, packageName: CLI_PACKAGES[cli].pkg }
  states = { ...states, [cli]: next }
  if (!disposed) emit({ t: 'state', state: next })
  return next
}

export function initCliUpdate(opts: { emit: (e: CliUpdateEvent) => void }): void {
  emit = opts.emit
  disposed = false
  states = emptyStates()
}

export function cliUpdateStates(): CliUpdateStates {
  return states
}

/* ── 检查 ─────────────────────────────────────────────────── */

/**
 * 检查一个 CLI 有没有新版。
 *
 * 6 小时内已经查过就直接返回缓存（`force` 跳过这个判断）—— 设置页来回切换
 * 不该反复起 npm 进程。检查失败不清空已知的版本信息。
 */
export async function checkCliUpdate(
  cli: CliId,
  opts: { force?: boolean } = {}
): Promise<CliUpdateState> {
  if (disposed || checking.has(cli) || running?.cli === cli) return states[cli]

  const prev = states[cli]
  const fresh = prev.checkedAt !== undefined && Date.now() - prev.checkedAt < CHECK_TTL_MS
  const settled = prev.phase === 'up-to-date' || prev.phase === 'available' || prev.phase === 'done'
  if (!opts.force && fresh && settled) return prev

  checking.add(cli)
  setState(cli, { phase: 'checking', error: undefined, errorScope: undefined, needAdmin: undefined })
  try {
    const probe = await probeInstall(cli)
    if (!probe.installed) {
      return setState(cli, {
        phase: 'unknown',
        installed: false,
        path: probe.path,
        current: undefined,
        currentRaw: undefined,
        latest: undefined,
        installKind: 'missing',
        canUpdate: false,
        command: undefined,
        fromCache: false,
        checkedAt: Date.now()
      })
    }

    const { roots } = await npmEnvironment()
    const installKind = guessInstallKind(probe.path, roots, CLI_PACKAGES[cli].pkg)
    const latest = await latestVersion(CLI_PACKAGES[cli].pkg)

    if (!latest.info) {
      return setState(cli, {
        phase: 'error',
        errorScope: 'check',
        installed: true,
        path: probe.path,
        current: probe.version,
        currentRaw: probe.raw,
        installKind,
        canUpdate: false,
        command: undefined,
        error: latest.error ?? t('cliUpdate.checkFailedMeta'),
        fromCache: false,
        checkedAt: Date.now()
      })
    }

    if (!probe.version) {
      return setState(cli, {
        phase: 'error',
        errorScope: 'check',
        installed: true,
        path: probe.path,
        currentRaw: probe.raw,
        latest: latest.info.version,
        installKind,
        canUpdate: false,
        command: undefined,
        error: t('cliUpdate.versionUnparsed', { raw: probe.raw ?? '—' }),
        fromCache: latest.stale === true,
        checkedAt: Date.now()
      })
    }

    const newer = compareVersions(latest.info.version, probe.version) > 0
    const canUpdate = newer && installKind === 'npm-global'
    return setState(cli, {
      phase: newer ? 'available' : 'up-to-date',
      installed: true,
      path: probe.path,
      current: probe.version,
      currentRaw: probe.raw,
      latest: latest.info.version,
      publishedAt: latest.info.publishedAt,
      installKind,
      canUpdate,
      command: canUpdate ? installCommand(CLI_PACKAGES[cli].pkg, latest.info.version) : undefined,
      // 检查失败但用了缓存：留在正常态，只把原因挂上，界面标「离线」
      error: latest.error,
      errorScope: latest.error ? 'check' : undefined,
      fromCache: latest.stale === true,
      checkedAt: Date.now()
    })
  } catch (e) {
    return setState(cli, {
      phase: 'error',
      errorScope: 'check',
      error: errText(e),
      fromCache: false,
      checkedAt: Date.now()
    })
  } finally {
    checking.delete(cli)
  }
}

/* ── 更新 ─────────────────────────────────────────────────── */

function clearRunning(session: RunningUpdate): void {
  clearTimeout(session.timer)
  if (session.poll) clearInterval(session.poll)
  if (running === session) running = null
}

function failUpdate(session: RunningUpdate, error: string, needAdmin: boolean): void {
  clearRunning(session)
  setState(session.cli, {
    phase: 'error',
    errorScope: 'update',
    error,
    needAdmin,
    startedAt: undefined,
    line: undefined,
    elevated: undefined
  })
}

async function finishUpdate(
  session: RunningUpdate,
  code: number | null,
  spawnError?: string
): Promise<void> {
  if (running !== session) return
  clearRunning(session)
  if (session.cancelled) return

  if (code !== 0) {
    const tail = session.log.trim().slice(-3000)
    const needAdmin = /EPERM|EACCES|permission denied|access is denied|拒绝访问|操作不允许/i.test(
      session.log
    )
    failUpdate(
      session,
      tail || spawnError || t('cliUpdate.updateExit', { code: String(code ?? 'signal') }),
      needAdmin
    )
    return
  }

  const probe = await probeInstall(session.cli)
  const reached = probe.version ? compareVersions(probe.version, session.target) >= 0 : false
  if (!reached) {
    failUpdate(
      session,
      t('cliUpdate.elevateNoChange', {
        target: session.target,
        current: probe.version ?? probe.raw ?? '—'
      }),
      false
    )
    return
  }
  setState(session.cli, {
    phase: 'done',
    installed: true,
    current: probe.version,
    currentRaw: probe.raw,
    canUpdate: false,
    command: undefined,
    latest: session.target,
    startedAt: undefined,
    line: undefined,
    elevated: undefined,
    error: undefined,
    errorScope: undefined,
    needAdmin: undefined,
    checkedAt: Date.now()
  })
}

/**
 * 开始更新。命令与目标版本都取自上一次检查的结果 —— 不在这里重新算，
 * 免得用户点的「更新到 2.1.0」和实际装的东西不是一回事。
 */
export function startCliUpdate(cli: CliId): CliUpdateRunResult {
  if (disposed) return { ok: false, message: t('cliUpdate.quitting') }
  if (running) return { ok: false, message: t('cliUpdate.busy') }

  const st = states[cli]
  if (!st.installed) return { ok: false, message: t('cliUpdate.notInstalled') }
  if (st.phase !== 'available' || !st.canUpdate || !st.latest) {
    return { ok: false, message: t('cliUpdate.notAvailable') }
  }

  const target = st.latest
  const command = installCommand(CLI_PACKAGES[cli].pkg, target)
  let child: ChildProcess
  try {
    child = spawnNpm(['install', '-g', `${CLI_PACKAGES[cli].pkg}@${target}`, '--no-audit', '--no-fund'])
  } catch (e) {
    return { ok: false, message: errText(e) }
  }

  const session: RunningUpdate = {
    cli,
    child,
    target,
    startedAt: Date.now(),
    timer: setTimeout(() => {
      failUpdate(session, t('cliUpdate.updateTimeout'), false)
      if (child) killProcessTree(child)
    }, UPDATE_TIMEOUT_MS),
    poll: null,
    cancelled: false,
    elevated: false,
    log: ''
  }
  running = session

  setState(cli, {
    phase: 'updating',
    command,
    startedAt: session.startedAt,
    line: '',
    elevated: false,
    error: undefined,
    errorScope: undefined,
    needAdmin: undefined
  })

  const onData = (d: Buffer): void => {
    if (running !== session) return
    session.log = (session.log + d.toString()).slice(-MAX_LOG)
    const line = lastMeaningfulLine(d.toString())
    if (line) setState(cli, { line })
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  child.on('error', (err) => void finishUpdate(session, -1, err.message))
  child.on('close', (code) => void finishUpdate(session, code))

  return { ok: true }
}

/**
 * 以管理员身份重试（Windows）。
 *
 * 提权进程的输出在另一个控制台窗口里，我们看不到实时进度 —— 所以这里退一步：
 * 用临时 .cmd 在管理员窗口里跑 npm，然后轮询 `--version` 等版本真的变了。
 * 成功/失败都以版本为准，不以窗口是否关闭为准。
 */
export function retryCliUpdateElevated(cli: CliId): CliUpdateRunResult {
  if (disposed) return { ok: false, message: t('cliUpdate.quitting') }
  if (running) return { ok: false, message: t('cliUpdate.busy') }
  if (!IS_WIN) return { ok: false, message: t('cliUpdate.elevateWindowsOnly') }

  const st = states[cli]
  if (st.phase !== 'available' || !st.canUpdate || !st.latest) {
    return { ok: false, message: t('cliUpdate.notAvailable') }
  }

  const target = st.latest
  const script = join(tmpdir(), `ccoder-cli-update-${cli}-${Date.now()}.cmd`)
  try {
    writeFileSync(
      script,
      [
        '@echo off',
        `title CCoder - update ${cli}`,
        `npm install -g ${CLI_PACKAGES[cli].pkg}@${target} --no-audit --no-fund`,
        'if errorlevel 1 (',
        '  echo.',
        '  echo Update failed. The window stays open so you can read the error above.',
        '  pause',
        ')',
        ''
      ].join('\r\n'),
      'utf8'
    )
  } catch (e) {
    return { ok: false, message: errText(e) }
  }

  const psArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Start-Process -Verb RunAs -FilePath ${JSON.stringify(script)} -WindowStyle Normal`
  ]
  const launcher = spawn('powershell.exe', psArgs, { windowsHide: true })

  const session: RunningUpdate = {
    cli,
    child: launcher,
    target,
    startedAt: Date.now(),
    timer: setTimeout(() => {
      failUpdate(session, t('cliUpdate.elevateTimeout'), false)
    }, ELEVATED_TIMEOUT_MS),
    poll: null,
    cancelled: false,
    elevated: true,
    log: ''
  }
  running = session

  setState(cli, {
    phase: 'updating',
    command: installCommand(CLI_PACKAGES[cli].pkg, target),
    startedAt: session.startedAt,
    line: t('cliUpdate.elevatedRunning'),
    elevated: true,
    error: undefined,
    errorScope: undefined,
    needAdmin: undefined
  })

  void capture(launcher, 30_000).then((r) => {
    if (running !== session || session.cancelled) return
    if (r.code !== 0) {
      // 最常见的是用户点了「否」：UAC 被取消时 PowerShell 会报错退出
      failUpdate(session, (r.stderr || r.stdout).trim() || t('cliUpdate.elevateDenied'), false)
      rmSync(script, { force: true })
      return
    }
    session.poll = setInterval(() => void pollElevated(session, script), ELEVATED_POLL_MS)
  })

  return { ok: true }
}

async function pollElevated(session: RunningUpdate, script: string): Promise<void> {
  if (running !== session || session.cancelled) return
  const probe = await probeInstall(session.cli)
  if (running !== session || session.cancelled) return
  if (probe.version && compareVersions(probe.version, session.target) >= 0) {
    clearRunning(session)
    rmSync(script, { force: true })
    setState(session.cli, {
      phase: 'done',
      installed: true,
      current: probe.version,
      currentRaw: probe.raw,
      canUpdate: false,
      command: undefined,
      latest: session.target,
      startedAt: undefined,
      line: undefined,
      elevated: undefined,
      error: undefined,
      errorScope: undefined,
      needAdmin: undefined,
      checkedAt: Date.now()
    })
  }
}

export function cancelCliUpdate(): CliUpdateRunResult {
  const session = running
  if (!session) return { ok: true }
  session.cancelled = true
  clearRunning(session)
  if (session.child) killProcessTree(session.child)
  setState(session.cli, {
    phase: 'available',
    startedAt: undefined,
    line: undefined,
    elevated: undefined,
    error: undefined,
    errorScope: undefined,
    needAdmin: undefined
  })
  return { ok: true }
}

/* ── 定时检查 ─────────────────────────────────────────────── */

let autoCheckEnabled: () => boolean = () => true
let autoFirstTimer: NodeJS.Timeout | null = null
let autoTimer: NodeJS.Timeout | null = null
let autoRunning = false

async function checkAllInBackground(): Promise<void> {
  if (autoRunning || disposed || !autoCheckEnabled()) return
  autoRunning = true
  try {
    for (const cli of CLI_IDS) {
      if (disposed || !autoCheckEnabled()) return
      if (running?.cli === cli || checking.has(cli)) continue
      await checkCliUpdate(cli)
      await sleep(AUTO_GAP_MS)
    }
  } finally {
    autoRunning = false
  }
}

/**
 * 启动后台检查。启动后先等一会儿再查（别和窗口创建抢 I/O），之后每 6 小时一次。
 * 每次触发都重新问一遍开关，用户在设置里关掉就立刻生效。
 */
export function startCliUpdateAutoCheck(enabled: () => boolean): void {
  autoCheckEnabled = enabled
  autoFirstTimer = setTimeout(() => void checkAllInBackground(), AUTO_FIRST_DELAY_MS)
  autoFirstTimer.unref?.()
  autoTimer = setInterval(() => void checkAllInBackground(), AUTO_INTERVAL_MS)
  autoTimer.unref?.()
}

export function disposeCliUpdate(): void {
  disposed = true
  if (autoFirstTimer) clearTimeout(autoFirstTimer)
  if (autoTimer) clearInterval(autoTimer)
  autoFirstTimer = null
  autoTimer = null
  const session = running
  running = null
  if (!session) return
  clearTimeout(session.timer)
  if (session.poll) clearInterval(session.poll)
  if (session.child) killProcessTree(session.child)
}
