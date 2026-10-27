import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentEvent,
  PermissionMode,
  Question,
  Usage
} from '../../../../shared/events'
import type { LocalizedText } from '../../../../shared/i18n'
import { canonicalModel } from '../../../../shared/model'
import type {
  PermissionDecision,
  QuestionAnswer,
  SessionSendInput
} from '../../../../shared/session'
import { msg, t } from '../../../i18n'
import { buildPreview } from '../../permission-preview'
import type { ProviderSession, ProviderSessionOptions } from '../../types'
import {
  DshEventTranslator,
  type DshAssistantStreamFrame,
  type DshWireEvent
} from '../events'
import { ensureDshHome, dshHomeForChannel, findDshHomeForSession } from '../runner'
import {
  arr,
  autoPermission,
  dshEffortForSelect,
  normalizeToolInput,
  num,
  obj,
  str,
  uiPermissionOptions,
  uiToolName,
  type Obj
} from '../shared'
import {
  DshWebError,
  getDshWebHost,
  type DshFollowSnapshot,
  type DshHostSession,
  type DshStream,
  type DshWebHost
} from './host'

/**
 * 通过 dsh Web 协议驱动的 ProviderSession。
 *
 * 生命周期：
 *  - 第一次 send 时才拉起 host / 创建或恢复 dsh 会话；
 *  - host 按 DSH_HOME 共享，一个 host 上可以挂很多会话；
 *  - dispose 只断开本会话的 follow 流，不关闭 dsh 进程里的 agent ——
 *    Web API 没有 session/close，agent 会在 host 里闲置，由 host 的空闲
 *    回收（10 分钟）或应用退出来收尾。
 */

function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0
  }
}

function reasonText(request: Obj): string {
  const direct = str(request.reason)
  if (direct) return direct
  const display = obj(request.displayReason)
  return str(display.zh) || str(display.en) || ''
}

function questionText(item: Obj): string {
  const question = str(item.question)
  const detail = str(item.detail)
  return detail ? `${question}\n\n${detail}` : question
}

interface PendingPermission {
  eventId: string
  tool: string
  callId: string
}

interface PendingQuestion {
  eventId: string
  /** 发给 UI 的 question 文本 → dsh 的 question id */
  items: Array<{
    id: string
    text: string
    options: Array<{ label: string }>
  }>
  callId: string
  /** true = 来自 userQuestions 投影（continued），用 userQuestions/answer */
  viaProjection: boolean
}

export class DshWebSession implements ProviderSession, DshHostSession {
  private host: DshWebHost | null = null
  private sessionIdValue = ''
  private follow: DshStream | null = null
  private attach: Promise<void> | null = null
  private translator: DshEventTranslator
  private lastSeq = -1
  private emittedStarted = false
  private hostOnline = false
  private disposed = false
  private done = false
  private exited = false
  private model = ''
  private pendingPermissions = new Map<string, PendingPermission>()
  private pendingQuestions = new Map<string, PendingQuestion>()
  private denyAlways = new Set<string>()
  private sendChain: Promise<void> = Promise.resolve()
  private lastErrorText = ''
  private lastErrorAt = 0
  private title = ''
  private planActive = false
  private permissionsValue = ''
  private followRetry: NodeJS.Timeout | null = null
  /** 投影可能先于 session_started 到达；先存着，等会话卡片建好再处理 */
  private started = false
  private queuedProjections: Record<string, unknown> = {}

  constructor(private o: ProviderSessionOptions) {
    this.translator = new DshEventTranslator({
      sessionId: o.resumeId ?? '',
      cwd: o.cwd,
      initialModel: o.model,
      live: true,
      emitStarted: false,
      emitTurnStarted: false,
      onEvent: (e) => this.emit(e)
    })
  }

  get sessionId(): string {
    return this.sessionIdValue
  }

  /* ── 启动 / 附加 ───────────────────────────────────────── */

  private home(): string {
    if (this.o.dshHome?.trim()) return ensureDshHome(this.o.dshHome)
    return (
      findDshHomeForSession(this.o.resumeId) ?? dshHomeForChannel(this.o.channel)
    )
  }

  private patchFile(home: string): string | undefined {
    /*
     * Web profile 没有 session/new 的 mcpServers 参数；MCP 必须挂在 profile
     * 配置里。App 的 MCP 管理器历史上写的是 acp profile 的用户 patch，
     * 这里把它作为 --patch 叠加到 web profile 上，避免两套配置。
     */
    const file = join(home, 'profiles', 'acp', 'cordis.patch.yml')
    return existsSync(file) ? file : undefined
  }

  private async ensure(): Promise<void> {
    if (this.disposed) throw new DshWebError('dsh/web-disposed', '会话已关闭。')
    if (this.hostOnline && this.sessionIdValue) return
    if (this.attach) return this.attach
    this.attach = this.doEnsure().finally(() => {
      this.attach = null
    })
    return this.attach
  }

  private async doEnsure(): Promise<void> {
    if (!this.host) {
      const home = this.home()
      this.host = getDshWebHost({
        home,
        channel: this.o.channel,
        cwd: this.o.cwd,
        patchFile: this.patchFile(home)
      })
      this.host.ref()
      await this.host.ready
      this.hostOnline = true
    } else if (!this.hostOnline) {
      await this.host.whenOnline()
      this.hostOnline = true
    }

    if (!this.sessionIdValue) {
      const resumeId = this.o.resumeId?.trim()
      if (resumeId) {
        this.sessionIdValue = resumeId
      } else {
        const created = await this.host.call<Obj>('session/create', {
          request: { cwd: this.o.cwd }
        })
        this.sessionIdValue = str(created.sessionId)
        if (!this.sessionIdValue) {
          throw new DshWebError('dsh/web-session', 'DeepSeek Harness 没有返回 sessionId。')
        }
      }
    }

    this.host.registerSession(this)

    try {
      await this.openFollow()
    } catch (e) {
      // 历史会话被删掉 / 被别的进程占用：给出清晰错误，不要悄悄新建
      if (e instanceof DshWebError && e.code === 'session/not-found' && this.o.resumeId) {
        throw new DshWebError(
          'dsh/web-resume-missing',
          t('dsh.web.resumeMissing')
        )
      }
      throw e
    }

    await this.applyModel()
    await this.applyPermissionPreset()

    if (!this.emittedStarted) {
      this.emittedStarted = true
      this.emit({
        t: 'session_started',
        sessionId: this.sessionIdValue,
        provider: 'dsh',
        model: this.model || this.o.model,
        cwd: this.o.cwd,
        tools: [],
        permissionMode: this.o.permissionMode as PermissionMode
      })
    }
    this.started = true
    const pending = this.queuedProjections
    this.queuedProjections = {}
    if (Object.keys(pending).length > 0) this.onProjections(pending)

    void this.refreshCommands()
  }

  private openFollow(): Promise<void> {
    if (!this.host) return Promise.reject(new DshWebError('dsh/web-host', 'host 未就绪'))
    const host = this.host
    const sessionId = this.sessionIdValue
    return new Promise<void>((resolve, reject) => {
      let opened = false
      try {
        this.follow?.close()
        this.follow = host.openStream(
          'session/follow',
          {
            request: {
              address: { kind: 'session', sessionId },
              assistantStream: true
            }
          },
          {
            onItem: (value) => {
              const frame = obj(value)
              const type = str(frame.type)
              if (type === 'snapshot') {
                const snap = frame as unknown as DshFollowSnapshot
                this.lastSeq = num(snap.cursor)
                const values = obj(obj(snap.projections).values)
                this.onProjections(values)
                opened = true
                resolve()
                return
              }
              if (type === 'event') {
                const event = obj(frame.event) as unknown as DshWireEvent
                const seq = num(event.seq)
                if (seq > 0 && seq <= this.lastSeq && this.lastSeq >= 0) return
                if (seq > 0) this.lastSeq = seq
                this.translator.push(event)
                return
              }
              if (type === 'assistant-stream') {
                this.translator.pushStream(
                  obj(frame.frame) as unknown as DshAssistantStreamFrame
                )
              }
            },
            onError: (e) => {
              if (!opened) {
                reject(e)
                return
              }
              this.emit({
                t: 'error',
                message: msg('dsh.web.followLost', { detail: e.message }),
                fatal: false
              })
              this.scheduleFollowReopen()
            },
            onEnd: () => {
              if (!opened) {
                reject(new DshWebError('dsh/web-follow', '会话事件流提前结束。'))
                return
              }
              this.scheduleFollowReopen()
            }
          }
        )
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  private async reopenFollow(): Promise<void> {
    if (!this.host || !this.sessionIdValue || this.disposed) return
    try {
      await this.openFollow()
    } catch (e) {
      this.emit({
        t: 'error',
        message: msg('dsh.web.followLost', {
          detail: e instanceof Error ? e.message : String(e)
        }),
        fatal: false
      })
      this.scheduleFollowReopen()
    }
  }

  /** follow 流单独坏掉（不是整条 socket）时，1 秒后重开。 */
  private scheduleFollowReopen(): void {
    if (this.followRetry || this.disposed || this.done) return
    this.followRetry = setTimeout(() => {
      this.followRetry = null
      if (this.disposed || this.done) return
      if (this.host?.isConnected && this.sessionIdValue) void this.reopenFollow()
    }, 1_000)
    this.followRetry.unref?.()
  }

  /* ── 模型 / 权限 ───────────────────────────────────────── */

  private async applyModel(): Promise<void> {
    const host = this.host
    if (!host) return
    const wanted = this.o.model.trim()
    if (!wanted) return

    let provider = 'deepseek-official'
    let modelId = canonicalModel(wanted) || wanted
    let effort = dshEffortForSelect(this.o.effort)
    let hasRoutes = false

    try {
      const catalog = await host.modelCatalog()
      const groups = arr(catalog.groups).map(obj)
      hasRoutes =
        arr(catalog.routableProviders).length > 0 ||
        groups.some((g) => arr(g.models).length > 0)
      const wantedCanonical = canonicalModel(wanted)
      outer: for (const group of groups) {
        for (const m of arr(group.models).map(obj)) {
          const id = str(m.id)
          const name = str(m.name)
          if (
            canonicalModel(id) === wantedCanonical ||
            canonicalModel(name) === wantedCanonical
          ) {
            provider = str(group.id) || provider
            modelId = id || modelId
            const efforts = arr(obj(m.reasoning).efforts).map(obj)
            if (effort && efforts.length > 0) {
              const hit = efforts.find(
                (e) =>
                  str(e.id) === effort ||
                  str(e.name).toLowerCase() === effort?.toLowerCase()
              )
              if (hit) effort = str(hit.id)
              else {
                effort = undefined
                this.note(
                  msg('dsh.web.effortUnavailable', {
                    effort: this.o.effort,
                    options: efforts.map((e) => str(e.id)).filter(Boolean).join(' / ')
                  })
                )
              }
            }
            break outer
          }
        }
      }
    } catch {
      // 没有凭据/目录时 modelCatalog 可能为空；下面仍然尝试 selectModel
    }

    // 没有任何可用路由（通常是没有凭据）时不要强行 selectModel：
    // 那只会报 session/model-unavailable，而真正的错误会在 prompt 时出现。
    if (!hasRoutes) {
      this.model = modelId
      return
    }

    try {
      const res = await host.call<Obj>('session/selectModel', {
        request: {
          sessionId: this.sessionIdValue,
          provider,
          model: modelId,
          ...(effort ? { reasoningEffort: effort } : {})
        }
      })
      const selected = obj(obj(res).selected)
      this.model = str(selected.model) || modelId
    } catch (e) {
      this.note(
        msg('dsh.web.modelUnavailable', {
          model: wanted,
          detail: e instanceof Error ? e.message : String(e)
        })
      )
      this.model = modelId
    }
  }

  private async applyPermissionPreset(): Promise<void> {
    const host = this.host
    if (!host) return
    const plan = this.o.permissionMode === 'plan'
    const preset = plan
      ? 'read-only'
      : this.o.permissionMode === 'bypassPermissions'
        ? 'danger-full-access'
        : 'workspace-write'

    const run = async (line: string): Promise<void> => {
      try {
        await host.call('commands/execute', {
          agentId: this.sessionIdValue,
          line,
          submittedAttachments: []
        })
      } catch {
        // 旧版 dsh / 自定义 profile 可能没有这些指令；宿主侧 autoPermission 仍能兜住
      }
    }

    if (this.permissionsValue !== preset) await run(`/permission ${preset}`)
    if (plan && !this.planActive) await run('/plan')
    else if (!plan && this.planActive) await run('/plan off')
  }

  private async refreshCommands(): Promise<void> {
    if (!this.host || !this.sessionIdValue) return
    try {
      const res = await this.host.call<unknown>('commands/list', {
        agentId: this.sessionIdValue
      })
      const list = Array.isArray(res) ? res : arr(obj(res).commands)
      const commands = list
        .map(obj)
        .map((c) => {
          const name = str(c.name).trim().replace(/^\/+/, '')
          if (!name) return null
          const input = obj(c.input)
          const hint = str(input.hint).trim()
          return {
            name,
            description: str(c.description),
            ...(hint ? { argumentHint: hint } : {}),
            run: 'app' as const,
            group: 'command' as const
          }
        })
        .filter((c): c is NonNullable<typeof c> => !!c)
      if (commands.length > 0) this.emit({ t: 'native_commands', commands })
    } catch {
      // 指令目录不是关键路径
    }
  }

  /* ── 发送 / 打断 ───────────────────────────────────────── */

  send(input: SessionSendInput): void {
    if (this.done || this.disposed) return
    this.sendChain = this.sendChain
      .then(() => this.prompt(input))
      .catch((e) => {
        if (this.done || this.disposed) return
        const message = e instanceof Error ? e.message : String(e)
        this.emit({ t: 'error', message, fatal: true })
        this.finishWithExit(message)
      })
  }

  private async prompt(input: SessionSendInput): Promise<void> {
    await this.ensure()

    const content: Obj[] = []
    const text = input.text.trim()
    if (text) content.push({ type: 'text', text })
    for (const image of input.images ?? []) {
      if (!image.data) continue
      content.push({
        type: 'image',
        mediaType: image.mediaType || 'image/png',
        data: image.data,
        ...(image.name ? { name: image.name } : {})
      })
    }
    if (content.length === 0) {
      this.note(msg('dsh.web.emptyPrompt'))
      return
    }

    try {
      await this.host!.call('session/prompt', {
        request: {
          requestId: randomUUID(),
          sessionId: this.sessionIdValue,
          mode: 'queue',
          content,
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
        }
      })
    } catch (e) {
      if (e instanceof DshWebError && e.code === 'dsh/web-auth-expired') {
        // host 正在重连；这条消息没有进入队列，让用户重发
        this.note(msg('dsh.web.offline'))
      } else {
        this.note(
          msg('dsh.web.promptFailed', {
            detail: e instanceof Error ? e.message : String(e)
          })
        )
      }
      this.emit({
        t: 'turn_end',
        durationMs: 0,
        usage: emptyUsage(),
        steps: 0
      })
    }
  }

  interrupt(): void {
    if (!this.host || !this.sessionIdValue || this.done) return
    void this.host
      .call('session/cancel', { request: { sessionId: this.sessionIdValue } })
      .catch(() => undefined)
  }

  command(name: string, args: string): { ok: boolean; message?: string } {
    if (this.done || this.disposed) {
      return { ok: false, message: t('dsh.web.offline') }
    }
    const line = `/${name}${args ? ` ${args}` : ''}`
    // 新会话可能还没发过消息；先完成 attach，再执行指令
    void this.ensure()
      .then(() =>
        this.host!.call('commands/execute', {
          agentId: this.sessionIdValue,
          line,
          submittedAttachments: []
        })
      )
      .catch((e) => {
        this.note(
          msg('dsh.web.commandFailed', {
            detail: e instanceof Error ? e.message : String(e)
          })
        )
      })
    return { ok: true }
  }

  /* ── 审批 ──────────────────────────────────────────────── */

  onApproval(eventId: string, request: Obj): void {
    const tool = uiToolName(str(request.toolName), '')
    const callId = str(request.callId)
    const auto = autoPermission(this.o.permissionMode, tool)
    if (auto === 'allow') {
      void this.answerApproval(eventId, true)
      return
    }
    if (auto === 'deny' || this.denyAlways.has(tool)) {
      void this.answerApproval(eventId, false)
      return
    }

    const input = normalizeToolInput(
      (callId && this.translator.inputOf(callId)) || {
        tool_name: str(request.toolName),
        ...(reasonText(request) ? { reason: reasonText(request) } : {})
      },
      []
    )
    const preview = buildPreview(tool, input, this.o.cwd)
    const reason = reasonText(request)
    if (reason && !preview.note) preview.note = reason

    this.pendingPermissions.set(eventId, { eventId, tool, callId })
    this.emit({
      t: 'permission_request',
      id: eventId,
      tool,
      input,
      preview,
      options: uiPermissionOptions(tool)
    })
  }

  respondPermission(requestId: string, decision: PermissionDecision): void {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return
    this.pendingPermissions.delete(requestId)
    if (decision.behavior === 'deny' && decision.always) {
      this.denyAlways.add(pending.tool)
    }
    void this.answerApproval(requestId, decision.behavior === 'allow')
  }

  private async answerApproval(eventId: string, allow: boolean): Promise<void> {
    try {
      await this.host?.answerWaterfall(eventId, {
        kind: 'result',
        value: allow ? 'allowed-once' : 'rejected'
      })
    } catch (e) {
      this.note(
        msg('dsh.web.answerLost', {
          detail: e instanceof Error ? e.message : String(e)
        })
      )
    }
  }

  /* ── 提问 ──────────────────────────────────────────────── */

  onQuestion(eventId: string, request: Obj): void {
    const raw = arr(request.questions).map(obj)
    if (raw.length === 0) {
      void this.host?.answerWaterfall(eventId, { kind: 'result', value: { answers: [] } })
      return
    }
    const questions: Question[] = raw.map((q) => ({
      question: questionText(q),
      header: str(q.header),
      options: arr(q.options)
        .map(obj)
        .map((o) => ({
          label: str(o.label),
          description: str(o.description)
        })),
      multiSelect: q.multiSelect === true
    }))
    const items = raw.map((q, i) => ({
      id: str(q.id) || String(i),
      text: questions[i].question,
      options: questions[i].options.map((o) => ({ label: o.label }))
    }))
    const callId = str(obj(request.wait).callId)
    this.pendingQuestions.set(eventId, {
      eventId,
      items,
      callId,
      viaProjection: false
    })
    this.emit({
      t: 'question_request',
      id: eventId,
      tool: 'AskUserQuestion',
      input: { questions: raw },
      questions
    })
  }

  respondQuestion(requestId: string, answer: QuestionAnswer): void {
    const pending = this.pendingQuestions.get(requestId)
    if (!pending) return
    this.pendingQuestions.delete(requestId)
    const answers = pending.items.map((item) => {
      const value = answer.answers[item.text]
      const values = Array.isArray(value) ? value : value ? [value] : []
      const known = values.filter((v) =>
        item.options.some((o) => o.label === v)
      )
      const custom = values.filter(
        (v) => !item.options.some((o) => o.label === v)
      )
      return {
        id: item.id,
        selected: answer.skipped ? [] : known,
        ...(custom.length > 0 ? { custom: custom.join('\n') } : {})
      }
    })
    const payload = { answers }
    if (pending.viaProjection) {
      void this.host
        ?.call('userQuestions/answer', {
          agentId: this.sessionIdValue,
          callId: pending.callId,
          answer: payload
        })
        .catch((e) => {
          this.note(
            msg('dsh.web.answerLost', {
              detail: e instanceof Error ? e.message : String(e)
            })
          )
        })
      return
    }
    void this.host
      ?.answerWaterfall(requestId, { kind: 'result', value: payload })
      .catch((e) => {
        this.note(
          msg('dsh.web.answerLost', {
            detail: e instanceof Error ? e.message : String(e)
          })
        )
      })
  }

  onEventCancelled(eventId: string): void {
    this.pendingPermissions.delete(eventId)
    this.pendingQuestions.delete(eventId)
  }

  /* ── host 回调 ─────────────────────────────────────────── */

  onHostConnected(): void {
    if (this.hostOnline || this.disposed) {
      this.hostOnline = true
      return
    }
    this.hostOnline = true
    void this.reopenFollow()
  }

  onHostDisconnected(): void {
    this.hostOnline = false
    this.follow?.close()
    this.follow = null
    this.note(msg('dsh.web.connectionLost'))
  }

  onHostExit(code: number | null, stderr: string): void {
    if (this.exited || this.disposed) return
    // 非进程崩溃的 host 关闭（配置变更 / 重连失败）没有 exitCode，
    // 给用户一张说明卡；非零退出由 SessionManager 自己报。
    if (code === null && stderr.trim()) {
      this.emit({ t: 'error', message: stderr.trim(), fatal: false })
    }
    this.exited = true
    this.done = true
    if (this.followRetry) {
      clearTimeout(this.followRetry)
      this.followRetry = null
    }
    this.follow?.close()
    this.follow = null
    this.host?.unregisterSession(this.sessionIdValue)
    this.host?.unref()
    this.o.onExit(code, stderr)
  }

  onProjections(values: Record<string, unknown>): void {
    if (!this.started) {
      this.queuedProjections = { ...this.queuedProjections, ...values }
      return
    }
    const title = values.title
    if (typeof title === 'string' && title) this.title = title

    const selection = obj(values.modelSelection)
    const next = obj(selection.next) ?? obj(selection.lastUsed)
    const model = str(next.model)
    if (model) this.model = model

    const plan = obj(values.plan)
    if (typeof plan.active === 'boolean') this.planActive = plan.active

    const permissions = obj(values.permissions)
    if (typeof permissions.currentValue === 'string') {
      this.permissionsValue = permissions.currentValue
    }

    const questions = obj(values.userQuestions)
    for (const entry of arr(questions.active).map(obj)) {
      // open 状态由实时 waterfall 处理；投影只补 continued（超时后仍可回答）
      if (str(entry.state) !== 'continued') continue
      const callId = str(entry.callId)
      if (!callId) continue
      if ([...this.pendingQuestions.values()].some((q) => q.callId === callId)) {
        continue
      }
      const raw = arr(entry.questions).map(obj)
      if (raw.length === 0) continue
      const questionsUi: Question[] = raw.map((q) => ({
        question: questionText(q),
        header: str(q.header),
        options: arr(q.options)
          .map(obj)
          .map((o) => ({ label: str(o.label), description: str(o.description) })),
        multiSelect: q.multiSelect === true
      }))
      const items = raw.map((q, i) => ({
        id: str(q.id) || String(i),
        text: questionsUi[i].question,
        options: questionsUi[i].options.map((o) => ({ label: o.label }))
      }))
      // 用 callId 作为 UI id；同一个 callId 只弹一次
      const id = `question:${callId}`
      this.pendingQuestions.set(id, {
        eventId: id,
        items,
        callId,
        viaProjection: true
      })
      this.emit({
        t: 'question_request',
        id,
        tool: 'AskUserQuestion',
        input: { questions: raw },
        questions: questionsUi
      })
    }
  }

  onProjection(key: string, value: unknown): void {
    if (key === 'commandsChanged') {
      void this.refreshCommands()
      return
    }
    if (key === 'title') {
      if (typeof value === 'string' && value) this.title = value
      return
    }
    if (key === 'hostError') {
      if (typeof value === 'string' && value) this.note(value)
      return
    }
    if (key === 'userQuestions') {
      this.onProjections({ userQuestions: value })
      return
    }
    if (key === 'modelSelection') {
      const next = obj(obj(value).next) ?? obj(obj(value).lastUsed)
      const model = str(next.model)
      if (model) this.model = model
      return
    }
    if (key === 'plan') {
      const plan = obj(value)
      if (typeof plan.active === 'boolean') this.planActive = plan.active
      return
    }
    if (key === 'permissions') {
      const permissions = obj(value)
      if (typeof permissions.currentValue === 'string') {
        this.permissionsValue = permissions.currentValue
      }
    }
  }

  /* ── 收尾 ──────────────────────────────────────────────── */

  private emit(event: AgentEvent): void {
    if (this.disposed || this.done) return
    if (event.t === 'error') {
      // $events 的 api-session/error 与 turn/end.reason 会同时报同一个失败；
      // 1.5 秒内同文案只留一张错误卡。
      const text =
        typeof event.message === 'string'
          ? event.message
          : JSON.stringify(event.message)
      const now = Date.now()
      if (text === this.lastErrorText && now - this.lastErrorAt < 1500) return
      this.lastErrorText = text
      this.lastErrorAt = now
    }
    this.o.onEvent(event)
  }

  private note(message: LocalizedText): void {
    this.emit({ t: 'error', message, fatal: false })
  }

  private finishWithExit(message: string): void {
    if (this.exited || this.disposed) return
    this.exited = true
    this.done = true
    if (this.followRetry) {
      clearTimeout(this.followRetry)
      this.followRetry = null
    }
    this.follow?.close()
    this.follow = null
    this.host?.unregisterSession(this.sessionIdValue)
    this.host?.unref()
    this.o.onExit(null, message)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.followRetry) {
      clearTimeout(this.followRetry)
      this.followRetry = null
    }
    this.follow?.close()
    this.follow = null
    this.host?.unregisterSession(this.sessionIdValue)
    this.host?.unref()
    this.pendingPermissions.clear()
    this.pendingQuestions.clear()
  }
}
