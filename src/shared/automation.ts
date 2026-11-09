import type { PermissionMode } from './events'
import type { CliId, EffortLevel } from './settings'

/**
 * 自动化任务的数据模型。
 *
 * 任务本身只描述「什么时候、在哪儿、跑什么、出事怎么办」；运行记录单独存，
 * 因为用户删掉任务之后，历史运行仍然值得留着看。
 *
 * 这一版只做时间触发（间隔 / 每天 / 每周）。文件变更、Git、Webhook 等
 * 事件触发留给下一阶段 —— 数据模型里没有为它们预留半成品字段，避免出现
 * 「界面上有、实际不生效」的选项。
 */

export const AUTOMATION_FILE_VERSION = 1
/** 最多保留多少条运行记录；超出后从最旧的开始丢 */
export const AUTOMATION_RUN_LIMIT = 200

export type AutomationScheduleKind = 'interval' | 'daily' | 'weekly'
export type AutomationSessionMode = 'new' | 'resume'
/** 无人值守时遇到 AskUserQuestion 怎么办 */
export type AutomationQuestionPolicy = 'pause' | 'deny'
export type AutomationRunStatus = 'running' | 'ok' | 'bad' | 'skipped'

export interface AutomationSchedule {
  kind: AutomationScheduleKind
  /** kind = interval 时生效，单位分钟 */
  everyMinutes: number
  /** kind = daily / weekly 时生效，本地时间 HH:mm */
  time: string
  /** kind = weekly 时生效；0 = 周日，6 = 周六 */
  weekdays: number[]
}

export interface AutomationTaskInput {
  name: string
  enabled: boolean
  schedule: AutomationSchedule
  /** 工作目录；同时决定这条运行会话归属哪个工作区 */
  cwd: string
  cli: CliId
  /** 空串 = 用渠道 / CLI 的默认模型 */
  model: string
  effort: EffortLevel
  permissionMode: PermissionMode
  sessionMode: AutomationSessionMode
  /** sessionMode = resume 时必填：CLI 自己的 session id */
  resumeSessionId: string
  prompt: string
  /** 单轮超时；到点直接收掉进程 */
  timeoutMinutes: number
  /** 单次预算（美元）；null = 不限制。轮末结算时检查，超出记为失败 */
  budgetUsd: number | null
  onQuestion: AutomationQuestionPolicy
  notifySuccess: boolean
  notifyFailure: boolean
}

export interface AutomationTask extends AutomationTaskInput {
  id: string
  createdAt: number
  updatedAt: number
  lastRunAt: number | null
  lastStatus: Exclude<AutomationRunStatus, 'running' | 'skipped'> | null
  /**
   * 下一次该跑的时刻（毫秒）。
   *
   * 持久化它而不是每次从 lastRunAt 推：应用关掉几天再打开时，下一轮
   * 直接按这个时刻判断「已经过期 → 补跑一次」，行为可预期。
   */
  nextRunAt: number | null
}

export interface AutomationRun {
  id: string
  taskId: string
  taskName: string
  cli: CliId
  cwd: string
  /** CLI 自己的 session id；拿到之前为 null */
  providerSessionId: string | null
  status: AutomationRunStatus
  startedAt: number
  finishedAt: number | null
  durationMs: number | null
  costUsd: number | null
  /** 一句话结果，界面直接显示 */
  message: string
}

export interface AutomationSchedulerState {
  /** 调度器是否在跑（应用退出前一直是 true） */
  running: boolean
  /** 所有启用任务里最早的下次运行时刻 */
  nextRunAt: number | null
  /** 当前正在跑的那次运行的 id */
  activeRunId: string | null
}

export interface AutomationState {
  tasks: AutomationTask[]
  runs: AutomationRun[]
  scheduler: AutomationSchedulerState
}

export interface AutomationMutationResult {
  ok: boolean
  id?: string
  message?: string
}

export interface AutomationRunResult {
  ok: boolean
  runId?: string
  message?: string
}

/** 主进程 → 渲染层：一次运行结束，可用于系统通知 */
export interface AutomationRunFinishedPayload {
  taskName: string
  run: AutomationRun
  /** 新会话的侧栏标题；续跑模式可能改到用户重命名过的标题，所以为空 */
  title?: string
}

export const DEFAULT_SCHEDULE: AutomationSchedule = {
  kind: 'daily',
  everyMinutes: 60,
  time: '09:00',
  weekdays: [1]
}

/** 星期从周一开始展示；周日放最后，符合中文 / 英文日历习惯 */
export const WEEKDAY_ORDER: number[] = [1, 2, 3, 4, 5, 6, 0]

const MIN_INTERVAL = 1
const MAX_INTERVAL = 7 * 24 * 60

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function isValidTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

/** 把外部输入（IPC / 磁盘）收敛成合法计划，坏值回落到默认值 */
export function normalizeSchedule(raw: unknown): AutomationSchedule {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<AutomationSchedule>
  const kind: AutomationScheduleKind =
    src.kind === 'interval' || src.kind === 'weekly' ? src.kind : 'daily'

  const everyMinutes = clampInt(src.everyMinutes, MIN_INTERVAL, MAX_INTERVAL, 60)
  const time = isValidTime(src.time) ? src.time : '09:00'

  const seen = new Set<number>()
  const weekdays: number[] = []
  if (Array.isArray(src.weekdays)) {
    for (const v of src.weekdays) {
      const d = clampInt(v, 0, 6, -1)
      if (d >= 0 && !seen.has(d)) {
        seen.add(d)
        weekdays.push(d)
      }
    }
  }
  weekdays.sort((a, b) => WEEKDAY_ORDER.indexOf(a) - WEEKDAY_ORDER.indexOf(b))

  return {
    kind,
    everyMinutes,
    time,
    // 每周至少要有一天；没选就退回周一
    weekdays: weekdays.length ? weekdays : [1]
  }
}

function timeOnDay(base: Date, time: string): Date {
  const [h, m] = time.split(':').map(Number)
  const d = new Date(base)
  d.setHours(h, m, 0, 0)
  return d
}

/**
 * 从 `from` 之后算下一次触发时刻。
 *
 * 全部按**本地时间**：用户说的「每天 09:00」就是自己电脑上的 09:00。
 * 跨时区 / 夏令时由 Date 自己处理；间隔任务按毫秒直接加。
 *
 * 返回值一定 **严格大于** from —— 调度器靠这个保证不会在同一时刻反复触发。
 */
export function computeNextRun(schedule: AutomationSchedule, from: number): number {
  const s = normalizeSchedule(schedule)
  if (s.kind === 'interval') {
    return from + s.everyMinutes * 60_000
  }

  if (s.kind === 'daily') {
    const next = timeOnDay(new Date(from), s.time)
    if (next.getTime() <= from) next.setDate(next.getDate() + 1)
    return next.getTime()
  }

  // weekly：从今天开始往后找 8 天，覆盖「今天稍晚」和「下周同一天」
  for (let i = 0; i <= 7; i++) {
    const candidate = timeOnDay(new Date(from), s.time)
    candidate.setDate(candidate.getDate() + i)
    if (candidate.getTime() > from && s.weekdays.includes(candidate.getDay())) {
      return candidate.getTime()
    }
  }

  // 理论上到不了这里（weekdays 至少一天）；兜底成一天后
  return from + 24 * 60 * 60_000
}
