import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { StoredSession } from '@shared/session'
import { cliDef, type CliId } from '@shared/settings'
import { relTime, type SessionSort, type WorkspaceView } from '../useSessions'
import type { PendingApproval } from '../pending-approvals'
import {
  IconClaudeCode,
  IconClock,
  IconFolder,
  IconFolderPlus,
  IconGear,
  IconPlugin,
  IconPlus,
  IconOpenAI,
  IconSearch,
  IconSort
} from './Icons'

/** 折叠时露出几个会话，其余收进「展开其余 N 个会话」 */
const COLLAPSED_COUNT = 5

interface SidebarProps {
  workspaces: WorkspaceView[]
  loading: boolean
  /** 正在跑的会话（CLI 的 session id）—— 这些行的图标会跳 */
  running: Set<string>
  /**
   * 卡在审批上的后台会话（CLI 的 session id）。
   * 当前会话不在里面显示跑马灯 —— 它的审批面板就在主区里。
   */
  pending: ReadonlyMap<string, PendingApproval>
  /** 会话行排序：创建时间 / 最近活动 */
  sort: SessionSort
  onToggleSort: () => void
  activeId: string | null
  onSelect: (s: StoredSession) => void
  /** 不传 cwd 就按「默认工作目录 / 上次打开的目录」开 */
  onNewSession: (cwd?: string) => void
  onCloseWorkspace: (cwd: string) => void
  /** 打开该工作区的独立 IDE 窗口 */
  onOpenIde: (cwd: string) => void
  /** 弹系统目录选择器，挑一个新目录加进列表 */
  onPickWorkspace: () => void
  onDeleteSession: (s: StoredSession) => void
  onRefresh: () => void
  onOpenSettings: () => void
}

export function Sidebar({
  workspaces,
  loading,
  running,
  pending,
  sort,
  onToggleSort,
  activeId,
  onSelect,
  onNewSession,
  onCloseWorkspace,
  onOpenIde,
  onPickWorkspace,
  onDeleteSession,
  onRefresh,
  onOpenSettings
}: SidebarProps): JSX.Element {
  return (
    <aside className="sidebar">
      <nav className="sidebar__nav">
        <button className="navitem">
          <IconPlugin width={15} height={15} />
          <span>插件</span>
        </button>
        <button className="navitem">
          <IconClock width={15} height={15} />
          <span>自动化任务</span>
        </button>
      </nav>

      <div className="sidebar__section-head">
        <span className="sidebar__section-title">工作区</span>
        <div className="sidebar__section-tools">
          <button className="iconbtn" title="搜索">
            <IconSearch width={14} height={14} />
          </button>
          <button
            className="iconbtn"
            title={
              sort === 'created'
                ? '排序：创建时间（点击改为最近活动）'
                : '排序：最近活动（点击改为创建时间）'
            }
            onClick={onToggleSort}
          >
            <IconSort width={14} height={14} />
          </button>
          <button className="iconbtn" title="打开一个工作区（选目录）" onClick={onPickWorkspace}>
            <IconFolderPlus width={14} height={14} />
          </button>
        </div>
      </div>

      <div className="sidebar__scroll">
        {loading && <p className="sidebar__hint">正在读取会话…</p>}
        {!loading && workspaces.length === 0 && (
          <p className="sidebar__hint">
            还没有打开的工作区。
            <br />
            点右上角的文件夹图标选一个目录 —— 里面已有的会话会一起列出来。
          </p>
        )}
        {workspaces.map((ws) => (
          <WorkspaceGroup
            key={ws.cwd}
            ws={ws}
            running={running}
            pending={pending}
            activeId={activeId}
            onSelect={onSelect}
            onNewSession={onNewSession}
            onCloseWorkspace={onCloseWorkspace}
            onOpenIde={onOpenIde}
            onDeleteSession={onDeleteSession}
            onRefresh={onRefresh}
          />
        ))}
      </div>

      <button className="sidebar__settings" onClick={onOpenSettings}>
        <IconGear width={15} height={15} />
        <span>设置</span>
      </button>
    </aside>
  )
}

function WorkspaceGroup({
  ws,
  running,
  pending,
  activeId,
  onSelect,
  onNewSession,
  onCloseWorkspace,
  onOpenIde,
  onDeleteSession,
  onRefresh
}: {
  ws: WorkspaceView
  running: Set<string>
  pending: ReadonlyMap<string, PendingApproval>
  activeId: string | null
  onSelect: (s: StoredSession) => void
  onNewSession: (cwd?: string) => void
  onCloseWorkspace: (cwd: string) => void
  onOpenIde: (cwd: string) => void
  onDeleteSession: (s: StoredSession) => void
  onRefresh: () => void
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const hidden = Math.max(0, ws.sessions.length - COLLAPSED_COUNT)
  /**
   * 组里有会话卡在审批上时强制展开。
   *
   * 跑马灯只能救"看得见"的行：被「展开其余 N 个」收进去的那条，用户
   * 根本不知道它在等。审批一答复就恢复原来的折叠状态，不把这次
   * 强制展开写进 `expanded` —— 用户手动收起的选择要保留。
   */
  const groupPending = ws.sessions.reduce((n, s) => n + (pending.has(s.id) ? 1 : 0), 0)
  const forceOpen = groupPending > 0
  const visible =
    expanded || hidden === 0 || forceOpen
      ? ws.sessions
      : ws.sessions.slice(0, COLLAPSED_COUNT)

  return (
    <div className="wsgroup">
      {/* 两个按钮常驻；目录名被省略时靠 title 看全路径。 */}
      <div className="wsgroup__head" title={ws.cwd}>
        <button
          className="wsgroup__iconbtn"
          title="打开内置 IDE（独立窗口）"
          onClick={() => onOpenIde(ws.cwd)}
        >
          <IconFolder width={15} height={15} className="wsgroup__icon" />
        </button>
        <span className="wsgroup__name">{ws.name}</span>
        {groupPending > 0 && (
          <span
            className="wsgroup__pending"
            title={`${groupPending} 个会话卡在审批上`}
          />
        )}
        <span className="wsgroup__count">{ws.sessions.length}</span>
        <span className="wsgroup__acts">
          <button
            className="wsact"
            title={`在 ${ws.cwd} 下开新会话`}
            onClick={() => onNewSession(ws.cwd)}
          >
            <IconPlus width={13} height={13} />
          </button>
          <button
            className="wsact wsact--del"
            title="关闭工作区（只是从列表里收起来，不删文件）"
            onClick={() => onCloseWorkspace(ws.cwd)}
          >
            ×
          </button>
        </span>
      </div>

      {visible.map((s) => (
        <SessionRow
          key={s.id}
          s={s}
          active={s.id === activeId}
          running={running.has(s.id)}
          approval={pending.get(s.id)}
          onSelect={() => {
            onSelect(s)
            onRefresh()
          }}
          onDelete={() => onDeleteSession(s)}
        />
      ))}

      {hidden > 0 && !forceOpen && (
        <button className="wsgroup__expand" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收起会话' : `展开其余 ${hidden} 个会话`}
        </button>
      )}
    </div>
  )
}

/** 一条会话。删除按钮跟工作区那两个一样，hover 才浮出来 */
function SessionRow({
  s,
  active,
  running,
  approval,
  onSelect,
  onDelete
}: {
  s: StoredSession
  active: boolean
  running: boolean
  /** 这条会话正在等的审批；没有就是 undefined */
  approval?: PendingApproval
  onSelect: () => void
  onDelete: () => void
}): JSX.Element {
  /*
   * 当前会话不挂跑马灯：审批面板已经在主区，重复提醒是噪音。
   * 点开这一行后它立刻变成 active，提醒自然收起。
   */
  const waiting = approval !== undefined && !active
  const label = waiting ? (approval.kind === 'question' ? '待回答' : '待审批') : ''

  return (
    <div className={`session ${active ? 'is-active' : ''} ${waiting ? 'is-pending' : ''}`}>
      <button
        className="session__main"
        onClick={onSelect}
        title={`${s.title}\n${s.cwd}\n${cliDef(s.cli).name}${
          waiting ? `\n${label}：${approval.text}` : ''
        }`}
      >
        {/*
          等审批时进程还活着，但卡在用户这里 —— 不是"在干活"，
          别让图标继续跳，把注意力留给跑马灯。
        */}
        <CliMark cli={s.cli} running={running && !waiting} />
        {waiting ? (
          <PendingTitle text={`${label} · ${approval.text}`} />
        ) : (
          <span className="session__title">{s.title}</span>
        )}
        {waiting ? (
          <span className="session__pending-tag" title={`${label}：${approval.text}`}>
            <i />
            {label}
          </span>
        ) : (
          /*
            在跑的时候，右下角不再显示「刚刚」—— 那个数字只说明最后写入有多近，
            跟"现在还在不在干活"是两回事。换成状态字，跟左侧图标的跳动互相印证；
            动效被系统「减少动态效果」关掉时，这行字就是唯一的状态来源。
          */
          <span className={`session__time ${running ? 'session__time--running' : ''}`}>
            {running ? '运行中' : relTime(s.updatedAt)}
          </span>
        )}
      </button>
      <button className="session__del" title="删除这条会话（不可恢复）" onClick={onDelete}>
        ×
      </button>
    </div>
  )
}

/**
 * 待审批标题的跑马灯。
 *
 * 只有文本真的溢出才滚：短命令（`ls`）在百来像素的标题位里来回晃，
 * 比省略号更烦。测量放在 layout effect —— 先画一帧静止的、再突然开始，
 * 看起来像界面在抖。
 *
 * 时长按距离算（约 26px/s），长命令不会滚得飞快；每轮开头由 keyframes
 * 自带 9% 的停顿，够读完一遍。
 */
function PendingTitle({ text }: { text: string }): JSX.Element {
  const box = useRef<HTMLSpanElement>(null)
  const [scrolling, setScrolling] = useState(false)
  const [duration, setDuration] = useState(9)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = (): void => {
      // 量第一份文本，而不是容器的 scrollWidth —— 滚起来之后 track 里
      // 有两份文本，scrollWidth 会翻倍，时长就会算慢一倍。
      const track = el.firstElementChild as HTMLElement | null
      const item = track?.firstElementChild as HTMLElement | null
      const width = item?.offsetWidth ?? 0
      const over = width > el.clientWidth + 1
      setScrolling(over)
      // 一轮里真正在走的部分占 82%（首尾各停 9%）
      if (over) setDuration(Math.min(20, Math.max(6, (width + 36) / (26 * 0.82))))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text])

  return (
    <span className={`session__mq ${scrolling ? 'is-scrolling' : ''}`} ref={box}>
      <span
        className="session__mq-track"
        style={{ '--mq-dur': `${duration.toFixed(1)}s` } as CSSProperties}
      >
        <span className="session__mq-item">{text}</span>
        {scrolling && (
          <span className="session__mq-item" aria-hidden="true">
            {text}
          </span>
        )}
      </span>
    </span>
  )
}

/**
 * 会话来自哪个 CLI。
 *
 * 不只是装饰：会话身份是 (cli, cwd, id)，拿错的 CLI 去 --resume 找不到。
 * 图标是**真实品牌标记**（simple-icons 的 claudecode / openai），没有重绘。
 *
 * `running` 时它原地跳（见 shell.css 的 session-bounce）—— 这一行是不是在跑，
 * 只靠左侧那点底色（is-active）说不清楚：底色说的是"你现在看着哪条"，
 * 跟"哪条在干活"是两件事，后台子代理跑着的时候更要分得开。
 */
function CliMark({ cli, running }: { cli: CliId; running: boolean }): JSX.Element {
  return (
    <span
      className={`session__cli session__cli--${cli} ${running ? 'is-running' : ''}`}
      title={running ? `${cliDef(cli).name} · 运行中` : cliDef(cli).name}
    >
      {cli === 'claude' ? <IconClaudeCode /> : <IconOpenAI />}
    </span>
  )
}
