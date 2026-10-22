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
import type {
  IdeCreateRequest,
  IdeDeleteRequest,
  IdeDeleteResult,
  IdeEntry,
  IdeEntryChange,
  IdeFsChanged,
  IdeFsResult,
  IdeImage,
  IdeOpenResult,
  IdeRenameRequest,
  IdeSaveRequest,
  IdeSearchFile,
  IdeTarget,
  IdeTextFile
} from './ide'
import type {
  ChatActiveInfo,
  ChatTargetInfo,
  IdeSendPayload,
  IdeSendResult
} from './ide-chat'
import type { VcsApi } from './vcs'

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
  sessionStatus: 'session:status',

  /** 打开（或聚焦）某个工作区的独立 IDE 窗口 */
  ideOpen: 'ide:open',
  /** 打开（或聚焦）IDE 并定位到某个文件；路径可以是绝对或相对工作区 */
  ideOpenFile: 'ide:open-file',
  /** 主进程 → IDE 渲染进程：窗口已存在时，直接在已开窗口里打开文件 */
  ideReveal: 'ide:reveal',
  ideListDir: 'ide:list-dir',
  ideReadFile: 'ide:read-file',
  ideReadImage: 'ide:read-image',
  ideSearchCode: 'ide:search-code',
  ideSaveFile: 'ide:save-file',
  ideCreateEntry: 'ide:create-entry',
  ideRenameEntry: 'ide:rename-entry',
  ideDeleteEntry: 'ide:delete-entry',
  /** IDE 渲染进程 → 主进程：有没有未保存的文件 */
  ideDirty: 'ide:dirty',
  /** 主进程 → IDE 渲染进程：用户关窗口，但有未保存修改 */
  ideCloseRequest: 'ide:close-request',
  /** IDE 渲染进程 → 主进程：已处理好未保存修改，可以真的关了 */
  ideConfirmClose: 'ide:confirm-close',
  /** 主进程 → IDE 渲染进程：一批工作区文件变化（已去抖 / 合并 / 过滤） */
  ideFsChanged: 'ide:fs-changed',

  /** IDE：列出这个工作区可选的聊天目标 */
  ideChatTargets: 'ide:chat-targets',
  /** IDE：把代码引用交给主进程，转给主窗口 */
  ideSendRefs: 'ide:send-refs',
  /** 主窗口 → 主进程：当前会话变了（工作区 / 标题 / id） */
  chatReportActive: 'chat:report-active',
  /** 主进程 → 主窗口：把代码引用附加到输入框 */
  chatAttachRefs: 'chat:attach-refs',

  /* ── 版本控制（Git / SVN） ───────────────────────────── */
  vcsDetect: 'vcs:detect',
  vcsStatus: 'vcs:status',
  vcsDiff: 'vcs:diff',
  vcsLog: 'vcs:log',
  vcsCommitDetail: 'vcs:commit-detail',
  vcsStage: 'vcs:stage',
  vcsUnstage: 'vcs:unstage',
  vcsDiscard: 'vcs:discard',
  vcsRevert: 'vcs:revert',
  vcsResolve: 'vcs:resolve',
  vcsCommit: 'vcs:commit',
  vcsFetch: 'vcs:fetch',
  vcsPull: 'vcs:pull',
  vcsPush: 'vcs:push',
  vcsUpdate: 'vcs:update',
  vcsCancel: 'vcs:cancel'
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

  /**
   * Git / SVN。只有 IDE 窗口能调用（主进程按窗口绑定的工作区校验），
   * 聊天窗口没有提交、还原这类写能力。
   */
  vcs: VcsApi

  /**
   * 独立 IDE 窗口的文件能力。
   *
   * 所有 `rel` 都是相对工作区的路径；主进程会做越界检查。
   * 写操作只允许创建该 IDE 窗口的工作区调用。
   */
  ide: {
    open(cwd: string): Promise<void>
    /**
     * 打开（或聚焦）IDE，并直接显示某个文件。
     *
     * 入参是**工具给的原始路径**（通常是绝对路径），由主进程换算成
     * 相对路径并拒绝工作区外的目标 —— 渲染层不做路径判断。
     */
    openFile(cwd: string, file: string, line?: number): Promise<IdeOpenResult>
    /** IDE 渲染进程订阅「打开这个文件」；返回取消订阅函数 */
    onReveal(cb: (target: IdeTarget) => void): () => void
    listDir(cwd: string, rel: string): Promise<IdeEntry[]>
    readFile(cwd: string, rel: string): Promise<IdeTextFile>
    readImage(cwd: string, rel: string): Promise<IdeImage>
    searchCode(cwd: string, query: string): Promise<IdeSearchFile[]>
    saveFile(req: IdeSaveRequest): Promise<IdeFsResult<IdeTextFile>>
    createEntry(req: IdeCreateRequest): Promise<IdeFsResult<IdeEntryChange>>
    renameEntry(req: IdeRenameRequest): Promise<IdeFsResult<IdeEntryChange>>
    deleteEntry(req: IdeDeleteRequest): Promise<IdeFsResult<IdeDeleteResult>>
    /** 订阅工作区文件变化；返回取消订阅函数 */
    onFsChanged(cb: (batch: IdeFsChanged) => void): () => void
    /** 告诉主进程当前有没有未保存修改，关闭窗口时据此拦截 */
    setDirty(dirty: boolean): void
    /** 主进程请求关闭窗口（有未保存修改时），返回取消订阅函数 */
    onCloseRequest(cb: () => void): () => void
    /** 用户已决定保存/放弃，允许主进程关窗口 */
    confirmClose(): void
  }

  /**
   * IDE → 聊天的桥。IDE 窗口和主窗口共用同一份 preload，两边各用一半：
   * IDE 用 targets / sendRefs，主窗口用 reportActive / onAttachRefs。
   */
  chat: {
    /** IDE：这个工作区可以发到哪些聊天（第一个是默认目标） */
    targets(cwd: string): Promise<ChatTargetInfo[]>
    /** IDE：发送代码引用；主进程只负责转给主窗口 */
    sendRefs(payload: IdeSendPayload): Promise<IdeSendResult>
    /** 主窗口：上报当前会话，IDE 靠它算默认目标 */
    reportActive(info: ChatActiveInfo): void
    /** 主窗口：接收 IDE 发来的引用 */
    onAttachRefs(cb: (payload: IdeSendPayload) => void): () => void
  }
}
