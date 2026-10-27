import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { IPC } from '../shared/ipc'
import type { IdeTerminalStartResult } from '../shared/ide'
import { sendToIdeSender } from './ide-window'
import { logMain } from './crash-log'

/**
 * IDE 内置终端。
 *
 * Windows 上没有 node-pty 就无法拿到真正的 PTY；这里用管道启动
 * `cmd.exe /Q /K chcp 65001`（POSIX 用 $SHELL -l），能执行常规命令、
 * 保留颜色，但全屏 TUI（vim / top）和真正的窗口尺寸变化不可用。
 * 渲染层用本地行编辑补上回显，交互体验接近普通终端。
 *
 * 会话按 webContents 隔离：A 窗口永远不能写到 B 窗口的终端。
 */

interface TermSession {
  id: string
  senderId: number
  proc: ChildProcessWithoutNullStreams
  cwd: string
  shell: string
  /** 仅记录；管道模式没有真正的 PTY 尺寸 */
  cols: number
  rows: number
}

/** webContents.id → (terminal id → session) */
const sessions = new Map<number, Map<string, TermSession>>()

const MAX_SESSIONS_PER_WINDOW = 8
const MAX_WRITE_CHARS = 64 * 1024

function sessionsOf(senderId: number): Map<string, TermSession> {
  let map = sessions.get(senderId)
  if (!map) {
    map = new Map()
    sessions.set(senderId, map)
  }
  return map
}

function shellFor(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const file = process.env.ComSpec || 'cmd.exe'
    return { file, args: ['/Q', '/K', 'chcp 65001>nul'] }
  }
  return { file: process.env.SHELL || '/bin/bash', args: ['-l'] }
}

function send(senderId: number, channel: string, payload: unknown): void {
  try {
    sendToIdeSender(senderId, channel, payload)
  } catch (e) {
    logMain('ide-terminal.send', e)
  }
}

export function startTerminal(
  senderId: number,
  cwd: string,
  id: string,
  cols?: number,
  rows?: number
): IdeTerminalStartResult {
  if (!id || typeof id !== 'string' || id.length > 120) {
    return { ok: false, error: 'invalid terminal id' }
  }
  const map = sessionsOf(senderId)
  const existing = map.get(id)
  if (existing) return { ok: true, shell: existing.shell }
  if (map.size >= MAX_SESSIONS_PER_WINDOW) {
    return { ok: false, error: 'too many terminals' }
  }

  const { file, args } = shellFor()
  let proc: ChildProcessWithoutNullStreams
  try {
    proc = spawn(file, args, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        PYTHONIOENCODING: 'utf-8',
        // 让 Node / Python 之类尽量输出 UTF-8；cmd 侧已经 chcp 65001
        COLUMNS: String(Math.max(20, cols ?? 80)),
        LINES: String(Math.max(5, rows ?? 24))
      }
    })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  const session: TermSession = {
    id,
    senderId,
    proc,
    cwd,
    shell: file,
    cols: Math.max(20, cols ?? 80),
    rows: Math.max(5, rows ?? 24)
  }
  map.set(id, session)

  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  proc.stdout.on('data', (data: string) => {
    send(senderId, IPC.ideTerminalData, { id, data })
  })
  proc.stderr.on('data', (data: string) => {
    send(senderId, IPC.ideTerminalData, { id, data })
  })
  proc.on('error', (err) => {
    logMain('ide-terminal.error', { senderId, id, error: err.message })
    send(senderId, IPC.ideTerminalData, {
      id,
      data: `\r\n[terminal error] ${err.message}\r\n`
    })
  })
  proc.on('close', (code) => {
    map.delete(id)
    if (map.size === 0) sessions.delete(senderId)
    send(senderId, IPC.ideTerminalExit, { id, code })
  })

  logMain('ide-terminal.started', { senderId, id, shell: file, cwd })
  return { ok: true, shell: file }
}

export function writeTerminal(senderId: number, id: string, data: string): void {
  const session = sessions.get(senderId)?.get(id)
  if (!session || typeof data !== 'string') return
  if (data.length > MAX_WRITE_CHARS) data = data.slice(0, MAX_WRITE_CHARS)
  try {
    session.proc.stdin.write(data)
  } catch (e) {
    logMain('ide-terminal.write', e)
  }
}

/**
 * 管道模式没法真正 resize；保留这个入口是为了以后换 node-pty 时
 * 渲染层不用改。环境变量里的 COLUMNS / LINES 已经在启动时给过了。
 */
export function resizeTerminal(
  senderId: number,
  id: string,
  cols: number,
  rows: number
): void {
  const session = sessions.get(senderId)?.get(id)
  if (!session) return
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
  session.cols = Math.max(20, Math.round(cols))
  session.rows = Math.max(5, Math.round(rows))
}

export function killTerminal(senderId: number, id: string): void {
  const map = sessions.get(senderId)
  const session = map?.get(id)
  if (!map || !session) return
  map.delete(id)
  if (map.size === 0) sessions.delete(senderId)
  try {
    session.proc.kill()
  } catch (e) {
    logMain('ide-terminal.kill', e)
  }
}

/** 窗口销毁 / 关闭时调用：结束这个 webContents 下的所有终端 */
export function killTerminalsForSender(senderId: number): void {
  const map = sessions.get(senderId)
  if (!map) return
  sessions.delete(senderId)
  for (const session of map.values()) {
    try {
      session.proc.kill()
    } catch (e) {
      logMain('ide-terminal.killAll', e)
    }
  }
}

/** 应用退出时统一收口，别留孤儿进程 */
export function killAllTerminals(): void {
  for (const senderId of [...sessions.keys()]) killTerminalsForSender(senderId)
}
