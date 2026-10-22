import { useEffect, useState } from 'react'
import type { RunAgent, RunState, RunTask } from '../run-state'
import { fmtClock, fmtTokens } from './format'
import { IconChevronRight } from './Icons'
import { AgentReportModal } from './AgentReportModal'

/**
 * 输出区右侧的「执行台」。
 *
 * 只做一件事：把这一轮的任务清单和子代理摊开。转写区仍然是对话本身，
 * 这里回答的是「它现在做到哪一步了、有没有在跑别的代理」。
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

export function RunPanel({
  run,
  live,
  running,
  onInterrupt,
  onCollapse,
  onOpenTrace
}: Props): JSX.Element | null {
  const now = useNow(live)
  const [reportId, setReportId] = useState<string | null>(null)

  if (run.tasks.length === 0 && run.agents.length === 0) return null

  const done = run.tasks.filter((t) => t.status === 'completed').length
  const active = run.tasks.filter((t) => t.status === 'in_progress').length
  const agentsDone = run.agents.filter((a) => a.status !== 'running').length
  const agentsActive = run.agents.length - agentsDone
  /*
   * 只在进行中显示计时。结束后不拿「主对话这一轮」的时长冒充整轮耗时 ——
   * 后台子代理可能比主对话多跑几分钟，那个数字会和卡片上的耗时打架。
   */
  const elapsed = live ? (run.startedAt ? now - run.startedAt : undefined) : undefined
  /** 卡片的 id 可能比 agents 活得久（换轮次），取不到就自动关掉弹窗 */
  const reportAgent = reportId ? run.agents.find((a) => a.id === reportId) ?? null : null

  const bits: string[] = []
  if (run.tasks.length) {
    bits.push(`${done} 完成`)
    if (active) bits.push(`${active} 进行中`)
  }
  if (run.agents.length) {
    bits.push(`子代理 ${agentsDone}/${run.agents.length}`)
    if (agentsActive) bits.push(`${agentsActive} 运行中`)
  }

  return (
    <>
    <aside className="runpanel">
      <div className="runpanel__head">
        <div className="runpanel__top">
          <span className="runpanel__title">执行台</span>
          <span className={`runpanel__state ${live ? 'is-live' : 'is-done'}`}>
            {live ? <i /> : <b>✓</b>}
            {elapsed != null ? fmtClock(elapsed) : live ? '运行中' : '已完成'}
          </span>
          {running && (
            <button
              className="runpanel__stop"
              onClick={onInterrupt}
              title="中断本轮；已在后台运行的子代理可能不会随之停止"
            >
              ■ 中断
            </button>
          )}
          <button className="runpanel__collapse" onClick={onCollapse} title="收起执行台">
            <IconChevronRight width={14} height={14} />
          </button>
        </div>
        {bits.length > 0 && <div className="runpanel__sub">{bits.join(' · ')}</div>}

        {run.tasks.length > 0 && (
          <div className="runpanel__strip" title={`${done} / ${run.tasks.length} 个任务完成`}>
            {run.tasks.map((t) => (
              <i
                key={t.id}
                className={
                  t.status === 'completed' ? 'is-done' : t.status === 'in_progress' ? 'is-run' : ''
                }
              />
            ))}
            <span>
              {done}/{run.tasks.length}
            </span>
          </div>
        )}
      </div>

      {/*
       * 任务和子代理各自一个滚动容器 —— 两边都长的时候，
       * 滚任务不会把子代理带着走，反之亦然。分区标题留在滚动区外面，
       * 滚动的时候还能看见列表是什么。
       */}
      <div className="runpanel__body">
        {run.tasks.length > 0 && (
          <section className="rsec">
            <div className="rsec__h">
              <span className="rsec__t">任务</span>
              <span className="rsec__n">
                {done} / {run.tasks.length}
              </span>
            </div>
            <div className="rsec__list">
              {run.tasks.map((t) => (
                <TaskRow key={t.id} task={t} now={now} live={live} />
              ))}
            </div>
          </section>
        )}

        {run.agents.length > 0 && (
          <section className="rsec">
            <div className="rsec__h">
              <span className="rsec__t">子代理</span>
              <span className="rsec__n">
                {agentsDone} / {run.agents.length}
              </span>
            </div>
            <div className="rsec__list">
              {run.agents.map((a) => (
                <AgentCard key={a.id} agent={a} now={now} onOpenReport={setReportId} />
              ))}
            </div>
          </section>
        )}
      </div>

      <div className="runpanel__foot">
        <span>{run.steps} 步</span>
        {run.added > 0 || run.removed > 0 ? (
          <>
            <span>·</span>
            <span className="runpanel__diff">
              {run.added > 0 && <b className="is-add">+{run.added}</b>}
              {run.removed > 0 && <b className="is-del">−{run.removed}</b>}
            </span>
          </>
        ) : null}
        <button className="runpanel__link" onClick={onOpenTrace}>
          查看轨迹 →
        </button>
      </div>
    </aside>
    {reportAgent && (
      <AgentReportModal agent={reportAgent} onClose={() => setReportId(null)} />
    )}
    </>
  )
}

/* ── 任务 ─────────────────────────────────────────────────── */

function TaskRow({ task, now, live }: { task: RunTask; now: number; live: boolean }): JSX.Element {
  const ms = taskMs(task, now, live)
  return (
    <div className={`rtask is-${task.status === 'in_progress' ? 'run' : task.status === 'completed' ? 'done' : 'todo'}`}>
      <span className="rtask__box">{task.status === 'completed' ? '✓' : ''}</span>
      <div className="rtask__main">
        <div className="rtask__text">{task.subject}</div>
        {task.status === 'in_progress' && (
          <div className="rtask__form">
            <i />
            {task.activeForm || '进行中'}
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

function agentTone(type: string): { tone: string; glyph: string; label: string } {
  const t = type.toLowerCase()
  if (t.includes('explore')) return { tone: 'explore', glyph: '✦', label: '代码库检索' }
  if (t.includes('plan')) return { tone: 'plan', glyph: '◇', label: '方案评估' }
  if (t.includes('general')) return { tone: 'general', glyph: '◈', label: '子代理' }
  return { tone: 'other', glyph: '◇', label: '子代理' }
}

function AgentCard({
  agent,
  now,
  onOpenReport
}: {
  agent: RunAgent
  now: number
  onOpenReport: (id: string) => void
}): JSX.Element {
  const { tone, glyph, label } = agentTone(agent.type)
  const running = agent.status === 'running'
  const stopped = agent.status === 'stopped'
  const failed = agent.status === 'error' || agent.status === 'denied'
  const isBackground = agent.isBackground === true || agent.info?.async === true
  const stateText = running
    ? '运行中'
    : stopped
      ? '已停止'
      : failed
        ? agent.status === 'denied'
          ? '已拒绝'
          : '失败'
        : '完成'
  const ms = agent.ms ?? (running && agent.startedAt ? now - agent.startedAt : undefined)
  const stats = agentStats(agent)
  /** 失败/停止时优先给原因；摘要仍然留在 result 里 */
  const detail = failed || stopped ? agent.error || agent.result : agent.result
  /** 结果和描述一模一样时只显示一次 —— 后台任务尤其容易这样 */
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()
  const showResult = !!detail && norm(detail) !== norm(agent.description)
  const canOpenReport = !running && !!(agent.report || agent.error || agent.result)

  return (
    <div
      className={`ragent is-${running ? 'run' : stopped ? 'stopped' : failed ? 'bad' : 'done'}`}
    >
      <div className="ragent__top">
        <span className={`ragent__glyph is-${tone}`}>{glyph}</span>
        <div className="ragent__id">
          <div className="ragent__name">
            {agent.type}
            <span>{label}</span>
            {isBackground && <em className="ragent__bg">后台</em>}
          </div>
          <div className="ragent__desc">{agent.description}</div>
        </div>
        <span
          className={`ragent__state ${
            running ? 'is-live' : stopped ? 'is-stopped' : failed ? 'is-bad' : 'is-done'
          }`}
        >
          {running ? <i /> : stopped ? '■' : failed ? '!' : '✓'} {stateText}
        </span>
      </div>

      {running ? (
        <div className="ragent__live" title={agent.activity}>
          <span className="ragent__spin">◌</span>
          {agent.activity || '子代理运行中，等待返回…'}
        </div>
      ) : (
        showResult && (
          <div className={`ragent__result ${failed ? 'is-bad' : ''}`}>{detail}</div>
        )
      )}

      {canOpenReport && (
        <button
          className="ragent__open"
          data-report-id={agent.id}
          onClick={() => onOpenReport(agent.id)}
        >
          查看完整报告 →
        </button>
      )}

      {(stats.length > 0 || ms != null) && (
        <div className="ragent__meta">
          {stats.map((s) => (
            <span key={s}>{s}</span>
          ))}
          {ms != null && <span className="tail">{fmtClock(ms)}</span>}
        </div>
      )}
    </div>
  )
}

function agentStats(agent: RunAgent): string[] {
  const s = agent.info?.toolStats
  const bits: string[] = []
  if (s) {
    if (s.readCount) bits.push(`${s.readCount} 次读取`)
    if (s.searchCount) bits.push(`${s.searchCount} 次搜索`)
    if (s.bashCount) bits.push(`${s.bashCount} 次命令`)
    if (s.editFileCount) bits.push(`${s.editFileCount} 次编辑`)
  }
  if (bits.length === 0 && agent.info?.toolUseCount) bits.push(`${agent.info.toolUseCount} 次工具`)
  if (agent.info?.totalTokens) bits.push(`${fmtTokens(agent.info.totalTokens)} tok`)
  return bits.slice(0, 3)
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
