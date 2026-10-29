import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { IPC, type WindowApi } from '../shared/ipc'
import type { CodexStatus } from '../shared/codex'
import type { DshStatus } from '../shared/dsh'
import type {
  ClaudeAuthEvent,
  ClaudeAuthResult,
  ClaudeAuthStatus,
  ClaudeLoginSnapshot
} from '../shared/claude'
import type { Channel, ChannelTestResult, CliId, Settings } from '../shared/settings'
import type {
  CliUpdateEvent,
  CliUpdateRunResult,
  CliUpdateState,
  CliUpdateStates
} from '../shared/cli-update'
import type {
  DshHomeOption,
  McpListResult,
  McpMigrationPreview,
  McpMigrationResult,
  McpMutationResult,
  McpScope,
  McpServerInput,
  McpTestResult
} from '../shared/mcp'
import type {
  SkillInput,
  SkillListResult,
  SkillMutationResult,
  SkillScope
} from '../shared/skills'
import type {
  HookInput,
  HookListResult,
  HookMutationResult,
  HookTestInput,
  HookTestResult,
  HookWritableScope
} from '../shared/hooks'
import type {
  PermissionDecision,
  QuestionAnswer,
  SessionEventPayload,
  SessionMetaMap,
  SessionMetaUpdate,
  SessionFocusTarget,
  SessionNotifyPayload,
  SessionSearchResult,
  SessionSendInput,
  SessionSendResult,
  SessionStartOptions,
  SessionStatusPayload,
  StoredSession
} from '../shared/session'
import type { AgentEvent } from '../shared/events'
import type { DirCheckResult } from '../shared/add-dirs'
import type {
  IdeFsChanged,
  IdeSearchStreamEvent,
  IdeTarget,
  IdeTerminalDataEvent,
  IdeTerminalExitEvent,
  IdeTerminalStartRequest
} from '../shared/ide'
import type {
  ChatActiveInfo,
  ChatTargetInfo,
  IdeSendPayload,
  IdeSendResult
} from '../shared/ide-chat'
import type {
  LspDiagnosticsEvent,
  LspNotification,
  LspRequest,
  LspResponse,
  LspStartRequest,
  LspStartResult,
  LspStateEvent
} from '../shared/lsp'
import type { VcsApi } from '../shared/vcs'
import type { SyncFocusPayload, SyncStatusPush } from '../shared/sync'
import type { UpdateInstallResult, UpdateState } from '../shared/update'
import type { RendererLogReport } from '../shared/log'
import type { LocaleInfo } from '../shared/i18n/locale'

/**
 * IDE 窗口的「打开文件」推送。
 *
 * 主进程可能在这个窗口的 React 还没挂上订阅时就把目标发过来（比如刚
 * 创建窗口就连点两次），所以先攒最后一条，等订阅方出现再补发。
 * 不攒的话表现就是"点了没反应"。
 */
let pendingReveal: IdeTarget | null = null
const revealListeners = new Set<(target: IdeTarget) => void>()

ipcRenderer.on(IPC.ideReveal, (_e: Electron.IpcRendererEvent, target: IdeTarget) => {
  if (revealListeners.size === 0) pendingReveal = target
  else for (const cb of revealListeners) cb(target)
})

/** 主进程请求关窗口；React 还没订阅时先记下来 */
let pendingCloseRequest = false
const closeListeners = new Set<() => void>()

ipcRenderer.on(IPC.ideCloseRequest, () => {
  if (closeListeners.size === 0) pendingCloseRequest = true
  else for (const cb of closeListeners) cb()
})

/** IDE 请求主窗口“在这个目录开新会话”；主窗口可能还在加载 */
let pendingOpenSession: string | null = null
const openSessionListeners = new Set<(cwd: string) => void>()

ipcRenderer.on(IPC.chatOpenSession, (_e: Electron.IpcRendererEvent, cwd: string) => {
  if (typeof cwd !== 'string') return
  if (openSessionListeners.size === 0) pendingOpenSession = cwd
  else for (const cb of openSessionListeners) cb(cwd)
})

/** 系统通知点击：主窗口切到那条会话。React 还没订阅时先记下来。 */
let pendingFocus: SessionFocusTarget | null = null
const focusListeners = new Set<(target: SessionFocusTarget) => void>()

ipcRenderer.on(IPC.chatFocusSession, (_e: Electron.IpcRendererEvent, target: SessionFocusTarget) => {
  if (!target || typeof target.cwd !== 'string' || typeof target.id !== 'string') return
  if (focusListeners.size === 0) pendingFocus = target
  else for (const cb of focusListeners) cb(target)
})

/** 系统通知点击：切到同步视图。React 还没订阅时先记下来。 */
let pendingSyncFocus: SyncFocusPayload | null = null
const syncFocusListeners = new Set<(payload: SyncFocusPayload) => void>()

ipcRenderer.on(IPC.syncFocus, (_e: Electron.IpcRendererEvent, payload: SyncFocusPayload) => {
  if (!payload || typeof payload.cwd !== 'string') return
  if (syncFocusListeners.size === 0) pendingSyncFocus = payload
  else for (const cb of syncFocusListeners) cb(payload)
})

/**
 * 渲染进程能看到的**全部**能力都在这里。加能力必须先在这里加一行，
 * 这是刻意的摩擦：渲染进程永远拿不到 ipcRenderer 本身。
 */
const api: WindowApi = {
  minimize: () => ipcRenderer.send(IPC.winMinimize),
  toggleMaximize: () => ipcRenderer.send(IPC.winToggleMaximize),
  close: () => ipcRenderer.send(IPC.winClose),
  isMaximized: () => ipcRenderer.invoke(IPC.winIsMaximized),
  onMaximizedChanged: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, maximized: boolean): void => cb(maximized)
    ipcRenderer.on(IPC.winMaximizedChanged, listener)
    return () => ipcRenderer.off(IPC.winMaximizedChanged, listener)
  },
  setZoom: (factor: number) => {
    // 夹一道，别让坏数据把窗口放大到点不到设置页
    const f = Math.min(2, Math.max(0.5, Number.isFinite(factor) ? factor : 1))
    webFrame.setZoomFactor(f)
  },
  platform: process.platform,

  i18n: {
    locale: (): Promise<LocaleInfo> => ipcRenderer.invoke(IPC.localeInfo)
  },

  log: {
    // 只发不收：主进程收到后直接落盘，渲染进程不需要回执
    report: (report: RendererLogReport): void => ipcRenderer.send(IPC.rendererLog, report)
  },

  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke(IPC.settingsGet),
    save: (s: Settings): Promise<Settings> => ipcRenderer.invoke(IPC.settingsSave, s),
    test: (c: Channel): Promise<ChannelTestResult> => ipcRenderer.invoke(IPC.channelTest, c),
    onChanged: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, s: Settings): void => cb(s)
      ipcRenderer.on(IPC.settingsChanged, listener)
      return () => ipcRenderer.off(IPC.settingsChanged, listener)
    }
  },

  mcp: {
    list: (cli: CliId, cwd: string, dshHome?: string): Promise<McpListResult> =>
      ipcRenderer.invoke(IPC.mcpList, cli, cwd, dshHome),
    save: (
      cli: CliId,
      server: McpServerInput,
      cwd: string,
      dshHome?: string
    ): Promise<McpMutationResult> =>
      ipcRenderer.invoke(IPC.mcpSave, cli, server, cwd, dshHome),
    remove: (cli: CliId, id: string, cwd: string, dshHome?: string): Promise<McpMutationResult> =>
      ipcRenderer.invoke(IPC.mcpRemove, cli, id, cwd, dshHome),
    setEnabled: (
      cli: CliId,
      id: string,
      enabled: boolean,
      cwd: string,
      dshHome?: string
    ): Promise<McpMutationResult> =>
      ipcRenderer.invoke(IPC.mcpSetEnabled, cli, id, enabled, cwd, dshHome),
    test: (cli: CliId, server: McpServerInput): Promise<McpTestResult> =>
      ipcRenderer.invoke(IPC.mcpTest, cli, server),
    testAll: (cli: CliId, cwd: string, dshHome?: string): Promise<McpListResult> =>
      ipcRenderer.invoke(IPC.mcpTestAll, cli, cwd, dshHome),
    dshHomes: (): Promise<DshHomeOption[]> => ipcRenderer.invoke(IPC.mcpDshHomes),
    openConfig: (
      cli: CliId,
      scope: McpScope,
      cwd: string,
      dshHome?: string
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.mcpOpenConfig, cli, scope, cwd, dshHome),
    revealConfig: (
      cli: CliId,
      scope: McpScope,
      cwd: string,
      dshHome?: string
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.mcpRevealConfig, cli, scope, cwd, dshHome),
    openBackups: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.mcpOpenBackups),
    migration: (dshHome?: string): Promise<McpMigrationPreview> =>
      ipcRenderer.invoke(IPC.mcpMigration, dshHome),
    migrate: (ids: string[], dshHome?: string): Promise<McpMigrationResult> =>
      ipcRenderer.invoke(IPC.mcpMigrate, ids, dshHome)
  },

  skills: {
    list: (cli: CliId, cwd: string, dshHome?: string): Promise<SkillListResult> =>
      ipcRenderer.invoke(IPC.skillsList, cli, cwd, dshHome),
    save: (
      cli: CliId,
      input: SkillInput,
      cwd: string,
      dshHome?: string
    ): Promise<SkillMutationResult> => ipcRenderer.invoke(IPC.skillsSave, cli, input, cwd, dshHome),
    remove: (cli: CliId, id: string, cwd: string, dshHome?: string): Promise<SkillMutationResult> =>
      ipcRenderer.invoke(IPC.skillsRemove, cli, id, cwd, dshHome),
    setEnabled: (
      cli: CliId,
      id: string,
      enabled: boolean,
      cwd: string,
      dshHome?: string
    ): Promise<SkillMutationResult> =>
      ipcRenderer.invoke(IPC.skillsSetEnabled, cli, id, enabled, cwd, dshHome),
    import: (
      cli: CliId,
      scope: SkillScope,
      cwd: string,
      dshHome?: string
    ): Promise<SkillMutationResult> =>
      ipcRenderer.invoke(IPC.skillsImport, cli, scope, cwd, dshHome),
    dshHomes: (): Promise<DshHomeOption[]> => ipcRenderer.invoke(IPC.skillsDshHomes),
    openDir: (
      cli: CliId,
      scope: SkillScope,
      cwd: string,
      dshHome?: string
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.skillsOpenDir, cli, scope, cwd, dshHome),
    openFile: (
      cli: CliId,
      id: string,
      cwd: string,
      dshHome?: string
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.skillsOpenFile, cli, id, cwd, dshHome),
    openResource: (
      cli: CliId,
      id: string,
      rel: string,
      cwd: string,
      dshHome?: string
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.skillsOpenResource, cli, id, rel, cwd, dshHome),
    openBackups: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.skillsOpenBackups)
  },

  hooks: {
    list: (cwd: string): Promise<HookListResult> =>
      ipcRenderer.invoke(IPC.hooksList, cwd),
    save: (input: HookInput, cwd: string): Promise<HookMutationResult> =>
      ipcRenderer.invoke(IPC.hooksSave, input, cwd),
    remove: (id: string, cwd: string): Promise<HookMutationResult> =>
      ipcRenderer.invoke(IPC.hooksRemove, id, cwd),
    setEnabled: (
      id: string,
      enabled: boolean,
      cwd: string
    ): Promise<HookMutationResult> =>
      ipcRenderer.invoke(IPC.hooksSetEnabled, id, enabled, cwd),
    test: (input: HookTestInput): Promise<HookTestResult> =>
      ipcRenderer.invoke(IPC.hooksTest, input),
    openConfig: (
      scope: HookWritableScope,
      cwd: string
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.hooksOpenConfig, scope, cwd),
    openBackups: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.hooksOpenBackups)
  },

  codex: {
    status: (): Promise<CodexStatus> => ipcRenderer.invoke(IPC.codexStatus)
  },

  dsh: {
    status: (channelId?: string | null): Promise<DshStatus> =>
      ipcRenderer.invoke(IPC.dshStatus, channelId)
  },

  updater: {
    status: (): Promise<UpdateState> => ipcRenderer.invoke(IPC.updaterStatus),
    check: (): Promise<UpdateState> => ipcRenderer.invoke(IPC.updaterCheck),
    download: (): Promise<UpdateState> => ipcRenderer.invoke(IPC.updaterDownload),
    install: (): Promise<UpdateInstallResult> => ipcRenderer.invoke(IPC.updaterInstall),
    onState: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, state: UpdateState): void => cb(state)
      ipcRenderer.on(IPC.updaterEvent, listener)
      return () => ipcRenderer.off(IPC.updaterEvent, listener)
    }
  },

  claude: {
    authStatus: (): Promise<ClaudeAuthStatus> => ipcRenderer.invoke(IPC.claudeAuthStatus),
    authLogin: (): Promise<ClaudeAuthResult> => ipcRenderer.invoke(IPC.claudeAuthLogin),
    authSubmitCode: (code: string): Promise<ClaudeAuthResult> =>
      ipcRenderer.invoke(IPC.claudeAuthSubmitCode, code),
    authCancel: (): Promise<ClaudeAuthResult> => ipcRenderer.invoke(IPC.claudeAuthCancel),
    authLogout: (): Promise<ClaudeAuthResult> => ipcRenderer.invoke(IPC.claudeAuthLogout),
    authLoginState: (): Promise<ClaudeLoginSnapshot> =>
      ipcRenderer.invoke(IPC.claudeAuthLoginState),
    onAuthEvent: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, ev: ClaudeAuthEvent): void => cb(ev)
      ipcRenderer.on(IPC.claudeAuthEvent, listener)
      return () => ipcRenderer.off(IPC.claudeAuthEvent, listener)
    }
  },

  cliUpdate: {
    states: (): Promise<CliUpdateStates> => ipcRenderer.invoke(IPC.cliUpdateStates),
    check: (cli: CliId, force?: boolean): Promise<CliUpdateState> =>
      ipcRenderer.invoke(IPC.cliUpdateCheck, cli, force === true),
    run: (cli: CliId): Promise<CliUpdateRunResult> => ipcRenderer.invoke(IPC.cliUpdateRun, cli),
    runElevated: (cli: CliId): Promise<CliUpdateRunResult> =>
      ipcRenderer.invoke(IPC.cliUpdateElevated, cli),
    cancel: (): Promise<CliUpdateRunResult> => ipcRenderer.invoke(IPC.cliUpdateCancel),
    onState: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, ev: CliUpdateEvent): void => {
        if (ev && ev.t === 'state') cb(ev.state)
      }
      ipcRenderer.on(IPC.cliUpdateEvent, listener)
      return () => ipcRenderer.off(IPC.cliUpdateEvent, listener)
    }
  },

  session: {
    start: (o: SessionStartOptions): Promise<string> => ipcRenderer.invoke(IPC.sessionStart, o),
    send: (id: string, input: SessionSendInput): Promise<SessionSendResult> =>
      ipcRenderer.invoke(IPC.sessionSend, id, input),
    command: (id: string, name: string, args?: string): Promise<SessionSendResult> =>
      ipcRenderer.invoke(IPC.sessionCommand, id, name, args),
    interrupt: (id: string) => ipcRenderer.send(IPC.sessionInterrupt, id),
    stop: (id: string) => ipcRenderer.send(IPC.sessionStop, id),
    respondPermission: (id, requestId, decision, always) =>
      ipcRenderer.send(IPC.sessionRespondPermission, id, requestId, decision, always),
    respondQuestion: (id: string, requestId: string, answer: QuestionAnswer) =>
      ipcRenderer.send(IPC.sessionRespondQuestion, id, requestId, answer),
    reconfigure: (id, patch) => ipcRenderer.send(IPC.sessionReconfigure, id, patch),
    running: (): Promise<string[]> => ipcRenderer.invoke(IPC.sessionRunning),
    onEvent: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, p: SessionEventPayload): void => cb(p)
      ipcRenderer.on(IPC.sessionEvent, listener)
      return () => ipcRenderer.off(IPC.sessionEvent, listener)
    },
    onStatus: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, p: SessionStatusPayload): void => cb(p)
      ipcRenderer.on(IPC.sessionStatus, listener)
      return () => ipcRenderer.off(IPC.sessionStatus, listener)
    }
  },

  sessions: {
    list: (): Promise<StoredSession[]> => ipcRenderer.invoke(IPC.sessionsList),
    transcript: (cwd: string, id: string): Promise<AgentEvent[]> =>
      ipcRenderer.invoke(IPC.sessionsTranscript, cwd, id),
    delete: (cwd: string, id: string): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke(IPC.sessionsDelete, cwd, id),
    meta: (): Promise<SessionMetaMap> => ipcRenderer.invoke(IPC.sessionsMeta),
    setMeta: (update: SessionMetaUpdate): Promise<SessionMetaMap> =>
      ipcRenderer.invoke(IPC.sessionsSetMeta, update),
    search: (query: string, limit?: number, offset?: number): Promise<SessionSearchResult> =>
      ipcRenderer.invoke(IPC.sessionsSearch, query, limit, offset),
    validateDir: (dir: string, cwd: string, existing: string[]): Promise<DirCheckResult> =>
      ipcRenderer.invoke(IPC.sessionsValidateDir, dir, cwd, existing),
    pickDir: (title?: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC.sessionsPickDir, title),
    saveMarkdown: (
      name: string,
      content: string
    ): Promise<{ ok: boolean; path?: string; canceled?: boolean; message?: string }> =>
      ipcRenderer.invoke(IPC.sessionsSaveMarkdown, name, content)
  },

  workspace: {
    searchFiles: (cwd: string, query: string, limit?: number) =>
      ipcRenderer.invoke(IPC.workspaceSearchFiles, cwd, query, limit),
    openPath: (cwd, target) => ipcRenderer.invoke(IPC.workspaceOpenPath, cwd, target),
    openSession: (cwd: string): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke(IPC.workspaceOpenSession, cwd),
    onOpenSession: (cb) => {
      openSessionListeners.add(cb)
      // 订阅之前就到的请求补发一次，别让用户点了没反应
      const late = pendingOpenSession
      if (late) {
        pendingOpenSession = null
        cb(late)
      }
      return () => {
        openSessionListeners.delete(cb)
      }
    }
  },

  ide: {
    open: (cwd: string): Promise<void> => ipcRenderer.invoke(IPC.ideOpen, cwd),
    openFile: (cwd, file, line) => ipcRenderer.invoke(IPC.ideOpenFile, cwd, file, line),
    openDiffs: (cwd, rels) => ipcRenderer.invoke(IPC.ideOpenDiffs, cwd, rels),
    onReveal: (cb) => {
      revealListeners.add(cb)
      // 订阅之前就到的目标，补发一次；随后清掉，别在重挂载时又打开一遍
      const late = pendingReveal
      if (late) {
        pendingReveal = null
        cb(late)
      }
      return () => {
        revealListeners.delete(cb)
      }
    },
    /**
     * 文件变化由主进程的 watcher 推送。订阅之前发生的变化会丢，
     * 但首屏的 listDir / readFile / vcs.status 本来就会读最新状态。
     */
    onFsChanged: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, batch: IdeFsChanged): void => cb(batch)
      ipcRenderer.on(IPC.ideFsChanged, listener)
      return () => ipcRenderer.off(IPC.ideFsChanged, listener)
    },
    listDir: (cwd, rel) => ipcRenderer.invoke(IPC.ideListDir, cwd, rel),
    readFile: (cwd, rel, encoding) => ipcRenderer.invoke(IPC.ideReadFile, cwd, rel, encoding),
    readImage: (cwd, rel) => ipcRenderer.invoke(IPC.ideReadImage, cwd, rel),
    revealInOs: (cwd, rel) => ipcRenderer.invoke(IPC.ideRevealInOs, cwd, rel),
    searchCode: (req) => ipcRenderer.invoke(IPC.ideSearchCode, req),
    startSearch: (req) => ipcRenderer.invoke(IPC.ideSearchStart, req),
    cancelSearch: (requestId) => ipcRenderer.send(IPC.ideSearchCancel, requestId),
    onSearchEvent: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, event: IdeSearchStreamEvent): void =>
        cb(event)
      ipcRenderer.on(IPC.ideSearchEvent, listener)
      return () => ipcRenderer.off(IPC.ideSearchEvent, listener)
    },
    replaceInWorkspace: (req) => ipcRenderer.invoke(IPC.ideReplaceInWorkspace, req),
    saveFile: (req) => ipcRenderer.invoke(IPC.ideSaveFile, req),
    createEntry: (req) => ipcRenderer.invoke(IPC.ideCreateEntry, req),
    renameEntry: (req) => ipcRenderer.invoke(IPC.ideRenameEntry, req),
    deleteEntry: (req) => ipcRenderer.invoke(IPC.ideDeleteEntry, req),
    setDirty: (dirty) => ipcRenderer.send(IPC.ideDirty, dirty),
    onCloseRequest: (cb) => {
      closeListeners.add(cb)
      if (pendingCloseRequest) {
        pendingCloseRequest = false
        cb()
      }
      return () => {
        closeListeners.delete(cb)
      }
    },
    confirmClose: () => ipcRenderer.send(IPC.ideConfirmClose)
  },

  terminal: {
    start: (req: IdeTerminalStartRequest) =>
      ipcRenderer.invoke(IPC.ideTerminalStart, req),
    write: (id: string, data: string) => ipcRenderer.send(IPC.ideTerminalWrite, id, data),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send(IPC.ideTerminalResize, id, cols, rows),
    kill: (id: string) => ipcRenderer.send(IPC.ideTerminalKill, id),
    onData: (cb: (event: IdeTerminalDataEvent) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, event: IdeTerminalDataEvent): void =>
        cb(event)
      ipcRenderer.on(IPC.ideTerminalData, listener)
      return () => ipcRenderer.off(IPC.ideTerminalData, listener)
    },
    onExit: (cb: (event: IdeTerminalExitEvent) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, event: IdeTerminalExitEvent): void =>
        cb(event)
      ipcRenderer.on(IPC.ideTerminalExit, listener)
      return () => ipcRenderer.off(IPC.ideTerminalExit, listener)
    }
  },

  lsp: {
    start: (req: LspStartRequest): Promise<LspStartResult> =>
      ipcRenderer.invoke(IPC.lspStart, req),
    stop: (cwd: string, language?: string) =>
      ipcRenderer.send(IPC.lspStop, cwd, language),
    request: (req: LspRequest): Promise<LspResponse> =>
      ipcRenderer.invoke(IPC.lspRequest, req),
    notify: (req: LspNotification) => ipcRenderer.send(IPC.lspNotify, req),
    onDiagnostics: (cb: (event: LspDiagnosticsEvent) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, event: LspDiagnosticsEvent): void =>
        cb(event)
      ipcRenderer.on(IPC.lspDiagnostics, listener)
      return () => ipcRenderer.off(IPC.lspDiagnostics, listener)
    },
    onState: (cb: (event: LspStateEvent) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, event: LspStateEvent): void => cb(event)
      ipcRenderer.on(IPC.lspState, listener)
      return () => ipcRenderer.off(IPC.lspState, listener)
    }
  },

  sync: {
    get: (cwd) => ipcRenderer.invoke(IPC.syncGet, cwd),
    save: (cwd, config) => ipcRenderer.invoke(IPC.syncSave, cwd, config),
    pickDir: (cwd, which) => ipcRenderer.invoke(IPC.syncPickDir, cwd, which),
    syncNow: (cwd) => ipcRenderer.invoke(IPC.syncNow, cwd),
    openTarget: (cwd) => ipcRenderer.invoke(IPC.syncOpenTarget, cwd),
    onStatus: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: SyncStatusPush): void =>
        cb(payload)
      ipcRenderer.on(IPC.syncStatus, listener)
      return () => ipcRenderer.off(IPC.syncStatus, listener)
    },
    onFocus: (cb) => {
      syncFocusListeners.add(cb)
      const late = pendingSyncFocus
      if (late) {
        pendingSyncFocus = null
        cb(late)
      }
      return () => {
        syncFocusListeners.delete(cb)
      }
    }
  },

  vcs: {
    detect: (cwd) => ipcRenderer.invoke(IPC.vcsDetect, cwd),
    status: (req) => ipcRenderer.invoke(IPC.vcsStatus, req),
    diff: (req) => ipcRenderer.invoke(IPC.vcsDiff, req),
    log: (req) => ipcRenderer.invoke(IPC.vcsLog, req),
    commitDetail: (req) => ipcRenderer.invoke(IPC.vcsCommitDetail, req),
    stage: (req) => ipcRenderer.invoke(IPC.vcsStage, req),
    unstage: (req) => ipcRenderer.invoke(IPC.vcsUnstage, req),
    discard: (req) => ipcRenderer.invoke(IPC.vcsDiscard, req),
    revert: (req) => ipcRenderer.invoke(IPC.vcsRevert, req),
    resolve: (req) => ipcRenderer.invoke(IPC.vcsResolve, req),
    commit: (req) => ipcRenderer.invoke(IPC.vcsCommit, req),
    fetch: (req) => ipcRenderer.invoke(IPC.vcsFetch, req),
    pull: (req) => ipcRenderer.invoke(IPC.vcsPull, req),
    push: (req) => ipcRenderer.invoke(IPC.vcsPush, req),
    update: (req) => ipcRenderer.invoke(IPC.vcsUpdate, req),
    branches: (req) => ipcRenderer.invoke(IPC.vcsBranches, req),
    worktreeMap: (req) => ipcRenderer.invoke(IPC.vcsWorktreeMap, req),
    worktreeList: (req) => ipcRenderer.invoke(IPC.vcsWorktreeList, req),
    worktreeAdd: (req) => ipcRenderer.invoke(IPC.vcsWorktreeAdd, req),
    mergeWorktree: (req) => ipcRenderer.invoke(IPC.vcsMergeWorktree, req),
    worktreeRemove: (req) => ipcRenderer.invoke(IPC.vcsWorktreeRemove, req),
    worktreePrune: (req) => ipcRenderer.invoke(IPC.vcsWorktreePrune, req),
    cancel: (req) => ipcRenderer.invoke(IPC.vcsCancel, req)
  } satisfies VcsApi,

  chat: {
    targets: (cwd: string): Promise<ChatTargetInfo[]> =>
      ipcRenderer.invoke(IPC.ideChatTargets, cwd),
    sendRefs: (payload: IdeSendPayload): Promise<IdeSendResult> =>
      ipcRenderer.invoke(IPC.ideSendRefs, payload),
    reportActive: (info: ChatActiveInfo): void =>
      ipcRenderer.send(IPC.chatReportActive, info),
    onAttachRefs: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: IdeSendPayload): void =>
        cb(payload)
      ipcRenderer.on(IPC.chatAttachRefs, listener)
      return () => ipcRenderer.off(IPC.chatAttachRefs, listener)
    },
    notifyDone: (payload: SessionNotifyPayload): void =>
      ipcRenderer.send(IPC.chatNotifyDone, payload),
    onFocusSession: (cb) => {
      focusListeners.add(cb)
      // 订阅之前就点了通知：补发一次，别让用户点了没反应
      const late = pendingFocus
      if (late) {
        pendingFocus = null
        cb(late)
      }
      return () => {
        focusListeners.delete(cb)
      }
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
