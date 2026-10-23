import type { BrowserWindow, WebContents } from 'electron'
import { logMain } from './crash-log'

/**
 * 窗口身份与生命周期日志。
 *
 * `render-process-gone` 只给一个 webContents id，光看日志无法判断消失的是
 * 聊天主窗口还是哪个工作区的 IDE 窗口。这里给每个窗口挂一个可读标签，
 * 并把生命周期 / 加载失败 / 渲染层 console 错误一并落盘。
 *
 * 高频的 console-message 做限流：错误风暴不能把同步写盘变成卡顿源。
 */

const labels = new WeakMap<WebContents, string>()

const CONSOLE_WINDOW_MS = 10_000
const CONSOLE_LIMIT = 30

interface ConsoleBudget {
  start: number
  count: number
  dropped: number
}

const budgets = new WeakMap<WebContents, ConsoleBudget>()

function noteConsole(wc: WebContents): { allowed: boolean; dropped: number } {
  const now = Date.now()
  let b = budgets.get(wc)
  if (!b || now - b.start >= CONSOLE_WINDOW_MS) {
    const dropped = b?.dropped ?? 0
    b = { start: now, count: 0, dropped: 0 }
    budgets.set(wc, b)
    return { allowed: true, dropped }
  }
  if (b.count >= CONSOLE_LIMIT) {
    b.dropped++
    return { allowed: false, dropped: 0 }
  }
  b.count++
  return { allowed: true, dropped: 0 }
}

/** 给窗口打标签并挂上日志监听。标签只用于日志，不参与权限判断。 */
export function labelWindow(win: BrowserWindow, label: string): void {
  const wc = win.webContents
  const id = wc.id
  labels.set(wc, label)

  logMain('window.created', { label, id })

  win.once('ready-to-show', () => logMain('window.ready-to-show', { label, id }))
  win.on('unresponsive', () => logMain('window.unresponsive', { label, id }))
  win.on('responsive', () => logMain('window.responsive', { label, id }))
  win.on('closed', () => logMain('window.closed', { label, id }))

  // preload 抛错时页面照常显示，但 window.api 可能缺一半 —— 不记就完全查不到
  wc.on('preload-error', (_e, preloadPath, error) => {
    logMain('preload-error', { label, id, preloadPath, error })
  })

  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    // -3 = ERR_ABORTED，导航被主动打断（重载 / 关窗口）是常态
    if (!isMainFrame || code === -3) return
    logMain('window.did-fail-load', { label, id, code, desc, url })
  })

  wc.on('console-message', (_e, level, message, line, sourceId) => {
    // 0 verbose / 1 info / 2 warning / 3 error：只记 error，避免日志被警告刷屏
    if (level < 3) return
    const budget = noteConsole(wc)
    if (budget.dropped > 0) {
      logMain('window.console.suppressed', { label, id, count: budget.dropped })
    }
    if (!budget.allowed) return
    logMain('window.console', {
      label,
      id,
      level,
      line,
      source: sourceId,
      message: message.length > 3000 ? `${message.slice(0, 3000)}…` : message
    })
  })
}

/** 按 WebContents 反查窗口标签；未登记的（理论上没有）回退成 unknown */
export function labelOf(wc: WebContents): string {
  return labels.get(wc) ?? 'unknown'
}
