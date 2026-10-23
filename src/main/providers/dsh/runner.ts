import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { DshStatus } from '../../../shared/dsh'
import type { Channel } from '../../../shared/settings'

const IS_WIN = process.platform === 'win32'

/**
 * DeepSeek Harness（dsh）的进程封装。
 *
 * 关键事实（实测 0.2.1-rc.2）：
 *  - `dsh` 的 bin.js 用 `import.meta.main` 判断是否执行。Electron 33 内置的
 *    Node 20 没有这个属性，直接跑会**安静地退出 0**；必须用系统 Node 24+。
 *  - 所以这里不 spawn `dsh.cmd`（它依赖系统 node），而是解析 npm 全局包里的
 *    `node_modules/@deepseek-ai/dsh/lib/bin.js`，再用系统 node 拉起来。
 *  - 不内嵌 `~/.dsh`：文档明确要求显式 DSH_HOME，SDK 也从不自动发现它。
 */

let cachedNode: string | null = null
let cachedBinJs: string | null | undefined
let cachedNodeOk: boolean | undefined

function pathDirs(): string[] {
  return (process.env.PATH ?? '')
    .split(IS_WIN ? ';' : ':')
    .map((s) => s.trim())
    .filter(Boolean)
}

function defaultPrefixDirs(): string[] {
  const dirs: string[] = []
  if (IS_WIN) {
    if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'npm'))
    if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, 'npm'))
    if (process.env.ProgramFiles) dirs.push(join(process.env.ProgramFiles, 'nodejs'))
    if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, 'Programs', 'nodejs'))
  } else {
    dirs.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin')
  }
  return dirs
}

/** 从 `dsh.cmd` / `dsh` 这类入口反推出真正的 bin.js */
function binJsFromEntry(entry: string): string | null {
  const p = entry.trim()
  if (!p) return null

  // 直接给的就是 bin.js
  if (/\.(m?js)$/i.test(p)) return existsSync(p) ? p : null

  const dir = dirname(p)

  // npm 全局包：<prefix>/node_modules/@deepseek-ai/dsh/lib/bin.js
  const nearby = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(nearby)) return nearby

  // POSIX prefix/bin 布局：<prefix>/bin/dsh → <prefix>/lib/node_modules/...
  const prefix = join(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(prefix)) return prefix

  // POSIX 上 `dsh` 通常是指向 bin.js 的符号链接
  if (!IS_WIN) {
    try {
      const real = realpathSync(p)
      if (/\.(m?js)$/i.test(real) && existsSync(real)) return real
    } catch {
      // 不是符号链接或路径不可读
    }
  }

  return null
}

/** 解析 dsh 的 bin.js；找不到返回 null */
export function resolveDshBinJs(): string | null {
  if (cachedBinJs !== undefined) return cachedBinJs

  const override = process.env.DSH_BIN?.trim()
  if (override) {
    const fromOverride = binJsFromEntry(override)
    if (fromOverride) return (cachedBinJs = fromOverride)
    // 显式指定了但解析不出来：不要悄悄退回别的安装，交给调用方报错
    return (cachedBinJs = null)
  }

  for (const dir of [...defaultPrefixDirs(), ...pathDirs()]) {
    const candidates = [
      join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      join(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    ]
    for (const c of candidates) {
      if (existsSync(c)) return (cachedBinJs = c)
    }
    for (const name of IS_WIN ? ['dsh.cmd', 'dsh.ps1', 'dsh'] : ['dsh']) {
      const entry = join(dir, name)
      if (!existsSync(entry)) continue
      const derived = binJsFromEntry(entry)
      if (derived) return (cachedBinJs = derived)
    }
  }

  return (cachedBinJs = null)
}

/** 解析用来跑 bin.js 的系统 node。Electron 自带的 Node 20 不行。 */
export function resolveNodeBin(): string {
  if (cachedNode) return cachedNode

  const override = process.env.NODE_BIN?.trim()
  if (override && existsSync(override)) return (cachedNode = override)

  const names = IS_WIN ? ['node.exe', 'node.cmd'] : ['node']
  const dirs = [...defaultPrefixDirs(), ...pathDirs()]
  for (const dir of dirs) {
    for (const name of names) {
      const p = join(dir, name)
      if (existsSync(p)) return (cachedNode = p)
    }
  }

  // 最后的兜底：开发时 process.execPath 就是 node；生产环境是 electron.exe，
  // 会在 nodeSupportsImportMetaMain 里被明确拒绝，而不是静默跑挂。
  return (cachedNode = process.execPath)
}

/**
 * dsh 的 bin.js 靠 `import.meta.main` 自启动。Node 20 没有这个属性，
 * 进程会静默退出 0 —— 这是最容易被误判成“启动成功”的坑，必须先探一次。
 */
export function nodeSupportsImportMetaMain(node = resolveNodeBin()): boolean {
  if (cachedNodeOk !== undefined) return cachedNodeOk
  try {
    execFileSync(
      node,
      ['--input-type=module', '-e', 'process.exit(import.meta.main === true ? 0 : 1)'],
      { timeout: 5_000, stdio: 'ignore', windowsHide: true }
    )
    cachedNodeOk = true
  } catch {
    cachedNodeOk = false
  }
  return cachedNodeOk
}

/**
 * 设置页 / 会话启动前的安装探测。
 *
 * 传了 channelId 就显示该渠道自己的 home —— 和实际跑会话的目录保持一致，
 * 免得设置页写着 `~/.dsh`、请求却来自 `dsh-homes/<id>`。
 */
export function checkDshStatus(channelId?: string | null): DshStatus {
  const checkedAt = Date.now()
  const binJs = resolveDshBinJs()
  const node = resolveNodeBin()
  /* 共享 home 始终探测：official 模式的凭据卡片要指向它，与当前渠道无关 */
  const sharedHome = ensureDshHome()
  const home = channelId?.trim() ? dshHomePathForChannel(channelId) : sharedHome

  if (!binJs) {
    return {
      installed: false,
      path: 'dsh',
      node,
      nodeOk: nodeSupportsImportMetaMain(node),
      home,
      sharedHome,
      error: '没有找到 DeepSeek Harness。先运行：npm i -g @deepseek-ai/dsh',
      checkedAt
    }
  }

  const nodeOk = nodeSupportsImportMetaMain(node)
  if (!nodeOk) {
    return {
      installed: true,
      path: binJs,
      node,
      nodeOk: false,
      home,
      sharedHome,
      error: `DeepSeek Harness 需要 Node 24+（当前 ${node} 不支持 import.meta.main）。`,
      checkedAt
    }
  }

  try {
    const version = execFileSync(node, [binJs, '--version'], {
      timeout: 15_000,
      windowsHide: true,
      encoding: 'utf8'
    })
      .toString()
      .trim()
    return {
      installed: true,
      path: binJs,
      node,
      nodeOk: true,
      version,
      home,
      sharedHome,
      checkedAt
    }
  } catch (e) {
    return {
      installed: true,
      path: binJs,
      node,
      nodeOk: true,
      home,
      sharedHome,
      error: e instanceof Error ? e.message : String(e),
      checkedAt
    }
  }
}

/* ── DSH_HOME ─────────────────────────────────────────────── */

/** 应用数据根目录（Windows 是 %APPDATA%，其余是 $XDG_CONFIG_HOME） */
function appDataDir(): string {
  return IS_WIN
    ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
}

/** 终端里 dsh 的默认 home：official 模式的凭据和旧版本留下的会话都在这 */
function sharedDshHome(): string {
  return join(homedir(), '.dsh')
}

/** 机器上没有 ~/.dsh 时的应用 fallback home */
function appDshHome(): string {
  return join(appDataDir(), 'ccoder-desktop', 'dsh-home')
}

/** 每个渠道独立 home（dsh-homes/<channelId>）的根目录 */
export function dshHomesRoot(): string {
  return join(appDataDir(), 'ccoder-desktop', 'dsh-homes')
}

/** 渠道 id → 目录名。id 是 UUID，但配置可能被手改过，兜一层。 */
function channelHomeId(id: string): string {
  return id.trim().replace(/[^A-Za-z0-9._-]+/g, '_') || 'default'
}

/** 渠道 home 的路径（只算路径，不建目录） */
export function dshHomePathForChannel(channelId: string): string {
  return join(dshHomesRoot(), channelHomeId(channelId))
}

/**
 * 选一个显式的 DSH_HOME。
 *
 * 文档要求调用方显式给 home；这里优先用调用方给的目录，其次 $DSH_HOME，
 * 再退到用户已有的 `~/.dsh`，最后才是应用专属目录。
 */
export function ensureDshHome(override?: string): string {
  const explicit = override?.trim() || process.env.DSH_HOME?.trim()
  if (explicit) {
    const home = resolve(explicit)
    mkdirSync(home, { recursive: true })
    return home
  }

  /*
   * 用户很可能已经在终端里跑过 dsh：`~/.dsh` 是它的默认 home，凭据、
   * 插件、会话都躺在里面。official 模式共享它，用的就是同一套凭据。
   */
  const shared = sharedDshHome()
  if (existsSync(shared)) return shared

  const home = appDshHome()
  mkdirSync(home, { recursive: true })
  return home
}

/**
 * 新渠道 home 第一次使用时，从共享 home 播种**只读配置**：
 * skills 和 acp profile 的用户 patch。
 *
 * 凭据、会话、storages 一律不复制 —— 每个渠道必须只看见自己的
 * `.credentials.yaml`（通常根本没有这个文件，于是 dsh 会回落到我们
 * 通过环境变量注入的 DEEPSEEK_API_KEY）。
 */
function seedChannelHome(home: string): void {
  const shared = sharedDshHome()
  if (!existsSync(shared) || resolve(shared) === resolve(home)) return

  const patch = join(shared, 'profiles', 'acp', 'cordis.patch.yml')
  const patchDst = join(home, 'profiles', 'acp', 'cordis.patch.yml')
  if (existsSync(patch) && !existsSync(patchDst)) {
    try {
      mkdirSync(dirname(patchDst), { recursive: true })
      copyFileSync(patch, patchDst)
    } catch {
      // 播种失败不该拦会话：dsh 自己会生成默认 profile
    }
  }

  const skills = join(shared, 'skills')
  const skillsDst = join(home, 'skills')
  if (existsSync(skills) && !existsSync(skillsDst)) {
    try {
      cpSync(skills, skillsDst, { recursive: true })
    } catch {
      // 同上，失败只是少几个技能
    }
  }
}

/**
 * 渠道专用 home。
 *
 * 必须隔离的原因：dsh 的 credentials 服务把 `$DSH_HOME/.credentials.yaml`
 * **排在进程环境变量之前**。共享 home 里只要有一条 DEEPSEEK_API_KEY，
 * 渠道里填的 key 就会被静默忽略 —— 请求会拿着别的 key 去打这个渠道的
 * 端点，表现就是莫名的 401。每个渠道一个 home 后，渠道 key 才真正生效，
 * 各渠道的会话历史也不再互相串。
 *
 * channel 为 null（official 模式）时返回共享 home —— 那时要用的正是
 * 用户在终端里已经配好的 Harness 凭据。
 */
export function dshHomeForChannel(channel: { id?: string } | null | undefined): string {
  const id = channel?.id?.trim()
  if (!id) return ensureDshHome()

  const home = dshHomePathForChannel(id)
  const fresh = !existsSync(home)
  mkdirSync(home, { recursive: true })
  if (fresh) seedChannelHome(home)
  return home
}

/**
 * 所有可能放着 dsh 会话的 home：共享 home、旧版 fallback、每个渠道。
 *
 * 顺序固定（共享 → fallback → 渠道按名排序）—— 历史列表和
 * `findDshHomeForSession` 必须用同一顺序，否则同一条会话可能指到不同目录。
 */
export function listDshHomes(): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (p: string): void => {
    if (!existsSync(p)) return
    const key = resolve(p)
    if (seen.has(key)) return
    seen.add(key)
    out.push(p)
  }

  push(sharedDshHome())
  push(appDshHome())

  let names: string[] = []
  try {
    names = readdirSync(dshHomesRoot())
  } catch {
    names = [] // 还没建过任何渠道 home
  }
  for (const name of names.sort()) {
    const p = join(dshHomesRoot(), name)
    try {
      if (statSync(p).isDirectory()) push(p)
    } catch {
      // 扫描期间被删掉的目录
    }
  }
  return out
}

/**
 * 从会话 id 反查它所在的 home —— resume 必须用当初写这条会话的那个 home，
 * 否则 dsh 在新 home 里找不到它。找不到返回 null，调用方回落到当前渠道 home。
 */
export function findDshHomeForSession(sessionId: string | null | undefined): string | null {
  const id = sessionId?.trim()
  if (!id) return null

  for (const home of listDshHomes()) {
    const root = join(home, 'sessions')
    let encodings: string[]
    try {
      encodings = readdirSync(root)
    } catch {
      continue // 这个 home 没有会话
    }
    for (const encoded of encodings) {
      try {
        if (statSync(join(root, encoded, id)).isDirectory()) return home
      } catch {
        // 这个 cwd 下没有这条会话
      }
    }
  }
  return null
}

/**
 * 渠道 → dsh 的进程环境。
 *
 * dsh 的 DeepSeek 适配器读 `DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY`；
 * 它不关心我们的 ChannelKind。模型不是环境变量，走 ACP 的
 * `session/set_config_option`（见 adapter）。
 */
export function dshChannelEnv(channel: Channel | null): Record<string, string> {
  const env: Record<string, string> = {}
  if (!channel) return env

  const base = channel.baseUrl.trim().replace(/\/+$/, '')
  if (base) env.DEEPSEEK_BASE_URL = base
  if (channel.authToken.trim()) env.DEEPSEEK_API_KEY = channel.authToken.trim()

  for (const kv of channel.extraEnv) {
    const k = kv.key.trim()
    if (k) env[k] = kv.value
  }
  return env
}

export interface SpawnDshOptions {
  cwd?: string
  /** 需要叠加到 process.env 上的变量（渠道 + DSH_HOME） */
  env?: Record<string, string>
  /** 显式 home；不传则用 ensureDshHome 的默认值 */
  dshHome?: string
  /** 测试 / 高级场景可覆盖 */
  node?: string
  binJs?: string
}

/**
 * 拉起 `dsh --profile <name>`。
 *
 * shell: false —— 参数里可能有用户目录、patch 路径；不经过 cmd.exe，
 * 也就不存在 Windows 引号 / `%VAR%` 展开那一堆坑。
 */
export function spawnDsh(args: string[], opts: SpawnDshOptions = {}): ChildProcess {
  const binJs = opts.binJs ?? resolveDshBinJs()
  if (!binJs) {
    throw new Error('找不到 DeepSeek Harness 运行时。先运行：npm i -g @deepseek-ai/dsh')
  }

  const node = opts.node ?? resolveNodeBin()
  if (!nodeSupportsImportMetaMain(node)) {
    throw new Error(
      `DeepSeek Harness 需要 Node 24+（当前 ${node} 不支持 import.meta.main）。` +
        '请安装 Node 24 或设置 NODE_BIN 指向它。'
    )
  }

  const home = ensureDshHome(opts.dshHome)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(opts.env ?? {}),
    DSH_HOME: home
  }

  return spawn(node, [binJs, ...args], {
    cwd: opts.cwd ? resolve(opts.cwd) : undefined,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

/**
 * 杀掉整棵进程树。
 *
 * Windows 上 `child.kill()` 只杀 node.exe 本身；dsh 可能会拉起 pwsh / 沙箱
 * 子进程，必须用 taskkill /T。
 */
export function killDshTree(child: ChildProcess): void {
  if (!child.pid) return
  if (IS_WIN) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } catch {
      // 进程已经没了
    }
    return
  }
  try {
    child.kill('SIGTERM')
  } catch {
    // 已经没了
  }
}
