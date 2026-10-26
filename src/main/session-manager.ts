import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type { AgentEvent, PermissionMode } from '../shared/events'
import type { McpScope } from '../shared/mcp'
import {
  activeChannelOf,
  cliConfig,
  cliDef,
  DEFAULT_EFFORT,
  type Channel,
  type CliAuthMode,
  type CliId,
  type EffortLevel,
  type Settings
} from '../shared/settings'
import type {
  PermissionDecision,
  QuestionAnswer,
  SessionEventPayload,
  SessionSendInput,
  SessionSendResult,
  SessionStartOptions,
  SessionStatusPayload
} from '../shared/session'
import { isSameOrInside, pathKey } from './path-key'
import { logMain } from './crash-log'
import { localizeText } from '../shared/i18n'
import { mainLocale, msg, t } from './i18n'
import { ClaudeProvider } from './providers/claude/adapter'
import { CodexProvider } from './providers/codex/adapter'
import { DshProvider } from './providers/dsh/adapter'
import type { Provider, ProviderSession } from './providers/types'
import { diffWorkspace, snapshotWorkspace, type WorkspaceSnapshot } from './workspace-snapshot'
import { getLegacyRuntimeMcpServers } from './mcp-service'

interface Live {
  id: string
  /** 这条会话跑在哪个 CLI 上 —— 渠道和进程都得按它来取 */
  cli: CliId
  cwd: string
  permissionMode: string
  model: string
  /** 思考深度（CLI 的 --effort）。跟模型一样是启动参数，改了要换进程 */
  effort: EffortLevel
  /**
   * 凭据来源。channel = 渠道；official = Claude 官方登录。
   *
   * 当前进程是用哪一种拉起来的 —— 设置里改了这一项就要换进程，
   * 所以得记住"启动时"的值，不能每次现读 settings。
   */
  authMode: CliAuthMode
  /**
   * 本会话启动时设置里的官方默认模型。
   *
   * 只在本会话没有显式选模型时当兜底；之后设置里再改默认值也不跟 ——
   * 那是「新会话默认」，不是全局开关。
   */
  officialModel: string
  /** CLI 自己的会话 id，供将来 --resume 恢复 */
  providerSessionId: string | null
  /** 打开时指定要接着跑的那条会话（--resume 的初值） */
  initialResumeId: string | null
  /** 长驻的 CLI 进程；首次发送时才拉起来 */
  session: ProviderSession | null
  /** 本轮已经发生的工具调用数，用于状态栏的「N 步」 */
  toolCount: number
  /** 是否有一轮正在跑 */
  busy: boolean
  /** 用户主动打断时置位，避免把打断当成错误 */
  interrupted: boolean
  /** 忙碌时发来的消息排队，轮结束再发（图片也要原样留着） */
  queue: SessionSendInput[]
  /** 本会话"总是允许"的工具名 —— 收到请求时我们直接代答，不打扰用户 */
  autoAllow: Set<string>
  /** 最近一条转给用户的审批请求是哪个工具（"总是允许"要记的就是它） */
  lastAskedTool: string | null
  /** 模型/思考深度/MCP 改了，当前进程的启动参数已过期，下一轮要换一个 */
  needsRespawn: boolean
  /** 本轮开始时的磁盘快照；轮末再拍一次，两次对比出工具事件漏掉的改动 */
  diskBefore: WorkspaceSnapshot | null
}

/**
 * 会话生命周期。
 *
 * 与 M1 最大的不同：一个会话对应**一个长驻的 CLI 进程**，而不是每轮拉一个。
 * 原因是审批必须在工具执行**之前**拦下来 —— 这要求对话中间有一个活着的东西
 * 接得住 CLI 发来的 control_request。代价是要自己管进程的生死，
 * 好处是打断从"kill 进程"升级成控制协议里的 interrupt，会话本身不受损。
 */
export class SessionManager {
  private live = new Map<string, Live>()
  /**
   * CLI → 适配器。没接入的留 undefined，`providerFor` 会给出明确报错 ——
   * 这样"多 CLI"不是靠 if 分支堆出来的，加一个 CLI 就是加一行。
   */
  private providers: Partial<Record<CliId, Provider>> = {
    claude: new ClaudeProvider(),
    codex: new CodexProvider(),
    dsh: new DshProvider()
  }

  constructor(
    private getSettings: () => Settings,
    private emitEvent: (p: SessionEventPayload) => void,
    private emitStatus: (p: SessionStatusPayload) => void
  ) {}

  private providerFor(id: CliId): Provider | null {
    return this.providers[id] ?? null
  }

  start(o: SessionStartOptions): string {
    const id = randomUUID()
    const cli = o.cli ?? 'claude'
    const cfg = cliConfig(this.getSettings(), cli)
    this.live.set(id, {
      id,
      cli,
      cwd: o.cwd?.trim() || homedir(),
      permissionMode: o.permissionMode,
      model: o.model ?? '',
      effort: o.effort ?? DEFAULT_EFFORT,
      // Claude 的 official = 官方 OAuth；dsh 的 official = 用 DSH_HOME 里
      // 已经配好的 Harness 凭据。Codex 仍然按渠道走。
      authMode: cli === 'claude' || cli === 'dsh' ? cfg.authMode : 'channel',
      officialModel:
        cli === 'claude' || cli === 'dsh' ? cfg.officialModel : '',
      providerSessionId: o.resumeId ?? null,
      initialResumeId: o.resumeId ?? null,
      session: null,
      toolCount: 0,
      busy: false,
      interrupted: false,
      queue: [],
      autoAllow: new Set(),
      lastAskedTool: null,
      needsRespawn: false,
      diskBefore: null
    })
    this.emitStatus({ sessionId: id, status: 'idle', providerSessionId: o.resumeId ?? null })
    return id
  }

  send(sessionId: string, input: SessionSendInput): SessionSendResult {
    const s = this.live.get(sessionId)
    if (!s) return { ok: false, message: t('session.notFound') }
    // 图片-only 消息合法；文本和图片都空才拒绝
    if (!input.text.trim() && !(input.images?.length ?? 0)) {
      return { ok: false, message: t('session.emptyMessage') }
    }

    const auth = this.authFor(s)
    if (!auth) {
      return {
        ok: false,
        message: t('session.noChannel', { cli: cliDef(s.cli).name })
      }
    }

    // 忙的时候**不能**因为 needsRespawn 就把正在跑的进程杀掉：改模型 / MCP
    // 只应该在本轮结束后生效。这里只处理空闲会话；忙碌的交给 flushQueue。
    // （权限模式不在此列：它走控制协议热切换，不会置 needsRespawn。）
    if (s.needsRespawn && !s.busy) this.respawn(s)

    // 进程还没起来就是"要现拉一个" —— 这段时间是在连 CLI，不是在思考。
    // 必须在 ensureSession 之前判断：它一返回 s.session 就有值了。
    const spawning = !s.session

    if (!this.ensureSession(s, auth.channel)) {
      return {
        ok: false,
        message:
          s.authMode === 'official'
            ? t('session.spawnFailedOfficial')
            : t('session.spawnFailed', { cli: cliDef(s.cli).name })
      }
    }

    // 忙碌时排队而不是拒绝：用户打字不该被弹回去
    if (s.busy) {
      s.queue.push(input)
      return { ok: true }
    }

    s.busy = true
    s.interrupted = false
    s.toolCount = 0
    // 拍快照必须在把消息交给 CLI 之前 —— 然后才轮到模型动文件
    s.diskBefore = this.snapshotForTurn(s)
    this.emitEvent({ sessionId: s.id, event: { t: 'turn_started' } })
    this.emitStatus({
      sessionId: s.id,
      status: spawning ? 'starting' : 'running',
      providerSessionId: s.providerSessionId
    })
    s.session?.send(input)
    return { ok: true }
  }

  /**
   * 执行一条 CLI 原生指令。
   *
   * 和 send 分开：指令不是发给模型的正文字。目前只有 Codex 的 compact
   * 有对应的 app-server RPC；其它情况明确返回不支持 —— 绝不能把
   * `/compact` 之类的原文当普通消息丢给模型。
   */
  command(sessionId: string, name: string, args = ''): SessionSendResult {
    const s = this.live.get(sessionId)
    if (!s) return { ok: false, message: t('session.notFound') }

    const cmd = name.trim().replace(/^\/+/, '')
    if (!cmd) return { ok: false, message: t('session.emptyMessage') }
    if (s.busy) return { ok: false, message: t('session.busyCommand') }

    const auth = this.authFor(s)
    if (!auth) {
      return { ok: false, message: t('session.noChannel', { cli: cliDef(s.cli).name }) }
    }
    if (s.needsRespawn) this.respawn(s)
    if (!this.ensureSession(s, auth.channel)) {
      return {
        ok: false,
        message:
          s.authMode === 'official'
            ? t('session.spawnFailedOfficial')
            : t('session.spawnFailed', { cli: cliDef(s.cli).name })
      }
    }

    if (!s.session?.command) {
      return {
        ok: false,
        message: t('session.commandUnsupported', { cli: cliDef(s.cli).name })
      }
    }
    return s.session.command(cmd, args)
  }

  respondPermission(
    sessionId: string,
    requestId: string,
    decision: PermissionDecision,
    always: boolean
  ): void {
    const s = this.live.get(sessionId)
    if (!s?.session) return
    if (always && decision.behavior === 'allow') {
      // 记住的是工具名；下次同名工具直接代答，用户不再被打扰
      s.autoAllow.add(s.lastAskedTool ?? '')
    }
    s.lastAskedTool = null
    s.session.respondPermission(requestId, {
      ...decision,
      always: always && decision.behavior === 'allow'
    })
  }

  /**
   * 回答一次 AskUserQuestion。
   *
   * 提问**不进 autoAllow** —— 「本会话总是允许 AskUserQuestion」没有意义：
   * 放行工具不等于替用户答题，答案每次都得人给。
   */
  respondQuestion(sessionId: string, requestId: string, answer: QuestionAnswer): void {
    const s = this.live.get(sessionId)
    if (!s?.session) return
    s.session.respondQuestion(requestId, answer)
  }

  /**
   * 改本会话的模型 / 权限模式 / 思考深度。
   *
   * 模型和思考深度是 CLI 的**启动参数**，长驻进程起来后就改不了了，只能换进程
   * （用 `--resume` 接回原会话，上下文不会丢）。忙的时候不立刻换，等这一轮
   * 收尾再换。
   *
   * 权限模式是例外：Claude 的控制协议支持运行中热改，而且子代理每次判断权限
   * 都读同一份活状态。所以这里直接下发，不再重启进程 —— 否则正在跑的子代理
   * 会继续用旧模式反复弹审批，用户改了右下角的设置也不生效。
   */
  reconfigure(
    sessionId: string,
    patch: { model?: string; permissionMode?: PermissionMode; effort?: EffortLevel }
  ): void {
    const s = this.live.get(sessionId)
    if (!s) return

    let needsRespawn = false
    if (patch.model !== undefined && patch.model !== s.model) {
      s.model = patch.model
      needsRespawn = true
    }
    if (patch.effort !== undefined && patch.effort !== s.effort) {
      s.effort = patch.effort
      needsRespawn = true
    }
    if (patch.permissionMode !== undefined) {
      s.permissionMode = patch.permissionMode
      if (s.cli === 'claude' && s.session?.setPermissionMode) {
        s.session.setPermissionMode(patch.permissionMode)
      } else {
        // 其它 CLI 的模式是启动参数，只能换进程
        needsRespawn = true
      }
    }

    if (!needsRespawn) return
    s.needsRespawn = true
    if (!s.busy) this.respawn(s)
  }

  /** 把当前 CLI 进程换掉；下一次发送会用新参数重新拉起（并 --resume 接回） */
  private respawn(s: Live): void {
    s.session?.dispose()
    s.session = null
    s.needsRespawn = false
  }

  /**
   * 设置落盘后通知会话：凭据来源是启动参数。
   *
   * 空闲会话立刻换进程，忙碌的等本轮结束（`needsRespawn` 由 flushQueue 消费）。
   * 切换来源时清掉本会话显式设过的模型 —— 旧来源的模型名放到新来源上未必存在。
   *
   * **官方默认模型（officialModel）故意不跟**：它只是新会话的默认值，
   * 每条已存在的会话在自己启动时就把当时的默认值记进了 `Live.officialModel`。
   * 如果在这里把新默认值写进所有会话，用户在一号对话里换模型，二号对话
   * 也会跟着换 —— 模型是会话级选择，不是全局开关。
   */
  settingsChanged(before: Settings, after: Settings): void {
    // Claude 和 dsh 的凭据来源是启动参数；Codex 仍然靠渠道，
    // 它的“登录”由 app-server 自己管。
    for (const cli of ['claude', 'dsh'] as const) {
      const b = cliConfig(before, cli)
      const a = cliConfig(after, cli)
      const modeChanged = b.authMode !== a.authMode
      const channelChanged = b.activeChannelId !== a.activeChannelId
      if (!modeChanged && !channelChanged) continue

      for (const s of this.live.values()) {
        if (s.cli !== cli) continue
        s.authMode = a.authMode
        // 旧来源的模型名放到新来源上未必存在，清掉让新来源自己决定
        if (modeChanged) s.model = ''
        s.needsRespawn = true
        if (!s.busy) this.respawn(s)
      }
    }
  }

  /**
   * 某个 CLI 的 MCP 配置改了。
   *
   * MCP 是启动参数：长驻进程不会自己重新读。空闲会话立刻换进程，
   * 忙碌的先生效到下一轮（send / flushQueue 会消费 needsRespawn）。
   */
  mcpChanged(cli: CliId, opts?: { scope?: McpScope; cwd?: string }): void {
    const scope = opts?.scope
    const cwd = opts?.cwd?.trim() ?? ''
    for (const s of this.live.values()) {
      if (s.cli !== cli) continue
      if (scope === 'local' || scope === 'project') {
        // local 按目录精确匹配；project 的 .mcp.json 对子目录同样生效
        const hit =
          scope === 'local'
            ? !!cwd && pathKey(s.cwd) === pathKey(cwd)
            : !!cwd && isSameOrInside(s.cwd, cwd)
        if (!hit) continue
      }
      // user / global / home / 未指定：该 CLI 的全部会话
      s.needsRespawn = true
      if (!s.busy) this.respawn(s)
    }
  }

  interrupt(sessionId: string): void {
    const s = this.live.get(sessionId)
    if (!s) return
    s.interrupted = true
    s.queue = []
    s.session?.interrupt()
  }

  stop(sessionId: string): void {
    const s = this.live.get(sessionId)
    if (!s) return
    s.interrupted = true
    s.queue = []
    s.diskBefore = null
    s.session?.dispose()
    this.live.delete(sessionId)
    this.emitStatus({ sessionId, status: 'exited', providerSessionId: s.providerSessionId })
  }

  /**
   * 按 CLI 的会话 id 停掉正在跑的会话。
   *
   * 删记录文件之前必须先把进程收掉 —— Windows 上文件被占着 unlink 直接 EPERM。
   * 一个 providerSessionId 可能对应多条 Live（同一个 CLI 会话被开了两次），
   * 所以是遍历而不是查一条。
   */
  stopByProviderId(providerSessionId: string): void {
    if (!providerSessionId) return
    for (const [id, s] of [...this.live]) {
      if (s.providerSessionId === providerSessionId) this.stop(id)
    }
  }

  stopAll(): void {
    for (const id of [...this.live.keys()]) this.stop(id)
  }

  /**
   * 是否有正在跑一轮的会话。
   *
   * 更新安装要重启应用，**不能**打断还在出字的回合；空闲的会话可以放心
   * 关掉 —— 它们的内容已经落盘，重启后还能接着打开。
   */
  hasBusySessions(): boolean {
    for (const s of this.live.values()) {
      if (s.busy) return true
    }
    return false
  }

  /**
   * 此刻正在跑的会话，按 **CLI 自己的 session id** 给。
   *
   * 侧栏要用它决定哪一行该显示「运行中」—— 而侧栏手里只有 CLI 的 session id
   * （会话行的 id 就是它），`emitStatus` 里那个 sessionId 是我们内部的 Live id，
   * 两边对不上。所以这里换算一道再给出去。
   *
   * 还没拿到 CLI id 的新会话（providerSessionId 为 null）不算：它这时候
   * 在侧栏里也还没有对应的行 —— 那份 jsonl 是 CLI 收到第一条消息才写的。
   */
  runningIds(): string[] {
    const out: string[] = []
    for (const s of this.live.values()) {
      if (s.busy && s.providerSessionId) out.push(s.providerSessionId)
    }
    return out
  }

  /**
   * 是否有活跃会话的 cwd 落在 dir 里。
   *
   * 还没发过消息的新会话也算 —— 它已经占着这个目录，删掉工作树之后
   * 再发送只会失败。删除工作树前先让用户把它收掉。
   */
  hasLiveSessionIn(dir: string): boolean {
    for (const s of this.live.values()) {
      if (isSameOrInside(s.cwd, dir)) return true
    }
    return false
  }

  /**
   * 这条会话现在该用什么凭据。
   *
   * official 模式返回 `channel: null` —— provider 据此不注入任何渠道环境；
   * channel 模式没有渠道时返回 null，由调用方给出"去设置里配一个"的提示。
   */
  private authFor(s: Live): { channel: Channel | null } | null {
    if (s.authMode === 'official') return { channel: null }
    const ch = activeChannelOf(this.getSettings(), s.cli)
    return ch ? { channel: ch } : null
  }

  /** 首次发送时才把 CLI 拉起来 —— 这样没配渠道的会话不会白占一个进程 */
  private ensureSession(s: Live, ch: Channel | null): boolean {
    if (s.session) return true

    const provider = this.providerFor(s.cli)
    if (!provider) {
      this.emitEvent({
        sessionId: s.id,
        event: {
          t: 'error',
          message: msg('session.adapterMissing', { cli: cliDef(s.cli).name }),
          fatal: true
        }
      })
      return false
    }

    try {
      // 官方登录没有渠道，模型回落到设置里的 officialModel（空 = CLI 默认）
      const fallbackModel =
        ch?.model ?? (s.authMode === 'official' ? s.officialModel.trim() : '')
      const model = s.model.trim() || fallbackModel
      const resume = s.providerSessionId ?? s.initialResumeId ?? null
      s.session = provider.start({
        channel: ch,
        cwd: s.cwd,
        model,
        permissionMode: s.permissionMode,
        effort: s.effort,
        addDirs: [],
        // 只注入旧私有 store 的条目（迁移期兼容）；原生条目由 CLI 自己读
        mcpServers: getLegacyRuntimeMcpServers(s.cli, s.cwd),
        // 进程活着就用它自己的 id；进程重启后回落到最初要接的那条
        resumeId: resume,
        onEvent: (e) => this.onEvent(s, e),
        onExit: (code, stderr) => this.onExit(s, code, stderr)
      })
      // 只记启动参数，不记 prompt / 用户输入
      logMain('session.spawn', {
        id: s.id,
        cli: s.cli,
        cwd: s.cwd,
        model,
        permissionMode: s.permissionMode,
        resume
      })
      return true
    } catch (err) {
      s.session = null
      logMain('session.spawn-failed', { id: s.id, cli: s.cli, cwd: s.cwd, error: err })
      this.emitEvent({
        sessionId: s.id,
        event: {
          t: 'error',
          message: msg('session.spawnError', { detail: String(err) }),
          fatal: true
        }
      })
      return false
    }
  }

  private onEvent(s: Live, e: AgentEvent): void {
    /*
     * 权限模式的实际生效值。以 CLI 为准而不是界面的点选值：CLI 可能拒绝
     * （bypass 未授权）或自己回落（auto 不可用）。主进程也同步一份，
     * 下一次换进程时按它启动。
     */
    if (e.t === 'permission_mode_changed') {
      s.permissionMode = e.mode
      this.emitEvent({ sessionId: s.id, event: e })
      return
    }

    // 审批请求不进转写区，由我们代答或转给用户
    if (e.t === 'permission_request') {
      if (s.autoAllow.has(e.tool)) {
        s.session?.respondPermission(e.id, { behavior: 'allow' })
        return
      }
      s.lastAskedTool = e.tool
      this.emitEvent({ sessionId: s.id, event: e })
      return
    }

    let ev = e
    if (ev.t === 'session_started') {
      if (ev.sessionId) s.providerSessionId = ev.sessionId
      // CLI 可能没按请求的模式启动（例如自动回落到 default），以它为准
      s.permissionMode = ev.permissionMode
      // CLI 起来了：把"连接中"换成"运行中"。这两段对用户是两件事，
      // 前者是进程在启动，后者才是模型在干活。
      if (s.busy) {
        this.emitStatus({
          sessionId: s.id,
          status: 'running',
          providerSessionId: s.providerSessionId
        })
      }
    } else if (ev.t === 'tool_call') {
      s.toolCount += 1
    } else if (ev.t === 'error' && !ev.fatal && s.cli === 'claude' && s.authMode === 'official') {
      // CLI 把"未登录"放在 result 里、以 is_error 结束；补一句去哪修。
      // 先把 LocalizedText 解析成当前语言再匹配 —— 匹配的是外部原文。
      const raw =
        typeof ev.message === 'string' ? ev.message : localizeText(mainLocale(), ev.message)
      if (/not logged in|please run \/login|unauthorized|401|authentication/i.test(raw)) {
        ev = { ...ev, message: t('session.officialAuthHint', { detail: raw }) }
      }
    } else if (ev.t === 'turn_end') {
      // 步数只有管理器知道，在这里补齐
      ev = { ...ev, steps: s.toolCount }
      /*
       * 磁盘对比必须在把「空闲」推给界面之前做完。否则用户看到空闲后
       * 立刻发下一条，上一轮的磁盘改动会晚到，被渲染层算进新一轮。
       */
      const diskChanges = this.collectDiskChanges(s)
      s.busy = false
      s.lastAskedTool = null
      for (const c of diskChanges) this.emitEvent({ sessionId: s.id, event: c })
      this.emitStatus({
        sessionId: s.id,
        status: 'idle',
        providerSessionId: s.providerSessionId
      })
      this.emitEvent({ sessionId: s.id, event: ev })
      this.flushQueue(s)
      return
    }
    this.emitEvent({ sessionId: s.id, event: ev })
  }

  private snapshotForTurn(s: Live): WorkspaceSnapshot | null {
    try {
      return snapshotWorkspace(s.cwd)
    } catch {
      return null
    }
  }

  /** 轮末对比磁盘；快照失败时安静退化成「只用工具事件」 */
  private collectDiskChanges(s: Live): AgentEvent[] {
    const before = s.diskBefore
    s.diskBefore = null
    if (!before) return []
    try {
      return diffWorkspace(before, snapshotWorkspace(s.cwd))
    } catch {
      return []
    }
  }

  private flushQueue(s: Live): void {
    const next = s.queue.shift()
    if (!next) return
    if (s.needsRespawn) this.respawn(s)
    const spawning = !s.session
    const auth = this.authFor(s)
    if (!auth || !this.ensureSession(s, auth.channel)) {
      // 队列不能悄悄停住：告诉用户为什么这一条没发出去
      this.emitEvent({
        sessionId: s.id,
        event: {
          t: 'error',
          message:
            s.authMode === 'official'
              ? msg('session.queuedAuthFailed')
              : msg('session.queuedNoChannel', { cli: cliDef(s.cli).name }),
          fatal: false
        }
      })
      return
    }
    s.busy = true
    s.interrupted = false
    s.toolCount = 0
    s.diskBefore = this.snapshotForTurn(s)
    this.emitEvent({ sessionId: s.id, event: { t: 'turn_started' } })
    this.emitStatus({
      sessionId: s.id,
      status: spawning ? 'starting' : 'running',
      providerSessionId: s.providerSessionId
    })
    s.session?.send(next)
  }

  private onExit(s: Live, code: number | null, stderr: string): void {
    logMain('session.exit', {
      id: s.id,
      cli: s.cli,
      cwd: s.cwd,
      code,
      interrupted: s.interrupted,
      // 正常退出不记 stderr（可能夹带用户内容），只留长度；异常退出留个尾部
      stderrBytes: stderr.length,
      stderrTail: !s.interrupted && code !== 0 ? stderr.trim().slice(-400) : undefined
    })

    s.session = null
    s.busy = false
    /*
     * 进程都没了，这一轮不会再有 turn_end。把已经落盘的改动结算掉，
     * 别让它们消失（也别留到下一轮的 before 快照里，那样就永远报不出来）。
     */
    const diskChanges = this.collectDiskChanges(s)

    if (!s.interrupted && code !== null && code !== 0) {
      const tail = stderr.trim().slice(-400)
      const authHint =
        s.cli === 'claude' &&
        s.authMode === 'official' &&
        /not logged in|unauthorized|401|authentication/i.test(stderr)
          ? t('session.officialAuthHintSuffix')
          : ''
      this.emitEvent({
        sessionId: s.id,
        event: {
          t: 'error',
          message: msg('session.exitCode', {
            code,
            detail: tail ? `\n${tail}` : '',
            hint: authHint
          }),
          fatal: true
        }
      })
    }

    for (const c of diskChanges) this.emitEvent({ sessionId: s.id, event: c })
    this.emitStatus({
      sessionId: s.id,
      status: 'idle',
      providerSessionId: s.providerSessionId,
      code
    })
    // 进程没了但会话还在，下一轮会重新拉起
    this.flushQueue(s)
  }
}
