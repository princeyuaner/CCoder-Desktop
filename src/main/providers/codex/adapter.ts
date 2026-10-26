import { existsSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import type {
  AgentEvent,
  DiffLine,
  PermissionMode,
  PermissionOption,
  PermissionPreview,
  Question,
  Usage
} from '../../../shared/events'
import type { PermissionDecision, QuestionAnswer, SessionSendInput } from '../../../shared/session'
import { CodexRpc, initializeCodex, resolveCodexBin } from '../../codex-runner'
import type { Provider, ProviderSession, ProviderSessionOptions } from '../types'
import { buildPreview } from '../permission-preview'
import { msg, t } from '../../i18n'

type Obj = Record<string, unknown>

const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * 我们的权限模式 → Codex 的 (approvalPolicy, permissions profile)。
 *
 * Codex 的沙箱和审批是两个维度：
 *  - `:read-only` 下任何写操作都要额外授权，最接近 Claude 的「每次都问」；
 *  - `:workspace` 放开工作区写入，审批只处理越界命令；
 *  - `:danger-full-access` 完全不设防，只有用户明确选「跳过权限」才用。
 */
const CODEX_MODE: Record<string, { approval: string; permissions: string }> = {
  standard: { approval: 'untrusted', permissions: ':read-only' },
  acceptEdits: { approval: 'on-request', permissions: ':workspace' },
  auto: { approval: 'on-request', permissions: ':workspace' },
  plan: { approval: 'never', permissions: ':read-only' },
  dontAsk: { approval: 'never', permissions: ':workspace' },
  bypassPermissions: { approval: 'never', permissions: ':danger-full-access' }
}

const MODES: PermissionMode[] = [
  'standard',
  'acceptEdits',
  'auto',
  'plan',
  'dontAsk',
  'bypassPermissions'
]

function normalizeMode(v: string): PermissionMode {
  return (MODES as string[]).includes(v) ? (v as PermissionMode) : 'standard'
}

function permissionOptions(tool: string, allowAlways = true): PermissionOption[] {
  return [
    { value: 'allow', label: msg('permission.allowOption') },
    ...(allowAlways
      ? [{ value: 'allow-always', label: msg('permission.allowAlwaysOption', { tool }) }]
      : []),
    { value: 'deny', label: msg('permission.denyOption'), danger: true }
  ]
}

function clip(s: string, max = 20_000): string {
  return s.length > max ? `${s.slice(0, max)}\n${t('codex.outputTruncated')}` : s
}

/* ── 文件 diff ───────────────────────────────────────────── */

/** Codex 给的是 unified diff；去掉文件头，只留界面能画的增删上下文 */
function diffLines(patch: string): DiffLine[] {
  const out: DiffLine[] = []
  for (const raw of patch.split('\n')) {
    if (
      raw.startsWith('diff --git') ||
      raw.startsWith('index ') ||
      raw.startsWith('--- ') ||
      raw.startsWith('+++ ') ||
      raw.startsWith('@@') ||
      raw.startsWith('\\ No newline')
    ) {
      continue
    }
    if (raw.startsWith('+')) out.push({ kind: 'add', text: raw.slice(1) })
    else if (raw.startsWith('-')) out.push({ kind: 'del', text: raw.slice(1) })
    else out.push({ kind: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw })
  }
  return out
}

function diffStat(patch: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of patch.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) added++
    else if (l.startsWith('-') && !l.startsWith('---')) removed++
  }
  return { added, removed }
}

interface FileChange {
  path: string
  kind: Obj
  diff: string
}

function changesOf(v: unknown): FileChange[] {
  return arr(v)
    .map((x) => obj(x))
    .map((x) => ({ path: str(x.path), kind: obj(x.kind), diff: str(x.diff) }))
    .filter((x) => x.path)
}

function absPath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : join(cwd, p)
}

function previewForChanges(changes: FileChange[], cwd: string): PermissionPreview {
  if (changes.length === 0) {
    return { kind: 'text', title: msg('codexAdapter.editFile'), note: msg('codexAdapter.noSpecificFile') }
  }

  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  for (const c of changes.slice(0, 4)) {
    const stat = diffStat(c.diff)
    added += stat.added
    removed += stat.removed
    if (changes.length > 1) {
      lines.push({ kind: 'ctx', text: `── ${c.path} ──` })
    }
    lines.push(...diffLines(c.diff).slice(0, 400))
  }

  const first = changes[0]
  return {
    kind: 'diff',
    title:
      changes.length === 1
        ? t('codexAdapter.editOne', { name: basename(first.path) })
        : t('codexAdapter.editMany', { n: changes.length }),
    path: absPath(cwd, first.path),
    lines,
    note: `+${added} −${removed}`
  }
}

/* ── 用量 ───────────────────────────────────────────────── */

interface Breakdown {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

interface TokenUsage {
  total: Breakdown
  last: Breakdown
  modelContextWindow: number | null
}

const zeroBreakdown = (): Breakdown => ({
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0
})

function breakdown(v: unknown): Breakdown {
  const o = obj(v)
  return {
    totalTokens: num(o.totalTokens),
    inputTokens: num(o.inputTokens),
    cachedInputTokens: num(o.cachedInputTokens),
    cacheWriteInputTokens: num(o.cacheWriteInputTokens),
    outputTokens: num(o.outputTokens),
    reasoningOutputTokens: num(o.reasoningOutputTokens)
  }
}

function usageOf(t: TokenUsage | null, durationMs: number): Usage {
  const last = t?.last ?? zeroBreakdown()
  const uncached = Math.max(
    0,
    last.inputTokens - last.cachedInputTokens - last.cacheWriteInputTokens
  )
  const seconds = durationMs / 1000
  return {
    inputTokens: uncached,
    outputTokens: last.outputTokens,
    cacheReadTokens: last.cachedInputTokens,
    cacheCreationTokens: last.cacheWriteInputTokens,
    tokensPerSecond: seconds > 0 ? Math.round(last.outputTokens / seconds) : undefined,
    contextPercent:
      t?.modelContextWindow && t.modelContextWindow > 0
        ? Math.round(Math.min(100, (last.totalTokens / t.modelContextWindow) * 100) * 10) / 10
        : undefined,
    contextTokens: last.totalTokens,
    contextUsage: {
      inputTokens: uncached,
      outputTokens: last.outputTokens,
      cacheReadTokens: last.cachedInputTokens,
      cacheCreationTokens: last.cacheWriteInputTokens
    }
  }
}

/* ── 会话 ───────────────────────────────────────────────── */

type ServerKind =
  | { kind: 'command' }
  | { kind: 'file' }
  | { kind: 'permissions'; requested: Obj }
  | { kind: 'unknown' }

class CodexSession implements ProviderSession {
  private rpc: CodexRpc
  private threadId: string | null = null
  private currentTurnId: string | null = null
  private ready = false
  private disposed = false
  private exited = false
  private starting = true
  private pending: SessionSendInput[] = []
  private items = new Map<string, Obj>()
  private streamed = new Set<string>()
  private usage: TokenUsage | null = null
  private turnStart = 0
  private questionIds = new Map<string, string>()
  private questionOrder: string[] = []
  private serverRequests = new Map<string, ServerKind>()
  /**
   * UI 里的 requestId 一律是字符串；JSON-RPC 的 id 可能是数字。
   * 回执必须用原类型，否则 app-server 对不上号，会一直等。
   */
  private serverRequestIds = new Map<string, string | number>()

  constructor(private o: ProviderSessionOptions) {
    this.rpc = new CodexRpc({
      channel: o.channel,
      mcpServers: o.mcpServers,
      cwd: o.cwd,
      onExit: (code, stderr) => {
        if (this.disposed || this.exited) return
        this.exited = true
        this.ready = false
        o.onExit(code, stderr)
      }
    })
    this.rpc.setNotificationHandler((method, params) => this.onNotification(method, params))
    this.rpc.setServerRequestHandler((id, method, params) =>
      this.onServerRequest(id, method, params)
    )
    void this.connect()
  }

  /* ── 启动 ── */

  private threadParams(): Obj {
    const mode = CODEX_MODE[this.o.permissionMode] ?? CODEX_MODE.standard
    const p: Obj = {
      cwd: this.o.cwd,
      approvalPolicy: mode.approval,
      // 用命名权限档，不要用 sandbox（两者互斥；实测 sandbox:workspace-write
      // 在 0.163 里会被解析成 readOnly，permissions 才是对的入口）
      permissions: mode.permissions
    }
    if (this.o.model.trim()) p.model = this.o.model.trim()
    return p
  }

  private async connect(): Promise<void> {
    try {
      await initializeCodex(this.rpc)

      let res: Obj
      if (this.o.resumeId) {
        try {
          res = await this.rpc.request<Obj>(
            'thread/resume',
            {
              threadId: this.o.resumeId,
              ...this.threadParams(),
              excludeTurns: true
            },
            30_000
          )
        } catch (e) {
          this.o.onEvent({
            t: 'error',
            message: t('codexAdapter.restoreFailed', { detail: String(e) }),
            fatal: false
          })
          res = await this.rpc.request<Obj>('thread/start', this.threadParams(), 30_000)
        }
      } else {
        res = await this.rpc.request<Obj>('thread/start', this.threadParams(), 30_000)
      }

      if (this.disposed) return
      const thread = obj(res.thread)
      this.threadId = str(thread.id) || this.o.resumeId || ''
      this.ready = true
      this.starting = false

      this.o.onEvent({
        t: 'session_started',
        sessionId: this.threadId,
        provider: 'codex',
        model: str(res.model) || this.o.model,
        cwd: str(res.cwd) || this.o.cwd,
        tools: [],
        permissionMode: normalizeMode(this.o.permissionMode)
      })
      this.flush()
    } catch (e) {
      if (this.disposed) return
      this.starting = false
      const stderr = this.rpc.stderrText.trim()
      this.o.onEvent({
        t: 'error',
        message: t('codexAdapter.startFailed', {
        detail: String(e) + (stderr ? `\n${stderr.slice(-600)}` : '')
      }),
        fatal: true
      })
      this.rpc.dispose()
      if (!this.exited) {
        this.exited = true
        this.o.onExit(null, stderr)
      }
    }
  }

  /* ── 发送 ── */

  send(input: SessionSendInput): void {
    if (this.disposed) return
    this.pending.push(input)
    this.flush()
  }

  private flush(): void {
    if (!this.ready || this.currentTurnId || this.disposed) return
    const next = this.pending.shift()
    if (next) void this.startTurn(next)
  }

  private async startTurn(input: SessionSendInput): Promise<void> {
    if (!this.threadId) return
    const content: Obj[] = []
    const text = input.text.trim()
    if (text) content.push({ type: 'text', text, text_elements: [] })
    for (const img of input.images ?? []) {
      if (!img.data) continue
      content.push({
        type: 'image',
        url: `data:${img.mediaType || 'image/png'};base64,${img.data}`
      })
    }
    if (content.length === 0) {
      this.flush()
      return
    }

    this.turnStart = Date.now()
    this.usage = null
    try {
      const res = await this.rpc.request<Obj>(
        'turn/start',
        {
          threadId: this.threadId,
          input: content,
          effort: this.o.effort
        },
        30_000
      )
      const turn = obj(res.turn)
      const status = str(turn.status)
      if (status === 'inProgress') {
        // turn/started 通知可能先到；别用响应里的旧值覆盖它
        if (!this.currentTurnId) this.currentTurnId = str(turn.id) || `local-${Date.now()}`
      } else {
        // 极快的端点可能在响应回来之前就跑完了
        this.currentTurnId = null
      }
    } catch (e) {
      this.o.onEvent({ t: 'error', message: t('codexAdapter.sendFailed', { detail: String(e) }), fatal: false })
      this.o.onEvent({
        t: 'turn_end',
        durationMs: Date.now() - this.turnStart,
        usage: usageOf(null, Date.now() - this.turnStart),
        steps: 0
      })
      this.currentTurnId = null
      this.flush()
    }
  }

  interrupt(): void {
    if (!this.threadId || !this.currentTurnId) return
    void this.rpc
      .request('turn/interrupt', { threadId: this.threadId, turnId: this.currentTurnId }, 10_000)
      .catch(() => undefined)
  }

  /**
   * 宿主代为执行的 CLI 原生指令。
   *
   * Codex 的 TUI slash 指令不走 app-server；这里只接有对应 RPC 的
   * `/compact`，其余返回 false，由上层提示「不支持」，绝不能把
   * 指令原文当正文发给模型。
   */
  command(name: string, _args: string): { ok: boolean; message?: string } {
    if (name !== 'compact') return { ok: false }
    if (!this.ready || !this.threadId) {
      return { ok: false, message: t('codexAdapter.notReady') }
    }
    void this.rpc
      .request('thread/compact/start', { threadId: this.threadId }, 120_000)
      .catch((e: unknown) => {
        if (this.disposed) return
        this.o.onEvent({
          t: 'error',
          message: t('codexAdapter.compactFailed', {
            detail: e instanceof Error ? e.message : String(e)
          }),
          fatal: false
        })
      })
    return { ok: true }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.ready = false
    this.pending = []
    this.rpc.dispose()
  }

  /* ── 审批答复 ── */

  /** 用服务端原来的 id 类型回执（数字 id 不能用字符串回） */
  private reply(requestId: string, result: unknown): void {
    const id = this.serverRequestIds.get(requestId) ?? requestId
    this.serverRequestIds.delete(requestId)
    this.rpc.respond(id, result)
  }

  respondPermission(requestId: string, decision: PermissionDecision): void {
    const kind = this.serverRequests.get(requestId) ?? { kind: 'unknown' }
    this.serverRequests.delete(requestId)
    const allow = decision.behavior === 'allow'
    const always = allow && decision.always === true

    if (kind.kind === 'command') {
      this.reply(requestId, {
        decision: allow ? (always ? 'acceptForSession' : 'accept') : 'decline'
      })
      return
    }
    if (kind.kind === 'file') {
      this.reply(requestId, {
        decision: allow ? (always ? 'acceptForSession' : 'accept') : 'decline'
      })
      return
    }
    if (kind.kind === 'permissions') {
      const granted: Obj = {}
      if (allow) {
        if (kind.requested.network) granted.network = kind.requested.network
        if (kind.requested.fileSystem) granted.fileSystem = kind.requested.fileSystem
      }
      this.reply(requestId, {
        permissions: granted,
        scope: always ? 'session' : 'turn'
      })
      return
    }

    // 不认识的审批：明确拒绝，别让 app-server 一直等
    this.reply(requestId, { decision: 'decline' })
  }

  respondQuestion(requestId: string, answer: QuestionAnswer): void {
    const answers: Record<string, { answers: string[] }> = {}
    if (!answer.skipped) {
      for (const q of this.questionOrder) {
        const id = this.questionIds.get(q)
        if (!id) continue
        const a = answer.answers[q]
        if (a === undefined) continue
        answers[id] = { answers: Array.isArray(a) ? a : [a] }
      }
    }
    this.reply(requestId, { answers })
    this.questionIds.clear()
    this.questionOrder = []
  }

  /* ── 服务端请求（审批 / 提问） ── */

  private onServerRequest(
    id: string | number,
    method: string,
    params: Obj
  ): void {
    const rid = String(id)
    this.serverRequestIds.set(rid, id)

    if (method === 'item/commandExecution/requestApproval') {
      const command = str(params.command)
      const cwd = str(params.cwd) || this.o.cwd
      const input = {
        command,
        cwd,
        description: str(params.reason)
      }
      this.serverRequests.set(rid, { kind: 'command' })
      this.o.onEvent({
        t: 'permission_request',
        id: rid,
        tool: 'Bash',
        input,
        preview: buildPreview('Bash', input, cwd),
        options: permissionOptions('Bash')
      })
      return
    }

    if (method === 'item/fileChange/requestApproval') {
      const item = this.items.get(str(params.itemId))
      const changes = changesOf(item?.changes)
      const preview = previewForChanges(changes, this.o.cwd)
      this.serverRequests.set(rid, { kind: 'file' })
      this.o.onEvent({
        t: 'permission_request',
        id: rid,
        tool: 'ApplyPatch',
        input: {
          file_path: changes[0]?.path ?? '',
          changes,
          reason: str(params.reason)
        },
        preview,
        options: permissionOptions('ApplyPatch')
      })
      return
    }

    if (method === 'item/permissions/requestApproval') {
      const requested = obj(params.permissions)
      this.serverRequests.set(rid, { kind: 'permissions', requested })
      const paths = arr(obj(requested.fileSystem).entries)
        .map((e) => str(obj(e).path))
        .filter(Boolean)
      this.o.onEvent({
        t: 'permission_request',
        id: rid,
        tool: 'Permissions',
        input: { permissions: requested, reason: str(params.reason) },
        preview: {
          kind: 'text',
          title: msg('codexAdapter.extraPermission'),
          note: str(params.reason) || (paths.length ? paths.join('\n') : t('codexAdapter.sandboxWrite'))
        },
        // 额外权限不做「本会话总是允许」：一次授权可能覆盖工作区外的读写，
        // 每次都让用户看一眼更稳。
        options: permissionOptions('Permissions', false)
      })
      return
    }

    if (method === 'item/tool/requestUserInput') {
      const raw = arr(params.questions)
        .map((v) => obj(v))
        .filter((q) => str(q.question))

      const questions: Question[] = []
      this.questionIds.clear()
      this.questionOrder = []

      for (const q of raw) {
        const question = str(q.question)
        const qid = str(q.id) || question
        const options = arr(q.options)
          .map((v) => obj(v))
          .map((v) => ({ label: str(v.label), description: str(v.description) }))
          .filter((v) => v.label)
        this.questionIds.set(question, qid)
        this.questionOrder.push(question)
        questions.push({
          question,
          header: str(q.header) || t('codexAdapter.question'),
          options,
          // Codex 的这个协议没有 multiSelect 字段；答案本身是数组，
          // 但一次只能选一个。
          multiSelect: false
        })
      }

      if (questions.length === 0) {
        this.reply(rid, { answers: {} })
        return
      }

      this.o.onEvent({
        t: 'question_request',
        id: rid,
        tool: 'AskUserQuestion',
        input: params,
        questions
      })
      return
    }

    if (method === 'currentTime/read') {
      this.reply(rid, { currentTimeAt: Math.floor(Date.now() / 1000) })
      return
    }

    // 未支持的服务端请求：回错误，避免 Codex 卡住
    this.serverRequestIds.delete(rid)
    this.rpc.respondError(id, -32601, t('codexAdapter.unsupported', { method }))
  }

  /* ── 通知 ── */

  private onNotification(method: string, p: Obj): void {
    switch (method) {
      case 'turn/started':
        this.currentTurnId = str(obj(p.turn).id) || this.currentTurnId
        this.turnStart = Date.now()
        this.usage = null
        return

      case 'thread/tokenUsage/updated':
        this.usage = {
          total: breakdown(obj(p.tokenUsage).total),
          last: breakdown(obj(p.tokenUsage).last),
          modelContextWindow:
            typeof obj(p.tokenUsage).modelContextWindow === 'number'
              ? (obj(p.tokenUsage).modelContextWindow as number)
              : null
        }
        return

      case 'item/started':
        this.onItemStarted(obj(p.item))
        return

      case 'item/completed':
        this.onItemCompleted(obj(p.item))
        return

      case 'item/agentMessage/delta': {
        const itemId = str(p.itemId)
        if (itemId) this.streamed.add(itemId)
        const delta = str(p.delta)
        if (delta) this.o.onEvent({ t: 'text_delta', text: delta })
        return
      }

      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const itemId = str(p.itemId)
        if (itemId) this.streamed.add(itemId)
        const delta = str(p.delta)
        if (delta) this.o.onEvent({ t: 'thinking_delta', text: delta })
        return
      }

      case 'item/plan/delta': {
        const delta = str(p.delta)
        if (delta) this.o.onEvent({ t: 'thinking_delta', text: delta })
        return
      }

      case 'error': {
        // 可重试的错误（Reconnecting… 1/5）不往转写区丢 —— 一轮里可能来五条，
        // 真正失败时 turn/completed 会带最终原因。
        if (p.willRetry === true) return
        const message = str(obj(p.error).message) || t('codexAdapter.reportedError')
        this.o.onEvent({ t: 'error', message, fatal: false })
        return
      }

      case 'turn/completed':
        this.onTurnCompleted(obj(p.turn))
        return

      default:
        return
    }
  }

  private onItemStarted(item: Obj): void {
    const id = str(item.id)
    if (id) this.items.set(id, item)
    const type = str(item.type)

    if (type === 'commandExecution') {
      const command = str(item.command)
      this.o.onEvent({
        t: 'tool_call',
        id,
        name: 'Bash',
        input: { command, cwd: str(item.cwd) }
      })
      return
    }

    if (type === 'fileChange') {
      const changes = changesOf(item.changes)
      this.o.onEvent({
        t: 'tool_call',
        id,
        name: 'ApplyPatch',
        input: { file_path: changes[0]?.path ?? '', changes }
      })
      return
    }

    if (type === 'mcpToolCall') {
      this.o.onEvent({
        t: 'tool_call',
        id,
        name: `mcp__${str(item.server)}__${str(item.tool)}`,
        input: item.arguments
      })
      return
    }

    if (type === 'dynamicToolCall') {
      this.o.onEvent({
        t: 'tool_call',
        id,
        name: `${str(item.namespace)}.${str(item.tool)}`.replace(/^\./, ''),
        input: item.arguments
      })
      return
    }

    if (type === 'webSearch') {
      this.o.onEvent({
        t: 'tool_call',
        id,
        name: 'WebSearch',
        input: { query: str(item.query) }
      })
    }
  }

  private onItemCompleted(item: Obj): void {
    const id = str(item.id)
    const type = str(item.type)
    if (id) this.items.set(id, item)

    if (type === 'agentMessage') {
      if (!this.streamed.has(id)) {
        const text = str(item.text)
        if (text) this.o.onEvent({ t: 'text_delta', text })
      }
      return
    }

    if (type === 'reasoning') {
      if (!this.streamed.has(id)) {
        const text = [...arr(item.summary), ...arr(item.content)]
          .map((v) => str(v))
          .filter(Boolean)
          .join('\n')
        if (text) this.o.onEvent({ t: 'thinking_delta', text })
      }
      return
    }

    if (type === 'commandExecution') {
      const status = str(item.status)
      const toolStatus =
        status === 'completed' ? 'ok' : status === 'declined' ? 'denied' : status === 'failed' ? 'error' : 'ok'
      const output = str(item.aggregatedOutput)
      const code = typeof item.exitCode === 'number' ? item.exitCode : null
      this.o.onEvent({
        t: 'tool_result',
        id,
        status: toolStatus,
        content: clip(output || (code !== null ? t('codexTest.exitCode', { code }) : ''))
      })
      return
    }

    if (type === 'fileChange') {
      const changes = changesOf(item.changes)
      const status = str(item.status)
      const toolStatus =
        status === 'completed' ? 'ok' : status === 'declined' ? 'denied' : status === 'failed' ? 'error' : 'ok'
      this.o.onEvent({
        t: 'tool_result',
        id,
        status: toolStatus,
        content: changes.map((c) => c.path).join('\n')
      })
      for (const c of changes) {
        const stat = diffStat(c.diff)
        this.o.onEvent({
          t: 'file_change',
          path: absPath(this.o.cwd, c.path),
          added: stat.added,
          removed: stat.removed,
          created: str(c.kind.type) === 'add',
          deleted: str(c.kind.type) === 'delete',
          source: 'agent'
        })
      }
      return
    }

    if (type === 'mcpToolCall') {
      const status = str(item.status)
      const result = item.result ?? item.error ?? null
      this.o.onEvent({
        t: 'tool_result',
        id,
        status: status === 'completed' ? 'ok' : status === 'failed' ? 'error' : 'ok',
        content: clip(typeof result === 'string' ? result : JSON.stringify(result))
      })
      return
    }

    if (type === 'dynamicToolCall') {
      const status = str(item.status)
      this.o.onEvent({
        t: 'tool_result',
        id,
        status: status === 'completed' ? 'ok' : status === 'failed' ? 'error' : 'ok',
        content: clip(
          arr(item.contentItems)
            .map((v) => {
              const o = obj(v)
              return str(o.text) || str(o.imageUrl) || JSON.stringify(o)
            })
            .join('\n')
        )
      })
      return
    }

    if (type === 'webSearch') {
      this.o.onEvent({
        t: 'tool_result',
        id,
        status: 'ok',
        content: clip(JSON.stringify(item.results ?? null))
      })
    }
  }

  private onTurnCompleted(turn: Obj): void {
    const durationMs = num(turn.durationMs) || (this.turnStart ? Date.now() - this.turnStart : 0)
    const status = str(turn.status)
    const error = obj(turn.error)
    if (status === 'failed') {
      this.o.onEvent({
        t: 'error',
        message: str(error.message) || t('codexAdapter.turnFailed'),
        fatal: false
      })
    }

    this.currentTurnId = null
    this.o.onEvent({
      t: 'turn_end',
      durationMs,
      usage: usageOf(this.usage, durationMs),
      steps: 0
    })
    // 一轮结束，工具项和流式标记不会再用到；不清会随会话长度一直涨
    this.items.clear()
    this.streamed.clear()
    this.flush()
  }
}

export class CodexProvider implements Provider {
  id = 'codex'

  async detect(): Promise<{ installed: boolean; path: string }> {
    // 真正的版本探测由 checkCodexStatus 做；这里只需回答"有没有这个文件"。
    const path = resolveCodexBin()
    return { installed: existsSync(path), path }
  }

  start(o: ProviderSessionOptions): ProviderSession {
    return new CodexSession(o)
  }
}
