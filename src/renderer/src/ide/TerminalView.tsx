import { useCallback, useEffect, useRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useI18n } from '../i18n'

/**
 * 内置终端。
 *
 * 主进程用管道启动 cmd.exe（没有 node-pty，拿不到真正的 PTY），
 * 所以这里自己实现一个最小的行编辑器：本地回显、退格、左右移动、
 * 历史命令。全屏 TUI 程序仍然不可用，启动时会提示一次。
 */

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

function terminalTheme(): ITheme {
  const bg = cssVar('--bg-app', '#191919')
  const fg = cssVar('--text', '#d4d4d4')
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: cssVar('--bg-active', '#333333'),
    black: '#3b4048',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#dcdfe4',
    brightBlack: '#5c6370',
    brightRed: '#ef7f88',
    brightGreen: '#a9d78a',
    brightYellow: '#f0d08c',
    brightBlue: '#7cc0f5',
    brightMagenta: '#d69ae8',
    brightCyan: '#6fcbd6',
    brightWhite: '#ffffff'
  }
}

function newSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `term-${crypto.randomUUID()}`
  }
  return `term-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

const HISTORY_MAX = 200

export function TerminalView({
  cwd,
  active,
  fontSize = 12
}: {
  cwd: string
  active: boolean
  fontSize?: number
}): JSX.Element {
  const { t } = useI18n()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const startedRef = useRef(false)
  const activeRef = useRef(active)
  activeRef.current = active
  /** xterm 创建时只拿一次 onData；用 ref 指向最新的行编辑器 */
  const inputHandlerRef = useRef<(data: string) => void>(() => {})

  /** 行编辑状态 */
  const lineRef = useRef('')
  const cursorRef = useRef(0)
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef(0)

  const write = useCallback((data: string): void => {
    termRef.current?.write(data)
  }, [])

  const fit = useCallback((): void => {
    const host = hostRef.current
    const term = termRef.current
    const addon = fitRef.current
    if (!host || !term || !addon) return
    if (host.clientWidth <= 0 || host.clientHeight <= 0) return
    try {
      addon.fit()
    } catch {
      // 隐藏 / 布局过程中尺寸为 0 时会抛，忽略即可
    }
  }, [])

  const sendInput = useCallback((data: string): void => {
    const id = sessionIdRef.current
    if (id) window.api?.terminal?.write(id, data)
  }, [])

  const startSession = useCallback((): void => {
    const term = termRef.current
    if (!term) return
    if (sessionIdRef.current) {
      window.api?.terminal?.kill(sessionIdRef.current)
      sessionIdRef.current = null
    }
    term.reset()
    term.focus()
    lineRef.current = ''
    cursorRef.current = 0
    historyIndexRef.current = historyRef.current.length
    const id = newSessionId()
    sessionIdRef.current = id
    write(`\x1b[90m${t('ide.terminal.pipeHint')}\x1b[0m\r\n`)
    fit()
    const api = window.api?.terminal
    if (!api) {
      write(`\r\n${t('ide.terminal.failed', { error: 'preload unavailable' })}\r\n`)
      return
    }
    void api
      .start({ cwd, id, cols: term.cols, rows: term.rows })
      .then((r) => {
        if (!r.ok) {
          write(`\r\n${t('ide.terminal.failed', { error: r.error })}\r\n`)
        }
      })
      .catch((err: unknown) => {
        write(
          `\r\n${t('ide.terminal.failed', {
            error: err instanceof Error ? err.message : String(err)
          })}\r\n`
        )
      })
  }, [cwd, fit, t, write])

  /* 创建 xterm 实例；只创建一次，面板隐藏时也保留会话 */
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      scrollback: 5000,
      fontFamily: cssVar('--font-mono', "'Cascadia Mono', Consolas, monospace"),
      fontSize,
      lineHeight: 1.2,
      theme: terminalTheme(),
      allowTransparency: false
    })
    const addon = new FitAddon()
    term.loadAddon(addon)
    term.open(host)
    termRef.current = term
    fitRef.current = addon

    const offResize = term.onResize(({ cols, rows }) => {
      const id = sessionIdRef.current
      if (id) window.api?.terminal?.resize(id, cols, rows)
    })
    const offData = term.onData((data) => {
      inputHandlerRef.current(data)
    })

    const resizeObs = new ResizeObserver(() => {
      if (activeRef.current) fit()
    })
    resizeObs.observe(host)

    const themeObs = new MutationObserver(() => {
      term.options.theme = terminalTheme()
      term.options.fontFamily = cssVar('--font-mono', term.options.fontFamily ?? 'monospace')
      // 字体宽度可能变化，列数要重算
      if (activeRef.current) requestAnimationFrame(() => fit())
    })
    themeObs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-scheme', 'style']
    })

    return () => {
      offResize.dispose()
      offData.dispose()
      resizeObs.disconnect()
      themeObs.disconnect()
      const id = sessionIdRef.current
      if (id) window.api?.terminal?.kill(id)
      sessionIdRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // handleLocalInput 定义在下面，通过 ref 访问，避免重建整个终端
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* 主进程 → 渲染层：输出 / 退出 */
  useEffect(() => {
    const api = window.api?.terminal
    if (!api) return
    const offData = api.onData((event) => {
      if (event.id !== sessionIdRef.current) return
      write(event.data)
    })
    const offExit = api.onExit((event) => {
      if (event.id !== sessionIdRef.current) return
      write(`\r\n\x1b[90m${t('ide.terminal.exited', { code: event.code ?? 0 })}\x1b[0m\r\n`)
      sessionIdRef.current = null
    })
    return () => {
      offData()
      offExit()
    }
  }, [t, write])

  /* 第一次显示面板时才真正启动 shell —— 用户没打开终端就不该常驻一个 cmd */
  useEffect(() => {
    if (!active) {
      termRef.current?.blur()
      return
    }
    requestAnimationFrame(() => {
      if (!activeRef.current) return
      fit()
      termRef.current?.focus()
    })
    if (startedRef.current) return
    startedRef.current = true
    startSession()
  }, [active, fit, startSession])

  /* ── 本地行编辑 ─────────────────────────────────────── */

  const replaceLine = useCallback((text: string): void => {
    lineRef.current = text
    cursorRef.current = text.length
    write(`\r\x1b[2K${text}`)
  }, [write])

  const insertText = useCallback((text: string): void => {
    if (!text) return
    const line = lineRef.current
    const cursor = cursorRef.current
    if (cursor === line.length) {
      lineRef.current = line + text
      cursorRef.current = cursor + text.length
      write(text)
      return
    }
    const rest = line.slice(cursor)
    lineRef.current = line.slice(0, cursor) + text + rest
    cursorRef.current = cursor + text.length
    write(text + rest + `\x1b[${rest.length}D`)
  }, [write])

  const backspace = useCallback((): void => {
    const line = lineRef.current
    const cursor = cursorRef.current
    if (cursor === 0) return
    const rest = line.slice(cursor)
    lineRef.current = line.slice(0, cursor - 1) + rest
    cursorRef.current = cursor - 1
    if (rest.length === 0) {
      write('\b \b')
    } else {
      write(`\b${rest} \x1b[${rest.length + 1}D`)
    }
  }, [write])

  const deleteForward = useCallback((): void => {
    const line = lineRef.current
    const cursor = cursorRef.current
    if (cursor >= line.length) return
    const rest = line.slice(cursor + 1)
    lineRef.current = line.slice(0, cursor) + rest
    write(`${rest} \x1b[${rest.length + 1}D`)
  }, [write])

  const submitLine = useCallback((): void => {
    const line = lineRef.current
    write('\r\n')
    lineRef.current = ''
    cursorRef.current = 0
    if (line.trim()) {
      historyRef.current = [...historyRef.current, line].slice(-HISTORY_MAX)
    }
    historyIndexRef.current = historyRef.current.length
    sendInput(`${line}\r\n`)
  }, [sendInput, write])

  const historyStep = useCallback((delta: number): void => {
    const history = historyRef.current
    if (history.length === 0) return
    const next = Math.max(
      0,
      Math.min(history.length, historyIndexRef.current + delta)
    )
    if (next === historyIndexRef.current) return
    historyIndexRef.current = next
    replaceLine(next === history.length ? '' : history[next])
  }, [replaceLine])

  const ctrlC = useCallback((): void => {
    write('^C\r\n')
    lineRef.current = ''
    cursorRef.current = 0
    sendInput('\x03')
  }, [sendInput, write])

  const clearScreen = useCallback((): void => {
    termRef.current?.clear()
    write('\r')
    termRef.current?.focus()
    lineRef.current = ''
    cursorRef.current = 0
  }, [write])

  /**
   * xterm 的 onData 一次可能给一个字符、一个转义序列，或一整段粘贴。
   * 先把常见转义序列吃掉，剩下的按字符处理；粘贴里的换行逐行提交。
   */
  const handleLocalInput = useCallback(
    (raw: string): void => {
      let data = raw.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '')
      if (!data) return

      // 整段转义序列（方向键 / Home / End / Delete）
      if (data === '\x1b[A') return historyStep(-1)
      if (data === '\x1b[B') return historyStep(1)
      if (data === '\x1b[C') {
        if (cursorRef.current < lineRef.current.length) {
          cursorRef.current += 1
          write('\x1b[C')
        }
        return
      }
      if (data === '\x1b[D') {
        if (cursorRef.current > 0) {
          cursorRef.current -= 1
          write('\x1b[D')
        }
        return
      }
      if (data === '\x1b[H' || data === '\x01') {
        const steps = cursorRef.current
        if (steps > 0) {
          cursorRef.current = 0
          write(`\x1b[${steps}D`)
        }
        return
      }
      if (data === '\x1b[F' || data === '\x05') {
        const steps = lineRef.current.length - cursorRef.current
        if (steps > 0) {
          cursorRef.current = lineRef.current.length
          write(`\x1b[${steps}C`)
        }
        return
      }
      if (data === '\x1b[3~') return deleteForward()
      if (data === '\x03') return ctrlC()
      if (data === '\x0c') return clearScreen()
      // readline 风格：Ctrl+W 删前一个词、Ctrl+U 删到行首、Ctrl+K 删到行尾
      if (data === '\x17') {
        const before = lineRef.current.slice(0, cursorRef.current)
        const word = /(\S+)\s*$/.exec(before)
        for (let i = 0; i < (word ? word[0].length : 0); i++) backspace()
        return
      }
      if (data === '\x15') {
        while (cursorRef.current > 0) backspace()
        return
      }
      if (data === '\x0b') {
        while (cursorRef.current < lineRef.current.length) deleteForward()
        return
      }
      if (data === '\r' || data === '\n') return submitLine()
      if (data === '\x7f' || data === '\b') return backspace()
      if (data === '\x04') {
        sendInput('\x04')
        return
      }
      if (data === '\t') {
        sendInput('\t')
        return
      }

      // 多字符粘贴：去掉剩余的 CSI 序列，逐个插入；换行当作提交
      data = data.replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '')
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') submitLine()
        else if (ch === '\x7f' || ch === '\b') backspace()
        else if (ch === '\x03') ctrlC()
        else if (ch >= ' ' || ch === '\t') insertText(ch)
      }
    },
    [
      backspace,
      clearScreen,
      ctrlC,
      deleteForward,
      historyStep,
      insertText,
      sendInput,
      submitLine,
      write
    ]
  )

  inputHandlerRef.current = handleLocalInput

  /* 字体跟随设置页里的编辑器字号 */
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = fontSize
    // 字号变了，单元格尺寸跟着变；重新 fit 一次，列数才不会错位
    requestAnimationFrame(() => {
      if (activeRef.current) fit()
    })
  }, [fit, fontSize])

  return (
    <div className="ide-terminal-wrap">
      <div className="ide-terminal" ref={hostRef} />
      <div className="ide-term-tools">
        <button title={t('ide.terminal.clear')} onClick={clearScreen}>
          {t('ide.terminal.clear')}
        </button>
        <button title={t('ide.terminal.new')} onClick={startSession}>
          {t('ide.terminal.new')}
        </button>
        <button
          title={t('ide.terminal.kill')}
          onClick={() => {
            const id = sessionIdRef.current
            if (id) window.api?.terminal?.kill(id)
            sessionIdRef.current = null
            write(`\r\n\x1b[90m${t('ide.terminal.exited', { code: 0 })}\x1b[0m\r\n`)
          }}
        >
          {t('ide.terminal.kill')}
        </button>
      </div>
    </div>
  )
}
