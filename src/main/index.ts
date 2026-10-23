import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { app, crashReporter, dialog, shell, BrowserWindow, ipcMain, nativeTheme } from 'electron'
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
import { checkCodexStatus, testCodexChannel } from './codex-runner'
import { checkDshStatus, testDshChannel } from './providers/dsh/adapter'
import {
  cancelClaudeLogin,
  claudeLoginSnapshot,
  disposeClaudeAuth,
  initClaudeAuth,
  logoutClaude,
  probeClaudeAuth,
  startClaudeLogin,
  submitClaudeLoginCode
} from './claude-auth'
import { deleteStoredSession, listStoredSessions, readTranscript } from './session-store'
import { SessionManager } from './session-manager'
import { searchWorkspaceFiles } from './workspace-search'
import {
  createEntry,
  deleteEntry,
  listDir,
  readImageResult,
  readTextFileResult,
  renameEntry,
  replaceInWorkspace,
  saveTextFile,
  searchCode
} from './ide-fs'
import {
  authorizeVcsSender,
  closeIdeWindow,
  hasIdeWindowUnder,
  isIdeSender,
  markIdeDirty,
  openFileInIde,
  openIdeWindow
} from './ide-window'
import type {
  IdeCreateRequest,
  IdeDeleteRequest,
  IdeRenameRequest,
  IdeReplaceRequest,
  IdeSaveRequest,
  IdeSearchRequest
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
  VcsUpdateRequest,
  VcsWorktreeAddRequest,
  VcsWorktreeListRequest,
  VcsWorktreePruneRequest,
  VcsWorktreeRemoveRequest
} from '../shared/vcs'
import {
  isChatMainSender,
  listChatTargets,
  openSessionInChat,
  reportActiveChat,
  sendRefsToChat,
  setChatMainWindow
} from './chat-bridge'
import type { ChatActiveInfo, IdeSendPayload } from '../shared/ide-chat'
import { pathKey } from './path-key'
import { applyNativeTheme, windowBg } from './window-theme'
import { createUpdater, registerUpdaterIpc } from './updater'
import { installCrashHandlers, logFilePath, logMain } from './crash-log'
import { labelOf, labelWindow } from './window-log'
import { safeSend } from './safe-send'
import type { RendererLogReport } from '../shared/log'
import { resolveLanguage } from '../shared/i18n'
import { applyLanguageSetting, initMainI18n, mainLocaleInfo, t } from './i18n'

/*
 * 崩溃现场：主进程的 JS 异常、渲染进程 / GPU 进程消失都会写进
 * userData/logs/main.log。必须先装处理器再碰任何会抛的东西。
 *
 * crashReporter 只落本地 dump、不上传，原生崩溃时也能拿到堆栈。
 */
installCrashHandlers()
try {
  crashReporter.start({ uploadToServer: false, compress: false })
} catch (e) {
  logMain('crashReporter.start', e)
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

  // 日志里的窗口身份（崩溃时能分清是聊天窗口还是 IDE 窗口）
  labelWindow(win, 'chat')

  // IDE 的「发送到聊天」需要把引用投递到主窗口；主窗口只有一个
  setChatMainWindow(win)
  win.on('closed', () => setChatMainWindow(null))

  win.on('ready-to-show', () => win.show())

  // 最大化状态要推给渲染进程，标题栏才能换图标（□ ↔ ❐）
  const pushMaximized = (): void => {
    safeSend(win, IPC.winMaximizedChanged, win.isMaximized())
  }
  win.on('maximize', pushMaximized)
  win.on('unmaximize', pushMaximized)

  // 页面里的外链一律交给系统浏览器，绝不在应用窗口里导航
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url).catch((e) => logMain('openExternal', e))
    return { action: 'deny' }
  })

  // loadURL / loadFile 返回 Promise：失败（dev server 没起来、产物缺失）
  // 若没人接就会变成 unhandledRejection，直接结束主进程。
  const loading = process.env.ELECTRON_RENDERER_URL
    ? win.loadURL(process.env.ELECTRON_RENDERER_URL)
    : win.loadFile(join(__dirname, '../renderer/index.html'))
  loading.catch((e) => logMain('main-window.load', e))

  return win
}

function registerWindowIpc(): void {
  const target = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender)

  /*
   * 渲染进程的未捕获异常 / Promise 拒绝。
   *
   * payload 来自渲染层，按不可信处理：字段类型和长度都要拦，避免一条坏消息
   * 把日志写爆或者把异常带进主进程。只落盘，不回复。
   */
  ipcMain.on(IPC.rendererLog, (e, raw: unknown) => {
    if (!raw || typeof raw !== 'object') return
    const r = raw as Partial<RendererLogReport>
    const clip = (v: unknown, max: number): string | undefined =>
      typeof v === 'string' && v ? (v.length > max ? `${v.slice(0, max)}…` : v) : undefined
    logMain('renderer', {
      window: labelOf(e.sender),
      id: e.sender.id,
      kind: clip(r.kind, 40),
      message: clip(r.message, 4000),
      stack: clip(r.stack, 8000),
      source: clip(r.source, 1000),
      line: typeof r.line === 'number' ? r.line : undefined,
      column: typeof r.column === 'number' ? r.column : undefined,
      url: clip(r.url, 1000)
    })
  })

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

/** 把一份已经落盘的设置推给所有窗口（语言、主题、底色、渲染层状态） */
function pushSettings(fresh: Settings): void {
  // 语言先落到主进程：随后的原生对话框 / IPC 错误都用新语言
  applyLanguageSetting(fresh.language)
  // 主题交给 Electron：原生控件、菜单、对话框跟着变，system 时继续跟系统走
  applyNativeTheme(fresh.theme)
  const bg = windowBg()
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.setBackgroundColor(bg)
    } catch {
      // 窗口正在销毁，跳过
    }
    safeSend(w, IPC.settingsChanged, fresh)
  }
}

function registerSettingsIpc(sessions: SessionManager): void {
  ipcMain.handle(IPC.settingsGet, (): Settings => loadSettings())

  // 系统语言只由主进程解析；渲染层启动时拿一次，之后本地用同一个函数解析
  ipcMain.handle(IPC.localeInfo, () => mainLocaleInfo())

  ipcMain.handle(IPC.settingsSave, (_e, incoming: Settings): Settings => {
    const before = loadSettings()
    saveSettings(incoming)
    const fresh = loadSettings()
    // 先切语言再通知会话：settingsChanged 触发的提示要用新语言
    applyLanguageSetting(fresh.language)
    // 凭据来源 / 官方默认模型是启动参数：让正在跑的会话在下一轮换进程
    sessions.settingsChanged(before, fresh)
    pushSettings(fresh)
    return fresh
  })

  ipcMain.handle(IPC.channelTest, (_e, channel: Channel) => {
    if (channel.kind === 'deepseek') return testDshChannel(channel)
    return channel.kind === 'openai' ? testCodexChannel(channel) : testChannel(channel)
  })

  ipcMain.handle(IPC.codexStatus, () => checkCodexStatus())
  ipcMain.handle(IPC.dshStatus, (_e, channelId?: string | null) => checkDshStatus(channelId))

  // 会话存储归 CLI 所有：我们只读它写的，唯一的写操作是"删掉一整条"
  ipcMain.handle(IPC.sessionsList, () => listStoredSessions())
  ipcMain.handle(IPC.sessionsTranscript, (_e, cwd: string, id: string) =>
    readTranscript(cwd, id)
  )
}

/**
 * Claude Code 官方登录。
 *
 * login 只负责拉起进程；URL / 输出 / 阶段由主进程广播（注册在 whenReady 里，
 * 见 initClaudeAuth），设置页订阅即可。授权码只从主进程写进 stdin。
 */
function registerClaudeAuthIpc(): void {
  ipcMain.handle(IPC.claudeAuthStatus, () => probeClaudeAuth())
  ipcMain.handle(IPC.claudeAuthLogin, () => startClaudeLogin())
  ipcMain.handle(IPC.claudeAuthSubmitCode, (_e, code: unknown) =>
    submitClaudeLoginCode(typeof code === 'string' ? code : '')
  )
  ipcMain.handle(IPC.claudeAuthCancel, () => cancelClaudeLogin())
  ipcMain.handle(IPC.claudeAuthLogout, () => logoutClaude())
  ipcMain.handle(IPC.claudeAuthLoginState, () => claudeLoginSnapshot())
}

/** @ 文件引用：主进程异步扫描工作区，渲染进程只拿相对路径 */
function registerWorkspaceIpc(): void {
  ipcMain.handle(IPC.workspaceSearchFiles, (_e, cwd: string, query: string, limit?: number) =>
    searchWorkspaceFiles(cwd, query, limit)
  )

  /**
   * IDE 请求主窗口在某个目录开新会话。
   *
   * `openedCwds` 必须在主进程合并：IDE 窗口没有 Settings 状态，
   * 让它拿一份旧快照整份 save 会覆盖主窗口刚改的主题 / 渠道等字段。
   */
  ipcMain.handle(IPC.workspaceOpenSession, (e, cwd: unknown) => {
    if (!isIdeSender(e.sender.id)) {
      return { ok: false, message: t('main.ideOnlyOpenSession') }
    }
    if (typeof cwd !== 'string' || !cwd.trim()) {
      return { ok: false, message: t('main.invalidPath') }
    }
    if (!isAbsolute(cwd)) {
      return { ok: false, message: t('main.absolutePathRequired') }
    }

    const abs = resolve(cwd)
    try {
      if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        return { ok: false, message: t('main.dirMissing') }
      }
    } catch {
      return { ok: false, message: t('main.dirUnreadable') }
    }

    try {
      const fresh = loadSettings()
      if (!fresh.openedCwds.some((c) => pathKey(c) === pathKey(abs))) {
        saveSettings({ ...fresh, openedCwds: [abs, ...fresh.openedCwds] })
        pushSettings(loadSettings())
      }
    } catch {
      // 设置落盘失败不应该挡住打开会话
    }

    return openSessionInChat(abs)
  })
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
    throw new Error(t('main.workspaceForbidden'))
  }
  /** 读文件的 handler 现在返回结构化结果，拒绝也要走同一条形状 */
  const denyReadResult = (): { ok: false; code: 'forbidden'; message: string } => ({
    ok: false,
    code: 'forbidden',
    message: t('main.workspaceForbidden')
  })
  const denyWrite = (): { ok: false; code: 'forbidden'; message: string } => ({
    ok: false,
    code: 'forbidden',
    message: t('main.workspaceWriteForbidden')
  })

  ipcMain.handle(IPC.ideListDir, (e, cwd: string, rel: string) =>
    allow(e, cwd) ? listDir(cwd, rel) : denyRead()
  )
  ipcMain.handle(IPC.ideReadFile, (e, cwd: string, rel: string) =>
    allow(e, cwd) ? readTextFileResult(cwd, rel) : denyReadResult()
  )
  ipcMain.handle(IPC.ideReadImage, (e, cwd: string, rel: string) =>
    allow(e, cwd) ? readImageResult(cwd, rel) : denyReadResult()
  )
  ipcMain.handle(IPC.ideSearchCode, (e, req: IdeSearchRequest) =>
    req && allow(e, req.cwd) ? searchCode(req) : denyRead()
  )
  ipcMain.handle(IPC.ideReplaceInWorkspace, (e, req: IdeReplaceRequest) =>
    req && allow(e, req.cwd) ? replaceInWorkspace(req) : denyWrite()
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
function registerVcsIpc(sessions: SessionManager): void {
  const deny = (): { ok: false; error: { code: 'forbidden'; message: string } } => ({
    ok: false,
    error: { code: 'forbidden', message: t('main.workspaceOpForbidden') }
  })
  const busy = (message: string): { ok: false; error: { code: 'busy'; message: string } } => ({
    ok: false,
    error: { code: 'busy', message }
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
  ipcMain.handle(IPC.vcsWorktreeList, (e, req: VcsWorktreeListRequest) =>
    req && allow(e, req.cwd) ? vcs.worktreeList(req) : deny()
  )
  ipcMain.handle(IPC.vcsWorktreeAdd, (e, req: VcsWorktreeAddRequest) =>
    req && allow(e, req.cwd) ? vcs.worktreeAdd(req) : deny()
  )
  ipcMain.handle(IPC.vcsWorktreePrune, (e, req: VcsWorktreePruneRequest) =>
    req && allow(e, req.cwd) ? vcs.worktreePrune(req) : deny()
  )
  ipcMain.handle(IPC.vcsWorktreeRemove, async (e, req: VcsWorktreeRemoveRequest) => {
    if (!req || !allow(e, req.cwd)) return deny()
    if (typeof req.path !== 'string' || !isAbsolute(req.path)) return deny()

    // 目录被 IDE 窗口或活跃会话占着时，Windows 上删不干净，
    // 而且删完还会让它们的后续读写落到一个不存在的目录。
    if (hasIdeWindowUnder(req.path)) return busy(t('main.closeIdeFirst'))
    if (sessions.hasLiveSessionIn(req.path)) return busy(t('main.stopSessionsFirst'))

    const r = await vcs.worktreeRemove(req)
    if (r.ok) {
      // 工作树目录已经没了，顺手把它从侧栏白名单里摘掉。
      // 仍然只在主进程合并，避免渲染层拿旧快照整份回写。
      try {
        const fresh = loadSettings()
        const next = fresh.openedCwds.filter((c) => pathKey(c) !== pathKey(req.path))
        if (next.length !== fresh.openedCwds.length) {
          saveSettings({ ...fresh, openedCwds: next })
          pushSettings(loadSettings())
        }
      } catch {
        // 清理失败不影响删除结果
      }
    }
    return r
  })

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
      return { ok: false, message: t('main.refsIncomplete') }
    }
    return sendRefsToChat(payload)
  })
}

/** 会话事件广播给所有窗口 —— 多窗口时天然同步 */
function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) safeSend(w, channel, payload)
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
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: t('main.dialog.openWorkspace') })
      : await dialog.showOpenDialog({ properties: ['openDirectory'], title: t('main.dialog.openWorkspace') })
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
  // 建窗口前先定语言和主题：原生对话框 / IPC 返回值和首屏都要用
  const initial = loadSettings()
  const systemLocale = app.getSystemLocale?.() ?? app.getLocale()
  initMainI18n({
    systemLocale,
    resolved: resolveLanguage(initial.language, systemLocale)
  })

  // 建窗口前先定主题：窗口底色和原生控件都跟着它走，避免启动时闪一下另一套颜色
  applyNativeTheme(initial.theme)
  // 「跟随系统」时 Windows 切换深浅色，窗口底色也要跟着换（渲染层的 CSS 由 matchMedia 处理）
  nativeTheme.on('updated', () => {
    const bg = windowBg()
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        w.setBackgroundColor(bg)
      } catch {
        // 窗口正在销毁
      }
    }
  })

  /*
   * 启动头信息：日志被用户单独发过来时，至少能知道是哪台机器、哪个版本、
   * 装在哪儿、日志和崩溃 dump 在哪。排查时省掉一轮追问。
   */
  let crashDumps = ''
  try {
    crashDumps = app.getPath('crashDumps')
  } catch {
    // 个别环境不支持这个路径，不影响其余信息
  }
  logMain('app.start', {
    version: app.getVersion(),
    packaged: app.isPackaged,
    pid: process.pid,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    locale: app.getLocale(),
    execPath: process.execPath,
    appPath: app.getAppPath(),
    userData: app.getPath('userData'),
    logs: logFilePath(),
    crashDumps
  })

  // 渲染进程 / GPU / 工具进程消失：先落盘再让应用继续
  app.on('render-process-gone', (_e, contents, details) => {
    logMain('render-process-gone', {
      window: labelOf(contents),
      id: contents.id,
      ...details
    })
  })
  app.on('child-process-gone', (_e, details) => {
    logMain('child-process-gone', details)
  })

  const sessions = new SessionManager(
    loadSettings,
    (p) => broadcast(IPC.sessionEvent, p),
    (p) => broadcast(IPC.sessionStatus, p)
  )

  // 登录状态机不直接碰 electron：事件出口和"打开浏览器"都从这里注入
  initClaudeAuth({
    emit: (e) => broadcast(IPC.claudeAuthEvent, e),
    openUrl: (url) => void shell.openExternal(url).catch((e) => logMain('openExternal', e))
  })

  // 自动更新：检查 / 下载 / 安装都由主进程做，状态广播给界面。
  // 开发模式与便携版会自己进入 unsupported，不发起任何网络请求。
  const updater = createUpdater({
    emit: (state) => broadcast(IPC.updaterEvent, state),
    hasBusySessions: () => sessions.hasBusySessions(),
    beforeInstall: () => sessions.stopAll()
  })
  registerUpdaterIpc(updater)

  registerWindowIpc()
  registerSettingsIpc(sessions)
  registerClaudeAuthIpc()
  registerSessionIpc(sessions)
  registerWorkspaceIpc()
  registerIdeIpc()
  registerVcsIpc(sessions)
  registerChatBridgeIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // 退出前收掉所有 CLI 子进程（包括还在等授权码的登录进程），别留孤儿
  app.on('before-quit', () => {
    logMain('app', 'before-quit')
    sessions.stopAll()
    disposeClaudeAuth()
  })

  // 和 before-quit 配对：有 before-quit 没 will-quit / quit 说明退出卡在收尾阶段
  app.on('will-quit', () => logMain('app', 'will-quit'))
  app.on('quit', (_e, code) => logMain('app', `quit code=${code}`))
})

app.on('window-all-closed', () => {
  logMain('app', 'window-all-closed')
  if (process.platform !== 'darwin') app.quit()
})
