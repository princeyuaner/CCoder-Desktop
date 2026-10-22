/**
 * IPC 通道名与载荷类型。两端都从这里取，避免字符串散落各处。
 */
import type { Channel, ChannelTestResult, EffortLevel, Settings } from './settings'
import type { AgentEvent, PermissionMode } from './events'
import type {
  PermissionDecision,
  QuestionAnswer,
  SessionEventPayload,
  SessionSendInput,
  SessionSendResult,
  SessionStartOptions,
  SessionStatusPayload,
  StoredSession
} from './session'
import type { FileMatch } from './workspace'

export const IPC = {
  winMinimize: 'win:minimize',
  winToggleMaximize: 'win:toggle-maximize',
  winClose: 'win:close',
  winIsMaximized: 'win:is-maximized',
  /** 主进程 → 渲染进程：窗口最大化状态变化 */
  winMaximizedChanged: 'win:maximized-changed',

  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  channelTest: 'channel:test',
  /** 主进程 → 渲染进程：设置被他处改动 */
  settingsChanged: 'settings:changed',

  sessionStart: 'session:start',
  sessionSend: 'session:send',
  sessionInterrupt: 'session:interrupt',
  sessionStop: 'session:stop',
  sessionRespondPermission: 'session:respond-permission',
  sessionRespondQuestion: 'session:respond-question',
  sessionReconfigure: 'session:reconfigure',
  /** 此刻哪些会话在跑（CLI 的 session id 列表） */
  sessionRunning: 'session:running',

  sessionsList: 'sessions:list',
  sessionsTranscript: 'sessions:transcript',
  sessionsDelete: 'sessions:delete',
  /** 弹系统目录选择器，返回选中的目录（取消 = null） */
  sessionsPickDir: 'sessions:pick-dir',
  /** 搜索当前工作区里的文件，供 @ 引用使用 */
  workspaceSearchFiles: 'workspace:search-files',
  /** 主进程 → 渲染进程：一条 AgentEvent */
  sessionEvent: 'session:event',
  /** 主进程 → 渲染进程：会话状态变化 */
  sessionStatus: 'session:status'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

export interface WindowApi {
  minimize(): void
  toggleMaximize(): void
  close(): void
  isMaximized(): Promise<boolean>
  /** 订阅最大化状态变化，返回取消订阅函数 */
  onMaximizedChanged(cb: (maximized: boolean) => void): () => void
  /** 设置页面缩放，1 = 100%。由 preload 里的 webFrame 直接生效 */
  setZoom(factor: number): void
  platform: NodeJS.Platform

  settings: {
    get(): Promise<Settings>
    save(settings: Settings): Promise<Settings>
    /** 用给定渠道跑一发真实请求，回报成功或端点给的原话 */
    test(channel: Channel): Promise<ChannelTestResult>
    onChanged(cb: (settings: Settings) => void): () => void
  }

  session: {
    start(options: SessionStartOptions): Promise<string>
    /** 文本 + 可选图片；只有图片没有文本也合法 */
    send(sessionId: string, input: SessionSendInput): Promise<SessionSendResult>
    interrupt(sessionId: string): void
    stop(sessionId: string): void
    /** 答复一条审批请求。always=true 表示本会话内同名工具不再询问。 */
    respondPermission(
      sessionId: string,
      requestId: string,
      decision: PermissionDecision,
      always: boolean
    ): void
    /** 答复一次 AskUserQuestion。答案会随 updatedInput 回到 CLI。 */
    respondQuestion(sessionId: string, requestId: string, answer: QuestionAnswer): void
    /**
     * 改本会话的模型 / 权限模式 / 思考深度。三者都是 CLI 的启动参数，
     * 主进程会换掉子进程并用 --resume 接回原会话，上下文不丢。
     */
    reconfigure(
      sessionId: string,
      patch: { model?: string; permissionMode?: PermissionMode; effort?: EffortLevel }
    ): void
    onEvent(cb: (payload: SessionEventPayload) => void): () => void
    onStatus(cb: (payload: SessionStatusPayload) => void): () => void
    /**
     * 此刻正在跑的会话，按 CLI 自己的 session id 给。
     *
     * 侧栏认的是 CLI 的 session id（会话行的 id 就是它），所以要这个换算过的
     * 名单 —— `sessionStatus` 事件里的 sessionId 是我们内部的 Live id，对不上。
     * 只在界面重载后需要（比如 dev 热更新）—— 平时靠 onStatus 增量维护就够了。
     */
    running(): Promise<string[]>
  }

  /** 读 CLI 自己写的会话存储（~/.claude/projects） */
  sessions: {
    list(): Promise<StoredSession[]>
    /** 把一份已有会话回放成事件流，供界面重建转写。会话身份是 (cwd, id)。 */
    transcript(cwd: string, id: string): Promise<AgentEvent[]>
    /**
     * 删掉一条会话的记录文件。**不可恢复** —— 调用方负责先问过用户。
     * 正在跑的那条会先把 CLI 进程收掉，否则 Windows 上文件被占着删不掉。
     */
    delete(cwd: string, id: string): Promise<{ ok: boolean; message?: string }>
    /** 弹系统目录选择器给「打开工作区」用。取消返回 null */
    pickDir(): Promise<string | null>
  }

  /** 工作区文件检索 —— @ 引用用。主进程异步扫描并缓存，返回相对路径。 */
  workspace: {
    searchFiles(cwd: string, query: string, limit?: number): Promise<FileMatch[]>
  }
}
