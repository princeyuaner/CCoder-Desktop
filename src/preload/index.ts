import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { IPC, type WindowApi } from '../shared/ipc'
import type { CodexStatus } from '../shared/codex'
import type {
  ClaudeAuthEvent,
  ClaudeAuthResult,
  ClaudeAuthStatus,
  ClaudeLoginSnapshot
} from '../shared/claude'
import type { Channel, ChannelTestResult, Settings } from '../shared/settings'
import type {
  PermissionDecision,
  QuestionAnswer,
  SessionEventPayload,
  SessionSendInput,
  SessionSendResult,
  SessionStartOptions,
  SessionStatusPayload,
  StoredSession
} from '../shared/session'
import type { AgentEvent } from '../shared/events'
import type { IdeFsChanged, IdeTarget } from '../shared/ide'
import type {
  ChatActiveInfo,
  ChatTargetInfo,
  IdeSendPayload,
  IdeSendResult
} from '../shared/ide-chat'
import type { VcsApi } from '../shared/vcs'

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

  codex: {
    status: (): Promise<CodexStatus> => ipcRenderer.invoke(IPC.codexStatus)
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

  session: {
    start: (o: SessionStartOptions): Promise<string> => ipcRenderer.invoke(IPC.sessionStart, o),
    send: (id: string, input: SessionSendInput): Promise<SessionSendResult> =>
      ipcRenderer.invoke(IPC.sessionSend, id, input),
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
    pickDir: (): Promise<string | null> => ipcRenderer.invoke(IPC.sessionsPickDir)
  },

  workspace: {
    searchFiles: (cwd: string, query: string, limit?: number) =>
      ipcRenderer.invoke(IPC.workspaceSearchFiles, cwd, query, limit),
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
    readFile: (cwd, rel) => ipcRenderer.invoke(IPC.ideReadFile, cwd, rel),
    readImage: (cwd, rel) => ipcRenderer.invoke(IPC.ideReadImage, cwd, rel),
    searchCode: (req) => ipcRenderer.invoke(IPC.ideSearchCode, req),
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
    worktreeList: (req) => ipcRenderer.invoke(IPC.vcsWorktreeList, req),
    worktreeAdd: (req) => ipcRenderer.invoke(IPC.vcsWorktreeAdd, req),
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
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
