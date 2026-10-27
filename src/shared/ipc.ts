/**
 * IPC 通道名与载荷类型。两端都从这里取，避免字符串散落各处。
 */
import type { CodexStatus } from './codex'
import type { DshStatus } from './dsh'
import type {
  ClaudeAuthEvent,
  ClaudeAuthResult,
  ClaudeAuthStatus,
  ClaudeLoginSnapshot
} from './claude'
import type { Channel, ChannelTestResult, CliId, EffortLevel, Settings } from './settings'
import type { CliUpdateRunResult, CliUpdateState, CliUpdateStates } from './cli-update'
import type {
  DshHomeOption,
  McpListResult,
  McpMigrationPreview,
  McpMigrationResult,
  McpMutationResult,
  McpScope,
  McpServerInput,
  McpTestResult
} from './mcp'
import type {
  SkillInput,
  SkillListResult,
  SkillMutationResult,
  SkillScope
} from './skills'
import type { AgentEvent, PermissionMode } from './events'
import type {
  PermissionDecision,
  QuestionAnswer,
  SessionEventPayload,
  SessionMetaMap,
  SessionMetaUpdate,
  SessionSearchResult,
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
  IdeEncoding,
  IdeEntry,
  IdeEntryChange,
  IdeFsChanged,
  IdeFsResult,
  IdeImage,
  IdeOpenResult,
  IdeRenameRequest,
  IdeReplaceRequest,
  IdeReplaceResult,
  IdeSaveRequest,
  IdeSearchRequest,
  IdeSearchResult,
  IdeSearchStartRequest,
  IdeSearchStartResult,
  IdeSearchStreamEvent,
  IdeTarget,
  IdeTerminalDataEvent,
  IdeTerminalExitEvent,
  IdeTerminalStartRequest,
  IdeTerminalStartResult,
  IdeTextFile
} from './ide'
import type {
  ChatActiveInfo,
  ChatTargetInfo,
  IdeSendPayload,
  IdeSendResult
} from './ide-chat'
import type {
  LspDiagnosticsEvent,
  LspNotification,
  LspRequest,
  LspResponse,
  LspStartRequest,
  LspStartResult,
  LspStateEvent
} from './lsp'
import type { VcsApi } from './vcs'
import type { SyncApi } from './sync'
import type { UpdateInstallResult, UpdateState } from './update'
import type { RendererLogReport } from './log'
import type { LocaleInfo } from './i18n/locale'

export const IPC = {
  winMinimize: 'win:minimize',
  winToggleMaximize: 'win:toggle-maximize',
  winClose: 'win:close',
  winIsMaximized: 'win:is-maximized',
  /** 主进程 → 渲染进程：窗口最大化状态变化 */
  winMaximizedChanged: 'win:maximized-changed',

  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  /** 启动时取系统语言和 system 解析后的实际语言 */
  localeInfo: 'locale:info',
  channelTest: 'channel:test',
  /** Codex CLI 安装 / 登录 / app-server 状态 */
  codexStatus: 'codex:status',
  /** DeepSeek Harness 安装 / Node / DSH_HOME 状态 */
  dshStatus: 'dsh:status',
  /** Claude Code 官方登录状态 / 登录 / 登出 */
  claudeAuthStatus: 'claude:auth-status',
  claudeAuthLogin: 'claude:auth-login',
  claudeAuthSubmitCode: 'claude:auth-submit-code',
  claudeAuthCancel: 'claude:auth-cancel',
  claudeAuthLogout: 'claude:auth-logout',
  /** 重开设置页时恢复登录流程现场 */
  claudeAuthLoginState: 'claude:auth-login-state',
  /** 主进程 → 渲染进程：登录流程的输出 / URL / 阶段变化 */
  claudeAuthEvent: 'claude:auth-event',

  /* ── CLI 自身的版本检查与更新 ───────────────────────────── */
  /** 三个 CLI 当前的状态快照 */
  cliUpdateStates: 'cli-update:states',
  /** 检查某个 CLI 有没有新版（force 跳过 6 小时缓存） */
  cliUpdateCheck: 'cli-update:check',
  /** 执行 npm i -g（包名 / 版本由主进程决定） */
  cliUpdateRun: 'cli-update:run',
  /** Windows：以管理员身份重试 */
  cliUpdateElevated: 'cli-update:elevated',
  cliUpdateCancel: 'cli-update:cancel',
  /** 主进程 → 渲染进程：单个 CLI 的状态变化 */
  cliUpdateEvent: 'cli-update:event',
  /** 主进程 → 渲染进程：设置被他处改动 */
  settingsChanged: 'settings:changed',

  /* ── MCP（直接管理各 CLI 原生配置） ─────────────────────── */
  mcpList: 'mcp:list',
  mcpSave: 'mcp:save',
  mcpRemove: 'mcp:remove',
  mcpSetEnabled: 'mcp:set-enabled',
  mcpTest: 'mcp:test',
  mcpTestAll: 'mcp:test-all',
  mcpDshHomes: 'mcp:dsh-homes',
  mcpOpenConfig: 'mcp:open-config',
  mcpRevealConfig: 'mcp:reveal-config',
  mcpOpenBackups: 'mcp:open-backups',
  mcpMigration: 'mcp:migration',
  mcpMigrate: 'mcp:migrate',

  /* ── Skills（各 CLI 的技能 / 提示词目录） ─────────────── */
  skillsList: 'skills:list',
  skillsSave: 'skills:save',
  skillsRemove: 'skills:remove',
  skillsSetEnabled: 'skills:set-enabled',
  skillsImport: 'skills:import',
  skillsDshHomes: 'skills:dsh-homes',
  skillsOpenDir: 'skills:open-dir',
  skillsOpenFile: 'skills:open-file',
  skillsOpenResource: 'skills:open-resource',
  skillsOpenBackups: 'skills:open-backups',

  /** 渲染进程 → 主进程：未捕获错误 / Promise 拒绝，只用于写本地日志 */
  rendererLog: 'log:renderer',

  /* ── 自动更新 ───────────────────────────────────────────── */
  updaterStatus: 'updater:status',
  updaterCheck: 'updater:check',
  updaterDownload: 'updater:download',
  updaterInstall: 'updater:install',
  /** 主进程 → 渲染进程：检查 / 下载 / 安装状态变化 */
  updaterEvent: 'updater:event',

  sessionStart: 'session:start',
  sessionSend: 'session:send',
  /** 执行 CLI 原生指令（Codex 的 compact 等），不是发给模型 */
  sessionCommand: 'session:command',
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
  /** 应用本地的会话元数据（重命名 / 置顶 / 归档） */
  sessionsMeta: 'sessions:meta',
  sessionsSetMeta: 'sessions:set-meta',
  /** 跨会话搜索对话内容；标题匹配在渲染层用已有的列表完成 */
  sessionsSearch: 'sessions:search',
  /** 弹系统目录选择器，返回选中的目录（取消 = null） */
  sessionsPickDir: 'sessions:pick-dir',
  /** 搜索当前工作区里的文件，供 @ 引用使用 */
  workspaceSearchFiles: 'workspace:search-files',
  /** 打开对话里点到的地址：外链交给浏览器，本地文件交给系统默认程序 */
  workspaceOpenPath: 'workspace:open-path',
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
  /** 在系统文件管理器里打开文件所在目录并选中文件 */
  ideRevealInOs: 'ide:reveal-in-os',
  ideSearchCode: 'ide:search-code',
  /** 流式搜索：启动 / 取消 / 主进程推送批次 */
  ideSearchStart: 'ide:search-start',
  ideSearchCancel: 'ide:search-cancel',
  ideSearchEvent: 'ide:search-event',
  ideReplaceInWorkspace: 'ide:replace-in-workspace',
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

  /** IDE 内置终端：启动 / 写入 / 调整大小 / 结束 */
  ideTerminalStart: 'ide:terminal-start',
  ideTerminalWrite: 'ide:terminal-write',
  ideTerminalResize: 'ide:terminal-resize',
  ideTerminalKill: 'ide:terminal-kill',
  /** 主进程 → IDE 渲染进程：输出 / 退出 */
  ideTerminalData: 'ide:terminal-data',
  ideTerminalExit: 'ide:terminal-exit',

  /** 语言服务器：启动 / 停止 / 请求 / 通知 / 诊断 / 状态 */
  lspStart: 'lsp:start',
  lspStop: 'lsp:stop',
  lspRequest: 'lsp:request',
  lspNotify: 'lsp:notify',
  /** 主进程 → IDE 渲染进程：诊断 / 会话状态 */
  lspDiagnostics: 'lsp:diagnostics',
  lspState: 'lsp:state',

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
  vcsBranches: 'vcs:branches',
  vcsWorktreeMap: 'vcs:worktree-map',
  vcsWorktreeList: 'vcs:worktree-list',
  vcsWorktreeAdd: 'vcs:worktree-add',
  vcsMergeWorktree: 'vcs:merge-worktree',
  vcsWorktreeRemove: 'vcs:worktree-remove',
  vcsWorktreePrune: 'vcs:worktree-prune',
  vcsCancel: 'vcs:cancel',

  /* ── 目录同步（单向镜像） ───────────────────────────── */
  syncGet: 'sync:get',
  syncSave: 'sync:save',
  /** 弹系统目录选择器给源 / 目标目录用 */
  syncPickDir: 'sync:pick-dir',
  /** 立刻跑一轮完整核对 */
  syncNow: 'sync:now',
  /** 在系统文件管理器里打开目标目录 */
  syncOpenTarget: 'sync:open-target',
  /** 主进程 → IDE 渲染进程：状态快照 */
  syncStatus: 'sync:status',
  /** 主进程 → IDE 渲染进程：系统通知点击后切到同步视图 */
  syncFocus: 'sync:focus',

  /* ── 工作树 → 新会话 ───────────────────────────────── */
  /** IDE → 主进程：请求在主窗口里用这个目录开一条新会话 */
  workspaceOpenSession: 'workspace:open-session',
  /** 主进程 → 主窗口：真正切到该目录的新会话 */
  chatOpenSession: 'chat:open-session'
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

  /**
   * 界面语言。主进程是 system 的唯一解析方；渲染层拿 systemLocale 后
   * 用同一个 resolveLanguage 在本地解析，保证两边一致。
   */
  i18n: {
    locale(): Promise<LocaleInfo>
  }

  /**
   * 渲染进程的异常上报。
   *
   * 打包版没有 DevTools，渲染层的未捕获异常 / Promise 拒绝不写出来就永远
   * 查不到。这里只发一条 IPC，主进程落进 main.log；不参与业务逻辑。
   */
  log: {
    report(report: RendererLogReport): void
  }

  settings: {
    get(): Promise<Settings>
    save(settings: Settings): Promise<Settings>
    /** 用给定渠道跑一发真实请求，回报成功或端点给的原话 */
    test(channel: Channel): Promise<ChannelTestResult>
    onChanged(cb: (settings: Settings) => void): () => void
  }

  /**
   * 直接管理各 CLI 的原生 MCP 配置。
   *
   * 写入前由主进程解析路径并做备份；`dshHome` 只对 DSH 有意义，
   * 且必须是主进程列出的可用 home 之一。
   */
  mcp: {
    list(cli: CliId, cwd: string, dshHome?: string): Promise<McpListResult>
    save(
      cli: CliId,
      server: McpServerInput,
      cwd: string,
      dshHome?: string
    ): Promise<McpMutationResult>
    remove(cli: CliId, id: string, cwd: string, dshHome?: string): Promise<McpMutationResult>
    setEnabled(
      cli: CliId,
      id: string,
      enabled: boolean,
      cwd: string,
      dshHome?: string
    ): Promise<McpMutationResult>
    test(cli: CliId, server: McpServerInput): Promise<McpTestResult>
    testAll(cli: CliId, cwd: string, dshHome?: string): Promise<McpListResult>
    dshHomes(): Promise<DshHomeOption[]>
    openConfig(
      cli: CliId,
      scope: McpScope,
      cwd: string,
      dshHome?: string
    ): Promise<{ ok: boolean; error?: string }>
    revealConfig(
      cli: CliId,
      scope: McpScope,
      cwd: string,
      dshHome?: string
    ): Promise<{ ok: boolean; error?: string }>
    openBackups(): Promise<{ ok: boolean; error?: string }>
    /** 旧 `mcp-servers.json` 的迁移预览；count = 0 时不显示提示 */
    migration(dshHome?: string): Promise<McpMigrationPreview>
    migrate(ids: string[], dshHome?: string): Promise<McpMigrationResult>
  }

  /**
   * 各 CLI 的技能 / 自定义提示词。
   *
   * `dshHome` 只对 DSH 有意义，且必须是主进程列出的 home 之一；
   * 写入前由主进程备份。插件技能只读。
   */
  skills: {
    list(cli: CliId, cwd: string, dshHome?: string): Promise<SkillListResult>
    save(
      cli: CliId,
      input: SkillInput,
      cwd: string,
      dshHome?: string
    ): Promise<SkillMutationResult>
    remove(cli: CliId, id: string, cwd: string, dshHome?: string): Promise<SkillMutationResult>
    setEnabled(
      cli: CliId,
      id: string,
      enabled: boolean,
      cwd: string,
      dshHome?: string
    ): Promise<SkillMutationResult>
    /** 弹系统选择器导入文件夹 / .md 文件；取消返回 cancelled */
    import(
      cli: CliId,
      scope: SkillScope,
      cwd: string,
      dshHome?: string
    ): Promise<SkillMutationResult>
    dshHomes(): Promise<DshHomeOption[]>
    openDir(
      cli: CliId,
      scope: SkillScope,
      cwd: string,
      dshHome?: string
    ): Promise<{ ok: boolean; error?: string }>
    openFile(
      cli: CliId,
      id: string,
      cwd: string,
      dshHome?: string
    ): Promise<{ ok: boolean; error?: string }>
    /** 打开技能目录内的一个资源；rel 必须是列表里的相对路径 */
    openResource(
      cli: CliId,
      id: string,
      rel: string,
      cwd: string,
      dshHome?: string
    ): Promise<{ ok: boolean; error?: string }>
    openBackups(): Promise<{ ok: boolean; error?: string }>
  }

  codex: {
    /** 探测 CLI 是否安装、app-server 是否可用、当前登录的是哪个账号 */
    status(): Promise<CodexStatus>
  }

  dsh: {
    /**
     * 探测 DeepSeek Harness 是否安装、Node 是否兼容、DSH_HOME 在哪。
     *
     * 传 channelId 时返回该渠道自己的 home（每个渠道一个 DSH_HOME）；
     * 不传则是共享的 `~/.dsh`（official 模式）。
     */
    status(channelId?: string | null): Promise<DshStatus>
  }

  /**
   * 自动更新。主进程负责检查、下载与安装，渲染层只展示状态。
   *
   * 下载和安装都不会自动发生：检查到新版本后由用户点「下载」，
   * 下载完成后再由用户点「重启并安装」。
   */
  updater: {
    status(): Promise<UpdateState>
    check(): Promise<UpdateState>
    download(): Promise<UpdateState>
    install(): Promise<UpdateInstallResult>
    /** 订阅状态变化，返回取消订阅函数 */
    onState(cb: (state: UpdateState) => void): () => void
  }

  /**
   * Claude Code 官方登录。
   *
   * 登录是一个长流程：login() 只负责把 CLI 拉起来，后续的 URL、输出、
   * 阶段变化通过 onAuthEvent 推送；用户拿到授权码后走 submitCode()。
   */
  claude: {
    authStatus(): Promise<ClaudeAuthStatus>
    authLogin(): Promise<ClaudeAuthResult>
    authSubmitCode(code: string): Promise<ClaudeAuthResult>
    authCancel(): Promise<ClaudeAuthResult>
    authLogout(): Promise<ClaudeAuthResult>
    authLoginState(): Promise<ClaudeLoginSnapshot>
    /** 订阅登录流程事件，返回取消订阅函数 */
    onAuthEvent(cb: (e: ClaudeAuthEvent) => void): () => void
  }

  /**
   * CLI 自身的更新（npm 上的新版本）。
   *
   * 只管「检查 + 用户确认后执行 npm i -g」。渲染层不能指定包名或版本 ——
   * 两者都由主进程按上一次检查的结果决定，避免这个入口变成任意命令执行。
   */
  cliUpdate: {
    states(): Promise<CliUpdateStates>
    /** force = 跳过 6 小时缓存（「立即检查」） */
    check(cli: CliId, force?: boolean): Promise<CliUpdateState>
    run(cli: CliId): Promise<CliUpdateRunResult>
    /** Windows：弹 UAC，在独立窗口里用管理员权限重试 */
    runElevated(cli: CliId): Promise<CliUpdateRunResult>
    cancel(): Promise<CliUpdateRunResult>
    /** 订阅状态变化，返回取消订阅函数 */
    onState(cb: (state: CliUpdateState) => void): () => void
  }

  session: {
    start(options: SessionStartOptions): Promise<string>
    /** 文本 + 可选图片；只有图片没有文本也合法 */
    send(sessionId: string, input: SessionSendInput): Promise<SessionSendResult>
    /** 执行 CLI 原生指令；unsupported 时返回 ok=false，由渲染层提示 */
    command(sessionId: string, name: string, args?: string): Promise<SessionSendResult>
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
    /** 会话的本地元数据（重命名 / 置顶 / 归档），按 (cli, cwd, id) 索引 */
    meta(): Promise<SessionMetaMap>
    /** 修改一条会话的元数据，返回更新后的整份 map */
    setMeta(update: SessionMetaUpdate): Promise<SessionMetaMap>
    /**
     * 搜索会话内容。主进程扫描各 CLI 的记录文件，只回命中片段；
     * 标题匹配由渲染层用本地列表完成（那边才知道用户改过的标题）。
     */
    search(query: string, limit?: number, offset?: number): Promise<SessionSearchResult>
    /**
     * 弹系统目录选择器给工作区用。`title` 是对话框标题（缺省「打开工作区」）。
     * 取消返回 null。
     */
    pickDir(title?: string): Promise<string | null>
  }

  /** 工作区文件检索 —— @ 引用用。主进程异步扫描并缓存，返回相对路径。 */
  workspace: {
    searchFiles(cwd: string, query: string, limit?: number): Promise<FileMatch[]>
    /**
     * 打开对话里点到的地址。
     *
     * `http(s)` 交给系统浏览器；本地文件交给默认程序，相对路径按 `cwd`
     * 解析。主进程只放行可直接查看的文件类型 —— 模型输出可能被提示注入，
     * 不能让它写个可执行文件路径就把进程拉起来。
     */
    openPath(cwd: string, target: string): Promise<{ ok: boolean; error?: string }>
    /**
     * IDE：请主窗口在这个目录下开一条新会话。
     *
     * 返回 ok 只表示请求已经投递到主窗口，不代表 CLI 已经启动。
     * 主进程会顺手把这个目录加入 `openedCwds`（在主进程里合并，避免整份回写）。
     */
    openSession(cwd: string): Promise<{ ok: boolean; message?: string }>
    /** 主窗口：接收上面的请求 */
    onOpenSession(cb: (cwd: string) => void): () => void
  }

  /**
   * 内置终端。只有绑定到工作区的 IDE 窗口能调用；主进程按
   * webContents 隔离会话，窗口关闭时统一结束子进程。
   */
  terminal: {
    start(req: IdeTerminalStartRequest): Promise<IdeTerminalStartResult>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): void
    onData(cb: (event: IdeTerminalDataEvent) => void): () => void
    onExit(cb: (event: IdeTerminalExitEvent) => void): () => void
  }

  /**
   * 语言服务器（LSP）。
   *
   * 只有绑定到工作区的 IDE 窗口能调用；主进程按 webContents 启动和隔离
   * 服务器进程。找不到服务器时 start 返回 not-found，渲染层回落到
   * Monaco 自带 worker，不影响基本编辑。
   */
  lsp: {
    start(req: LspStartRequest): Promise<LspStartResult>
    /** 关闭这个工作区的会话；不传 language 时全部关闭 */
    stop(cwd: string, language?: string): void
    request(req: LspRequest): Promise<LspResponse>
    notify(req: LspNotification): void
    onDiagnostics(cb: (event: LspDiagnosticsEvent) => void): () => void
    onState(cb: (event: LspStateEvent) => void): () => void
  }

  /**
   * Git / SVN。只有 IDE 窗口能调用（主进程按窗口绑定的工作区校验），
   * 聊天窗口没有提交、还原这类写能力。
   */
  vcs: VcsApi

  /**
   * 目录同步。只有绑定到该工作区的 IDE 窗口能调用 —— 和 VCS 一样，
   * 主进程按窗口绑定的工作区校验 `cwd`。
   */
  sync: SyncApi

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
    readFile(cwd: string, rel: string, encoding?: IdeEncoding): Promise<IdeFsResult<IdeTextFile>>
    readImage(cwd: string, rel: string): Promise<IdeFsResult<IdeImage>>
    /** 在系统文件管理器中打开 rel 所在目录并选中它 */
    revealInOs(cwd: string, rel: string): Promise<{ ok: boolean; message?: string }>
    searchCode(req: IdeSearchRequest): Promise<IdeSearchResult>
    /** 启动流式搜索；结果通过 onSearchEvent 推送 */
    startSearch(req: IdeSearchStartRequest): Promise<IdeSearchStartResult>
    /** 取消自己发起的某个搜索；不传 requestId 时取消当前搜索 */
    cancelSearch(requestId?: string): void
    /** 订阅流式搜索结果；返回取消订阅函数 */
    onSearchEvent(cb: (event: IdeSearchStreamEvent) => void): () => void
    /** 工作区全部替换；有未保存修改的文件由 dirtyRels 指定并跳过 */
    replaceInWorkspace(req: IdeReplaceRequest): Promise<IdeReplaceResult>
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
