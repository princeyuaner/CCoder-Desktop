import { join } from 'node:path'
import { app, dialog, shell, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { IPC } from '../shared/ipc'
import type { PermissionMode } from '../shared/events'
import type { Channel, Settings } from '../shared/settings'
import type {
  PermissionDecision,
  QuestionAnswer,
  SessionSendInput,
  SessionStartOptions
} from '../shared/session'
import { loadSettings, saveSettings } from './settings-store'
import { testChannel } from './claude-runner'
import { deleteStoredSession, listStoredSessions, readTranscript } from './session-store'
import { SessionManager } from './session-manager'
import { searchWorkspaceFiles } from './workspace-search'

/** 窗口底色跟主题走 —— 页面渲染前和缩放重绘时都不会闪出另一套颜色 */
const WINDOW_BG = { dark: '#191919', light: '#f6f6f7' } as const

function windowBg(): string {
  return nativeTheme.shouldUseDarkColors ? WINDOW_BG.dark : WINDOW_BG.light
}

/**
 * 无边框窗口（frame: false）。标题栏由渲染进程自绘，
 * 窗口控件经 preload 暴露的 window.api 走 IPC 回来。
 *
 * 注意：`frame: false` 之后，双击标题栏最大化、拖拽贴边分屏这些
 * 系统行为都不再自动生效 —— 双击要自己处理，拖拽靠 CSS 的
 * -webkit-app-region。这是自绘标题栏的固定代价。
 */
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    frame: false,
    backgroundColor: windowBg(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 渲染进程不开 Node，能力一律经 preload 白名单暴露
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // 最大化状态要推给渲染进程，标题栏才能换图标（□ ↔ ❐）
  const pushMaximized = (): void => {
    win.webContents.send(IPC.winMaximizedChanged, win.isMaximized())
  }
  win.on('maximize', pushMaximized)
  win.on('unmaximize', pushMaximized)

  // 页面里的外链一律交给系统浏览器，绝不在应用窗口里导航
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function registerWindowIpc(): void {
  const target = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender)

  ipcMain.on(IPC.winMinimize, (e) => target(e)?.minimize())
  ipcMain.on(IPC.winClose, (e) => target(e)?.close())
  ipcMain.on(IPC.winToggleMaximize, (e) => {
    const w = target(e)
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  ipcMain.handle(IPC.winIsMaximized, (e) => target(e)?.isMaximized() ?? false)
}

function registerSettingsIpc(): void {
  ipcMain.handle(IPC.settingsGet, (): Settings => loadSettings())

  ipcMain.handle(IPC.settingsSave, (_e, incoming: Settings): Settings => {
    saveSettings(incoming)
    // 主题交给 Electron：原生控件、菜单、对话框跟着变，system 时继续跟系统走
    nativeTheme.themeSource = incoming.theme
    const bg = windowBg()
    const fresh = loadSettings()
    // 广播给所有窗口，将来多窗口时天然同步
    for (const w of BrowserWindow.getAllWindows()) {
      w.setBackgroundColor(bg)
      w.webContents.send(IPC.settingsChanged, fresh)
    }
    return fresh
  })

  ipcMain.handle(IPC.channelTest, (_e, channel: Channel) => testChannel(channel))

  // 会话存储归 CLI 所有：我们只读它写的，唯一的写操作是"删掉一整条"
  ipcMain.handle(IPC.sessionsList, () => listStoredSessions())
  ipcMain.handle(IPC.sessionsTranscript, (_e, cwd: string, id: string) =>
    readTranscript(cwd, id)
  )
}

/** @ 文件引用：主进程异步扫描工作区，渲染进程只拿相对路径 */
function registerWorkspaceIpc(): void {
  ipcMain.handle(IPC.workspaceSearchFiles, (_e, cwd: string, query: string, limit?: number) =>
    searchWorkspaceFiles(cwd, query, limit)
  )
}

/** 会话事件广播给所有窗口 —— 多窗口时天然同步 */
function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
}

function registerSessionIpc(sessions: SessionManager): void {
  // 删会话要连进程一起收 —— 放在这里是因为它需要 SessionManager
  ipcMain.handle(IPC.sessionsDelete, (_e, cwd: string, id: string) => {
    // 正在跑的那条先把进程收掉，否则 Windows 上文件被占着 unlink 会 EPERM
    sessions.stopByProviderId(id)
    return deleteStoredSession(cwd, id)
  })

  // 工作区不是自动扫出来的，得用户手动打开 —— 这里就是那个"打开"
  ipcMain.handle(IPC.sessionsPickDir, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const r = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '打开工作区' })
      : await dialog.showOpenDialog({ properties: ['openDirectory'], title: '打开工作区' })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })

  // 界面重载后侧栏要重新知道哪些会话在跑（平时靠 sessionStatus 增量维护）
  ipcMain.handle(IPC.sessionRunning, () => sessions.runningIds())

  ipcMain.handle(IPC.sessionStart, (_e, o: SessionStartOptions) => sessions.start(o))
  ipcMain.handle(IPC.sessionSend, (_e, id: string, input: SessionSendInput) =>
    sessions.send(id, input)
  )
  ipcMain.on(IPC.sessionInterrupt, (_e, id: string) => sessions.interrupt(id))
  ipcMain.on(IPC.sessionStop, (_e, id: string) => sessions.stop(id))
  ipcMain.on(
    IPC.sessionRespondPermission,
    (_e, id: string, requestId: string, decision: PermissionDecision, always: boolean) =>
      sessions.respondPermission(id, requestId, decision, always)
  )
  ipcMain.on(
    IPC.sessionRespondQuestion,
    (_e, id: string, requestId: string, answer: QuestionAnswer) =>
      sessions.respondQuestion(id, requestId, answer)
  )
  ipcMain.on(
    IPC.sessionReconfigure,
    (_e, id: string, patch: { model?: string; permissionMode?: PermissionMode }) =>
      sessions.reconfigure(id, patch)
  )
}

app.whenReady().then(() => {
  // 建窗口前先定主题：窗口底色和原生控件都跟着它走，避免启动时闪一下另一套颜色
  nativeTheme.themeSource = loadSettings().theme
  // 「跟随系统」时 Windows 切换深浅色，窗口底色也要跟着换（渲染层的 CSS 由 matchMedia 处理）
  nativeTheme.on('updated', () => {
    const bg = windowBg()
    for (const w of BrowserWindow.getAllWindows()) w.setBackgroundColor(bg)
  })

  const sessions = new SessionManager(
    loadSettings,
    (p) => broadcast(IPC.sessionEvent, p),
    (p) => broadcast(IPC.sessionStatus, p)
  )

  registerWindowIpc()
  registerSettingsIpc()
  registerSessionIpc(sessions)
  registerWorkspaceIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // 退出前收掉所有 CLI 子进程，别留孤儿
  app.on('before-quit', () => sessions.stopAll())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
