import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { IPC, type WindowApi } from '../shared/ipc'
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
      ipcRenderer.invoke(IPC.workspaceSearchFiles, cwd, query, limit)
  }
}

contextBridge.exposeInMainWorld('api', api)
