import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  CommandHook,
  HookTestInput,
  HookTestResult,
  HttpHook
} from '../../shared/hooks'
import { killProcessTree } from '../kill-process'
import type { HookNativeContext } from './types'

const OUTPUT_CAP = 64 * 1024

function unsupported(input: HookTestInput): HookTestResult {
  return {
    ok: false,
    supported: false,
    exitCode: null,
    stdout: '',
    stderr: '',
    durationMs: 0,
    timedOut: false,
    errorKey: 'hook.test.unsupportedType',
    detail: input.hook.type
  }
}

function sampleFor(input: HookTestInput): Record<string, unknown> {
  const cwd = input.cwd || homedir()
  const sample: Record<string, unknown> = {
    session_id: 'ccoder-hook-test',
    transcript_path: '',
    cwd,
    hook_event_name: input.event,
    tool_input: { command: 'echo ccoder-hook-test' },
    tool_response: { ok: true }
  }
  if (input.matcher) sample.tool_name = input.matcher.split('|')[0] || input.matcher
  if (input.event === 'UserPromptSubmit' || input.event === 'UserPromptExpansion') {
    sample.prompt = 'ccoder hook test'
  }
  if (input.event === 'Stop' || input.event === 'SubagentStop') {
    sample.stop_hook_active = false
  }
  return sample
}

function findGitBash(): string {
  if (process.platform !== 'win32') return 'bash'
  const candidates = [
    process.env.CLAUDE_CODE_GIT_BASH_PATH ?? '',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe')
  ]
  return candidates.find((p) => p && existsSync(p)) ?? ''
}

function findPowerShell(): string {
  if (process.platform !== 'win32') return 'pwsh'
  const pwsh = join(
    process.env.ProgramFiles ?? 'C:\\Program Files',
    'PowerShell',
    '7',
    'pwsh.exe'
  )
  return existsSync(pwsh) ? pwsh : 'powershell.exe'
}

function runCommand(input: HookTestInput, ctx: HookNativeContext): Promise<HookTestResult> {
  if (input.hook.type !== 'command') return Promise.resolve(unsupported(input))
  const hook = input.hook as CommandHook
  const cwd = input.cwd || ctx.claudeDir
  const timeoutMs = Math.min(60, Math.max(1, hook.timeout ?? 10)) * 1000
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_PROJECT_DIR: cwd
  }

  let child: ChildProcess
  try {
    if (hook.args?.length) {
      child = spawn(hook.command, hook.args, {
        cwd,
        env,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } else if (hook.shell === 'powershell') {
      child = spawn(findPowerShell(), ['-NoProfile', '-Command', hook.command], {
        cwd,
        env,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } else {
      const bash = findGitBash()
      child = bash
        ? spawn(bash, ['-lc', hook.command], {
            cwd,
            env,
            windowsHide: true,
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe']
          })
        : spawn(hook.command, {
            cwd,
            env,
            windowsHide: true,
            shell: true,
            stdio: ['pipe', 'pipe', 'pipe']
          })
    }
  } catch (e) {
    return Promise.resolve({
      ok: false,
      supported: true,
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: 0,
      timedOut: false,
      errorKey: 'hook.test.spawnFailed',
      detail: e instanceof Error ? e.message : String(e)
    })
  }

  const started = Date.now()
  let stdout = ''
  let stderr = ''
  let timedOut = false
  let settled = false

  child.stdout?.on('data', (chunk: Buffer | string) => {
    if (stdout.length >= OUTPUT_CAP) return
    stdout += String(chunk).slice(0, OUTPUT_CAP - stdout.length)
  })
  child.stderr?.on('data', (chunk: Buffer | string) => {
    if (stderr.length >= OUTPUT_CAP) return
    stderr += String(chunk).slice(0, OUTPUT_CAP - stderr.length)
  })

  const timer = setTimeout(() => {
    timedOut = true
    killProcessTree(child)
  }, timeoutMs)

  return new Promise((resolve) => {
    const finish = (code: number | null, error?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const durationMs = Date.now() - started
      resolve({
        ok: !timedOut && (code === 0 || code === 2),
        supported: true,
        exitCode: code,
        stdout,
        stderr,
        durationMs,
        timedOut,
        ...(timedOut
          ? { errorKey: 'hook.test.timeout' }
          : error
            ? { errorKey: 'hook.test.spawnFailed', detail: error }
            : {})
      })
    }

    child.on('error', (e) => finish(null, e.message))
    child.on('close', (code) => finish(code))
    child.stdin?.end(JSON.stringify(sampleFor(input)))
  })
}

async function runHttp(input: HookTestInput, ctx: HookNativeContext): Promise<HookTestResult> {
  if (input.hook.type !== 'http') return unsupported(input)
  const hook = input.hook as HttpHook
  const started = Date.now()
  const timeoutMs = Math.min(60, Math.max(1, hook.timeout ?? 10)) * 1000
  const allowed = new Set(hook.allowedEnvVars ?? [])
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(hook.headers ?? {})
  }
  for (const [key, value] of Object.entries(headers)) {
    headers[key] = value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (match, a: string, b: string) => {
        const name = a || b
        return allowed.has(name) ? process.env[name] ?? '' : match
      }
    )
  }

  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(sampleFor(input)),
      signal: AbortSignal.timeout(timeoutMs)
    })
    const text = (await res.text()).slice(0, OUTPUT_CAP)
    return {
      ok: res.ok,
      supported: true,
      exitCode: res.ok ? 0 : 1,
      stdout: text,
      stderr: '',
      durationMs: Date.now() - started,
      timedOut: false,
      ...(res.ok ? {} : { errorKey: 'hook.test.httpStatus', detail: String(res.status) })
    }
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'TimeoutError'
    return {
      ok: false,
      supported: true,
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: Date.now() - started,
      timedOut,
      errorKey: timedOut ? 'hook.test.timeout' : 'hook.test.httpFailed',
      detail: e instanceof Error ? e.message : String(e)
    }
  }
}

export function testHookNative(
  input: HookTestInput,
  ctx: HookNativeContext
): Promise<HookTestResult> {
  if (input.hook.type === 'command') return runCommand(input, ctx)
  if (input.hook.type === 'http') return runHttp(input, ctx)
  return Promise.resolve(unsupported(input))
}
