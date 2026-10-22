import { useState } from 'react'
import type { StoredSession } from '@shared/session'
import { cliDef, type CliId } from '@shared/settings'
import { relTime, type WorkspaceView } from '../useSessions'
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
  activeId: string | null
  onSelect: (s: StoredSession) => void
  /** 不传 cwd 就按「默认工作目录 / 上次打开的目录」开 */
  onNewSession: (cwd?: string) => void
  onCloseWorkspace: (cwd: string) => void
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
  activeId,
  onSelect,
  onNewSession,
  onCloseWorkspace,
  onPickWorkspace,
  onDeleteSession,
  onRefresh,
  onOpenSettings
}: SidebarProps): JSX.Element {
  return (
    <aside className="sidebar">
      <button className="sidebar__new" onClick={() => onNewSession()}>
        <IconPlus width={15} height={15} />
        <span>新会话</span>
      </button>

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
          <button className="iconbtn" title="排序">
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
            activeId={activeId}
            onSelect={onSelect}
            onNewSession={onNewSession}
            onCloseWorkspace={onCloseWorkspace}
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
  activeId,
  onSelect,
  onNewSession,
  onCloseWorkspace,
  onDeleteSession,
  onRefresh
}: {
  ws: WorkspaceView
  running: Set<string>
  activeId: string | null
  onSelect: (s: StoredSession) => void
  onNewSession: (cwd?: string) => void
  onCloseWorkspace: (cwd: string) => void
  onDeleteSession: (s: StoredSession) => void
  onRefresh: () => void
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const hidden = Math.max(0, ws.sessions.length - COLLAPSED_COUNT)
  const visible = expanded || hidden === 0 ? ws.sessions : ws.sessions.slice(0, COLLAPSED_COUNT)

  return (
    <div className="wsgroup">
      {/*
        两个按钮平时收着，鼠标移到这一行才浮出来 —— 侧栏只有 280px，
        常驻会把目录名挤掉一截。目录名被省略时靠 title 看全路径。
      */}
      <div className="wsgroup__head" title={ws.cwd}>
        <IconFolder width={15} height={15} className="wsgroup__icon" />
        <span className="wsgroup__name">{ws.name}</span>
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
          onSelect={() => {
            onSelect(s)
            onRefresh()
          }}
          onDelete={() => onDeleteSession(s)}
        />
      ))}

      {hidden > 0 && !expanded && (
        <button className="wsgroup__expand" onClick={() => setExpanded(true)}>
          展开其余 {hidden} 个会话
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
  onSelect,
  onDelete
}: {
  s: StoredSession
  active: boolean
  running: boolean
  onSelect: () => void
  onDelete: () => void
}): JSX.Element {
  return (
    <div className={`session ${active ? 'is-active' : ''}`}>
      <button
        className="session__main"
        onClick={onSelect}
        title={`${s.title}\n${s.cwd}\n${cliDef(s.cli).name}`}
      >
        <CliMark cli={s.cli} running={running} />
        <span className="session__title">{s.title}</span>
        {/*
          在跑的时候，右下角不再显示「刚刚」—— 那个数字只说明最后写入有多近，
          跟"现在还在不在干活"是两回事。换成状态字，跟左侧图标的跳动互相印证；
          动效被系统「减少动态效果」关掉时，这行字就是唯一的状态来源。
        */}
        <span className={`session__time ${running ? 'session__time--running' : ''}`}>
          {running ? '运行中' : relTime(s.updatedAt)}
        </span>
      </button>
      <button className="session__del" title="删除这条会话（不可恢复）" onClick={onDelete}>
        ×
      </button>
    </div>
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
