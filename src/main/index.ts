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
import {
  createEntry,
  deleteEntry,
  listDir,
  readImage,
  readTextFile,
  renameEntry,
  saveTextFile,
  searchCode
} from './ide-fs'
import {
  authorizeVcsSender,
  closeIdeWindow,
  markIdeDirty,
  openFileInIde,
  openIdeWindow
} from './ide-window'
import type {
  IdeCreateRequest,
  IdeDeleteRequest,
  IdeRenameRequest,
  IdeSaveRequest
} from '../shared/ide'
import * as vcs from './vcs'
import type {
  VcsCancelRequest,
  VcsCommitDetailRequest,
  VcsCommitRequest,
  VcsDiffRequest,
  VcsDiscardRequest,
  VcsLogRequest,
  VcsPathsRequest,
  VcsPullRequest,
  VcsPushRequest,
  VcsRequestBase,
  VcsResolveRequest,
  VcsRevertRequest,
  VcsStatusRequest,
  VcsUpdateRequest
} from '../shared/vcs'
import {
  isChatMainSender,
  listChatTargets,
  reportActiveChat,
  sendRefsToChat,
  setChatMainWindow
} from './chat-bridge'
import type { ChatActiveInfo, IdeSendPayload } from '../shared/ide-chat'
import { applyNativeTheme, windowBg } from './window-theme'

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

  // IDE 的「发送到聊天」需要把引用投递到主窗口；主窗口只有一个
  setChatMainWindow(win)
  win.on('closed', () => setChatMainWindow(null))

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
    applyNativeTheme(incoming.theme)
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

/** 独立 IDE 窗口的文件 / 搜索能力。写操作按窗口绑定的工作区授权。 */
function registerIdeIpc(): void {
  ipcMain.handle(IPC.ideOpen, (_e, cwd: string) => openIdeWindow(cwd))
  ipcMain.handle(IPC.ideOpenFile, (_e, cwd: string, file: string, line?: number) =>
    openFileInIde(cwd, file, line)
  )

  const allow = (e: Electron.IpcMainInvokeEvent, cwd: unknown): boolean =>
    typeof cwd === 'string' && authorizeVcsSender(e.sender.id, cwd)
  const denyRead = (): never => {
    throw new Error('这个窗口不能访问该工作区')
  }
  const denyWrite = (): { ok: false; code: 'forbidden'; message: string } => ({
    ok: false,
    code: 'forbidden',
    message: '这个窗口不能修改该工作区'
  })

  ipcMain.handle(IPC.ideListDir, (e, cwd: string, rel: string) =>
    allow(e, cwd) ? listDir(cwd, rel) : denyRead()
  )
  ipcMain.handle(IPC.ideReadFile, (e, cwd: string, rel: string) =>
    allow(e, cwd) ? readTextFile(cwd, rel) : denyRead()
  )
  ipcMain.handle(IPC.ideReadImage, (e, cwd: string, rel: string) =>
    allow(e, cwd) ? readImage(cwd, rel) : denyRead()
  )
  ipcMain.handle(IPC.ideSearchCode, (e, cwd: string, query: string) =>
    allow(e, cwd) ? searchCode(cwd, query) : denyRead()
  )
  ipcMain.handle(IPC.ideSaveFile, (e, req: IdeSaveRequest) =>
    req && allow(e, req.cwd) ? saveTextFile(req) : denyWrite()
  )
  ipcMain.handle(IPC.ideCreateEntry, (e, req: IdeCreateRequest) =>
    req && allow(e, req.cwd) ? createEntry(req) : denyWrite()
  )
  ipcMain.handle(IPC.ideRenameEntry, (e, req: IdeRenameRequest) =>
    req && allow(e, req.cwd) ? renameEntry(req) : denyWrite()
  )
  ipcMain.handle(IPC.ideDeleteEntry, (e, req: IdeDeleteRequest) =>
    req && allow(e, req.cwd) ? deleteEntry(req) : denyWrite()
  )

  ipcMain.on(IPC.ideDirty, (e, dirty: unknown) => markIdeDirty(e.sender.id, dirty === true))
  ipcMain.on(IPC.ideConfirmClose, (e) => closeIdeWindow(e.sender.id))
}

/**
 * Git / SVN。只有绑定到该工作区的 IDE 窗口能调用 —— 渲染层传来的 cwd
 * 不可信，必须和窗口创建时记录的工作区一致。
 */
function registerVcsIpc(): void {
  const deny = (): { ok: false; error: { code: 'forbidden'; message: string } } => ({
    ok: false,
    error: { code: 'forbidden', message: '这个窗口不能操作该工作区' }
  })
  const allow = (e: Electron.IpcMainInvokeEvent, cwd: unknown): boolean =>
    typeof cwd === 'string' && authorizeVcsSender(e.sender.id, cwd)

  ipcMain.handle(IPC.vcsDetect, (e, cwd: string) =>
    allow(e, cwd) ? vcs.detect(cwd) : deny()
  )
  ipcMain.handle(IPC.vcsStatus, (e, req: VcsStatusRequest) =>
    req && allow(e, req.cwd) ? vcs.status(req) : deny()
  )
  ipcMain.handle(IPC.vcsDiff, (e, req: VcsDiffRequest) =>
    req && allow(e, req.cwd) ? vcs.diff(req) : deny()
  )
  ipcMain.handle(IPC.vcsLog, (e, req: VcsLogRequest) =>
    req && allow(e, req.cwd) ? vcs.log(req) : deny()
  )
  ipcMain.handle(IPC.vcsCommitDetail, (e, req: VcsCommitDetailRequest) =>
    req && allow(e, req.cwd) ? vcs.commitDetail(req) : deny()
  )
  ipcMain.handle(IPC.vcsStage, (e, req: VcsPathsRequest) =>
    req && allow(e, req.cwd) ? vcs.stage(req) : deny()
  )
  ipcMain.handle(IPC.vcsUnstage, (e, req: VcsPathsRequest) =>
    req && allow(e, req.cwd) ? vcs.unstage(req) : deny()
  )
  ipcMain.handle(IPC.vcsDiscard, (e, req: VcsDiscardRequest) =>
    req && allow(e, req.cwd) ? vcs.discard(req) : deny()
  )
  ipcMain.handle(IPC.vcsRevert, (e, req: VcsRevertRequest) =>
    req && allow(e, req.cwd) ? vcs.revert(req) : deny()
  )
  ipcMain.handle(IPC.vcsResolve, (e, req: VcsResolveRequest) =>
    req && allow(e, req.cwd) ? vcs.resolve(req) : deny()
  )
  ipcMain.handle(IPC.vcsCommit, (e, req: VcsCommitRequest) =>
    req && allow(e, req.cwd) ? vcs.commit(req) : deny()
  )
  ipcMain.handle(IPC.vcsFetch, (e, req: VcsRequestBase) =>
    req && allow(e, req.cwd) ? vcs.fetch(req) : deny()
  )
  ipcMain.handle(IPC.vcsPull, (e, req: VcsPullRequest) =>
    req && allow(e, req.cwd) ? vcs.pull(req) : deny()
  )
  ipcMain.handle(IPC.vcsPush, (e, req: VcsPushRequest) =>
    req && allow(e, req.cwd) ? vcs.push(req) : deny()
  )
  ipcMain.handle(IPC.vcsUpdate, (e, req: VcsUpdateRequest) =>
    req && allow(e, req.cwd) ? vcs.update(req) : deny()
  )
  ipcMain.handle(IPC.vcsCancel, (e, req: VcsCancelRequest) =>
    req && allow(e, req.cwd) ? vcs.cancel(req) : deny()
  )
}

/** IDE → 聊天：目标列表与引用投递 */
function registerChatBridgeIpc(): void {
  ipcMain.on(IPC.chatReportActive, (e, info: ChatActiveInfo) => {
    if (!isChatMainSender(e.sender.id)) return
    if (!info || typeof info.cwd !== 'string') return
    reportActiveChat(info)
  })

  ipcMain.handle(IPC.ideChatTargets, (_e, cwd: string) =>
    typeof cwd === 'string' ? listChatTargets(cwd) : []
  )

  ipcMain.handle(IPC.ideSendRefs, (_e, payload: IdeSendPayload) => {
    if (!payload || !Array.isArray(payload.refs) || !payload.target) {
      return { ok: false, message: '引用数据不完整' }
    }
    return sendRefsToChat(payload)
  })
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
  applyNativeTheme(loadSettings().theme)
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
  registerIdeIpc()
  registerVcsIpc()
  registerChatBridgeIpc()
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
