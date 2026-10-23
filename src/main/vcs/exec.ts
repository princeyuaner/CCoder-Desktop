import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { VcsErrorCode } from '../../shared/vcs'

/**
 * VCS 子进程执行器。
 *
 * 只接受参数数组，绝不拼 shell；提交信息走 stdin。stdout/stderr 都有上限，
 * 超时或取消时尽量把整棵进程树收掉（Windows 上 git/ssh/svn 可能还有子进程）。
 */

export class VcsOpError extends Error {
  code: VcsErrorCode
  detail?: string
  paths?: string[]

  constructor(code: VcsErrorCode, message: string, detail?: string, paths?: string[]) {
    super(message)
    this.name = 'VcsOpError'
    this.code = code
    this.detail = detail
    this.paths = paths
  }
}

export interface VcsExecOptions {
  stdin?: string
  timeoutMs?: number
  maxStdoutBytes?: number
  maxStderrBytes?: number
  signal?: AbortSignal
}

export interface VcsExecResult {
  code: number | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  durationMs: number
}

const DEFAULT_TIMEOUT = 30_000
const DEFAULT_MAX_STDOUT = 8 * 1024 * 1024
const DEFAULT_MAX_STDERR = 256 * 1024

function killTree(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.on('error', () => child.kill())
    } catch {
      child.kill()
    }
  } else {
    child.kill('SIGKILL')
  }
}

function collect(
  stream: NodeJS.ReadableStream,
  cap: number,
  onChunk: (text: string, truncated: boolean) => void
): void {
  let bytes = 0
  stream.on('data', (chunk: Buffer) => {
    if (bytes >= cap) {
      onChunk('', true)
      return
    }
    const take = Math.min(chunk.length, cap - bytes)
    bytes += take
    onChunk(chunk.subarray(0, take).toString('utf8'), take < chunk.length)
  })
}

function exec(
  bin: string,
  args: string[],
  cwd: string,
  opts: VcsExecOptions = {}
): Promise<VcsExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT
  const maxOut = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT
  const maxErr = opts.maxStderrBytes ?? DEFAULT_MAX_STDERR
  const started = Date.now()

  return new Promise((resolvePromise, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(bin, args, {
        cwd,
        shell: false,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_EDITOR: 'true',
          GIT_PAGER: 'cat',
          GCM_INTERACTIVE: 'never',
          LC_ALL: 'C',
          LANG: 'C'
        }
      })
    } catch (err) {
      reject(err)
      return
    }

    let stdout = ''
    let stderr = ''
    let outTruncated = false
    let errTruncated = false
    let settled = false
    let timedOut = false
    let cancelled = false
    let timer: NodeJS.Timeout | null = null
    let onAbort = (): void => undefined

    const finish = (code: number | null, error?: Error): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else
        resolvePromise({
          code,
          stdout,
          stderr,
          stdoutTruncated: outTruncated,
          stderrTruncated: errTruncated,
          durationMs: Date.now() - started
        })
    }

    onAbort = (): void => {
      cancelled = true
      killTree(child)
    }

    timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            killTree(child)
          }, timeoutMs)
        : null

    if (opts.signal) {
      if (opts.signal.aborted) {
        cancelled = true
        killTree(child)
      } else {
        opts.signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    child.stdout.on('error', () => undefined)
    child.stderr.on('error', () => undefined)
    child.stdin.on('error', () => undefined)

    collect(child.stdout, maxOut, (text, truncated) => {
      stdout += text
      if (truncated) outTruncated = true
    })
    collect(child.stderr, maxErr, (text, truncated) => {
      stderr += text
      if (truncated) errTruncated = true
    })

    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        finish(
          null,
          new VcsOpError('no-cli', `找不到 ${bin} 命令，请确认已安装并加入 PATH`, String(err))
        )
      } else {
        finish(null, err)
      }
    })

    child.on('close', (code) => {
      if (timedOut) {
        finish(null, new VcsOpError('timeout', `${bin} 操作超时（${timeoutMs}ms）`))
      } else if (cancelled) {
        finish(null, new VcsOpError('cancelled', '操作已取消'))
      } else {
        finish(code)
      }
    })

    if (opts.stdin !== undefined) child.stdin.end(opts.stdin, 'utf8')
    else child.stdin.end()
  })
}

/** Git 全局参数：不分页、literal pathspec、不转义非 ASCII 文件名 */
export function runGit(
  cwd: string,
  args: string[],
  opts: VcsExecOptions = {}
): Promise<VcsExecResult> {
  return exec(
    'git',
    ['--no-pager', '--literal-pathspecs', '-c', 'core.quotepath=false', '-C', cwd, ...args],
    cwd,
    opts
  )
}

/** SVN 全局参数：非交互，避免在无终端窗口里等密码/证书 */
export function runSvn(
  cwd: string,
  args: string[],
  opts: VcsExecOptions = {}
): Promise<VcsExecResult> {
  return exec('svn', ['--non-interactive', '--no-auth-cache', ...args], cwd, opts)
}

/** svnversion 是本地命令，不联网；用来显示混合修订工作副本的最高 revision */
export function runSvnVersion(
  cwd: string,
  args: string[],
  opts: VcsExecOptions = {}
): Promise<VcsExecResult> {
  return exec('svnversion', args, cwd, opts)
}

/** 把常见 CLI 错误映射成 UI 能分流的错误码 */
export function mapCliError(kind: 'git' | 'svn', r: VcsExecResult): VcsOpError {
  const text = `${r.stderr}\n${r.stdout}`.trim()
  const low = text.toLowerCase()

  if (/authentication|authorization|credential|permission denied|e170001|e215004/.test(low)) {
    return new VcsOpError('auth-required', '需要先完成认证', text)
  }
  if (/index\.lock|e155004|working copy.*locked|is locked|locked working tree/.test(low)) {
    return new VcsOpError('locked', '仓库正在被另一个进程占用', text)
  }
  if (/out of date|e160028|needs update|non-fast-forward|fetch first|rejected/.test(low)) {
    return new VcsOpError(
      kind === 'svn' ? 'needs-update' : 'not-fast-forward',
      kind === 'svn' ? '工作副本不是最新，请先更新' : '远端有新的提交，请先拉取',
      text
    )
  }
  if (/conflict|unmerged|e155015|e155027/.test(low)) {
    return new VcsOpError('conflict', '存在未解决的冲突', text)
  }
  if (/local changes|would be overwritten|please commit|dirty|contains modified or untracked files/.test(low)) {
    return new VcsOpError('dirty', '工作区有未处理的改动', text)
  }
  return new VcsOpError('unknown', text.split('\n').find((l) => l.trim()) || '操作失败', text)
}
