import { useEffect, useState } from 'react'
import type { RunAgent, RunState, RunTask } from '../run-state'
import { fmtTokens } from './format'
import { IconChevronRight } from './Icons'

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
  onCollapse: () => void
  onOpenTrace: () => void
}

export function RunPanel({ run, live, onCollapse, onOpenTrace }: Props): JSX.Element | null {
  const now = useNow(live)

  if (run.tasks.length === 0 && run.agents.length === 0) return null

  const done = run.tasks.filter((t) => t.status === 'completed').length
  const active = run.tasks.filter((t) => t.status === 'in_progress').length
  /*
   * 只在进行中显示计时。结束后不拿「主对话这一轮」的时长冒充整轮耗时 ——
   * 后台子代理可能比主对话多跑几分钟，那个数字会和卡片上的耗时打架。
   */
  const elapsed = live ? (run.startedAt ? now - run.startedAt : undefined) : undefined

  const bits: string[] = []
  if (run.tasks.length) {
    bits.push(`${done} 完成`)
    if (active) bits.push(`${active} 进行中`)
  }
  if (run.agents.length) bits.push(`${run.agents.length} 个子代理`)

  return (
    <aside className="runpanel">
      <div className="runpanel__head">
        <div className="runpanel__top">
          <span className="runpanel__title">执行台</span>
          <span className={`runpanel__state ${live ? 'is-live' : 'is-done'}`}>
            {live ? <i /> : <b>✓</b>}
            {elapsed != null ? fmtClock(elapsed) : live ? '运行中' : '已完成'}
          </span>
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
              <span className="rsec__n">{run.agents.length}</span>
            </div>
            <div className="rsec__list">
              {run.agents.map((a) => (
                <AgentCard key={a.id} agent={a} now={now} />
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

function AgentCard({ agent, now }: { agent: RunAgent; now: number }): JSX.Element {
  const { tone, glyph, label } = agentTone(agent.type)
  const running = agent.status === 'running'
  const stopped = agent.status === 'stopped'
  const failed = agent.status === 'error' || agent.status === 'denied'
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
        agent.result && (
          <div className={`ragent__result ${failed ? 'is-bad' : ''}`}>{agent.result}</div>
        )
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

/** 毫秒 → 「01:12」；超过一小时给「1:02:03」 */
function fmtClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

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
