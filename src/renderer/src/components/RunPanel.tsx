import { Fragment, memo, useEffect, useState, type ReactNode } from 'react'
import type { MessageKey } from '@shared/i18n'
import type { RunAgent, RunBackgroundTask, RunState, RunTask } from '../run-state'
import { useI18n } from '../i18n'
import { fmtClock, fmtTokens } from './format'
import {
  IconAlert,
  IconArrowRight,
  IconCheck,
  IconChevronRight,
  IconCompass,
  IconInfo,
  IconRoute,
  IconSpark,
  IconStopSquare,
  IconTerminal
} from './Icons'
import { AgentReportModal } from './AgentReportModal'

/**
 * 输出区右侧的「执行台」。
 *
 * 只做一件事：把这一轮的任务清单和子代理摊开。转写区仍然是对话本身，
 * 这里回答的是「它现在做到哪一步了、有没有在跑别的代理」。
 *
 * 视觉上是「运行状态优先」：计时器是头部锚点，子代理卡片用左侧色条 +
 * 右上角胶囊双重编码状态，活动行只保留「工具 + 正在做什么」。任务进度
 * 放回任务分区，底部固定本轮步数 / 增删行数。
 *
 * 没有任务也没有子代理时整个面板不渲染 —— 右侧还给对话，不占地方。
 */

interface Props {
  run: RunState
  /** 这一轮还在跑（含正在连 CLI 的那一段） */
  live: boolean
  /**
   * 主对话这一轮还在跑。和 live 分开：只有后台子代理在跑时 live 仍为 true，
   * 但 CLI 的 interrupt 是整轮中断，这时不该给「中断」按钮。
   */
  running: boolean
  onInterrupt: () => void
  onCollapse: () => void
  onOpenTrace: () => void
}

function RunPanelImpl({
  run,
  live,
  running,
  onInterrupt,
  onCollapse,
  onOpenTrace
}: Props): JSX.Element | null {
  const { t, tn } = useI18n()
  const now = useNow(live)
  const [reportId, setReportId] = useState<string | null>(null)

  if (
    run.tasks.length === 0 &&
    run.agents.length === 0 &&
    run.background.length === 0
  ) {
    return null
  }

  const doneTasks = run.tasks.filter((t) => t.status === 'completed').length
  const activeTasks = run.tasks.filter((t) => t.status === 'in_progress').length
  const runningAgents = run.agents.filter((a) => a.status === 'running').length
  const runningBackground = run.background.filter((b) => b.status === 'running').length
  /*
   * 只在进行中显示计时。结束后不拿「主对话这一轮」的时长冒充整轮耗时 ——
   * 后台子代理可能比主对话多跑几分钟，那个数字会和卡片上的耗时打架。
   */
  const elapsed = live ? (run.startedAt ? now - run.startedAt : undefined) : undefined
  /** 卡片的 id 可能比 agents 活得久（换轮次），取不到就自动关掉弹窗 */
  const reportAgent = reportId ? run.agents.find((a) => a.id === reportId) ?? null : null

  /*
   * 头部只留一句人话摘要，具体计数交给分区标题 —— 旧版把
   * 「子代理 0/2 · 2 运行中」这类重复信息堆在头部，越看越像日志。
   */
  let summary = ''
  if (live) {
    if (runningAgents > 0) {
      summary = tn('runpanel.summary.parallelAgents', runningAgents)
    } else if (runningBackground > 0) {
      summary = tn('runpanel.summary.parallelBackground', runningBackground)
    } else if (activeTasks > 0) {
      summary = tn('runpanel.summary.activeTasks', activeTasks)
    } else {
      summary = t('runpanel.running')
    }
  } else if (run.tasks.length > 0) {
    summary = tn('runpanel.tasksDone', run.tasks.length, {
      done: doneTasks,
      total: run.tasks.length
    })
  } else if (run.agents.length > 0) {
    summary = tn('runpanel.summary.doneAgents', run.agents.length)
  } else {
    summary = t('runpanel.done')
  }

  return (
    <>
      <aside className="runpanel">
        <header className={`runpanel__head ${live ? 'is-live' : 'is-done'}`}>
          <div className="runpanel__top">
            <span className="runpanel__title">{t('runpanel.title')}</span>
            <button
              className="runpanel__collapse"
              onClick={onCollapse}
              title={t('runpanel.collapse')}
            >
              <IconChevronRight width={14} height={14} />
            </button>
          </div>

          <div className="runpanel__status">
            {elapsed != null && (
              <span className="runpanel__timer">{fmtClock(elapsed)}</span>
            )}
            <span className={`runpanel__state ${live ? 'is-live' : 'is-done'}`}>
              {live ? <i className="dot" /> : <IconCheck width={10} height={10} />}
              {live ? t('runpanel.running') : t('runpanel.done')}
            </span>
            {running && (
              <button
                className="runpanel__stop"
                onClick={onInterrupt}
                title={t('runpanel.interruptHint')}
              >
                <IconStopSquare width={10} height={10} />
                {t('runpanel.interrupt')}
              </button>
            )}
          </div>

          {summary && <p className="runpanel__sub">{summary}</p>}
          {live && <div className="runpanel__scan" />}
        </header>

        {/*
         * 任务和子代理各自一个滚动容器 —— 两边都长的时候，
         * 滚任务不会把子代理带着走，反之亦然。分区标题留在滚动区外面，
         * 滚动的时候还能看见列表是什么。
         */}
        <div className="runpanel__body">
          {run.tasks.length > 0 && (
            <section className="rsec rsec--tasks">
              <SectionHead
                title={t('runpanel.tasks')}
                right={
                  <>
                    <b>{doneTasks}</b> / {run.tasks.length}
                  </>
                }
              />
              <div
                className="rtaskbar"
                title={tn('runpanel.tasksDone', run.tasks.length, {
                  done: doneTasks,
                  total: run.tasks.length
                })}
              >
                {run.tasks.map((task) => (
                  <i
                    key={task.id}
                    className={
                      task.status === 'completed'
                        ? 'is-done'
                        : task.status === 'in_progress'
                          ? `is-run${live ? '' : ' is-stale'}`
                          : 'is-todo'
                    }
                  />
                ))}
              </div>
              <div className="rsec__list">
                {run.tasks.map((task, index) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    index={index}
                    now={now}
                    live={live}
                  />
                ))}
              </div>
            </section>
          )}

          {run.agents.length > 0 && (
            <section className="rsec rsec--agents">
              <SectionHead
                title={t('runpanel.agents')}
                right={<StateCounts statuses={run.agents.map((a) => a.status)} />}
              />
              <div className="rsec__list">
                {run.agents.map((a) => (
                  <AgentCard key={a.id} agent={a} now={now} onOpenReport={setReportId} />
                ))}
              </div>
            </section>
          )}

          {/*
            后台 shell / workflow 单列。它们不是子代理（没有 agentType），
            但同样会在主对话结束后继续跑 —— 混进子代理区会让人误以为
            是 Agent 调用，单列才能一眼看出「还有命令在后台跑」。
          */}
          {run.background.length > 0 && (
            <section className="rsec rsec--bg">
              <SectionHead
                title={t('runpanel.backgroundTasks')}
                right={<StateCounts statuses={run.background.map((b) => b.status)} />}
              />
              <div className="rsec__list">
                {run.background.map((task) => (
                  <BackgroundCard key={task.id} task={task} now={now} />
                ))}
              </div>
            </section>
          )}
        </div>

        <div className="runpanel__foot">
          <span>{tn('count.steps', run.steps)}</span>
          {(run.added > 0 || run.removed > 0) && (
            <span className="runpanel__diff">
              {run.added > 0 && <b className="is-add">+{run.added}</b>}
              {run.removed > 0 && <b className="is-del">−{run.removed}</b>}
            </span>
          )}
          <button className="runpanel__link" onClick={onOpenTrace}>
            {t('runpanel.viewTrace')}
            <IconArrowRight width={11} height={11} />
          </button>
        </div>
      </aside>
      {reportAgent && (
        <AgentReportModal agent={reportAgent} onClose={() => setReportId(null)} />
      )}
    </>
  )
}

/* ── 分区标题 ─────────────────────────────────────────────── */

function SectionHead({
  title,
  right
}: {
  title: string
  right: ReactNode
}): JSX.Element {
  return (
    <div className="rsec__h">
      <span className="rsec__t">{title}</span>
      <span className="rsec__line" />
      <span className="rsec__n">{right}</span>
    </div>
  )
}

/** 子代理 / 后台任务分区右侧的状态计数，运行、完成、失败、停止各一色 */
function StateCounts({
  statuses
}: {
  statuses: Array<RunAgent['status'] | RunBackgroundTask['status']>
}): JSX.Element {
  const { t } = useI18n()
  const running = statuses.filter((s) => s === 'running').length
  const done = statuses.filter((s) => s === 'ok').length
  const failed = statuses.filter((s) => s === 'error' || s === 'denied').length
  const stopped = statuses.filter((s) => s === 'stopped' || s === 'unknown').length

  const bits: Array<{ cls: string; text: string }> = []
  if (running) {
    bits.push({ cls: 'is-run', text: t('runpanel.summary.agentsActive', { n: running }) })
  }
  if (done) {
    bits.push({ cls: 'is-ok', text: t('runpanel.summary.done', { n: done }) })
  }
  if (failed) {
    bits.push({ cls: 'is-bad', text: t('runpanel.summary.failed', { n: failed }) })
  }
  if (stopped) {
    bits.push({ cls: 'is-stopped', text: t('runpanel.summary.stopped', { n: stopped }) })
  }

  return (
    <>
      {bits.map((b, index) => (
        <Fragment key={b.cls}>
          {index > 0 && <span className="sep">·</span>}
          <span className={b.cls}>
            <i />
            {b.text}
          </span>
        </Fragment>
      ))}
    </>
  )
}

/* ── 任务 ─────────────────────────────────────────────────── */

function TaskRow({
  task,
  index,
  now,
  live
}: {
  task: RunTask
  index: number
  now: number
  live: boolean
}): JSX.Element {
  const { t } = useI18n()
  const ms = taskMs(task, now, live)
  const subject =
    task.subject ||
    (task.rawId
      ? t('run.taskWithId', { id: task.rawId })
      : t('run.taskNumbered', { n: index + 1 }))
  const tone =
    task.status === 'in_progress' ? 'run' : task.status === 'completed' ? 'done' : 'todo'
  /** 轮次已经结束但任务还停在 in_progress：保留位置，但别再脉冲 */
  const stale = task.status === 'in_progress' && !live
  return (
    <div className={`rtask is-${tone}${stale ? ' is-stale' : ''}`}>
      <span className="rtask__check">
        {task.status === 'completed' && <IconCheck width={9} height={9} />}
      </span>
      <div className="rtask__main">
        <div className="rtask__text">{subject}</div>
        {task.status === 'in_progress' && (
          <div className="rtask__form">
            <i />
            {task.activeForm || t('runpanel.inProgress')}
          </div>
        )}
      </div>
      {ms != null && <span className="rtask__time">{fmtClock(ms)}</span>}
    </div>
  )
}

function taskMs(task: RunTask, now: number, live: boolean): number | undefined {
  if (!task.startedAt) return undefined
  const end = task.endedAt ?? (task.status === 'in_progress' && live ? now : undefined)
  if (!end) return undefined
  const ms = end - task.startedAt
  return ms > 0 ? ms : undefined
}

/* ── 子代理 ───────────────────────────────────────────────── */

function agentTone(type: string): {
  tone: string
  glyph: JSX.Element
  labelKey: MessageKey
} {
  const t = type.toLowerCase()
  if (t.includes('explore')) {
    return {
      tone: 'explore',
      glyph: <IconCompass width={14} height={14} />,
      labelKey: 'agentType.explore'
    }
  }
  if (t.includes('plan')) {
    return {
      tone: 'plan',
      glyph: <IconRoute width={14} height={14} />,
      labelKey: 'agentType.plan'
    }
  }
  if (t.includes('general')) {
    return {
      tone: 'general',
      glyph: <IconSpark width={14} height={14} />,
      labelKey: 'agentType.subagent'
    }
  }
  return {
    tone: 'other',
    glyph: <IconSpark width={14} height={14} />,
    labelKey: 'agentType.subagent'
  }
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()

function AgentCard({
  agent,
  now,
  onOpenReport
}: {
  agent: RunAgent
  now: number
  onOpenReport: (id: string) => void
}): JSX.Element {
  const { t, tn } = useI18n()
  const { tone, glyph, labelKey } = agentTone(agent.type)
  const running = agent.status === 'running'
  const stopped = agent.status === 'stopped'
  const failed = agent.status === 'error' || agent.status === 'denied'
  const isBackground = agent.isBackground === true || agent.info?.async === true
  const stateText = running
    ? t('agentState.running')
    : stopped
      ? t('agentState.stopped')
      : failed
        ? agent.status === 'denied'
          ? t('agentState.denied')
          : t('agentState.failed')
        : t('agentState.done')
  const stateTone = running
    ? 'is-live'
    : stopped
      ? 'is-stopped'
      : failed
        ? 'is-bad'
        : 'is-done'
  const cardTone = running
    ? 'is-run'
    : stopped
      ? 'is-stopped'
      : failed
        ? 'is-bad'
        : 'is-done'
  const stateIcon = running ? (
    <i className="dot" />
  ) : failed ? (
    <IconAlert width={9} height={9} />
  ) : stopped ? (
    <IconStopSquare width={9} height={9} />
  ) : (
    <IconCheck width={9} height={9} />
  )

  const ms = agent.ms ?? (running && agent.startedAt ? now - agent.startedAt : undefined)
  const stats = agentStats(agent, tn)
  /** 失败/停止时优先给原因；摘要仍然留在 result 里 */
  const detail =
    failed || stopped
      ? agent.error ||
        (agent.errorCode
          ? t(agent.errorCode === 'denied' ? 'agentError.denied' : 'agentError.failed')
          : agent.result)
      : agent.result
  /** 结果和描述一模一样时只显示一次 —— 后台任务尤其容易这样 */
  const showDetail =
    !!detail && (failed || stopped ? true : norm(detail) !== norm(agent.description))
  /** 没有 activity 时把 description 当作当前活动，避免旧版两行说同一件事 */
  const liveText =
    agent.activity ||
    agent.description ||
    (agent.lastToolName
      ? t('run.callingTool', { tool: agent.lastToolName })
      : t('runpanel.agentRunning'))
  const toolChip = agent.activity ? agent.lastToolName : undefined
  /*
   * 跑起来之后 activity 才是「现在做什么」，description 退回任务说明。
   * 两者相同就不重复；跑完/失败时 description 仍然要留着。
   */
  const showDesc =
    !!agent.description &&
    (running
      ? !!agent.activity && norm(agent.description) !== norm(agent.activity)
      : norm(agent.description) !== norm(detail ?? ''))
  const canOpenReport = !running && !!(agent.report || agent.error || agent.result)
  const hasFoot = stats.visible.length > 0 || ms != null || canOpenReport

  return (
    <div className={`ragent ${cardTone}`}>
      <div className="ragent__top">
        <span className={`ragent__glyph is-${tone}`}>{glyph}</span>
        <div className="ragent__id">
          <div className="ragent__name">
            {agent.type}
            <span>{t(labelKey)}</span>
            {isBackground && <em className="ragent__bg">{t('runpanel.background')}</em>}
          </div>
          {showDesc && (
            <div className="ragent__desc" title={agent.description}>
              {agent.description}
            </div>
          )}
        </div>
        <span className={`ragent__state ${stateTone}`}>
          {stateIcon}
          {stateText}
        </span>
      </div>

      {running ? (
        <div
          className="ragent__live"
          title={agent.activity || agent.description || undefined}
        >
          <span className="ragent__spinner" />
          {toolChip && <span className="ragent__tool">{toolChip}</span>}
          <span className="ragent__live-text">{liveText}</span>
        </div>
      ) : failed ? (
        showDetail && (
          <div className="ragent__error">
            <IconAlert width={11} height={11} />
            <span>{detail}</span>
          </div>
        )
      ) : (
        showDetail && (
          <div className={`ragent__result ${stopped ? 'is-muted' : ''}`}>{detail}</div>
        )
      )}

      {hasFoot && (
        <div className={`ragent__foot ${canOpenReport ? 'has-report' : ''}`}>
          {stats.visible.length > 0 && (
            <div className="ragent__meta" title={stats.title}>
              {stats.visible.map((s) => (
                <span key={s}>{s}</span>
              ))}
            </div>
          )}
          {ms != null && <span className="ragent__time">{fmtClock(ms)}</span>}
          {canOpenReport && (
            <button
              className="ragent__open"
              data-report-id={agent.id}
              onClick={() => onOpenReport(agent.id)}
            >
              {t('runpanel.viewReport')}
              <IconArrowRight width={10} height={10} />
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/* ── 后台任务（后台 shell / workflow） ─────────────────────── */

function BackgroundCard({
  task,
  now
}: {
  task: RunBackgroundTask
  now: number
}): JSX.Element {
  const { t } = useI18n()
  const running = task.status === 'running'
  const stopped = task.status === 'stopped'
  const failed = task.status === 'error'
  const unknown = task.status === 'unknown'
  const stateText = running
    ? t('agentState.running')
    : stopped
      ? t('agentState.stopped')
      : unknown
        ? t('agentState.unknown')
        : failed
          ? t('agentState.failed')
          : t('agentState.done')
  const stateTone = running
    ? 'is-live'
    : stopped || unknown
      ? 'is-stopped'
      : failed
        ? 'is-bad'
        : 'is-done'
  const cardTone = running
    ? 'is-run'
    : failed
      ? 'is-bad'
      : stopped || unknown
        ? 'is-stopped'
        : 'is-done'
  const stateIcon = running ? (
    <i className="dot" />
  ) : failed ? (
    <IconAlert width={9} height={9} />
  ) : stopped ? (
    <IconStopSquare width={9} height={9} />
  ) : unknown ? (
    <IconInfo width={9} height={9} />
  ) : (
    <IconCheck width={9} height={9} />
  )

  const ms =
    task.ms ?? (running && task.startedAt ? now - task.startedAt : undefined)
  const description = task.description || t('runpanel.backgroundTask')
  const tip = task.outputFile ? `${description}\n${task.outputFile}` : description
  const detail = failed || stopped ? task.error || task.result : task.result
  // 结果和描述一模一样时只显示一次 —— 后台命令尤其容易这样
  const showDetail =
    !!detail && (failed || stopped || unknown ? true : norm(detail) !== norm(description))
  /** 没有 activity 时把命令本身当作活动行，卡片顶部不再重复一遍 */
  const liveText = task.activity || task.description || t('runpanel.backgroundRunning')
  const showDesc =
    !!task.description &&
    (running
      ? !!task.activity && norm(task.description) !== norm(task.activity)
      : norm(task.description) !== norm(detail ?? ''))

  return (
    <div className={`ragent ${cardTone}`}>
      <div className="ragent__top">
        <span className="ragent__glyph is-shell">
          <IconTerminal width={14} height={14} />
        </span>
        <div className="ragent__id">
          <div className="ragent__name">{t('runpanel.backgroundTask')}</div>
          {showDesc && (
            <div className="ragent__desc is-mono" title={tip}>
              {task.description}
            </div>
          )}
        </div>
        <span className={`ragent__state ${stateTone}`}>
          {stateIcon}
          {stateText}
        </span>
      </div>

      {running ? (
        <div className="ragent__live" title={tip}>
          <span className="ragent__spinner" />
          <span className="ragent__live-text">{liveText}</span>
        </div>
      ) : failed ? (
        !!detail && (
          <div className="ragent__error">
            <IconAlert width={11} height={11} />
            <span>{detail}</span>
          </div>
        )
      ) : (
        showDetail && (
          <div className={`ragent__result ${stopped || unknown ? 'is-muted' : ''}`}>
            {detail}
          </div>
        )
      )}

      {ms != null && (
        <div className="ragent__foot">
          <span className="ragent__time">{fmtClock(ms)}</span>
        </div>
      )}
    </div>
  )
}

function agentStats(
  agent: RunAgent,
  tn: (key: MessageKey, count: number) => string
): { visible: string[]; title?: string } {
  const s = agent.info?.toolStats
  const detailed: string[] = []
  if (s) {
    if (s.readCount) detailed.push(tn('agentStats.reads', s.readCount))
    if (s.searchCount) detailed.push(tn('agentStats.searches', s.searchCount))
    if (s.bashCount) detailed.push(tn('agentStats.commands', s.bashCount))
    if (s.editFileCount) detailed.push(tn('agentStats.edits', s.editFileCount))
  }
  const visible: string[] = []
  if (agent.info?.toolUseCount) {
    visible.push(tn('count.tools', agent.info.toolUseCount))
  } else if (detailed.length > 0) {
    visible.push(detailed[0])
  }
  if (agent.info?.totalTokens) visible.push(`${fmtTokens(agent.info.totalTokens)} tok`)
  return {
    visible,
    // 细分统计收进 tooltip，卡片底部只留「多少次工具 · tok」，窄面板不挤
    title: detailed.length > 1 ? detailed.join(' · ') : undefined
  }
}

/* ── 工具 ─────────────────────────────────────────────────── */

/** 面板在跑的时候每秒跳一次；停了就不再重建定时器 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [active])
  return now
}

/** 任务清单只在运行状态变化时更新，不跟着正文流式重渲染 */
export const RunPanel = memo(RunPanelImpl)
