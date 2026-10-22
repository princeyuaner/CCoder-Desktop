import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { channelToEnv } from './channel-env'
import type { Channel, ChannelTestResult } from '../shared/settings'

const IS_WIN = process.platform === 'win32'

/**
 * 解析 `claude` 可执行文件的**绝对路径**。
 *
 * 为什么不能用裸命令名：实测五种方式，只有"绝对路径 + shell"能跑起来 ——
 *  - 裸 `claude` + shell:true   → cmd 找不到（PATH 里有目录也不认）
 *  - 裸 `claude` + shell:false  → ENOENT
 *  - 绝对路径 .cmd + shell:false → EINVAL（Windows 无法直接 CreateProcess .cmd）
 *  - 绝对路径 .cmd + shell:true  → ✓
 */
let cachedBin: string | null = null

export function resolveClaudeBin(): string {
  if (cachedBin) return cachedBin

  const override = process.env.CLAUDE_BIN?.trim()
  if (override) return (cachedBin = override)

  const names = IS_WIN ? ['claude.cmd', 'claude.exe'] : ['claude']
  const dirs: string[] = []

  if (IS_WIN) {
    if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'npm'))
    if (process.env.ProgramFiles) dirs.push(join(process.env.ProgramFiles, 'nodejs'))
    if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, 'Programs', 'claude'))
  }
  dirs.push(...(process.env.PATH ?? '').split(IS_WIN ? ';' : ':').filter(Boolean))

  for (const d of dirs) {
    for (const n of names) {
      const p = join(d, n)
      try {
        if (existsSync(p)) return (cachedBin = p)
      } catch {
        // 单个目录不可读就跳过，别让整体失败
      }
    }
  }
  return (cachedBin = names[0])
}

/**
 * Windows 上必须经 shell 才能执行 .cmd，而 shell 会把参数按空格拼接、
 * 还会展开 `%VAR%`。所以：
 *  - 参数自己加引号（实测空格、`&`、`|`、内嵌双引号都能原样到达）
 *  - **prompt 绝不放进命令行**，改走 stdin —— 否则 prompt 里的 `%` 和换行会被破坏
 */
function quoteWin(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`
}

/**
 * 按平台正确地把 claude 拉起来。所有调用点都该走这里，
 * 免得 Windows 那套 spawn 细节散落各处。
 */
export function spawnClaude(
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}
): ChildProcess {
  const bin = resolveClaudeBin()
  // 关键：告诉 CLI「provider（base URL / 凭据 / 模型）由宿主管理」。
  //
  // 不加这一条时，CLI 会把 `~/.claude/settings.json` 里的 `env` 块**叠在**
  // 我们传进去的进程环境之上 —— 用户全局配过 ANTHROPIC_BASE_URL 的话，
  // 渠道里填的地址根本不生效（实测 2.1.303：进程环境 ANTHROPIC_BASE_URL
  // 指向本地探针，请求依旧打到 ~/.claude/settings.json 里的网关）。
  // 加上之后宿主注入的渠道环境才是权威，CLI 不再用全局配置覆盖它。
  const env = {
    ...process.env,
    ...opts.env,
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1'
  }
  return IS_WIN
    ? spawn([quoteWin(bin), ...args.map(quoteWin)].join(' '), {
        env,
        cwd: opts.cwd,
        shell: true,
        windowsHide: true
      })
    : spawn(bin, args, { env, cwd: opts.cwd, shell: false, windowsHide: true })
}

export interface RunOptions {
  channel: Channel
  prompt: string
  cwd?: string
  timeoutMs?: number
  extraArgs?: string[]
}

export interface RunResult {
  /** stdout 里最后一个能解析成 JSON 的行 */
  json: Record<string, unknown> | null
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
}

/**
 * 用某个渠道的环境跑一次 `claude -p`。连通性测试与将来的真实会话都走这里，
 * 保证"测试通过"和"真能用"是同一套环境、同一套参数。
 */
export function runClaudeOnce(o: RunOptions): Promise<RunResult> {
  const timeoutMs = o.timeoutMs ?? 60_000

  const args = [
    '-p',
    '--output-format',
    'json',
    // 连通性测试不该在会话历史里留垃圾
    '--no-session-persistence',
    ...(o.channel.model.trim() ? ['--model', o.channel.model.trim()] : []),
    ...(o.extraArgs ?? [])
  ]

  const child = spawnClaude(args, { env: channelToEnv(o.channel), cwd: o.cwd })

  let stdout = ''
  let stderr = ''
  let timedOut = false

  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)

  // prompt 走 stdin：命令行里只有固定参数，用户内容不经过 shell
  child.stdin?.on('error', () => undefined) // 子进程早退时的 EPIPE，忽略
  child.stdin?.end(o.prompt)

  child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
  child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))

  return new Promise((resolve) => {
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ json: null, stdout, stderr: `${stderr}${err.message}`, code: null, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ json: lastJson(stdout), stdout, stderr, code, timedOut })
    })
  })
}

/**
 * 取最后一个合法 JSON 对象行。
 *
 * 不能简单取最后一行：stdout 会混入 `[claude-code:unrecognized_model] {...}`
 * 这类带前缀的行，也不能因为一行解析失败就整体失败。
 */
export function lastJson(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim()
    if (!t.startsWith('{')) continue
    try {
      const v = JSON.parse(t) as unknown
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    } catch {
      // 预期：非法行是常态，继续往前找
    }
  }
  return null
}

export async function testChannel(channel: Channel): Promise<ChannelTestResult> {
  const started = Date.now()
  const r = await runClaudeOnce({ channel, prompt: 'ping', timeoutMs: 60_000 })
  const latencyMs = Date.now() - started

  if (r.timedOut) {
    return { ok: false, message: `超时（60 秒无响应）${r.stderr ? `\n${r.stderr}` : ''}`, latencyMs }
  }
  if (!r.json) {
    return {
      ok: false,
      message: [
        `没有拿到可解析的输出（退出码 ${r.code}）。`,
        `stdout: ${r.stdout.slice(0, 400) || '(空)'}`,
        `stderr: ${r.stderr.slice(0, 400) || '(空)'}`
      ].join('\n'),
      latencyMs
    }
  }
  const result = typeof r.json.result === 'string' ? r.json.result : ''
  if (r.json.is_error === true) return { ok: false, message: result || '未知错误', latencyMs }
  return { ok: true, message: result || '连接正常', latencyMs }
}
