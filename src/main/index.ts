import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, crashReporter, dialog, shell, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { IPC } from '../shared/ipc'
import type { PermissionMode } from '../shared/events'
import type { Channel, CliId, Settings } from '../shared/settings'
import type { SyncConfig } from '../shared/sync'
import type {
  PermissionDecision,
  QuestionAnswer,
  SessionMetaUpdate,
  SessionSendInput,
  SessionStartOptions
} from '../shared/session'
import { loadSettings, saveSettings } from './settings-store'
import {
  coerceMcpInput,
  isMcpScope,
  MCP_SCOPES,
  type DshHomeOption,
  type McpMigrationPreview,
  type McpMigrationResult,
  type McpScope,
  type McpServerInput
} from '../shared/mcp'
import {
  asCliId,
  clearMcpProbeCache,
  listMcpServers,
  removeMcpServer,
  saveMcpServer,
  setMcpEnabled,
  testAllMcpServers,
  testMcpServer
} from './mcp-service'
import { createMcpNativeContext, defaultDshHome, sourcePathFor } from './mcp-native'
import { applyMigration, previewMigration } from './mcp-migration'
import {
  coerceSkillInput,
  isSkillScope,
  SKILL_SCOPES,
  type SkillInput,
  type SkillScope
} from '../shared/skills'
import {
  asSkillCliId,
  importSkill,
  listSkills,
  removeSkill,
  saveSkill,
  setSkillEnabled,
  sourcePathOf
} from './skills-service'
import { createSkillNativeContext } from './skills-native'
import {
  defaultDshHomeForSettings,
  listDshHomeOptions
} from './providers/dsh/runner'
import { testChannel } from './claude-runner'
import { checkCodexStatus, testCodexChannel } from './codex-runner'
import { checkDshStatus, testDshChannel } from './providers/dsh/adapter'
import { disposeAllDshWebHosts } from './providers/dsh/web/host'
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
import {
  cancelCliUpdate,
  checkCliUpdate,
  cliUpdateStates,
  disposeCliUpdate,
  initCliUpdate,
  retryCliUpdateElevated,
  startCliUpdate,
  startCliUpdateAutoCheck
} from './cli-update'
import {
  deleteStoredSession,
  listStoredSessions,
  readTranscript,
  searchStoredSessions
} from './session-store'
import {
  forgetSessionMeta,
  getSessionMeta,
  updateSessionMeta
} from './session-meta-store'
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
  focusIdeWindow,
  hasIdeWindowUnder,
  isIdeSender,
  markIdeDirty,
  openFileInIde,
  openIdeWindow,
  sendToIdeSender,
  sendToIdeWindow,
  setIdeWindowHooks
} from './ide-window'
import {
  cancelAllIdeSearches,
  cancelIdeSearch,
  cancelIdeSearchesForSender,
  startIdeSearch
} from './ide-search-service'
import {
  killAllTerminals,
  killTerminal,
  killTerminalsForSender,
  resizeTerminal,
  startTerminal,
  writeTerminal
} from './ide-terminal'
import {
  configureLspHost,
  killAllLsp,
  notifyLsp,
  requestLsp,
  startLsp,
  stopLsp,
  stopLspForSender
} from './lsp/host'
import type { LspNotification, LspRequest, LspStartRequest } from '../shared/lsp'
import type {
  IdeCreateRequest,
  IdeDeleteRequest,
  IdeRenameRequest,
  IdeReplaceRequest,
  IdeSaveRequest,
  IdeSearchRequest,
  IdeSearchStartRequest,
  IdeTerminalStartRequest
} from '../shared/ide'
import * as vcs from './vcs'
import type {
  VcsBranchListRequest,
  VcsCancelRequest,
  VcsCommitDetailRequest,
  VcsCommitRequest,
  VcsDiffRequest,
  VcsDiscardRequest,
  VcsLogRequest,
  VcsMergeWorktreeRequest,
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
  VcsWorktreeMapRequest,
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
import { isSameOrInside, pathKey } from './path-key'
import { applyNativeTheme, windowBg } from './window-theme'
import { createUpdater, registerUpdaterIpc } from './updater'
import { installCrashHandlers, logFilePath, logMain } from './crash-log'
import { labelOf, labelWindow } from './window-log'
import { safeSend } from './safe-send'
import { configureSyncHost } from './sync/host'
import {
  disposeAllSync,
  disposeSync,
  ensureSync,
  getSyncState,
  saveSyncConfig,
  syncNow
} from './sync/manager'
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
    // 凭据来源是启动参数：让正在跑的会话在下一轮换进程。
    // 官方默认模型只影响新会话 —— 已有会话的模型是各会话自己选的，不在这里跟。
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
/**
 * MCP 的 IPC。
 *
 * cli / cwd / server 都来自渲染层，按不可信处理：cli 不认识就直接拒绝，
 * server 先 coerce 成已知字段，再由 mcp-service 做业务校验。
 */
function registerMcpIpc(sessions: SessionManager): void {
  const cliOrThrow = (raw: unknown): CliId => {
    const cli = asCliId(raw)
    if (!cli) throw new Error(t('mcp.error.invalidCli'))
    return cli
  }
  const cwdOf = (raw: unknown): string =>
    typeof raw === 'string' ? raw.slice(0, 4096) : ''

  const context = (): ReturnType<typeof createMcpNativeContext> => {
    const settings = loadSettings()
    const options = listDshHomeOptions(settings)
    const active = defaultDshHomeForSettings(settings)
    const homes: string[] = []
    const push = (p: string): void => {
      if (!p) return
      if (homes.some((h) => pathKey(h) === pathKey(p))) return
      homes.push(p)
    }
    push(active)
    for (const o of options) push(o.path)
    return createMcpNativeContext({
      backupRoot: join(app.getPath('userData'), 'mcp-backups'),
      dshHomes: homes
    })
  }

  /** dshHome 只接受主进程列出的 home，避免渲染进程写任意目录 */
  const homeOf = (cli: CliId, raw: unknown, ctx: ReturnType<typeof context>): string | undefined => {
    if (cli !== 'dsh') return undefined
    const fallback = ctx.dshHomes[0] ?? defaultDshHome(ctx)
    if (typeof raw !== 'string' || !raw.trim()) return fallback
    const key = pathKey(raw)
    return ctx.dshHomes.find((h) => pathKey(h) === key)
  }

  const scopeOf = (cli: CliId, raw: unknown): McpScope => {
    if (!isMcpScope(raw) || !MCP_SCOPES[cli].includes(raw)) {
      throw new Error(t('mcp.error.invalidScope'))
    }
    return raw
  }

  /** 写入 Claude local/project 前确认 cwd 是当前工作区，避免写到任意目录 */
  const assertKnownCwd = (cwd: string): void => {
    if (!cwd.trim()) throw new Error(t('mcp.error.cwdRequired'))
    const settings = loadSettings()
    const known = [settings.defaultCwd, ...settings.openedCwds].filter(Boolean)
    if (!known.some((k) => pathKey(k) === pathKey(cwd))) {
      throw new Error(t('mcp.error.cwdNotAllowed'))
    }
    try {
      if (!statSync(cwd).isDirectory()) throw new Error('not a directory')
    } catch {
      throw new Error(t('mcp.error.cwdNotAllowed'))
    }
  }

  const list = (
    cli: CliId,
    cwd: string,
    home: string | undefined,
    ctx: ReturnType<typeof context>
  ) => listMcpServers(cli, cwd, ctx, { dshHome: home })

  ipcMain.handle(
    IPC.mcpList,
    (_e, cliRaw: unknown, cwdRaw: unknown, dshHomeRaw: unknown) => {
      const cli = cliOrThrow(cliRaw)
      const ctx = context()
      return list(cli, cwdOf(cwdRaw), homeOf(cli, dshHomeRaw, ctx), ctx)
    }
  )

  ipcMain.handle(
    IPC.mcpSave,
    (_e, cliRaw: unknown, serverRaw: unknown, cwdRaw: unknown, dshHomeRaw: unknown) => {
      const cli = cliOrThrow(cliRaw)
      const ctx = context()
      const home = homeOf(cli, dshHomeRaw, ctx)
      const cwd = cwdOf(cwdRaw)
      const input: McpServerInput = coerceMcpInput(serverRaw)
      if (input.scope === 'local' || input.scope === 'project') {
        assertKnownCwd(input.cwd || cwd)
      }
      const result = saveMcpServer(cli, input, cwd, ctx, { dshHome: home })
      if (result.ok) sessions.mcpChanged(cli, { scope: input.scope, cwd: input.cwd || cwd })
      return result
    }
  )

  ipcMain.handle(
    IPC.mcpRemove,
    (_e, cliRaw: unknown, idRaw: unknown, cwdRaw: unknown, dshHomeRaw: unknown) => {
      const cli = cliOrThrow(cliRaw)
      const ctx = context()
      const home = homeOf(cli, dshHomeRaw, ctx)
      const cwd = cwdOf(cwdRaw)
      if (cwd) assertKnownCwd(cwd)
      const id = typeof idRaw === 'string' ? idRaw : ''
      const result = removeMcpServer(cli, id, cwd, ctx, { dshHome: home })
      if (result.ok) sessions.mcpChanged(cli)
      return result
    }
  )

  ipcMain.handle(
    IPC.mcpSetEnabled,
    (
      _e,
      cliRaw: unknown,
      idRaw: unknown,
      enabledRaw: unknown,
      cwdRaw: unknown,
      dshHomeRaw: unknown
    ) => {
      const cli = cliOrThrow(cliRaw)
      const ctx = context()
      const home = homeOf(cli, dshHomeRaw, ctx)
      const cwd = cwdOf(cwdRaw)
      if (cwd) assertKnownCwd(cwd)
      const id = typeof idRaw === 'string' ? idRaw : ''
      const result = setMcpEnabled(cli, id, enabledRaw !== false, cwd, ctx, {
        dshHome: home
      })
      if (result.ok) sessions.mcpChanged(cli)
      return result
    }
  )

  ipcMain.handle(
    IPC.mcpTest,
    (_e, cliRaw: unknown, serverRaw: unknown) =>
      testMcpServer(cliOrThrow(cliRaw), coerceMcpInput(serverRaw))
  )

  ipcMain.handle(
    IPC.mcpTestAll,
    (_e, cliRaw: unknown, cwdRaw: unknown, dshHomeRaw: unknown) => {
      const cli = cliOrThrow(cliRaw)
      const ctx = context()
      return testAllMcpServers(cli, cwdOf(cwdRaw), ctx, {
        dshHome: homeOf(cli, dshHomeRaw, ctx)
      })
    }
  )

  ipcMain.handle(IPC.mcpDshHomes, (): DshHomeOption[] =>
    listDshHomeOptions(loadSettings()).map((o) => ({
      path: o.path,
      label: o.channelName ?? '',
      kind: o.kind,
      active: o.active,
      exists: o.exists
    }))
  )

  ipcMain.handle(
    IPC.mcpOpenConfig,
    async (
      _e,
      cliRaw: unknown,
      scopeRaw: unknown,
      cwdRaw: unknown,
      dshHomeRaw: unknown
    ) => {
      const cli = cliOrThrow(cliRaw)
      const scope = scopeOf(cli, scopeRaw)
      const ctx = context()
      const cwd = cwdOf(cwdRaw)
      if (scope === 'local' || scope === 'project') assertKnownCwd(cwd)
      const file = sourcePathFor(cli, scope, { cwd, dshHome: homeOf(cli, dshHomeRaw, ctx) }, ctx)
      if (!file) return { ok: false, error: t('mcp.error.invalidScope') }
      const target = existsSync(file) ? file : dirname(file)
      const err = await shell.openPath(target)
      return err ? { ok: false, error: err } : { ok: true }
    }
  )

  ipcMain.handle(
    IPC.mcpRevealConfig,
    async (
      _e,
      cliRaw: unknown,
      scopeRaw: unknown,
      cwdRaw: unknown,
      dshHomeRaw: unknown
    ) => {
      const cli = cliOrThrow(cliRaw)
      const scope = scopeOf(cli, scopeRaw)
      const ctx = context()
      const cwd = cwdOf(cwdRaw)
      if (scope === 'local' || scope === 'project') assertKnownCwd(cwd)
      const file = sourcePathFor(cli, scope, { cwd, dshHome: homeOf(cli, dshHomeRaw, ctx) }, ctx)
      if (!file) return { ok: false, error: t('mcp.error.invalidScope') }
      if (existsSync(file)) shell.showItemInFolder(file)
      else {
        const err = await shell.openPath(dirname(file))
        if (err) return { ok: false, error: err }
      }
      return { ok: true }
    }
  )

  ipcMain.handle(IPC.mcpOpenBackups, async () => {
    const dir = join(app.getPath('userData'), 'mcp-backups')
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      // openPath 会给出错误
    }
    const err = await shell.openPath(dir)
    return err ? { ok: false, error: err } : { ok: true }
  })

  ipcMain.handle(IPC.mcpMigration, (_e, dshHomeRaw: unknown): McpMigrationPreview => {
    const ctx = context()
    const home =
      homeOf('dsh', dshHomeRaw, ctx) ??
      ctx.dshHomes[0] ??
      defaultDshHomeForSettings(loadSettings())
    return previewMigration(ctx, home)
  })

  ipcMain.handle(
    IPC.mcpMigrate,
    (_e, idsRaw: unknown, dshHomeRaw: unknown): McpMigrationResult => {
      const ctx = context()
      const home =
        homeOf('dsh', dshHomeRaw, ctx) ??
        ctx.dshHomes[0] ??
        defaultDshHomeForSettings(loadSettings())
      const ids = Array.isArray(idsRaw)
        ? idsRaw.filter((x): x is string => typeof x === 'string').slice(0, 5000)
        : []
      const result = applyMigration(ids, ctx, home)
      clearMcpProbeCache()
      if (result.migrated > 0) {
        sessions.mcpChanged('claude')
        sessions.mcpChanged('codex')
        sessions.mcpChanged('dsh')
      }
      return result
    }
  )
}

/**
 * Skills 的 IPC。
 *
 * 和 MCP 一样，cli / cwd / home / input 全部按不可信处理：cli 不认识就
 * 拒绝，cwd 必须是当前已知工作区，DSH home 只能从主进程列出的目录里选。
 * 真正写哪个路径由 skills-service 根据 scope 计算，渲染层永远不传路径。
 */
function registerSkillsIpc(): void {
  const cliOrThrow = (raw: unknown): CliId => {
    const cli = asSkillCliId(raw)
    if (!cli) throw new Error(t('skill.error.invalidCli'))
    return cli
  }
  const cwdOf = (raw: unknown): string => (typeof raw === 'string' ? raw.slice(0, 4096) : '')

  const context = (): ReturnType<typeof createSkillNativeContext> => {
    const settings = loadSettings()
    const options = listDshHomeOptions(settings)
    const active = defaultDshHomeForSettings(settings)
    const homes: string[] = []
    const push = (p: string): void => {
      if (!p) return
      if (homes.some((h) => pathKey(h) === pathKey(p))) return
      homes.push(p)
    }
    push(active)
    for (const o of options) push(o.path)
    return createSkillNativeContext({
      backupRoot: join(app.getPath('userData'), 'skills-backups'),
      dshHomes: homes
    })
  }

  const homeOf = (
    cli: CliId,
    raw: unknown,
    ctx: ReturnType<typeof context>
  ): string | undefined => {
    if (cli !== 'dsh') return undefined
    const fallback = ctx.dshHomes[0]
    if (typeof raw !== 'string' || !raw.trim()) return fallback
    const key = pathKey(raw)
    return ctx.dshHomes.find((h) => pathKey(h) === key) ?? fallback
  }

  const assertKnownCwd = (cwd: string): void => {
    if (!cwd.trim()) throw new Error(t('skill.error.cwdRequired'))
    const settings = loadSettings()
    const known = [settings.defaultCwd, ...settings.openedCwds].filter(Boolean)
    if (!known.some((k) => pathKey(k) === pathKey(cwd))) {
      throw new Error(t('skill.error.cwdNotAllowed'))
    }
    try {
      if (!statSync(cwd).isDirectory()) throw new Error('not a directory')
    } catch {
      throw new Error(t('skill.error.cwdNotAllowed'))
    }
  }

  const scopeOf = (cli: CliId, raw: unknown): SkillScope => {
    if (!isSkillScope(raw) || !SKILL_SCOPES[cli].includes(raw)) {
      throw new Error(t('skill.error.invalidScope'))
    }
    return raw
  }

  ipcMain.handle(IPC.skillsList, (_e, cliRaw: unknown, cwdRaw: unknown, homeRaw: unknown) => {
    const cli = cliOrThrow(cliRaw)
    const ctx = context()
    return listSkills(cli, cwdOf(cwdRaw), ctx, { dshHome: homeOf(cli, homeRaw, ctx) })
  })

  ipcMain.handle(
    IPC.skillsSave,
    (_e, cliRaw: unknown, inputRaw: unknown, cwdRaw: unknown, homeRaw: unknown) => {
      const cli = cliOrThrow(cliRaw)
      const ctx = context()
      const home = homeOf(cli, homeRaw, ctx)
      const cwd = cwdOf(cwdRaw)
      const input: SkillInput = coerceSkillInput(inputRaw)
      if (input.scope === 'project') assertKnownCwd(input.cwd || cwd)
      return saveSkill(cli, input, cwd, ctx, { dshHome: home })
    }
  )

  ipcMain.handle(
    IPC.skillsRemove,
    (_e, cliRaw: unknown, idRaw: unknown, cwdRaw: unknown, homeRaw: unknown) => {
      const cli = cliOrThrow(cliRaw)
      const ctx = context()
      const home = homeOf(cli, homeRaw, ctx)
      const cwd = cwdOf(cwdRaw)
      if (cwd) assertKnownCwd(cwd)
      const id = typeof idRaw === 'string' ? idRaw : ''
      return removeSkill(cli, id, cwd, ctx, { dshHome: home })
    }
  )

  ipcMain.handle(
    IPC.skillsSetEnabled,
    (
      _e,
      cliRaw: unknown,
      idRaw: unknown,
      enabledRaw: unknown,
      cwdRaw: unknown,
      homeRaw: unknown
    ) => {
      const cli = cliOrThrow(cliRaw)
      const ctx = context()
      const home = homeOf(cli, homeRaw, ctx)
      const cwd = cwdOf(cwdRaw)
      if (cwd) assertKnownCwd(cwd)
      const id = typeof idRaw === 'string' ? idRaw : ''
      return setSkillEnabled(cli, id, enabledRaw === true, cwd, ctx, { dshHome: home })
    }
  )

  ipcMain.handle(
    IPC.skillsImport,
    async (_e, cliRaw: unknown, scopeRaw: unknown, cwdRaw: unknown, homeRaw: unknown) => {
      const cli = cliOrThrow(cliRaw)
      const scope = scopeOf(cli, scopeRaw)
      const ctx = context()
      const home = homeOf(cli, homeRaw, ctx)
      const cwd = cwdOf(cwdRaw)
      if (scope === 'project') assertKnownCwd(cwd)

      const picked = await dialog.showOpenDialog({
        title: cli === 'codex' ? t('skill.import.pickFile') : t('skill.import.pickFolder'),
        properties: cli === 'codex' ? ['openFile'] : ['openDirectory'],
        filters: cli === 'codex' ? [{ name: 'Markdown', extensions: ['md'] }] : undefined
      })
      if (picked.canceled || !picked.filePaths[0]) {
        return {
          ok: false,
          cancelled: true,
          list: listSkills(cli, cwd, ctx, { dshHome: home })
        }
      }
      return importSkill(cli, scope, cwd, picked.filePaths[0], ctx, { dshHome: home })
    }
  )

  ipcMain.handle(IPC.skillsDshHomes, (): DshHomeOption[] =>
    listDshHomeOptions(loadSettings()).map((o) => ({
      path: o.path,
      label: o.channelName ?? '',
      kind: o.kind,
      active: o.active,
      exists: o.exists
    }))
  )

  ipcMain.handle(
    IPC.skillsOpenDir,
    async (_e, cliRaw: unknown, scopeRaw: unknown, cwdRaw: unknown, homeRaw: unknown) => {
      const cli = cliOrThrow(cliRaw)
      const scope = scopeOf(cli, scopeRaw)
      const ctx = context()
      const cwd = cwdOf(cwdRaw)
      if (scope === 'project') assertKnownCwd(cwd)
      const dir = sourcePathOf(cli, scope, cwd, ctx, { dshHome: homeOf(cli, homeRaw, ctx) })
      if (!dir) return { ok: false, error: t('skill.error.invalidScope') }
      try {
        if (scope !== 'plugin') mkdirSync(dir, { recursive: true })
      } catch {
        // openPath 会给出具体错误
      }
      const err = await shell.openPath(dir)
      return err ? { ok: false, error: err } : { ok: true }
    }
  )

  ipcMain.handle(
    IPC.skillsOpenFile,
    async (_e, cliRaw: unknown, idRaw: unknown, cwdRaw: unknown, homeRaw: unknown) => {
      const cli = cliOrThrow(cliRaw)
      const ctx = context()
      const cwd = cwdOf(cwdRaw)
      const home = homeOf(cli, homeRaw, ctx)
      const id = typeof idRaw === 'string' ? idRaw : ''
      const view = listSkills(cli, cwd, ctx, { dshHome: home }).skills.find((s) => s.id === id)
      if (!view) return { ok: false, error: t('skill.error.notFound') }
      if (existsSync(view.path)) {
        const err = await shell.openPath(view.path)
        return err ? { ok: false, error: err } : { ok: true }
      }
      if (existsSync(view.dirPath)) {
        const err = await shell.openPath(view.dirPath)
        return err ? { ok: false, error: err } : { ok: true }
      }
      return { ok: false, error: t('skill.error.notFound') }
    }
  )

  ipcMain.handle(
    IPC.skillsOpenResource,
    async (_e, cliRaw: unknown, idRaw: unknown, relRaw: unknown, cwdRaw: unknown, homeRaw: unknown) => {
      const cli = cliOrThrow(cliRaw)
      const ctx = context()
      const cwd = cwdOf(cwdRaw)
      const home = homeOf(cli, homeRaw, ctx)
      const id = typeof idRaw === 'string' ? idRaw : ''
      const rel = typeof relRaw === 'string' ? relRaw.slice(0, 2048) : ''
      const view = listSkills(cli, cwd, ctx, { dshHome: home }).skills.find((s) => s.id === id)
      if (!view) return { ok: false, error: t('skill.error.notFound') }
      if (!rel || isAbsolute(rel)) return { ok: false, error: t('skill.error.notFound') }
      // 只允许打开列表里出现过的资源，避免构造 ../ 读技能目录外的东西
      if (!view.resources.some((r) => r.path === rel)) {
        return { ok: false, error: t('skill.error.notFound') }
      }
      let target = resolve(view.dirPath, rel)
      if (rel === view.fileLabel || rel === `${view.name}.md`) target = view.path
      const inside = relative(view.dirPath, target)
      if (inside.startsWith('..') || isAbsolute(inside)) {
        return { ok: false, error: t('skill.error.notFound') }
      }
      if (!existsSync(target)) return { ok: false, error: t('skill.error.notFound') }
      const err = await shell.openPath(target)
      return err ? { ok: false, error: err } : { ok: true }
    }
  )

  ipcMain.handle(IPC.skillsOpenBackups, async () => {
    const dir = join(app.getPath('userData'), 'skills-backups')
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      // openPath 会给出错误
    }
    const err = await shell.openPath(dir)
    return err ? { ok: false, error: err } : { ok: true }
  })
}

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

/**
 * CLI 自身的更新。
 *
 * 渲染层只能传 cli 名，包名与目标版本都由主进程按上一次检查的结果决定 ——
 * 这个入口不能变成「让界面随便执行一条 npm 命令」。
 */
function registerCliUpdateIpc(): void {
  ipcMain.handle(IPC.cliUpdateStates, () => cliUpdateStates())
  ipcMain.handle(IPC.cliUpdateCheck, (_e, cliRaw: unknown, force?: unknown) => {
    const cli = asCliId(cliRaw)
    if (!cli) return null
    return checkCliUpdate(cli, { force: force === true })
  })
  ipcMain.handle(IPC.cliUpdateRun, (_e, cliRaw: unknown) => {
    const cli = asCliId(cliRaw)
    if (!cli) return { ok: false, message: t('cliUpdate.notAvailable') }
    return startCliUpdate(cli)
  })
  ipcMain.handle(IPC.cliUpdateElevated, (_e, cliRaw: unknown) => {
    const cli = asCliId(cliRaw)
    if (!cli) return { ok: false, message: t('cliUpdate.notAvailable') }
    return retryCliUpdateElevated(cli)
  })
  ipcMain.handle(IPC.cliUpdateCancel, () => cancelCliUpdate())
}

/**
 * 对话里的链接只允许打开这些类型。
 *
 * 必须是白名单而不是黑名单：`shell.openPath` 走系统关联，`.bat` / `.js` /
 * `.exe` 在 Windows 上会被直接执行 —— 而链接目标可能来自模型输出，也就
 * 可能来自提示注入。
 */
const CHAT_OPENABLE_EXTS = new Set([
  // 网页 / 图片
  '.html', '.htm', '.xhtml', '.svg',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico',
  // 文档 / 数据
  '.pdf', '.md', '.markdown', '.txt', '.log', '.csv', '.json', '.jsonc',
  // 源码（交给默认编辑器，不会执行）
  '.ts', '.tsx', '.jsx', '.css', '.scss', '.less', '.vue', '.svelte',
  '.yml', '.yaml', '.toml', '.ini', '.xml', '.sql'
])

/** @ 文件引用：主进程异步扫描工作区，渲染进程只拿相对路径 */
function registerWorkspaceIpc(): void {
  ipcMain.handle(IPC.workspaceSearchFiles, (_e, cwd: string, query: string, limit?: number) =>
    searchWorkspaceFiles(cwd, query, limit)
  )

  /**
   * 打开对话里点到的地址。
   *
   * 渲染层只负责把 Markdown 链接送过来，路径解析与安全检查全在这里：
   * 相对路径按会话 cwd 解析，绝对路径必须是本机文件，外链只放行 http(s)。
   */
  ipcMain.handle(IPC.workspaceOpenPath, async (_e, cwdRaw: unknown, targetRaw: unknown) => {
    const target = typeof targetRaw === 'string' ? targetRaw.trim() : ''
    if (!target) return { ok: false, error: t('workspace.openPath.empty') }
    if (target.length > 4096) return { ok: false, error: t('workspace.openPath.invalid') }

    if (/^https?:\/\//i.test(target)) {
      try {
        const url = new URL(target)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol')
        await shell.openExternal(url.toString())
        return { ok: true }
      } catch {
        return { ok: false, error: t('workspace.openPath.invalid') }
      }
    }

    let file = target
    if (/^file:/i.test(target)) {
      try {
        file = fileURLToPath(target)
      } catch {
        return { ok: false, error: t('workspace.openPath.invalid') }
      }
    } else if (!isAbsolute(target) && /^[a-z][a-z0-9+.-]*:/i.test(target)) {
      // javascript: / ms-msdt: / smb: … 一律不接
      return { ok: false, error: t('workspace.openPath.unsupported') }
    }

    // UNC 会触发 SMB 认证，不让聊天里的链接碰网络路径
    if (/^[\\/]{2}/.test(file)) {
      return { ok: false, error: t('workspace.openPath.unsupported') }
    }

    const cwd = typeof cwdRaw === 'string' ? cwdRaw.trim() : ''
    if (!isAbsolute(file) && !cwd) {
      return { ok: false, error: t('workspace.openPath.noCwd') }
    }
    const abs = isAbsolute(file) ? resolve(file) : resolve(cwd, file)

    let isDir = false
    try {
      isDir = statSync(abs).isDirectory()
    } catch {
      return { ok: false, error: t('workspace.openPath.missing') }
    }
    if (!isDir && !CHAT_OPENABLE_EXTS.has(extname(abs).toLowerCase())) {
      return { ok: false, error: t('workspace.openPath.unsupported') }
    }

    const err = await shell.openPath(abs)
    return err ? { ok: false, error: err } : { ok: true }
  })

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
  configureLspHost({ send: sendToIdeSender, log: logMain })
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
  ipcMain.handle(IPC.ideSearchStart, (e, req: IdeSearchStartRequest) => {
    if (!req || typeof req !== 'object' || typeof req.cwd !== 'string' || !allow(e, req.cwd)) {
      return denyReadResult()
    }
    return startIdeSearch({
      senderId: e.sender.id,
      req,
      send: (event) => sendToIdeSender(e.sender.id, IPC.ideSearchEvent, event)
    })
  })
  ipcMain.on(IPC.ideSearchCancel, (e, requestId: unknown) => {
    if (requestId === undefined) cancelIdeSearch(e.sender.id)
    else if (typeof requestId === 'string') cancelIdeSearch(e.sender.id, requestId)
  })
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

  ipcMain.handle(IPC.ideTerminalStart, (e, req: IdeTerminalStartRequest) => {
    if (
      !req ||
      typeof req.cwd !== 'string' ||
      typeof req.id !== 'string' ||
      !allow(e, req.cwd)
    ) {
      return { ok: false, error: t('main.workspaceForbidden') }
    }
    return startTerminal(e.sender.id, req.cwd, req.id, req.cols, req.rows)
  })
  ipcMain.on(IPC.ideTerminalWrite, (e, id: unknown, data: unknown) => {
    if (typeof id === 'string' && typeof data === 'string') {
      writeTerminal(e.sender.id, id, data)
    }
  })
  ipcMain.on(IPC.ideTerminalResize, (e, id: unknown, cols: unknown, rows: unknown) => {
    if (typeof id === 'string' && typeof cols === 'number' && typeof rows === 'number') {
      resizeTerminal(e.sender.id, id, cols, rows)
    }
  })
  ipcMain.on(IPC.ideTerminalKill, (e, id: unknown) => {
    if (typeof id === 'string') killTerminal(e.sender.id, id)
  })

  ipcMain.handle(IPC.lspStart, (e, req: LspStartRequest) => {
    if (
      !req ||
      typeof req.cwd !== 'string' ||
      typeof req.language !== 'string' ||
      !allow(e, req.cwd)
    ) {
      return { ok: false, code: 'forbidden', error: t('main.workspaceForbidden') }
    }
    return startLsp(e.sender.id, req.cwd, req.language)
  })
  ipcMain.on(IPC.lspStop, (e, cwd: unknown, language: unknown) => {
    if (typeof cwd !== 'string' || !authorizeVcsSender(e.sender.id, cwd)) return
    stopLsp(e.sender.id, cwd, typeof language === 'string' ? language : undefined)
  })
  ipcMain.handle(IPC.lspRequest, (e, req: LspRequest) => {
    if (
      !req ||
      typeof req.cwd !== 'string' ||
      typeof req.language !== 'string' ||
      typeof req.method !== 'string' ||
      !allow(e, req.cwd)
    ) {
      return { ok: false, code: 'forbidden', error: t('main.workspaceForbidden') }
    }
    return requestLsp(e.sender.id, req)
  })
  ipcMain.on(IPC.lspNotify, (e, req: LspNotification) => {
    if (
      !req ||
      typeof req.cwd !== 'string' ||
      typeof req.language !== 'string' ||
      typeof req.method !== 'string' ||
      !authorizeVcsSender(e.sender.id, req.cwd)
    ) {
      return
    }
    notifyLsp(e.sender.id, req)
  })

  ipcMain.on(IPC.ideDirty, (e, dirty: unknown) => markIdeDirty(e.sender.id, dirty === true))
  ipcMain.on(IPC.ideConfirmClose, (e) => closeIdeWindow(e.sender.id))
}

/**
 * Git / SVN。IDE 窗口只能调用绑定到自己的那个工作区；聊天主窗口可以
 * 调用已打开工作区的 VCS —— 「新建会话」弹窗要在主窗口里列分支、建工作树。
 * 渲染层传来的 cwd 仍然按不可信处理，必须先过白名单。
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
  const knownWorkspace = (cwd: string): boolean => {
    try {
      const settings = loadSettings()
      const known = [settings.defaultCwd, ...settings.openedCwds].filter(Boolean)
      // 会话的 cwd 可能是工作区里的子目录（比如从子目录启动过 CLI）
      return known.some((c) => isSameOrInside(cwd, c))
    } catch {
      return false
    }
  }
  const allow = (e: Electron.IpcMainInvokeEvent, cwd: unknown): boolean =>
    typeof cwd === 'string' &&
    (authorizeVcsSender(e.sender.id, cwd) ||
      (isChatMainSender(e.sender.id) && knownWorkspace(cwd)))

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
  ipcMain.handle(IPC.vcsBranches, (e, req: VcsBranchListRequest) =>
    req && allow(e, req.cwd) ? vcs.branches(req) : deny()
  )
  ipcMain.handle(IPC.vcsWorktreeMap, (e, req: VcsWorktreeMapRequest) => {
    if (!req || !Array.isArray(req.cwds)) return deny()
    const cwds = [...new Set(req.cwds)]
      .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
      .slice(0, 500)
    // 逐个 cwd 过白名单；失效/不可访问的目录直接忽略，不影响其它分组
    const permitted = cwds.filter((c) => allow(e, c))
    if (!permitted.length) return { ok: true, data: { entries: [] } }
    return vcs.worktreeMap({ cwds: permitted })
  })
  ipcMain.handle(IPC.vcsWorktreeList, (e, req: VcsWorktreeListRequest) =>
    req && allow(e, req.cwd) ? vcs.worktreeList(req) : deny()
  )
  ipcMain.handle(IPC.vcsWorktreeAdd, (e, req: VcsWorktreeAddRequest) =>
    req && allow(e, req.cwd) ? vcs.worktreeAdd(req) : deny()
  )
  ipcMain.handle(IPC.vcsMergeWorktree, (e, req: VcsMergeWorktreeRequest) =>
    req && allow(e, req.cwd) ? vcs.mergeWorktree(req) : deny()
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

/** 目录同步：配置、状态、目录选择、手动触发。按 IDE 窗口绑定的工作区授权。 */
function registerSyncIpc(): void {
  const allow = (e: Electron.IpcMainInvokeEvent, cwd: unknown): cwd is string =>
    typeof cwd === 'string' && authorizeVcsSender(e.sender.id, cwd)
  const deny = (): never => {
    throw new Error(t('main.workspaceForbidden'))
  }

  ipcMain.handle(IPC.syncGet, (e, cwd: string) => (allow(e, cwd) ? getSyncState(cwd) : deny()))

  ipcMain.handle(IPC.syncSave, (e, cwd: string, config: unknown) => {
    if (!allow(e, cwd)) deny()
    if (!config || typeof config !== 'object') {
      throw new Error(t('main.invalidPath'))
    }
    return saveSyncConfig(cwd, config as SyncConfig)
  })

  ipcMain.handle(IPC.syncPickDir, async (e, cwd: string, which: unknown) => {
    if (!allow(e, cwd)) return null
    const win = BrowserWindow.fromWebContents(e.sender)
    const title = which === 'dst' ? t('sync.dialog.pickTarget') : t('sync.dialog.pickSource')
    const r = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'], title })
      : await dialog.showOpenDialog({ properties: ['openDirectory'], title })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC.syncNow, (e, cwd: string) => {
    if (!allow(e, cwd)) return { ok: false, message: t('main.workspaceForbidden') }
    return syncNow(cwd)
  })

  ipcMain.handle(IPC.syncOpenTarget, async (e, cwd: string) => {
    if (!allow(e, cwd)) return { ok: false, message: t('main.workspaceForbidden') }
    const state = getSyncState(cwd)
    const dst = state.config.dst
    if (!dst) return { ok: false, message: t('sync.error.noDst') }
    const err = await shell.openPath(dst)
    return err ? { ok: false, message: err } : { ok: true }
  })
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
  ipcMain.handle(IPC.sessionsDelete, async (_e, cwd: string, id: string) => {
    // 正在跑的那条先把进程收掉，否则 Windows 上文件被占着 unlink 会 EPERM
    sessions.stopByProviderId(id)
    const r = await deleteStoredSession(cwd, id)
    // 记录都删了，重命名 / 置顶 / 归档也没有存在的意义
    if (r.ok) forgetSessionMeta(cwd, id)
    return r
  })

  // 重命名 / 置顶 / 归档只动应用自己的那一份元数据，不碰 CLI 的记录文件
  ipcMain.handle(IPC.sessionsMeta, () => getSessionMeta())
  ipcMain.handle(IPC.sessionsSetMeta, (_e, update: SessionMetaUpdate) =>
    updateSessionMeta(update)
  )
  ipcMain.handle(IPC.sessionsSearch, (_e, query: string, limit?: number, offset?: number) =>
    searchStoredSessions(
      typeof query === 'string' ? query : '',
      limit,
      offset
    )
  )

  // 工作区不是自动扫出来的，得用户手动打开 —— 这里就是那个"打开"
  ipcMain.handle(IPC.sessionsPickDir, async (e, title?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    // 调用方可以带标题（如「新建工作区」）；不带就沿用默认的「打开工作区」
    const dialogTitle =
      typeof title === 'string' && title.trim()
        ? title.trim()
        : t('main.dialog.openWorkspace')
    const r = win
      ? await dialog.showOpenDialog(win, {
          properties: ['openDirectory'],
          title: dialogTitle
        })
      : await dialog.showOpenDialog({
          properties: ['openDirectory'],
          title: dialogTitle
        })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })

  // 界面重载后侧栏要重新知道哪些会话在跑（平时靠 sessionStatus 增量维护）
  ipcMain.handle(IPC.sessionRunning, () => sessions.runningIds())

  ipcMain.handle(IPC.sessionStart, (_e, o: SessionStartOptions) => sessions.start(o))
  ipcMain.handle(IPC.sessionSend, (_e, id: string, input: SessionSendInput) =>
    sessions.send(id, input)
  )
  ipcMain.handle(IPC.sessionCommand, (_e, id: string, name: string, args?: string) =>
    sessions.command(id, name, args)
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
  // Windows 的系统通知需要一个稳定的 AppUserModelID；打包配置里的 appId
  // 与它保持一致。非 Windows 上是空操作。
  if (process.platform === 'win32') {
    try {
      app.setAppUserModelId('com.ccoder.desktop')
    } catch {
      // 个别环境不支持，不影响同步本身
    }
  }

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
  registerMcpIpc(sessions)
  registerSkillsIpc()
  registerClaudeAuthIpc()
  // CLI 版本检查 / 更新：状态归主进程，设置页与导航标记都订它
  initCliUpdate({ emit: (e) => broadcast(IPC.cliUpdateEvent, e) })
  startCliUpdateAutoCheck(() => loadSettings().cliUpdate.autoCheck)
  registerCliUpdateIpc()
  registerSessionIpc(sessions)
  registerWorkspaceIpc()
  registerIdeIpc()
  registerVcsIpc(sessions)
  registerSyncIpc()
  registerChatBridgeIpc()

  // 同步服务 → IDE 窗口的出口与生命周期。必须在建窗口之前装好：
  // IDE 窗口一打开就要按工作区恢复上次启用的同步。
  configureSyncHost({
    send: (cwd, channel, payload) => sendToIdeWindow(cwd, channel, payload),
    focus: (cwd, openLog) => {
      focusIdeWindow(cwd)
      sendToIdeWindow(cwd, IPC.syncFocus, { cwd, openLog })
    }
  })
  setIdeWindowHooks({
    onOpened: (cwd) => {
      ensureSync(cwd)
    },
    onClosed: (cwd) => {
      void disposeSync(cwd)
    },
    onSenderClosed: (senderId) => {
      cancelIdeSearchesForSender(senderId)
      killTerminalsForSender(senderId)
      stopLspForSender(senderId)
    }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // 退出前收掉所有 CLI 子进程（包括还在等授权码的登录进程），别留孤儿
  app.on('before-quit', () => {
    logMain('app', 'before-quit')
    sessions.stopAll()
    disposeAllDshWebHosts()
    disposeClaudeAuth()
    disposeCliUpdate()
    cancelAllIdeSearches()
    killAllTerminals()
    killAllLsp()
    void disposeAllSync()
  })

  // 和 before-quit 配对：有 before-quit 没 will-quit / quit 说明退出卡在收尾阶段
  app.on('will-quit', () => logMain('app', 'will-quit'))
  app.on('quit', (_e, code) => logMain('app', `quit code=${code}`))
})

app.on('window-all-closed', () => {
  logMain('app', 'window-all-closed')
  if (process.platform !== 'darwin') app.quit()
})
