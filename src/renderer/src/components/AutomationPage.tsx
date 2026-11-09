import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AutomationRun,
  AutomationRunStatus,
  AutomationSchedule,
  AutomationState,
  AutomationTask,
  AutomationTaskInput
} from '@shared/automation'
import { DEFAULT_SCHEDULE, WEEKDAY_ORDER } from '@shared/automation'
import type { PermissionMode } from '@shared/events'
import type { MessageKey } from '@shared/i18n'
import type { StoredSession } from '@shared/session'
import { cliDef, sameCwd, type CliId, type EffortLevel } from '@shared/settings'
import { useI18n } from '../i18n'
import { ConfirmModal } from './ConfirmModal'
import {
  IconAlert,
  IconBell,
  IconCalendar,
  IconCheck,
  IconClock,
  IconFile,
  IconFolder,
  IconHistory,
  IconInfo,
  IconPencil,
  IconPlay,
  IconPlus,
  IconSearch,
  IconShield,
  IconStopSquare,
  IconTerminal,
  IconTrash,
  IconX
} from './Icons'

/**
 * 自动化任务一级页。
 *
 * 页面本身只做展示和编辑；调度、运行、落盘全在主进程。渲染层刷新靠
 * `automation.onChanged` 推送，不轮询 —— 运行记录的变化频率很低。
 */

interface AutomationPageProps {
  /** 当前打开的工作区，任务只能跑在这些目录里 */
  workspaces: { cwd: string; name: string }[]
  onOpenSession: (run: AutomationRun) => void
}

type Filter = 'all' | 'on' | 'off'
type RunFilter = 'all' | 'ok' | 'bad' | 'running'

const CLI_IDS: CliId[] = ['claude', 'codex', 'dsh']
const PERMISSION_MODES: PermissionMode[] = [
  'standard',
  'acceptEdits',
  'auto',
  'plan',
  'dontAsk',
  'bypassPermissions'
]
const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']

const MODE_KEY: Record<PermissionMode, MessageKey> = {
  standard: 'mode.standard',
  acceptEdits: 'mode.acceptEdits',
  auto: 'mode.auto',
  plan: 'mode.plan',
  dontAsk: 'mode.dontAsk',
  bypassPermissions: 'mode.bypassPermissions'
}
const EFFORT_KEY: Record<EffortLevel, MessageKey> = {
  low: 'effort.low',
  medium: 'effort.medium',
  high: 'effort.high',
  xhigh: 'effort.xhigh',
  max: 'effort.max',
  ultra: 'effort.ultra'
}
const WEEKDAY_KEY: MessageKey[] = [
  'automation.form.weekday.0',
  'automation.form.weekday.1',
  'automation.form.weekday.2',
  'automation.form.weekday.3',
  'automation.form.weekday.4',
  'automation.form.weekday.5',
  'automation.form.weekday.6'
]

function fmtDateTime(ms: number | null, locale: 'zh' | 'en'): string {
  if (ms == null) return '—'
  return new Date(ms).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—'
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`
}

function fmtCost(n: number | null): string {
  return n == null ? '—' : `$${n.toFixed(2)}`
}

export function AutomationPage({ workspaces, onOpenSession }: AutomationPageProps): JSX.Element {
  const { t, locale } = useI18n()
  const [state, setState] = useState<AutomationState | null>(null)
  const [unavailable, setUnavailable] = useState('')
  const [view, setView] = useState<'tasks' | 'runs'>('tasks')
  const [filter, setFilter] = useState<Filter>('all')
  const [runFilter, setRunFilter] = useState<RunFilter>('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editing, setEditing] = useState<AutomationTask | 'new' | null>(null)
  const [pendingDelete, setPendingDelete] = useState<AutomationTask | null>(null)
  const [toast, setToast] = useState('')
  const toastTimer = useRef<number | null>(null)

  const showToast = (message: string): void => {
    setToast(message)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 2400)
  }

  useEffect(() => {
    const api = window.api?.automation
    if (!api) {
      setUnavailable(t('errors.notElectron'))
      return
    }
    let alive = true
    void api
      .get()
      .then((s) => {
        if (alive) setState(s)
      })
      .catch((e) => {
        if (alive) setUnavailable(e instanceof Error ? e.message : String(e))
      })
    const off = api.onChanged((s) => setState(s))
    return () => {
      alive = false
      off()
    }
  }, [t])

  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    }
  }, [])

  const tasks = state?.tasks ?? []
  const runs = state?.runs ?? []
  const selected = tasks.find((x) => x.id === selectedId) ?? tasks[0] ?? null

  const runningRun = runs.find((r) => r.status === 'running') ?? null
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    // 有运行在跑时按秒走，平时半分钟更新一次「还有多久」
    const timer = window.setInterval(
      () => setNow(Date.now()),
      runningRun ? 1000 : 30_000
    )
    return () => window.clearInterval(timer)
  }, [runningRun?.id])

  const visibleTasks = useMemo(() => {
    const q = query.trim().toLowerCase()
    return tasks.filter((task) => {
      const byFilter = filter === 'all' || (filter === 'on' ? task.enabled : !task.enabled)
      const byQuery =
        !q ||
        `${task.name} ${task.cwd} ${task.prompt}`.toLowerCase().includes(q)
      return byFilter && byQuery
    })
  }, [tasks, filter, query])

  const filteredRuns = useMemo(
    () => runs.filter((r) => runFilter === 'all' || r.status === runFilter),
    [runs, runFilter]
  )

  const summary = useMemo(() => {
    const finished = runs.filter((r) => r.status === 'ok' || r.status === 'bad')
    const ok = finished.filter((r) => r.status === 'ok').length
    const rate = finished.length ? Math.round((ok / finished.length) * 100) : 0
    const cost = runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)
    return { count: runs.length, rate, cost }
  }, [runs])

  const api = () => window.api?.automation

  /** IPC 本身也可能失败（主进程异常），别让按钮点下去变成未处理拒绝 */
  const safe = async <T extends { ok: boolean; message?: string }>(
    p: Promise<T>
  ): Promise<T | { ok: false; message: string }> => {
    try {
      return await p
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }

  const runNow = async (task: AutomationTask): Promise<void> => {
    const a = api()
    if (!a) return
    const r = await safe(a.runNow(task.id))
    showToast(r.ok ? t('automation.toast.queued') : r.message || t('automation.error.save'))
  }

  const stopRun = async (task: AutomationTask): Promise<void> => {
    const a = api()
    if (!a) return
    const r = await safe(a.stop(task.id))
    if (!r.ok) showToast(r.message || t('automation.error.notRunning'))
  }

  const toggleTask = async (task: AutomationTask): Promise<void> => {
    const a = api()
    if (!a) return
    const r = await safe(a.setEnabled(task.id, !task.enabled))
    showToast(
      r.ok
        ? t(task.enabled ? 'automation.toast.disabled' : 'automation.toast.enabled', {
            name: task.name
          })
        : r.message || t('automation.error.save')
    )
  }

  const deleteTask = async (task: AutomationTask): Promise<void> => {
    const a = api()
    if (!a) return
    const r = await safe(a.remove(task.id))
    setPendingDelete(null)
    showToast(r.ok ? t('automation.toast.deleted') : r.message || t('automation.error.save'))
  }

  const saveTask = async (input: AutomationTaskInput): Promise<string | null> => {
    const a = api()
    if (!a) return t('errors.notElectron')
    const current = editing
    try {
      if (current === 'new') {
        const r = await a.create(input)
        if (!r.ok) return r.message || t('automation.error.save')
        if (r.id) setSelectedId(r.id)
        showToast(t('automation.toast.created'))
      } else if (current) {
        const r = await a.update(current.id, input)
        if (!r.ok) return r.message || t('automation.error.save')
        showToast(t('automation.toast.updated'))
      }
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
    setEditing(null)
    return null
  }

  const openRun = (run: AutomationRun): void => {
    if (run.status === 'running') {
      // 同一个 CLI 会话被两个进程同时接会打架，等这一轮收尾再开
      showToast(t('automation.runs.runningHint'))
      return
    }
    if (!run.providerSessionId) {
      showToast(t('automation.runs.noSession'))
      return
    }
    onOpenSession(run)
  }

  const scheduleLabel = (schedule: AutomationSchedule): string => {
    if (schedule.kind === 'interval') {
      return t('automation.schedule.interval', { minutes: schedule.everyMinutes })
    }
    if (schedule.kind === 'daily') {
      return t('automation.schedule.daily', { time: schedule.time })
    }
    const days = schedule.weekdays.map((d) => t(WEEKDAY_KEY[d])).join(t('common.listSeparator'))
    return t('automation.schedule.weekly', { days, time: schedule.time })
  }

  const relativeNext = (ms: number): string => {
    const diff = ms - now
    if (diff <= 0) return t('automation.relative.overdue')
    const minutes = Math.ceil(diff / 60_000)
    if (minutes <= 1) return t('automation.relative.soon')
    if (minutes < 60) return t('automation.relative.minutes', { count: minutes })
    const hours = Math.ceil(minutes / 60)
    if (hours < 48) return t('automation.relative.hours', { count: hours })
    return t('automation.relative.days', { count: Math.ceil(hours / 24) })
  }

  const statusLabel = (status: AutomationRunStatus): string => {
    if (status === 'running') return t('automation.status.running')
    if (status === 'ok') return t('automation.status.ok')
    if (status === 'bad') return t('automation.status.bad')
    return t('automation.status.skipped')
  }

  const statusBadge = (status: AutomationRunStatus): JSX.Element => (
    <span className={`au-badge au-badge--${status}`}>
      <i className="au-badge__dot" />
      {statusLabel(status)}
    </span>
  )

  const detailTask = selected
  const activeRun = detailTask
    ? runs.find((r) => r.taskId === detailTask.id && r.status === 'running') ?? null
    : null

  return (
    <section className="automation-page">
      <header className="au-head">
        <div className="au-heading">
          <div className="au-titleline">
            <h1 className="au-title">{t('nav.automation')}</h1>
            <span className="au-badge au-badge--mono">AUTOMATION</span>
          </div>
          <p className="au-sub">{t('automation.subtitle')}</p>
        </div>
        <div className="au-actions">
          <div className="au-segmented">
            <button
              className={view === 'tasks' ? 'is-active' : ''}
              onClick={() => setView('tasks')}
            >
              {t('automation.tab.tasks')} <span>{tasks.length}</span>
            </button>
            <button
              className={view === 'runs' ? 'is-active' : ''}
              onClick={() => setView('runs')}
            >
              {t('automation.tab.runs')}
            </button>
          </div>
          <button className="au-btn au-btn--primary" onClick={() => setEditing('new')}>
            <IconPlus width={14} height={14} />
            {t('automation.new')}
          </button>
        </div>
      </header>

      <div className="au-body">
        {unavailable ? (
          <div className="au-empty au-empty--page">{unavailable}</div>
        ) : !state ? (
          <div className="au-empty au-empty--page">{t('automation.loading')}</div>
        ) : view === 'tasks' ? (
          <div className="au-split">
            <aside className="au-list">
              <div className="au-tools">
                <label className="au-search">
                  <IconSearch width={14} height={14} />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('automation.search')}
                    spellCheck={false}
                  />
                </label>
              </div>
              <div className="au-chips">
                {(
                  [
                    ['all', 'automation.filter.all'],
                    ['on', 'automation.filter.on'],
                    ['off', 'automation.filter.off']
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    className={`au-chip ${filter === key ? 'is-active' : ''}`}
                    onClick={() => setFilter(key)}
                  >
                    {t(label)}
                  </button>
                ))}
              </div>

              <div className="au-scroll">
                {visibleTasks.length === 0 ? (
                  <div className="au-empty">
                    {tasks.length === 0 ? t('automation.empty') : t('automation.emptySearch')}
                    {tasks.length === 0 && (
                      <p className="au-empty__hint">{t('automation.emptyHint')}</p>
                    )}
                  </div>
                ) : (
                  (['on', 'off'] as const).map((group) => {
                    const list = visibleTasks.filter((x) => (group === 'on' ? x.enabled : !x.enabled))
                    if (!list.length) return null
                    return (
                      <div key={group}>
                        <div className="au-label">
                          {t(group === 'on' ? 'automation.group.on' : 'automation.group.off')}
                          <span>{list.length}</span>
                        </div>
                        {list.map((task) => {
                          const taskRunning = runs.some(
                            (r) => r.taskId === task.id && r.status === 'running'
                          )
                          return (
                            <div
                              key={task.id}
                              className={`au-row ${selected?.id === task.id ? 'is-active' : ''}`}
                              onClick={() => setSelectedId(task.id)}
                            >
                              <span
                                className={`au-row__dot ${
                                  taskRunning
                                    ? 'is-run'
                                    : !task.enabled && task.lastStatus !== 'bad'
                                      ? 'is-paused'
                                      : task.lastStatus === 'ok'
                                        ? 'is-ok'
                                        : task.lastStatus === 'bad'
                                          ? 'is-bad'
                                          : 'is-paused'
                                }`}
                              />
                              <div className="au-row__main">
                                <div className="au-row__line">
                                  <span className="au-row__name">{task.name}</span>
                                  <span className="au-row__cli" style={{ color: cliColor(task.cli) }}>
                                    {cliDef(task.cli).name.split(' ')[0]}
                                  </span>
                                </div>
                                <div className="au-row__meta">
                                  {scheduleLabel(task.schedule)} · {baseName(task.cwd)}
                                </div>
                              </div>
                              <div className="au-row__right">
                                <span
                                  className={`au-row__when ${taskRunning ? 'is-run' : task.lastStatus === 'bad' ? 'is-bad' : ''}`}
                                >
                                  {taskRunning
                                    ? t('automation.status.running')
                                    : task.enabled
                                      ? task.nextRunAt
                                        ? relativeNext(task.nextRunAt)
                                        : '—'
                                      : t('automation.status.paused')}
                                </span>
                                <button
                                  className={`au-switch ${task.enabled ? 'is-on' : ''}`}
                                  title={
                                    task.enabled
                                      ? t('automation.action.pause')
                                      : t('automation.action.enable')
                                  }
                                  aria-label={
                                    task.enabled
                                      ? t('automation.action.pause')
                                      : t('automation.action.enable')
                                  }
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    void toggleTask(task)
                                  }}
                                />
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )
                  })
                )}
              </div>

              <div className="au-list-foot">
                <i className="au-sched-dot" />
                <span>
                  {state.scheduler.running
                    ? t('automation.scheduler.running')
                    : t('automation.scheduler.hint')}
                </span>
                <span className="au-list-foot__hint">{t('automation.scheduler.hint')}</span>
              </div>
            </aside>

            <div className="au-detail">
              {!detailTask ? (
                <div className="au-empty au-empty--page">{t('automation.empty')}</div>
              ) : (
                <>
                  <div className="au-dhead">
                    <div className="au-mark">
                      <IconClock width={18} height={18} />
                    </div>
                    <div className="au-dheading">
                      <div className="au-dtitleline">
                        <h2 className="au-dtitle">{detailTask.name}</h2>
                        <span className={`au-badge ${detailTask.enabled ? 'au-badge--ok' : ''}`}>
                          <i className="au-badge__dot" />
                          {detailTask.enabled
                            ? t('automation.status.enabled')
                            : t('automation.status.paused')}
                        </span>
                        {activeRun && (
                          <span className="au-badge au-badge--running">
                            <i className="au-badge__dot" />
                            {t('automation.status.running')}
                          </span>
                        )}
                      </div>
                      <div className="au-dmeta">
                        <span className="au-inline">
                          <IconTerminal width={12} height={12} />
                          {cliDef(detailTask.cli).name}
                        </span>
                        <span className="au-dotsep">·</span>
                        <span>
                          {detailTask.model || t('automation.value.defaultModel')} ·{' '}
                          {t('automation.form.effort')} {t(EFFORT_KEY[detailTask.effort])}
                        </span>
                        <span className="au-dotsep">·</span>
                        <span>{scheduleLabel(detailTask.schedule)}</span>
                      </div>
                    </div>
                    <div className="au-dactions">
                      {activeRun ? (
                        <>
                          <button
                            className="au-btn au-btn--ghost au-btn--danger"
                            onClick={() => void stopRun(detailTask)}
                          >
                            <IconStopSquare width={13} height={13} />
                            {t('automation.action.stop')}
                          </button>
                          <button className="au-btn au-btn--primary" disabled>
                            {t('automation.status.running')}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="au-btn au-btn--ghost"
                            onClick={() => void toggleTask(detailTask)}
                          >
                            {detailTask.enabled ? t('automation.action.pause') : t('automation.action.enable')}
                          </button>
                          <button
                            className="au-btn au-btn--primary"
                            onClick={() => void runNow(detailTask)}
                          >
                            <IconPlay width={13} height={13} />
                            {t('automation.action.runNow')}
                          </button>
                        </>
                      )}
                      <button
                        className="au-iconbtn"
                        title={t('automation.edit')}
                        onClick={() => setEditing(detailTask)}
                      >
                        <IconPencil width={14} height={14} />
                      </button>
                      <button
                        className="au-iconbtn au-iconbtn--danger"
                        title={t('automation.delete')}
                        onClick={() => setPendingDelete(detailTask)}
                      >
                        <IconTrash width={14} height={14} />
                      </button>
                    </div>
                  </div>

                  {activeRun && (
                    <div className="au-runbar">
                      <div className="au-runbar__top">
                        <span className="au-runbar__state">
                          <i className="au-pulse" />
                          {t('automation.status.running')}
                        </span>
                        <span className="au-runbar__elapsed">
                          {t('automation.value.elapsed', {
                            time: fmtElapsed(now - activeRun.startedAt)
                          })}
                        </span>
                        <span className="au-runbar__spacer" />
                        <button className="au-link" onClick={() => void stopRun(detailTask)}>
                          {t('automation.action.stop')}
                        </button>
                      </div>
                      <div className="au-progress">
                        <div className="au-progress__fill" />
                      </div>
                      <div className="au-runbar__step">
                        <IconFile width={12} height={12} />
                        {activeRun.message}
                      </div>
                    </div>
                  )}

                  <section className="au-section">
                    <div className="au-section__head">
                      <IconCalendar width={13} height={13} />
                      <span className="au-section__title">{t('automation.section.trigger')}</span>
                    </div>
                    <div className="au-field">
                      <span className="au-field__label">{t('automation.field.schedule')}</span>
                      <span className="au-field__value">{scheduleLabel(detailTask.schedule)}</span>
                    </div>
                    <div className="au-field">
                      <span className="au-field__label">{t('automation.field.nextRun')}</span>
                      <span className="au-field__value">
                        {detailTask.enabled && detailTask.nextRunAt
                          ? `${fmtDateTime(detailTask.nextRunAt, locale)} · ${relativeNext(detailTask.nextRunAt)}`
                          : t('automation.status.paused')}
                      </span>
                    </div>
                    <div className="au-field">
                      <span className="au-field__label">{t('automation.field.missed')}</span>
                      <span className="au-field__value">{t('automation.value.missedCatchUp')}</span>
                    </div>
                    <div className="au-field">
                      <span className="au-field__label">{t('automation.field.timezone')}</span>
                      <span className="au-field__value au-muted">
                        {Intl.DateTimeFormat().resolvedOptions().timeZone ||
                          t('automation.value.localTimezone')}
                      </span>
                    </div>
                  </section>

                  <section className="au-section">
                    <div className="au-section__head">
                      <IconTerminal width={13} height={13} />
                      <span className="au-section__title">{t('automation.section.execution')}</span>
                    </div>
                    <div className="au-field">
                      <span className="au-field__label">{t('automation.field.workspace')}</span>
                      <span className="au-field__value">
                        <IconFolder width={13} height={13} />
                        {detailTask.cwd}
                      </span>
                    </div>
                    <div className="au-field">
                      <span className="au-field__label">{t('automation.field.cliModel')}</span>
                      <span className="au-field__value">
                        <span style={{ color: cliColor(detailTask.cli) }}>
                          {cliDef(detailTask.cli).name}
                        </span>
                        <span className="au-faint">·</span>
                        {detailTask.model || t('automation.value.defaultModel')}
                        <span className="au-faint">·</span>
                        <span className="au-muted">
                          {t('automation.form.effort')} {t(EFFORT_KEY[detailTask.effort])}
                        </span>
                      </span>
                    </div>
                    <div className="au-field">
                      <span className="au-field__label">{t('automation.field.session')}</span>
                      <span className="au-field__value">
                        {detailTask.sessionMode === 'resume'
                          ? t('automation.session.resume')
                          : t('automation.session.new')}
                        {detailTask.sessionMode === 'resume' && (
                          <>
                            <span className="au-faint">·</span>
                            <span className="au-mono">{detailTask.resumeSessionId}</span>
                          </>
                        )}
                      </span>
                    </div>
                    <div className="au-field au-field--top">
                      <span className="au-field__label">{t('automation.field.prompt')}</span>
                      <div className="au-field__value au-field__value--block">
                        <div className="au-prompt">{detailTask.prompt}</div>
                      </div>
                    </div>
                  </section>

                  <section className="au-section">
                    <div className="au-section__head">
                      <IconShield width={13} height={13} />
                      <span className="au-section__title">{t('automation.section.policy')}</span>
                    </div>
                    <div className="au-field">
                      <span className="au-field__label">{t('automation.field.permission')}</span>
                      <span className="au-field__value">
                        <span className="au-mono">{t(MODE_KEY[detailTask.permissionMode])}</span>
                        <span className="au-tag au-tag--warn">
                          {t('automation.policy.permissionNote')}
                        </span>
                      </span>
                    </div>
                    <div className="au-field">
                      <span className="au-field__label">{t('automation.field.question')}</span>
                      <span className="au-field__value">
                        {detailTask.onQuestion === 'deny'
                          ? t('automation.question.deny')
                          : t('automation.question.pause')}
                      </span>
                    </div>
                    <div className="au-field">
                      <span className="au-field__label">{t('automation.field.timeout')}</span>
                      <span className="au-field__value">
                        {t('automation.value.timeout', { minutes: detailTask.timeoutMinutes })}
                      </span>
                    </div>
                    <div className="au-field">
                      <span className="au-field__label">{t('automation.field.budget')}</span>
                      <span className="au-field__value">
                        {detailTask.budgetUsd == null
                          ? t('automation.value.noBudget')
                          : `$${detailTask.budgetUsd.toFixed(2)}`}
                        {detailTask.budgetUsd != null && (
                          <span className="au-faint">· {t('automation.value.budgetHint')}</span>
                        )}
                      </span>
                    </div>
                    <div className="au-callout au-callout--warn">
                      <IconAlert width={14} height={14} />
                      <span>{t('automation.policy.warning')}</span>
                    </div>
                  </section>

                  <section className="au-section">
                    <div className="au-section__head">
                      <IconBell width={13} height={13} />
                      <span className="au-section__title">{t('automation.section.notify')}</span>
                    </div>
                    <div className="au-notify">
                      <IconCheck width={13} height={13} />
                      <span>{t('automation.notify.success')}</span>
                      <span className={`au-switch ${detailTask.notifySuccess ? 'is-on' : ''}`} />
                    </div>
                    <div className="au-notify">
                      <IconCheck width={13} height={13} />
                      <span>{t('automation.notify.failure')}</span>
                      <span className={`au-switch ${detailTask.notifyFailure ? 'is-on' : ''}`} />
                    </div>
                    <div className="au-notify__hint">{t('automation.notify.hint')}</div>
                  </section>

                  <section className="au-section">
                    <div className="au-section__head">
                      <IconHistory width={13} height={13} />
                      <span className="au-section__title">{t('automation.section.runs')}</span>
                      <span className="au-section__action">
                        <button className="au-link au-link--accent" onClick={() => setView('runs')}>
                          {t('automation.action.viewAll')} →
                        </button>
                      </span>
                    </div>
                    {runs.filter((r) => r.taskId === detailTask.id).length === 0 ? (
                      <div className="au-muted au-run-empty">{t('automation.runs.empty')}</div>
                    ) : (
                      runs
                        .filter((r) => r.taskId === detailTask.id)
                        .slice(0, 4)
                        .map((run) => (
                          <div key={run.id} className="au-runrow">
                            {statusBadge(run.status)}
                            <span className="au-runrow__time">
                              {fmtDateTime(run.startedAt, locale)}
                            </span>
                            <span className="au-runrow__result" title={run.message}>
                              {run.message}
                            </span>
                            <span className="au-runrow__num">{fmtDuration(run.durationMs)}</span>
                            <span className="au-runrow__num au-runrow__num--cost">
                              {fmtCost(run.costUsd)}
                            </span>
                            <button className="au-link au-runrow__open" onClick={() => openRun(run)}>
                              {run.status === 'running'
                                ? t('automation.action.view')
                                : t('automation.action.openSession')}
                            </button>
                          </div>
                        ))
                    )}
                  </section>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="au-runs">
            <div className="au-runs__toolbar">
              <div className="au-chips au-chips--inline">
                {(
                  [
                    ['all', 'automation.filter.all'],
                    ['ok', 'automation.status.ok'],
                    ['bad', 'automation.status.bad'],
                    ['running', 'automation.status.running']
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    className={`au-chip ${runFilter === key ? 'is-active' : ''}`}
                    onClick={() => setRunFilter(key)}
                  >
                    {t(label)}
                  </button>
                ))}
              </div>
              <div className="au-runs__summary">
                {t('automation.runs.summary', {
                  count: summary.count,
                  rate: summary.rate,
                  cost: `$${summary.cost.toFixed(2)}`
                })}
              </div>
            </div>
            <table className="au-table">
              <thead>
                <tr>
                  <th style={{ width: 190 }}>{t('automation.runs.task')}</th>
                  <th style={{ width: 86 }}>{t('automation.runs.status')}</th>
                  <th style={{ width: 118 }}>{t('automation.runs.start')}</th>
                  <th style={{ width: 88 }}>{t('automation.runs.duration')}</th>
                  <th style={{ width: 64 }}>{t('automation.runs.cost')}</th>
                  <th>{t('automation.runs.result')}</th>
                  <th style={{ width: 76 }} />
                </tr>
              </thead>
              <tbody>
                {filteredRuns.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="au-empty">
                      {t('automation.runs.empty')}
                    </td>
                  </tr>
                ) : (
                  filteredRuns.map((run) => (
                    <tr key={run.id}>
                      <td>
                        <div className="au-table__task">
                          <IconClock width={13} height={13} />
                          <span>{run.taskName}</span>
                        </div>
                      </td>
                      <td>{statusBadge(run.status)}</td>
                      <td className="au-muted">{fmtDateTime(run.startedAt, locale)}</td>
                      <td className="au-table__num">{fmtDuration(run.durationMs)}</td>
                      <td className="au-table__num">{fmtCost(run.costUsd)}</td>
                      <td className="au-table__result" title={run.message}>
                        {run.message}
                      </td>
                      <td>
                        <button className="au-link au-table__open" onClick={() => openRun(run)}>
                          {run.status === 'running'
                            ? t('automation.action.view')
                            : t('automation.action.openSession')}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <TaskForm
          task={editing === 'new' ? null : editing}
          workspaces={workspaces}
          onCancel={() => setEditing(null)}
          onSubmit={saveTask}
        />
      )}

      {pendingDelete && (
        <ConfirmModal
          title={t('automation.delete')}
          badge={t('automation.delete')}
          confirmLabel={t('automation.delete')}
          onConfirm={() => void deleteTask(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        >
          {t('automation.deleteConfirm', { name: pendingDelete.name })}
        </ConfirmModal>
      )}

      {toast && (
        <div className="au-toast">
          <IconCheck width={14} height={14} />
          <span>{toast}</span>
        </div>
      )}
    </section>
  )
}

/* ── 新建 / 编辑表单 ─────────────────────────────────────── */

function TaskForm({
  task,
  workspaces,
  onCancel,
  onSubmit
}: {
  task: AutomationTask | null
  workspaces: { cwd: string; name: string }[]
  onCancel: () => void
  onSubmit: (input: AutomationTaskInput) => Promise<string | null>
}): JSX.Element {
  const { t } = useI18n()
  const [v, setV] = useState<AutomationTaskInput>(() => ({
    name: task?.name ?? '',
    enabled: task?.enabled ?? true,
    schedule: task ? { ...task.schedule, weekdays: [...task.schedule.weekdays] } : { ...DEFAULT_SCHEDULE },
    cwd: task?.cwd ?? workspaces[0]?.cwd ?? '',
    cli: task?.cli ?? 'claude',
    model: task?.model ?? '',
    effort: task?.effort ?? 'medium',
    permissionMode: task?.permissionMode ?? 'dontAsk',
    sessionMode: task?.sessionMode ?? 'new',
    resumeSessionId: task?.resumeSessionId ?? '',
    prompt: task?.prompt ?? '',
    timeoutMinutes: task?.timeoutMinutes ?? 30,
    budgetUsd: task?.budgetUsd ?? null,
    onQuestion: task?.onQuestion ?? 'pause',
    notifySuccess: task?.notifySuccess ?? true,
    notifyFailure: task?.notifyFailure ?? true
  }))
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [sessions, setSessions] = useState<StoredSession[]>([])

  useEffect(() => {
    let alive = true
    void window.api?.sessions
      ?.list()
      .then((list) => {
        if (alive) setSessions(list)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const set = <K extends keyof AutomationTaskInput>(
    key: K,
    value: AutomationTaskInput[K]
  ): void => setV((prev) => ({ ...prev, [key]: value }))

  const setSchedule = (patch: Partial<AutomationSchedule>): void =>
    setV((prev) => ({ ...prev, schedule: { ...prev.schedule, ...patch } }))

  const cwdOptions = useMemo(() => {
    const out = [...workspaces]
    if (v.cwd && !out.some((w) => sameCwd(w.cwd, v.cwd))) out.unshift({ cwd: v.cwd, name: v.cwd })
    return out
  }, [workspaces, v.cwd])

  const resumeOptions = useMemo(
    () => sessions.filter((s) => s.cli === v.cli && sameCwd(s.cwd, v.cwd)),
    [sessions, v.cli, v.cwd]
  )

  const submit = async (): Promise<void> => {
    setError('')
    if (!v.name.trim()) {
      setError(t('automation.error.name'))
      return
    }
    if (!v.prompt.trim()) {
      setError(t('automation.error.prompt'))
      return
    }
    if (!v.cwd) {
      setError(t('automation.form.workspaceEmpty'))
      return
    }
    if (v.sessionMode === 'resume' && !v.resumeSessionId.trim()) {
      setError(t('automation.error.resume'))
      return
    }
    setSaving(true)
    const message = await onSubmit(v)
    setSaving(false)
    if (message) setError(message)
  }

  return (
    <div className="au-scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="au-dialog" role="dialog" aria-modal="true" aria-label={t(task ? 'automation.modal.editTitle' : 'automation.modal.title')}>
        <header className="au-dialog__head">
          <div className="au-dialog__mark">
            <IconClock width={16} height={16} />
          </div>
          <div className="au-dialog__titlebox">
            <h2 className="au-dialog__title">
              {t(task ? 'automation.modal.editTitle' : 'automation.modal.title')}
            </h2>
            <p className="au-dialog__sub">{t('automation.modal.subtitle')}</p>
          </div>
          <button className="au-iconbtn" onClick={onCancel} aria-label={t('common.close')}>
            <IconX width={15} height={15} />
          </button>
        </header>

        <div className="au-dialog__body">
          <div className="au-form-field">
            <label>{t('automation.form.name')}</label>
            <input
              className="au-input"
              value={v.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder={t('automation.form.namePlaceholder')}
            />
          </div>

          <div className="au-form-row au-form-row--2">
            <div className="au-form-field">
              <label>{t('automation.form.trigger')}</label>
              <select
                className="au-input"
                value={v.schedule.kind}
                onChange={(e) => setSchedule({ kind: e.target.value as AutomationSchedule['kind'] })}
              >
                <option value="interval">{t('automation.form.kind.interval')}</option>
                <option value="daily">{t('automation.form.kind.daily')}</option>
                <option value="weekly">{t('automation.form.kind.weekly')}</option>
              </select>
            </div>
            {v.schedule.kind === 'interval' ? (
              <div className="au-form-field">
                <label>{t('automation.form.interval')}</label>
                <input
                  className="au-input"
                  type="number"
                  min={1}
                  max={10080}
                  value={v.schedule.everyMinutes}
                  onChange={(e) =>
                    setSchedule({ everyMinutes: Math.max(1, Number(e.target.value) || 1) })
                  }
                />
              </div>
            ) : (
              <div className="au-form-field">
                <label>{t('automation.form.time')}</label>
                <input
                  className="au-input"
                  type="time"
                  value={v.schedule.time}
                  onChange={(e) => setSchedule({ time: e.target.value || '09:00' })}
                />
              </div>
            )}
          </div>

          {v.schedule.kind === 'weekly' && (
            <div className="au-form-field">
              <label>{t('automation.form.weekdays')}</label>
              <div className="au-days">
                {WEEKDAY_ORDER.map((day) => {
                  const on = v.schedule.weekdays.includes(day)
                  return (
                    <button
                      key={day}
                      type="button"
                      className={`au-day ${on ? 'is-on' : ''}`}
                      onClick={() => {
                        const next = on
                          ? v.schedule.weekdays.filter((d) => d !== day)
                          : [...v.schedule.weekdays, day]
                        // 至少保留一天；空数组在主进程会被回落成周一，界面别出现这种"静默修正"
                        if (next.length) setSchedule({ weekdays: next })
                      }}
                    >
                      {t(WEEKDAY_KEY[day])}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <div className="au-form-row au-form-row--2">
            <div className="au-form-field">
              <label>{t('automation.form.workspace')}</label>
              {cwdOptions.length ? (
                <select
                  className="au-input"
                  value={v.cwd}
                  onChange={(e) => {
                    setV((prev) => ({ ...prev, cwd: e.target.value, resumeSessionId: '' }))
                  }}
                >
                  {cwdOptions.map((w) => (
                    <option key={w.cwd} value={w.cwd}>
                      {w.name}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="au-form-empty">{t('automation.form.workspaceEmpty')}</div>
              )}
            </div>
            <div className="au-form-field">
              <label>{t('automation.form.cli')}</label>
              <select
                className="au-input"
                value={v.cli}
                onChange={(e) => {
                  setV((prev) => ({
                    ...prev,
                    cli: e.target.value as CliId,
                    resumeSessionId: ''
                  }))
                }}
              >
                {CLI_IDS.map((id) => (
                  <option key={id} value={id}>
                    {cliDef(id).name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="au-form-row au-form-row--2">
            <div className="au-form-field">
              <label>{t('automation.form.model')}</label>
              <input
                className="au-input"
                value={v.model}
                onChange={(e) => set('model', e.target.value)}
                placeholder={t('automation.form.modelPlaceholder')}
              />
            </div>
            <div className="au-form-field">
              <label>{t('automation.form.effort')}</label>
              <select
                className="au-input"
                value={v.effort}
                onChange={(e) => set('effort', e.target.value as EffortLevel)}
              >
                {EFFORT_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {t(EFFORT_KEY[level])}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="au-form-row au-form-row--2">
            <div className="au-form-field">
              <label>{t('automation.form.session')}</label>
              <select
                className="au-input"
                value={v.sessionMode}
                onChange={(e) => set('sessionMode', e.target.value as 'new' | 'resume')}
              >
                <option value="new">{t('automation.session.new')}</option>
                <option value="resume">{t('automation.session.resume')}</option>
              </select>
            </div>
            {v.sessionMode === 'resume' && (
              <div className="au-form-field">
                <label>{t('automation.form.resumeSession')}</label>
                {resumeOptions.length ? (
                  <select
                    className="au-input"
                    value={v.resumeSessionId}
                    onChange={(e) => set('resumeSessionId', e.target.value)}
                  >
                    <option value="">{t('automation.error.resume')}</option>
                    {!v.resumeSessionId && null}
                    {v.resumeSessionId &&
                    !resumeOptions.some((s) => s.id === v.resumeSessionId) ? (
                      <option value={v.resumeSessionId}>{v.resumeSessionId}</option>
                    ) : null}
                    {resumeOptions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {(s.title || s.id).slice(0, 60)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="au-form-empty">{t('automation.session.none')}</div>
                )}
              </div>
            )}
          </div>

          <div className="au-form-field">
            <label>{t('automation.form.prompt')}</label>
            <textarea
              className="au-textarea"
              value={v.prompt}
              onChange={(e) => set('prompt', e.target.value)}
              placeholder={t('automation.form.promptPlaceholder')}
              rows={4}
            />
          </div>

          <div className="au-form-divider">{t('automation.form.policy')}</div>

          <div className="au-form-row au-form-row--3">
            <div className="au-form-field">
              <label>{t('automation.form.permission')}</label>
              <select
                className="au-input"
                value={v.permissionMode}
                onChange={(e) => set('permissionMode', e.target.value as PermissionMode)}
              >
                {PERMISSION_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(MODE_KEY[mode])}
                  </option>
                ))}
              </select>
            </div>
            <div className="au-form-field">
              <label>{t('automation.form.question')}</label>
              <select
                className="au-input"
                value={v.onQuestion}
                onChange={(e) => set('onQuestion', e.target.value as 'pause' | 'deny')}
              >
                <option value="pause">{t('automation.question.pause')}</option>
                <option value="deny">{t('automation.question.deny')}</option>
              </select>
            </div>
            <div className="au-form-field">
              <label>{t('automation.form.timeout')}</label>
              <input
                className="au-input"
                type="number"
                min={1}
                max={1440}
                value={v.timeoutMinutes}
                onChange={(e) =>
                  set('timeoutMinutes', Math.max(1, Number(e.target.value) || 1))
                }
              />
            </div>
          </div>

          <div className="au-form-row au-form-row--2">
            <div className="au-form-field">
              <label>{t('automation.form.budget')}</label>
              <input
                className="au-input"
                type="number"
                min={0}
                step={0.01}
                value={v.budgetUsd ?? ''}
                placeholder={t('automation.form.budgetPlaceholder')}
                onChange={(e) => {
                  const raw = e.target.value
                  set('budgetUsd', raw === '' ? null : Math.max(0, Number(raw) || 0) || null)
                }}
              />
            </div>
            <div className="au-form-field">
              <label>{t('automation.section.notify')}</label>
              <div className="au-checks">
                <label className="au-check">
                  <input
                    type="checkbox"
                    checked={v.notifySuccess}
                    onChange={(e) => set('notifySuccess', e.target.checked)}
                  />
                  {t('automation.form.notifySuccess')}
                </label>
                <label className="au-check">
                  <input
                    type="checkbox"
                    checked={v.notifyFailure}
                    onChange={(e) => set('notifyFailure', e.target.checked)}
                  />
                  {t('automation.form.notifyFailure')}
                </label>
              </div>
            </div>
          </div>

          <div className="au-callout au-callout--info">
            <IconInfo width={14} height={14} />
            <span>{t('automation.form.note')}</span>
          </div>

          {error && <div className="au-form-error">{error}</div>}
        </div>

        <footer className="au-dialog__foot">
          <span className="au-dialog__hint">{t('automation.policy.permissionNote')}</span>
          <button className="au-btn au-btn--ghost" onClick={onCancel} disabled={saving}>
            {t('common.cancel')}
          </button>
          <button className="au-btn au-btn--primary" onClick={() => void submit()} disabled={saving}>
            <IconCheck width={14} height={14} />
            {saving
              ? t('automation.loading')
              : t(task ? 'automation.form.saveEdit' : 'automation.form.save')}
          </button>
        </footer>
      </div>
    </div>
  )
}

/* ── 小工具 ─────────────────────────────────────────────── */

function cliColor(cli: CliId): string {
  if (cli === 'codex') return '#9a9a9a'
  if (cli === 'dsh') return '#5b9dff'
  return '#d97757'
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || p
}
