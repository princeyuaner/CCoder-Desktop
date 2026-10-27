import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { app, BrowserWindow, dialog, screen, shell } from 'electron'
import { IPC } from '../shared/ipc'
import type { IdeFsChanged, IdeOpenResult, IdeTarget } from '../shared/ide'
import { startWorkspaceWatch } from './ide-watch'
import { pathKey } from './path-key'
import { windowBg } from './window-theme'
import { logMain } from './crash-log'
import { labelWindow } from './window-log'
import { t } from './i18n'
import { safeSend } from './safe-send'

/**
 * 独立 IDE 窗口。
 *
 * 一个工作区对应一个窗口：已经开着就聚焦/还原，不重复创建。
 * 窗口生命周期与聊天进程完全解耦 —— 关掉 IDE 不会碰 SessionManager。
 */

interface SavedBounds {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

const windows = new Map<string, BrowserWindow>()
/** webContents.id → 这个 IDE 窗口绑定的工作区。文件 / VCS 写操作只允许对应窗口调用。 */
const senderCwds = new Map<number, string>()
const senderWindows = new Map<number, BrowserWindow>()
/** 有未保存修改的窗口：关闭时先让渲染层处理 */
const dirtySenders = new Set<number>()
/** 渲染层已经确认可以关（保存/放弃完成），下一次 close 直接放行 */
const closeConfirmed = new Set<number>()

const keyOf = (cwd: string): string => pathKey(cwd)

/**
 * 窗口生命周期钩子。`main/index.ts` 用它们在工作区开 / 关时启动 / 停止
 * 目录同步服务 —— ide-window 本身不 import sync，避免循环依赖。
 */
interface IdeWindowHooks {
  onOpened?: (cwd: string) => void
  onClosed?: (cwd: string) => void
  /** webContents 关闭前清理与该 sender 绑定的后台任务（如流式搜索） */
  onSenderClosed?: (senderId: number) => void
}

let hooks: IdeWindowHooks = {}

export function setIdeWindowHooks(next: IdeWindowHooks): void {
  hooks = next
}

/** 往某个工作区的 IDE 窗口发一条 IPC；窗口不存在 / 已销毁时静默忽略。 */
export function sendToIdeWindow(cwd: string, channel: string, payload: unknown): void {
  const win = windows.get(keyOf(cwd))
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  safeSend(win, channel, payload)
}

/** 按 webContents.id 发送；流式搜索的响应必须回到发起请求的那个窗口。 */
export function sendToIdeSender(senderId: number, channel: string, payload: unknown): void {
  const win = senderWindows.get(senderId)
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  safeSend(win, channel, payload)
}

/** 聚焦某个工作区的 IDE 窗口；没有就打开一个。 */
export function focusIdeWindow(cwd: string): void {
  const win = windows.get(keyOf(cwd))
  if (!win || win.isDestroyed()) {
    openIdeWindow(cwd)
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

export function authorizeVcsSender(senderId: number, cwd: string): boolean {
  const allowed = senderCwds.get(senderId)
  return !!allowed && allowed === keyOf(cwd)
}

/** 是否有 IDE 窗口绑定在 dir 或 dir 的子目录上 */
export function hasIdeWindowUnder(dir: string): boolean {
  const key = keyOf(dir)
  for (const bound of senderCwds.values()) {
    if (bound === key || bound.startsWith(`${key}/`)) return true
  }
  return false
}

/** 这个 webContents 是不是 IDE 窗口 */
export function isIdeSender(senderId: number): boolean {
  return senderCwds.has(senderId)
}

export function markIdeDirty(senderId: number, dirty: boolean): void {
  if (dirty) dirtySenders.add(senderId)
  else dirtySenders.delete(senderId)
}

/** 渲染层已经处理完未保存修改，允许真正关闭窗口 */
export function closeIdeWindow(senderId: number): void {
  const win = senderWindows.get(senderId)
  if (!win || win.isDestroyed()) return
  closeConfirmed.add(senderId)
  win.close()
}

const statePath = (): string => join(app.getPath('userData'), 'ide-windows.json')

function loadState(): Record<string, SavedBounds> {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8')) as unknown
    return raw && typeof raw === 'object' ? (raw as Record<string, SavedBounds>) : {}
  } catch {
    return {}
  }
}

function saveState(key: string, win: BrowserWindow): void {
  try {
    const all = loadState()
    const b = win.getNormalBounds()
    all[key] = { ...b, maximized: win.isMaximized() }
    // 窗口数量有限，直接整份写回；文件很小
    writeFileSync(statePath(), JSON.stringify(all, null, 2), 'utf8')
  } catch {
    // 状态存不下来不影响窗口本身
  }
}

function visibleOnSomeDisplay(b: SavedBounds): boolean {
  return screen.getAllDisplays().some((d) => {
    const w = d.workArea
    return (
      b.x < w.x + w.width &&
      b.x + b.width > w.x &&
      b.y < w.y + w.height &&
      b.y + b.height > w.y
    )
  })
}

function initialBounds(key: string): { width: number; height: number; x?: number; y?: number; maximized: boolean } {
  const saved = loadState()[key]
  if (saved && visibleOnSomeDisplay(saved)) {
    return {
      width: Math.max(900, saved.width),
      height: Math.max(600, saved.height),
      x: saved.x,
      y: saved.y,
      maximized: saved.maximized === true
    }
  }
  return { width: 1280, height: 860, maximized: false }
}

function rendererUrl(
  cwd: string,
  target?: IdeTarget
): { url?: string; file?: string; query: Record<string, string> } {
  const query: Record<string, string> = { view: 'ide', cwd }
  if (target) {
    query.file = target.rel
    if (target.line) query.line = String(target.line)
  }
  const dev = process.env.ELECTRON_RENDERER_URL
  if (dev) {
    const q = new URLSearchParams(query).toString()
    return { url: `${dev}?${q}`, query }
  }
  return { file: join(__dirname, '../renderer/index.html'), query }
}

/**
 * 在一个已经开着的 IDE 窗口里打开文件。
 *
 * 窗口可能正在加载（用户连点两次），此时立刻 `send` 会丢 —— 等
 * `did-finish-load` 再发。preload 还会把早到的消息攒住，两层兜底。
 */
function revealInWindow(win: BrowserWindow, target: IdeTarget): void {
  const send = (): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    try {
      win.webContents.send(IPC.ideReveal, target)
    } catch (e) {
      logMain('ide-window.reveal', e)
    }
  }
  if (win.webContents.isLoadingMainFrame()) win.webContents.once('did-finish-load', send)
  else send()
}

/**
 * 打开（或聚焦）某个工作区的 IDE，并定位到一个文件。
 *
 * `file` 是工具给的原始路径，绝对相对都行；这里统一换算成工作区
 * 相对路径，并拒绝 `..` 越界 —— 和 ide-fs 的检查同一套语义。
 *
 * 工作区**之外**的文件不再直接拒绝：工具卡里的路径可能来自临时目录
 * （例如粘贴的截图），那时以文件所在目录为根另开一个 IDE 窗口。
 * 打开的文件仍然只能是真实存在的普通文件；窗口的读写权限也只覆盖
 * 这个目录，不会顺着工具给的路径扩大到别处。
 */
export function openFileInIde(cwd: string, file: string, line?: number): IdeOpenResult {
  if (!cwd || !file.trim()) return { ok: false, message: t('ideWindow.noFile') }

  const root = resolve(cwd)
  const abs = isAbsolute(file) ? resolve(file) : resolve(root, file)
  const rel = relative(root, abs)
  const target = (r: string): IdeTarget => ({
    rel: r.replace(/\\/g, '/'),
    ...(line && line > 0 ? { line: Math.floor(line) } : {})
  })

  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    try {
      if (!statSync(abs).isFile()) return { ok: false, message: t('ideWindow.notAFile', { path: abs }) }
    } catch {
      return { ok: false, message: t('ideWindow.missing', { path: abs }) }
    }
    openIdeWindow(dirname(abs), target(basename(abs)))
    return { ok: true }
  }

  openIdeWindow(cwd, target(rel))
  return { ok: true }
}

export function openIdeWindow(cwd: string, initialTarget?: IdeTarget): void {
  if (!cwd || !existsSync(cwd)) return
  try {
    if (!statSync(cwd).isDirectory()) return
  } catch {
    return
  }

  const key = keyOf(cwd)
  const existing = windows.get(key)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    if (initialTarget) revealInWindow(existing, initialTarget)
    return
  }

  const bounds = initialBounds(key)
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x != null && bounds.y != null ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    title: `CCoder IDE — ${basename(cwd)}`,
    backgroundColor: windowBg(),
    webPreferences: {
      // 验证脚本直接把 ide-window 单独打包到 tools/ 时 __dirname 会指错，
      // 允许用环境变量覆盖；正常运行时走打包产物里的相对路径。
      preload: process.env.CCODER_PRELOAD_PATH || join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  labelWindow(win, `ide:${cwd}`)

  windows.set(key, win)
  const senderId = win.webContents.id
  senderCwds.set(senderId, key)
  senderWindows.set(senderId, win)
  // 渲染进程崩溃时不会触发 closed；先收掉这个 sender 的搜索 / 终端子进程
  win.webContents.on('render-process-gone', () => {
    hooks.onSenderClosed?.(senderId)
  })
  hooks.onOpened?.(cwd)

  /*
   * 外部文件变化（Agent / 终端 / 其他编辑器）由 watcher 去抖后推给这个窗口。
   * 页面还在加载时只留一个合并批次，加载完再发；首屏本来就会读取最新状态，
   * 所以即便早期事件被合并掉也不会丢数据。
   */
  let pendingWatch: IdeFsChanged | null = null
  let watchLoadQueued = false
  const mergeWatch = (a: IdeFsChanged, b: IdeFsChanged): IdeFsChanged => {
    const merged = Array.from(new Set([...a.rels, ...b.rels]))
    const rels = merged.slice(0, 500)
    return {
      rels,
      truncated: a.truncated || b.truncated || merged.length > rels.length,
      generic: a.generic || b.generic
    }
  }
  const flushPendingWatch = (): void => {
    watchLoadQueued = false
    const batch = pendingWatch
    pendingWatch = null
    if (batch) safeSend(win, IPC.ideFsChanged, batch)
  }
  const pushWatch = (batch: IdeFsChanged): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    if (win.webContents.isLoadingMainFrame()) {
      pendingWatch = pendingWatch ? mergeWatch(pendingWatch, batch) : batch
      if (!watchLoadQueued) {
        watchLoadQueued = true
        win.webContents.once('did-finish-load', flushPendingWatch)
      }
      return
    }
    safeSend(win, IPC.ideFsChanged, batch)
  }
  const stopWatch = startWorkspaceWatch(cwd, pushWatch)

  win.once('ready-to-show', () => {
    win.show()
    if (bounds.maximized) win.maximize()
  })

  const pushMaximized = (): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    try {
      win.webContents.send(IPC.winMaximizedChanged, win.isMaximized())
    } catch (e) {
      logMain('ide-window.maximized', e)
    }
  }
  // 拖动窗口会连续触发 move/resize，攒一下再落盘
  let saveTimer: NodeJS.Timeout | null = null
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveState(key, win)
    }, 250)
  }
  win.on('maximize', () => {
    pushMaximized()
    saveState(key, win)
  })
  win.on('unmaximize', () => {
    pushMaximized()
    saveState(key, win)
  })
  win.on('resize', scheduleSave)
  win.on('move', scheduleSave)

  /*
   * 渲染进程被超大文件 / diff 卡住时，窗口自己的关闭逻辑也走不动
   * （标题栏关闭要经过渲染层）。这里给一个不依赖渲染层的逃生口。
   */
  win.on('unresponsive', () => {
    if (win.isDestroyed()) return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      noLink: true,
      buttons: [t('main.dialog.keepWaiting'), t('main.dialog.forceClose')],
      defaultId: 1,
      cancelId: 0,
      title: t('main.dialog.ideUnresponsiveTitle'),
      message: t('main.dialog.ideUnresponsiveMessage'),
      detail: t('main.dialog.ideUnresponsiveDetail')
    })
    if (choice === 1 && !win.isDestroyed()) win.destroy()
  })

  win.on('close', (e) => {
    if (saveTimer) clearTimeout(saveTimer)
    saveState(key, win)
    if (dirtySenders.has(senderId) && !closeConfirmed.has(senderId)) {
      e.preventDefault()
      safeSend(win, IPC.ideCloseRequest)
    }
  })
  win.on('closed', () => {
    stopWatch()
    pendingWatch = null
    hooks.onSenderClosed?.(senderId)
    windows.delete(key)
    senderCwds.delete(senderId)
    senderWindows.delete(senderId)
    dirtySenders.delete(senderId)
    closeConfirmed.delete(senderId)
    hooks.onClosed?.(cwd)
  })

  // 外链交给系统浏览器，IDE 窗口本身不做导航
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url).catch((e) => logMain('openExternal', e))
    return { action: 'deny' }
  })

  const target = rendererUrl(cwd, initialTarget)
  // loadURL / loadFile 的 Promise 必须有人接，否则加载失败会变成
  // unhandledRejection —— 在打包版里等于主进程静默退出。
  const loading = target.url
    ? win.loadURL(target.url)
    : target.file
      ? win.loadFile(target.file, { query: target.query })
      : Promise.resolve()
  loading.catch((e) => logMain('ide-window.load', e))
}
