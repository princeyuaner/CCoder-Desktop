import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
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

/** 设置页 / 会话启动前的安装探测 */
export function checkDshStatus(): DshStatus {
  const checkedAt = Date.now()
  const binJs = resolveDshBinJs()
  const node = resolveNodeBin()
  const home = ensureDshHome()

  if (!binJs) {
    return {
      installed: false,
      path: 'dsh',
      node,
      nodeOk: nodeSupportsImportMetaMain(node),
      home,
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
    return { installed: true, path: binJs, node, nodeOk: true, version, home, checkedAt }
  } catch (e) {
    return {
      installed: true,
      path: binJs,
      node,
      nodeOk: true,
      home,
      error: e instanceof Error ? e.message : String(e),
      checkedAt
    }
  }
}

/**
 * 选一个显式的 DSH_HOME。
 *
 * 文档要求调用方显式给 home；这里给应用一个自己的目录，而不是去猜 `~/.dsh`。
 * 之后接设置页时，这个值可以改成用户可配置项。
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
   * 插件、会话都躺在里面。共享它，界面里用的就是同一套 key 和历史；
   * 另起一个 app 专属 home 会让「明明配好了 key 却说没登录」。
   */
  const shared = join(homedir(), '.dsh')
  if (existsSync(shared)) return shared

  const base = IS_WIN
    ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const home = join(base, 'ccoder-desktop', 'dsh-home')
  mkdirSync(home, { recursive: true })
  return home
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
