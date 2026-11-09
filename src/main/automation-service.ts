import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, PermissionMode } from '../shared/events'
import type { SessionEventPayload, SessionStatusPayload } from '../shared/session'
import {
  AUTOMATION_FILE_VERSION,
  AUTOMATION_RUN_LIMIT,
  computeNextRun,
  isValidTime,
  normalizeSchedule,
  type AutomationMutationResult,
  type AutomationRun,
  type AutomationRunFinishedPayload,
  type AutomationRunResult,
  type AutomationRunStatus,
  type AutomationState,
  type AutomationTask,
  type AutomationTaskInput
} from '../shared/automation'
import { DEFAULT_EFFORT, CLI_IDS, type CliId, type EffortLevel } from '../shared/settings'
import { localizeText } from '../shared/i18n'
import { logMain } from './crash-log'
import { mainLocale, t } from './i18n'
import type { SessionManager } from './session-manager'

/**
 * 自动化任务：存储、调度与执行。
 *
 * 运行模型很朴素 —— 一次运行 = `SessionManager.start()` + `send()` 拉起来
 * 的一条普通会话。这样「运行记录」天然可以点开回看，CLI 自己的 jsonl 就是
 * 日志，不需要另造一套。
 *
 * 三条硬约束直接写进实现：
 *  1. **同一时刻只允许一次自动化运行**。两个 agent 同时改一个工作区会互相
 *     踩，现有的 fileWriters 只是归属标记，不是锁。
 *  2. **审批请求一律自动拒绝**。无人值守时把请求转给用户等于让任务永久挂起；
 *     `permission_request` 没有宿主侧超时。
 *  3. **提问按任务策略处理**：跳过（拒绝）或中止并通知。不会被自动回答。
 */
export class AutomationService {
  private tasks: AutomationTask[] = []
  private runs: AutomationRun[] = []
  private timer: NodeJS.Timeout | null = null
  private active: ActiveRun | null = null
  private started = false
  private disposed = false
  private readonly file: string

  constructor(private readonly deps: AutomationDeps) {
    this.file = join(deps.dir, 'automation.json')
    this.load()
  }

  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.emit()
    // 给窗口一点启动时间；到期任务会在第一次 tick 里补跑
    this.timer = setTimeout(() => this.tick(), 800)
    this.timer.unref?.()
  }

  dispose(): void {
    this.disposed = true
    this.started = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const a = this.active
    if (a) {
      // 退出时不再通知，也不再去 stop（before-quit 会统一收进程）；只落盘
      this.finishRecord(a, 'bad', t('automation.run.interrupted'), null, false)
      this.active = null
    }
    this.save()
  }

  getState(): AutomationState {
    return {
      tasks: this.tasks.map(cloneTask),
      runs: this.runs.map((r) => ({ ...r })),
      scheduler: {
        running: this.started && !this.disposed,
        nextRunAt: this.nextEnabledRunAt(),
        activeRunId: this.active?.runId ?? null
      }
    }
  }

  /* ── 增删改 ─────────────────────────────────────────────── */

  create(raw: unknown): AutomationMutationResult {
    const normalized = normalizeInput(raw)
    if ('error' in normalized) return { ok: false, message: normalized.error }
    if (!isDirectory(normalized.input.cwd)) {
      return { ok: false, message: t('automation.error.cwd') }
    }

    const now = Date.now()
    const task: AutomationTask = {
      ...normalized.input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      lastStatus: null,
      nextRunAt: normalized.input.enabled
        ? computeNextRun(normalized.input.schedule, now)
        : null
    }
    this.tasks.unshift(task)
    this.save()
    this.emit()
    this.scheduleTick()
    return { ok: true, id: task.id }
  }

  update(id: string, raw: unknown): AutomationMutationResult {
    const task = this.tasks.find((x) => x.id === id)
    if (!task) return { ok: false, message: t('automation.error.notFound') }

    const normalized = normalizeInput(raw)
    if ('error' in normalized) return { ok: false, message: normalized.error }
    if (!isDirectory(normalized.input.cwd)) {
      return { ok: false, message: t('automation.error.cwd') }
    }

    const now = Date.now()
    Object.assign(task, normalized.input, {
      updatedAt: now,
      // 改了计划就从现在重新算，不追旧计划欠下的账
      nextRunAt: normalized.input.enabled ? computeNextRun(normalized.input.schedule, now) : null
    })
    this.save()
    this.emit()
    this.scheduleTick()
    return { ok: true, id: task.id }
  }

  remove(id: string): AutomationMutationResult {
    const idx = this.tasks.findIndex((x) => x.id === id)
    if (idx < 0) return { ok: false, message: t('automation.error.notFound') }

    if (this.active?.taskId === id) {
      this.finishActive('bad', t('automation.run.deleted'), null)
    }
    this.tasks.splice(idx, 1)
    this.save()
    this.emit()
    this.scheduleTick()
    return { ok: true, id }
  }

  setEnabled(id: string, enabled: boolean): AutomationMutationResult {
    const task = this.tasks.find((x) => x.id === id)
    if (!task) return { ok: false, message: t('automation.error.notFound') }

    task.enabled = enabled
    task.updatedAt = Date.now()
    task.nextRunAt = enabled ? computeNextRun(task.schedule, Date.now()) : null

    // 暂停一个正在跑的任务 = 立刻中止这一轮，否则「已暂停」只是文字
    if (!enabled && this.active?.taskId === id) {
      this.finishActive('bad', t('automation.run.stopped'), null)
    }

    this.save()
    this.emit()
    this.scheduleTick()
    return { ok: true, id }
  }

  /* ── 运行 ───────────────────────────────────────────────── */

  runNow(id: string): AutomationRunResult {
    const task = this.tasks.find((x) => x.id === id)
    if (!task) return { ok: false, message: t('automation.error.notFound') }
    if (this.active) return { ok: false, message: t('automation.error.busy') }
    if (!isDirectory(task.cwd)) return { ok: false, message: t('automation.error.cwd') }

    // 手动运行也算一次正常调度：把下次时间往后推，避免刚点完又被计划触发
    if (task.enabled) task.nextRunAt = computeNextRun(task.schedule, Date.now())

    const run = this.startRun(task)
    this.save()
    this.emit()
    this.scheduleTick()
    return { ok: true, runId: run.id }
  }

  stop(id: string): AutomationRunResult {
    if (this.active?.taskId !== id) {
      return { ok: false, message: t('automation.error.notRunning') }
    }
    const runId = this.active.runId
    this.finishActive('bad', t('automation.run.stopped'), null)
    return { ok: true, runId }
  }

  /** SessionManager 的事件出口。只关心当前这次自动化运行 */
  onSessionEvent(p: SessionEventPayload): void {
    const a = this.active
    if (!a || a.liveId !== p.sessionId) return
    const e: AgentEvent = p.event
    // 和 SessionManager 一样：turn_end 的成败看**上一条**事件是不是 error，
    // 收到 turn_end 后就 return，不能用它自己覆盖这个标记。
    const previousWasError = a.lastEventWasError

    switch (e.t) {
      case 'session_started':
        if (e.sessionId) this.setProviderSessionId(a, e.sessionId)
        break
      case 'turn_started':
        a.turnActive = true
        break
      case 'text_delta':
        // 留最后一段模型输出做运行结果摘要；只在内存里滚，最多 4k 字符
        a.output = (a.output + e.text).slice(-4000)
        break
      case 'permission_request':
        // 无人值守：拒绝而不是挂起。给模型一句原因，它会继续往下走。
        this.deps.sessions.respondPermission(
          a.liveId,
          e.id,
          { behavior: 'deny', message: t('automation.permission.denied') },
          false
        )
        break
      case 'question_request':
        if (a.questionPolicy === 'deny') {
          // 跳过整组提问，模型会知道这次没拿到答案
          this.deps.sessions.respondQuestion(a.liveId, e.id, { answers: {}, skipped: true })
        } else {
          this.finishActive('bad', t('automation.run.question'), null)
        }
        break
      case 'error':
        a.errorMessage =
          typeof e.message === 'string' ? e.message : localizeText(mainLocale(), e.message)
        break
      case 'turn_end':
        // status idle 先到，turn_end 随后带着 usage / cost 到；以它为准结算
        this.finishActive(
          a.idleErrored || previousWasError ? 'bad' : 'ok',
          a.idleErrored || previousWasError
            ? a.errorMessage || t('automation.run.failed')
            : t('automation.run.ok'),
          typeof e.costUsd === 'number' ? e.costUsd : null
        )
        return
      default:
        break
    }

    a.lastEventWasError = e.t === 'error'
  }

  /** SessionManager 的状态出口。用作 turn_end 缺失时的兜底 */
  onSessionStatus(p: SessionStatusPayload): void {
    const a = this.active
    if (!a || a.liveId !== p.sessionId) return

    if (p.providerSessionId) this.setProviderSessionId(a, p.providerSessionId)

    if (p.status === 'starting' || p.status === 'running') {
      a.turnActive = true
      return
    }

    if (p.status === 'idle') {
      if (!a.turnActive) return
      a.idleErrored = p.errored === true
      // turn_end 通常紧接着 idle 同步到达；1.5 秒还没来就说明这一轮没有
      // usage 可结算（例如被 CLI 内部掐断），此时按 idle 的 errored 收尾。
      if (!a.finishTimer) {
        a.finishTimer = setTimeout(() => {
          if (this.active !== a) return
          this.finishActive(
            a.idleErrored ? 'bad' : 'ok',
            a.idleErrored ? a.errorMessage || t('automation.run.failed') : t('automation.run.ok'),
            null
          )
        }, 1500)
        a.finishTimer.unref?.()
      }
      return
    }

    if (p.status === 'exited') {
      // 进程没了但还没结算：这一轮不会再有 turn_end
      this.finishActive('bad', p.message || t('automation.run.exit'), null)
    }
  }

  /* ── 内部 ───────────────────────────────────────────────── */

  private startRun(task: AutomationTask): AutomationRun {
    const startedAt = Date.now()
    const run: AutomationRun = {
      id: randomUUID(),
      taskId: task.id,
      taskName: task.name,
      cli: task.cli,
      cwd: task.cwd,
      providerSessionId: null,
      status: 'running',
      startedAt,
      finishedAt: null,
      durationMs: null,
      costUsd: null,
      message: t('automation.status.running')
    }

    const liveId = this.deps.sessions.start({
      cli: task.cli,
      cwd: task.cwd,
      permissionMode: task.permissionMode,
      model: task.model.trim() || undefined,
      effort: task.effort,
      resumeId: task.sessionMode === 'resume' ? task.resumeSessionId || null : null
    })

    const a: ActiveRun = {
      runId: run.id,
      taskId: task.id,
      liveId,
      startedAt,
      providerSessionId: null,
      questionPolicy: task.onQuestion,
      turnActive: false,
      lastEventWasError: false,
      errorMessage: '',
      output: '',
      idleErrored: false,
      timeoutTimer: null,
      finishTimer: null
    }
    this.active = a

    this.runs.unshift(run)
    if (this.runs.length > AUTOMATION_RUN_LIMIT) this.runs.length = AUTOMATION_RUN_LIMIT
    task.lastRunAt = startedAt

    const timeoutMs = Math.max(1, task.timeoutMinutes) * 60_000
    a.timeoutTimer = setTimeout(() => {
      if (this.active !== a) return
      this.finishActive('bad', t('automation.run.timeout', { minutes: task.timeoutMinutes }), null)
    }, timeoutMs)
    a.timeoutTimer.unref?.()

    // 失败信息可能来自「没有渠道」之类的启动错误，不一定是 CLI 事件
    void this.deps.sessions
      .send(liveId, { text: task.prompt })
      .then((r) => {
        if (this.active !== a) return
        if (!r.ok) this.finishActive('bad', r.message || t('automation.run.failed'), null)
      })
      .catch((e) => {
        if (this.active !== a) return
        logMain('automation.send', e)
        this.finishActive('bad', e instanceof Error ? e.message : String(e), null)
      })

    return run
  }

  private setProviderSessionId(a: ActiveRun, id: string): void {
    if (!id || a.providerSessionId === id) return
    a.providerSessionId = id
    const run = this.runs.find((r) => r.id === a.runId)
    if (run && !run.providerSessionId) {
      run.providerSessionId = id
      this.save()
      this.emit()
    }

    /*
     * 给新会话挂一个稳定标题。CLI 记录里的标题是提示词的第一行，自动化
     * 任务往往是一段很长的指令，侧栏会变成一堆看不懂的长句。
     * 续跑模式不改：那条会话可能被用户重命名过。
     */
    const task = this.tasks.find((x) => x.id === a.taskId)
    if (task?.sessionMode === 'new') {
      this.deps.titleSession?.({
        cli: task.cli,
        cwd: task.cwd,
        id,
        title: t('automation.sessionTitle', { name: task.name })
      })
    }
  }

  private finishActive(status: AutomationRunStatus, message: string, costUsd: number | null): void {
    const a = this.active
    if (!a) return
    this.active = null
    this.finishRecord(a, status, message, costUsd, true)
    // 这一次运行已经结束，长驻 CLI 进程没有继续留着的理由
    this.deps.sessions.stop(a.liveId)
    this.scheduleTick()
  }

  private finishRecord(
    a: ActiveRun,
    status: AutomationRunStatus,
    message: string,
    costUsd: number | null,
    announce: boolean
  ): void {
    if (a.timeoutTimer) clearTimeout(a.timeoutTimer)
    if (a.finishTimer) clearTimeout(a.finishTimer)
    a.timeoutTimer = null
    a.finishTimer = null

    const run = this.runs.find((r) => r.id === a.runId)
    const task = this.tasks.find((x) => x.id === a.taskId)
    if (!run) return

    let finalStatus: AutomationRunStatus = status
    let finalMessage = message
    if (run.providerSessionId === null && a.providerSessionId) run.providerSessionId = a.providerSessionId

    // 成功时用模型最后一句输出当结果摘要 —— 运行记录里「运行完成」四个字
    // 没有信息量，用户想知道的是这次到底发现了什么
    if (finalStatus === 'ok') {
      const summary = summarizeRunOutput(a.output)
      if (summary) finalMessage = summary
    }

    // 预算只能事后检查：现在的数据流没有逐 token 的花费，无法在跑到一半时熔断
    if (
      finalStatus === 'ok' &&
      task?.budgetUsd != null &&
      costUsd != null &&
      costUsd > task.budgetUsd
    ) {
      finalStatus = 'bad'
      finalMessage = t('automation.run.budget', {
        cost: `$${costUsd.toFixed(2)}`,
        budget: `$${task.budgetUsd.toFixed(2)}`
      })
    }

    run.status = finalStatus
    run.finishedAt = Date.now()
    run.durationMs = run.finishedAt - run.startedAt
    run.costUsd = costUsd
    run.message = finalMessage

    if (task) {
      task.lastRunAt = run.startedAt
      task.lastStatus = finalStatus === 'skipped' || finalStatus === 'running' ? null : finalStatus
      task.updatedAt = Date.now()
    }

    this.save()
    this.emit()

    if (!announce) return
    if (!task) return
    if (finalStatus === 'ok' && !task.notifySuccess) return
    if (finalStatus !== 'ok' && !task.notifyFailure) return
    const payload: AutomationRunFinishedPayload = {
      taskName: task.name,
      run: { ...run },
      title:
        task.sessionMode === 'new'
          ? t('automation.sessionTitle', { name: task.name })
          : undefined
    }
    this.deps.emitRunFinished(payload)
  }

  private tick(): void {
    this.timer = null
    if (this.disposed) return

    if (!this.active) {
      const now = Date.now()
      const due = this.tasks
        .filter((task) => task.enabled && task.nextRunAt != null && task.nextRunAt <= now)
        .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0]

      if (due) {
        // 先推下次时间再跑：即使 send 失败也不会在同一秒里反复重试
        due.nextRunAt = computeNextRun(due.schedule, now)
        this.startRun(due)
        this.save()
        this.emit()
      }
    }

    this.armTimer()
  }

  private scheduleTick(): void {
    if (this.disposed) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.armTimer()
  }

  private armTimer(): void {
    if (this.disposed) return
    const next = this.nextEnabledRunAt()
    // 最多 60 秒醒一次：长定时器在休眠 / 挂起后只会迟到，醒来再按墙钟补跑
    const delay = next == null ? 60_000 : Math.max(1_000, Math.min(next - Date.now(), 60_000))
    this.timer = setTimeout(() => this.tick(), delay)
    this.timer.unref?.()
  }

  private nextEnabledRunAt(): number | null {
    let next: number | null = null
    for (const task of this.tasks) {
      if (!task.enabled || task.nextRunAt == null) continue
      if (next == null || task.nextRunAt < next) next = task.nextRunAt
    }
    return next
  }

  private emit(): void {
    this.deps.emitState(this.getState())
  }

  /* ── 持久化 ─────────────────────────────────────────────── */

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as {
        tasks?: unknown
        runs?: unknown
      }
      if (Array.isArray(raw.tasks)) {
        this.tasks = raw.tasks.map(normalizeStoredTask).filter((x): x is AutomationTask => !!x)
      }
      if (Array.isArray(raw.runs)) {
        this.runs = raw.runs
          .map(normalizeStoredRun)
          .filter((x): x is AutomationRun => !!x)
          .slice(0, AUTOMATION_RUN_LIMIT)
      }
    } catch {
      // 首次启动 / 文件损坏：按空状态开始，下一次保存会覆盖它
    }

    let dirty = false
    const now = Date.now()

    // 上次退出时还在跑的运行已经没有真实进程了
    for (const run of this.runs) {
      if (run.status === 'running') {
        run.status = 'bad'
        run.finishedAt = run.finishedAt ?? now
        run.durationMs = run.finishedAt - run.startedAt
        run.message = t('automation.run.interrupted')
        dirty = true
      }
    }

    for (const task of this.tasks) {
      if (task.enabled && task.nextRunAt == null) {
        task.nextRunAt = computeNextRun(task.schedule, now)
        dirty = true
      }
      if (!task.enabled) task.nextRunAt = null
    }

    if (dirty) this.save()
  }

  private save(): void {
    try {
      mkdirSync(this.deps.dir, { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(
        tmp,
        JSON.stringify(
          { v: AUTOMATION_FILE_VERSION, tasks: this.tasks, runs: this.runs },
          null,
          2
        ),
        'utf8'
      )
      renameSync(tmp, this.file)
    } catch (e) {
      logMain('automation.save', e)
    }
  }
}

interface AutomationDeps {
  sessions: SessionManager
  /** userData 目录 */
  dir: string
  emitState: (state: AutomationState) => void
  emitRunFinished: (payload: AutomationRunFinishedPayload) => void
  /** 给新会话写侧栏标题；测试和 Electron 主进程各自的实现不同 */
  titleSession?: (input: { cli: CliId; cwd: string; id: string; title: string }) => void
}

interface ActiveRun {
  runId: string
  taskId: string
  liveId: string
  startedAt: number
  providerSessionId: string | null
  questionPolicy: 'pause' | 'deny'
  turnActive: boolean
  lastEventWasError: boolean
  errorMessage: string
  /** 最近一段模型输出，用来做运行结果摘要 */
  output: string
  idleErrored: boolean
  timeoutTimer: NodeJS.Timeout | null
  finishTimer: NodeJS.Timeout | null
}

const PERMISSION_MODES: PermissionMode[] = [
  'standard',
  'acceptEdits',
  'auto',
  'plan',
  'dontAsk',
  'bypassPermissions'
]
const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']

function cleanString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function isDirectory(p: string): boolean {
  try {
    return !!p && existsSync(p) && statSync(p).isDirectory()
  } catch {
    return false
  }
}

function normalizeInput(raw: unknown): { input: AutomationTaskInput } | { error: string } {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  const name = cleanString(src.name, 80)
  if (!name) return { error: t('automation.error.name') }

  const prompt = typeof src.prompt === 'string' ? src.prompt.trim().slice(0, 20_000) : ''
  if (!prompt) return { error: t('automation.error.prompt') }

  const cwd = cleanString(src.cwd, 4096)
  if (!cwd) return { error: t('automation.error.cwd') }

  const cli: CliId = CLI_IDS.includes(src.cli as CliId) ? (src.cli as CliId) : 'claude'
  const effort: EffortLevel = EFFORT_LEVELS.includes(src.effort as EffortLevel)
    ? (src.effort as EffortLevel)
    : DEFAULT_EFFORT
  const permissionMode: PermissionMode = PERMISSION_MODES.includes(src.permissionMode as PermissionMode)
    ? (src.permissionMode as PermissionMode)
    : 'dontAsk'

  const sessionMode = src.sessionMode === 'resume' ? 'resume' : 'new'
  const resumeSessionId = cleanString(src.resumeSessionId, 256)
  if (sessionMode === 'resume' && !resumeSessionId) {
    return { error: t('automation.error.resume') }
  }

  const schedule = normalizeSchedule(src.schedule)
  if (schedule.kind === 'daily' || schedule.kind === 'weekly') {
    if (!isValidTime(schedule.time)) return { error: t('automation.error.schedule') }
    if (schedule.kind === 'weekly' && schedule.weekdays.length === 0) {
      return { error: t('automation.error.schedule') }
    }
  }

  const timeoutMinutes = Math.min(
    1440,
    Math.max(1, Math.round(typeof src.timeoutMinutes === 'number' ? src.timeoutMinutes : 30))
  )
  const rawBudget = typeof src.budgetUsd === 'number' ? src.budgetUsd : Number(src.budgetUsd)
  const budgetUsd =
    Number.isFinite(rawBudget) && rawBudget > 0 ? Math.min(1000, Math.round(rawBudget * 100) / 100) : null

  return {
    input: {
      name,
      enabled: src.enabled !== false,
      schedule,
      cwd,
      cli,
      model: cleanString(src.model, 200),
      effort,
      permissionMode,
      sessionMode: sessionMode as 'new' | 'resume',
      resumeSessionId,
      prompt,
      timeoutMinutes,
      budgetUsd,
      onQuestion: src.onQuestion === 'deny' ? 'deny' : 'pause',
      notifySuccess: src.notifySuccess !== false,
      notifyFailure: src.notifyFailure !== false
    }
  }
}

function normalizeStoredTask(raw: unknown): AutomationTask | null {
  const normalized = normalizeInput(raw)
  if ('error' in normalized) return null
  const src = raw as Record<string, unknown>
  const now = Date.now()
  const createdAt = typeof src.createdAt === 'number' && src.createdAt > 0 ? src.createdAt : now
  const lastStatus =
    src.lastStatus === 'ok' || src.lastStatus === 'bad' ? (src.lastStatus as 'ok' | 'bad') : null
  const nextRunAt =
    typeof src.nextRunAt === 'number' && Number.isFinite(src.nextRunAt) ? src.nextRunAt : null

  return {
    ...normalized.input,
    id: cleanString(src.id, 80) || randomUUID(),
    createdAt,
    updatedAt: typeof src.updatedAt === 'number' && src.updatedAt > 0 ? src.updatedAt : createdAt,
    lastRunAt:
      typeof src.lastRunAt === 'number' && src.lastRunAt > 0 ? src.lastRunAt : null,
    lastStatus,
    nextRunAt
  }
}

function normalizeStoredRun(raw: unknown): AutomationRun | null {
  if (!raw || typeof raw !== 'object') return null
  const src = raw as Record<string, unknown>
  const id = cleanString(src.id, 80)
  const taskId = cleanString(src.taskId, 80)
  if (!id || !taskId) return null
  const status = src.status
  if (status !== 'running' && status !== 'ok' && status !== 'bad' && status !== 'skipped') {
    return null
  }
  const startedAt = typeof src.startedAt === 'number' ? src.startedAt : Date.now()
  return {
    id,
    taskId,
    taskName: cleanString(src.taskName, 80) || taskId,
    cli: CLI_IDS.includes(src.cli as CliId) ? (src.cli as CliId) : 'claude',
    cwd: cleanString(src.cwd, 4096),
    providerSessionId: cleanString(src.providerSessionId, 256) || null,
    status,
    startedAt,
    finishedAt: typeof src.finishedAt === 'number' ? src.finishedAt : null,
    durationMs: typeof src.durationMs === 'number' ? src.durationMs : null,
    costUsd: typeof src.costUsd === 'number' ? src.costUsd : null,
    message: cleanString(src.message, 2000)
  }
}

function cloneTask(task: AutomationTask): AutomationTask {
  return {
    ...task,
    schedule: { ...task.schedule, weekdays: [...task.schedule.weekdays] }
  }
}

/** 取模型输出的最后一行有效文本，压成一行并截断 */
function summarizeRunOutput(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('```'))
  const last = lines[lines.length - 1] ?? ''
  const flat = last.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  return flat.length > 240 ? `${flat.slice(0, 237)}…` : flat
}
