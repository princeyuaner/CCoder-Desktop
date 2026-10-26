import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import {
  sessionMetaKey,
  type SessionMeta,
  type SessionMetaMap,
  type StoredSession
} from '@shared/session'
import { cliDef, type CliId } from '@shared/settings'
import { formatRelativeTime } from '@shared/i18n'
import { useI18n, type I18nApi } from '../i18n'
import { metaOf } from '../useSessionMeta'
import { cwdKey } from '@shared/path'
import type { SessionSort, WorkspaceView } from '../useSessions'
import type { PendingApproval } from '../pending-approvals'
import {
  IconArchive,
  IconBranch,
  IconClaudeCode,
  IconClock,
  IconDeepSeek,
  IconFolder,
  IconFolderPlus,
  IconGear,
  IconMore,
  IconPencil,
  IconPin,
  IconPlugin,
  IconPlus,
  IconOpenAI,
  IconSearch,
  IconSort
} from './Icons'

/** 折叠时露出几个会话，其余收进「展开其余 N 个会话」 */
const COLLAPSED_COUNT = 5

/** 把待审批请求拼成跑马灯 / tooltip 里的一句话（按当前语言） */
function describeApproval(approval: PendingApproval, i18n: I18nApi): string {
  const { t, text } = i18n
  if (approval.kind === 'question') {
    return approval.text || t('permission.questionFallback')
  }
  const what = approval.command
    ? t('permission.allowRun', { command: approval.command })
    : approval.title
      ? t('permission.allowTitle', { title: text(approval.title) })
      : t('permission.allowCommand')
  return approval.danger ? `${t('permission.dangerPrefix')} · ${what}` : what
}

interface SidebarProps {
  workspaces: WorkspaceView[]
  loading: boolean
  /** 正在跑的会话（CLI 的 session id）—— 这些行的图标会跳 */
  running: Set<string>
  /**
   * 刚跑完一轮、还没被打开看过的会话（CLI 的 session id）。
   * 点开这一行后标记会清掉，所以「已完成」不是常驻状态。
   */
  completed: ReadonlySet<string>
  /**
   * 卡在审批上的后台会话（CLI 的 session id）。
   * 当前会话不在里面显示跑马灯 —— 它的审批面板就在主区里。
   */
  pending: ReadonlyMap<string, PendingApproval>
  /** 会话行排序：创建时间 / 最近活动 */
  sort: SessionSort
  onToggleSort: () => void
  activeId: string | null
  /**
   * cwd → 工作树分支。键只在 linked worktree 的目录上出现；
   * 用来给会话行加分支标识、统计组头的工作树会话数。
   */
  worktreeBranches: Record<string, string>
  onSelect: (s: StoredSession) => void
  /** 打开「新建会话」弹窗，在这里选分支 / 工作树 */
  onRequestNewSession: (cwd: string) => void
  onCloseWorkspace: (cwd: string) => void
  /** 打开该工作区的独立 IDE 窗口 */
  onOpenIde: (cwd: string) => void
  /** 弹系统目录选择器，挑一个新目录加进列表 */
  onPickWorkspace: () => void
  onDeleteSession: (s: StoredSession) => void
  onRefresh: () => void
  onOpenSettings: () => void
  /** 打开跨会话搜索 */
  onOpenSearch: () => void
  /** 本地元数据：重命名 / 置顶 / 归档 */
  meta: SessionMetaMap
  onUpdateMeta: (s: StoredSession, patch: SessionMeta) => void | Promise<boolean>
  /** 是否显示已归档会话 */
  showArchived: boolean
  /** 当前打开的工作区里有多少条已归档会话 */
  archivedCount: number
  onToggleArchived: () => void
}

interface MenuState {
  s: StoredSession
  x: number
  y: number
}

export function Sidebar({
  workspaces,
  loading,
  running,
  completed,
  pending,
  sort,
  onToggleSort,
  activeId,
  worktreeBranches,
  onSelect,
  onRequestNewSession,
  onCloseWorkspace,
  onOpenIde,
  onPickWorkspace,
  onDeleteSession,
  onRefresh,
  onOpenSettings,
  onOpenSearch,
  meta,
  onUpdateMeta,
  showArchived,
  archivedCount,
  onToggleArchived
}: SidebarProps): JSX.Element {
  const { t } = useI18n()
  /** 搜索图标的 tooltip 带上快捷键；侧栏这排按钮平时是隐藏的 */
  const searchShortcut = window.api?.platform === 'darwin' ? '⌘K' : 'Ctrl+K'
  /** 正在哪一行上打开操作菜单；null = 没开 */
  const [menu, setMenu] = useState<MenuState | null>(null)
  /** 正在内联重命名的会话键；同一时间只允许一行 */
  const [renamingKey, setRenamingKey] = useState<string | null>(null)

  const openMenu = (s: StoredSession, el: HTMLElement): void => {
    const r = el.getBoundingClientRect()
    setMenu({ s, x: r.left, y: r.bottom + 5 })
  }

  const startRename = (s: StoredSession): void => {
    setMenu(null)
    setRenamingKey(sessionMetaKey(s.cli, s.cwd, s.id))
  }

  const commitRename = (s: StoredSession, value: string): void => {
    setRenamingKey(null)
    // 空串在主进程里表示"恢复 CLI 原标题"，不是把标题删成空白
    void onUpdateMeta(s, { title: value })
  }

  const togglePin = (s: StoredSession): void => {
    setMenu(null)
    void onUpdateMeta(s, { pinned: !metaOf(s, meta).pinned })
  }

  const toggleArchive = (s: StoredSession): void => {
    setMenu(null)
    void onUpdateMeta(s, { archived: !metaOf(s, meta).archived })
  }

  return (
    <aside className="sidebar">
      <nav className="sidebar__nav">
        <button className="navitem">
          <IconPlugin width={15} height={15} />
          <span>{t('nav.plugins')}</span>
        </button>
        <button className="navitem">
          <IconClock width={15} height={15} />
          <span>{t('nav.automation')}</span>
        </button>
      </nav>

      <div className="sidebar__section-head">
        <span className="sidebar__section-title">{t('sidebar.workspace')}</span>
        <div className="sidebar__section-tools">
          <button
            className="iconbtn"
            title={`${t('sidebar.search')} (${searchShortcut})`}
            onClick={onOpenSearch}
          >
            <IconSearch width={14} height={14} />
          </button>
          <button
            className="iconbtn"
            title={sort === 'created' ? t('sidebar.sortCreated') : t('sidebar.sortActive')}
            onClick={onToggleSort}
          >
            <IconSort width={14} height={14} />
          </button>
          <button
            className="iconbtn"
            title={t('sidebar.pickWorkspace')}
            onClick={onPickWorkspace}
          >
            <IconFolderPlus width={14} height={14} />
          </button>
        </div>
      </div>

      <div className="sidebar__scroll">
        {loading && <p className="sidebar__hint">{t('sidebar.loading')}</p>}
        {!loading && workspaces.length === 0 && (
          <p className="sidebar__hint">
            {t('sidebar.empty')}
            <br />
            {t('sidebar.emptyHint')}
          </p>
        )}
        {workspaces.map((ws) => (
          <WorkspaceGroup
            key={ws.cwd}
            ws={ws}
            running={running}
            completed={completed}
            pending={pending}
            activeId={activeId}
            worktreeBranches={worktreeBranches}
            meta={meta}
            renamingKey={renamingKey}
            onSelect={onSelect}
            onRequestNewSession={onRequestNewSession}
            onCloseWorkspace={onCloseWorkspace}
            onOpenIde={onOpenIde}
            onDeleteSession={onDeleteSession}
            onRefresh={onRefresh}
            onOpenMenu={openMenu}
            onCommitRename={commitRename}
            onCancelRename={() => setRenamingKey(null)}
          />
        ))}
      </div>

      {archivedCount > 0 && (
        <button
          className={`sidebar__archived ${showArchived ? 'is-on' : ''}`}
          onClick={onToggleArchived}
          title={showArchived ? t('sidebar.hideArchived') : t('sidebar.showArchived')}
          aria-pressed={showArchived}
        >
          <IconArchive width={15} height={15} />
          <span>{showArchived ? t('sidebar.hideArchived') : t('sidebar.showArchived')}</span>
          <span className="sidebar__archived-count">{archivedCount}</span>
        </button>
      )}

      <button className="sidebar__settings" onClick={onOpenSettings}>
        <IconGear width={15} height={15} />
        <span>{t('sidebar.settings')}</span>
      </button>

      {menu && (
        <SessionMenu
          x={menu.x}
          y={menu.y}
          session={menu.s}
          meta={metaOf(menu.s, meta)}
          onRename={() => startRename(menu.s)}
          onTogglePin={() => togglePin(menu.s)}
          onToggleArchive={() => toggleArchive(menu.s)}
          onDelete={() => {
            setMenu(null)
            onDeleteSession(menu.s)
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </aside>
  )
}

function WorkspaceGroup({
  ws,
  running,
  completed,
  pending,
  activeId,
  worktreeBranches,
  meta,
  renamingKey,
  onSelect,
  onRequestNewSession,
  onCloseWorkspace,
  onOpenIde,
  onDeleteSession,
  onRefresh,
  onOpenMenu,
  onCommitRename,
  onCancelRename
}: {
  ws: WorkspaceView
  running: Set<string>
  completed: ReadonlySet<string>
  pending: ReadonlyMap<string, PendingApproval>
  activeId: string | null
  worktreeBranches: Record<string, string>
  meta: SessionMetaMap
  renamingKey: string | null
  onSelect: (s: StoredSession) => void
  onRequestNewSession: (cwd: string) => void
  onCloseWorkspace: (cwd: string) => void
  onOpenIde: (cwd: string) => void
  onDeleteSession: (s: StoredSession) => void
  onRefresh: () => void
  onOpenMenu: (s: StoredSession, el: HTMLElement) => void
  onCommitRename: (s: StoredSession, value: string) => void
  onCancelRename: () => void
}): JSX.Element {
  const { t, tn } = useI18n()
  const [expanded, setExpanded] = useState(false)
  /** 只看 linked worktree 里的会话 */
  const [onlyWorktree, setOnlyWorktree] = useState(false)

  const worktreeSessions = ws.sessions.filter(
    (s) => worktreeBranches[cwdKey(s.cwd)] !== undefined
  )
  const worktreeCount = worktreeSessions.length
  const filtering = onlyWorktree && worktreeCount > 0
  const pool = filtering ? worktreeSessions : ws.sessions
  const hidden = Math.max(0, pool.length - COLLAPSED_COUNT)

  /**
   * 组里有会话卡在审批上时强制展开。
   *
   * 跑马灯只能救"看得见"的行：被「展开其余 N 个」收进去的那条，用户
   * 根本不知道它在等。审批一答复就恢复原来的折叠状态，不把这次
   * 强制展开写进 `expanded` —— 用户手动收起的选择要保留。
   */
  const groupPending = ws.sessions.reduce((n, s) => n + (pending.has(s.id) ? 1 : 0), 0)
  const poolPending = pool.reduce((n, s) => n + (pending.has(s.id) ? 1 : 0), 0)
  const forceOpen = poolPending > 0
  const visible =
    expanded || hidden === 0 || forceOpen ? pool : pool.slice(0, COLLAPSED_COUNT)

  // 工作树都关掉后别把筛选状态留着，下次再出现工作树时会莫名其妙只剩几行
  useEffect(() => {
    if (onlyWorktree && worktreeCount === 0) setOnlyWorktree(false)
  }, [onlyWorktree, worktreeCount])

  return (
    <div className="wsgroup">
      {/* 两个按钮常驻；目录名被省略时靠 title 看全路径。 */}
      <div className="wsgroup__head" title={ws.cwd}>
        <button
          className="wsgroup__iconbtn"
          title={t('sidebar.openIde')}
          onClick={() => onOpenIde(ws.cwd)}
        >
          <IconFolder width={15} height={15} className="wsgroup__icon" />
        </button>
        <span className="wsgroup__name">{ws.name}</span>
        {groupPending > 0 && (
          <span
            className="wsgroup__pending"
            title={tn('sidebar.pendingCount', groupPending)}
          />
        )}
        <span className="wsgroup__count">{ws.sessions.length}</span>
        {worktreeCount > 0 && (
          <button
            className={`wsgroup__wt ${filtering ? 'is-on' : ''}`}
            title={`${tn('sidebar.worktreeSessions', worktreeCount)} · ${t(
              'sidebar.onlyWorktrees'
            )}`}
            aria-pressed={filtering}
            onClick={() => setOnlyWorktree((v) => !v)}
          >
            <IconBranch width={10} height={10} />
            {worktreeCount}
          </button>
        )}
        <span className="wsgroup__acts">
          <button
            className="wsact"
            title={t('sidebar.newSessionHere', { cwd: ws.cwd })}
            onClick={() => onRequestNewSession(ws.cwd)}
          >
            <IconPlus width={13} height={13} />
          </button>
          <button
            className="wsact wsact--del"
            title={t('sidebar.closeWorkspace')}
            onClick={() => onCloseWorkspace(ws.cwd)}
          >
            ×
          </button>
        </span>
      </div>

      {filtering && (
        <div className="wsgroup__filter">
          <IconBranch width={10} height={10} />
          <span>
            {t('sidebar.onlyWorktrees')} <b>{worktreeCount}</b>
          </span>
          <button
            className="wsgroup__filter-clear"
            onClick={() => setOnlyWorktree(false)}
          >
            {t('sidebar.showAllSessions')} ×
          </button>
        </div>
      )}

      {visible.map((s) => {
        const key = sessionMetaKey(s.cli, s.cwd, s.id)
        return (
          <SessionRow
            key={key}
            s={s}
            meta={metaOf(s, meta)}
            branch={worktreeBranches[cwdKey(s.cwd)] ?? ''}
            active={s.id === activeId}
            running={running.has(s.id)}
            done={completed.has(s.id)}
            approval={pending.get(s.id)}
            renaming={renamingKey === key}
            onSelect={() => {
              onSelect(s)
              onRefresh()
            }}
            onDelete={() => onDeleteSession(s)}
            onOpenMenu={(el) => onOpenMenu(s, el)}
            onCommitRename={(value) => onCommitRename(s, value)}
            onCancelRename={onCancelRename}
          />
        )
      })}

      {hidden > 0 && !forceOpen && (
        <button className="wsgroup__expand" onClick={() => setExpanded((v) => !v)}>
          {expanded ? t('sidebar.collapseSessions') : tn('sidebar.expandSessions', hidden)}
        </button>
      )}
    </div>
  )
}

/** 一条会话。操作按钮跟工作区那两个一样，hover 才浮出来 */
function SessionRow({
  s,
  meta,
  branch,
  active,
  running,
  done,
  approval,
  renaming,
  onSelect,
  onDelete,
  onOpenMenu,
  onCommitRename,
  onCancelRename
}: {
  s: StoredSession
  meta: SessionMeta
  /** 非空 = 这条会话跑在 linked worktree 里，显示在标题下方 */
  branch: string
  active: boolean
  running: boolean
  /** 刚跑完、用户还没点开看过 */
  done: boolean
  /** 这条会话正在等的审批；没有就是 undefined */
  approval?: PendingApproval
  /** 正在内联重命名 */
  renaming: boolean
  onSelect: () => void
  onDelete: () => void
  onOpenMenu: (el: HTMLElement) => void
  onCommitRename: (value: string) => void
  onCancelRename: () => void
}): JSX.Element {
  const i18n = useI18n()
  const { t, locale } = i18n
  /*
   * 当前会话不挂跑马灯：审批面板已经在主区，重复提醒是噪音。
   * 点开这一行后它立刻变成 active，提醒自然收起。
   */
  const waiting = approval !== undefined && !active
  const label = waiting
    ? approval.kind === 'question'
      ? t('sidebar.pendingQuestion')
      : t('sidebar.pendingApproval')
    : ''
  const detail = waiting ? describeApproval(approval, i18n) : ''
  const title = meta.title || s.title
  const pinned = meta.pinned === true
  const archived = meta.archived === true

  /*
   * 重命名时整行不再是按钮：把 input 嵌在 button 里是非法结构，点击输入框
   * 还会触发选中会话，光标根本站不住。
   */
  if (renaming) {
    return (
      <div
        className={`session is-renaming ${active ? 'is-active' : ''} ${
          archived ? 'is-archived' : ''
        }`}
      >
        <div className="session__main session__main--rename">
          <CliMark cli={s.cli} running={running && !waiting} />
          <RenameInput initial={title} onCommit={onCommitRename} onCancel={onCancelRename} />
        </div>
      </div>
    )
  }

  return (
    <div
      className={`session ${active ? 'is-active' : ''} ${waiting ? 'is-pending' : ''} ${
        archived ? 'is-archived' : ''
      }`}
    >
      <button
        className="session__main"
        onClick={onSelect}
        title={`${title}\n${s.cwd}\n${cliDef(s.cli).name}${
          branch ? `\n${branch}` : ''
        }${waiting ? `\n${label}: ${detail}` : ''}`}
      >
        {/*
          等审批时进程还活着，但卡在用户这里 —— 不是"在干活"，
          别让图标继续跳，把注意力留给跑马灯。
        */}
        <CliMark cli={s.cli} running={running && !waiting} />
        <span className="session__text">
          <span className="session__line1">
            {pinned && (
              <IconPin
                className="session__pin"
                width={11}
                height={11}
                aria-label={t('sidebar.pinned')}
              />
            )}
            {waiting ? (
              <PendingTitle text={`${label} · ${detail}`} />
            ) : (
              <span className="session__title">{title}</span>
            )}
            {archived && !waiting && (
              <span className="session__archived-tag">{t('sidebar.archived')}</span>
            )}
            {waiting ? (
              <span className="session__pending-tag" title={`${label}: ${detail}`}>
                <i />
                {label}
              </span>
            ) : (
              /*
                在跑的时候，右下角不再显示「刚刚」—— 那个数字只说明最后写入有多近，
                跟"现在还在不在干活"是两回事。换成状态字，跟左侧图标的跳动互相印证；
                动效被系统「减少动态效果」关掉时，这行字就是唯一的状态来源。
                跑完一轮但还没被点开时写「已完成」，点开这一行就清掉。
              */
              <span
                className={`session__time ${
                  running ? 'session__time--running' : done ? 'session__time--done' : ''
                }`}
              >
                {running
                  ? t('sidebar.running')
                  : done
                    ? t('sidebar.done')
                    : formatRelativeTime(s.updatedAt, locale, 'short')}
              </span>
            )}
          </span>
          {branch && (
            <span className="session__branch" title={`${branch}\n${s.cwd}`}>
              <IconBranch width={10} height={10} />
              <span className="session__branch-name">{branch}</span>
              <span className="session__branch-tag">{t('sidebar.worktreeTag')}</span>
            </span>
          )}
        </span>
      </button>
      <button
        className="session__more"
        title={t('sidebar.sessionActions')}
        aria-haspopup="menu"
        onClick={(e) => onOpenMenu(e.currentTarget)}
      >
        <IconMore width={14} height={14} />
      </button>
      <button className="session__del" title={t('sidebar.deleteSession')} onClick={onDelete}>
        ×
      </button>
    </div>
  )
}

/**
 * 内联重命名。
 *
 * Enter / 失焦提交，Esc 取消。用 done ref 兜住"Esc 之后 input 卸载又触发
 * blur"这一下，否则取消会变成提交空值（等于恢复原标题，看起来像没改）。
 */
function RenameInput({
  initial,
  onCommit,
  onCancel
}: {
  initial: string
  onCommit: (value: string) => void
  onCancel: () => void
}): JSX.Element {
  const { t } = useI18n()
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const cancelled = useRef(false)

  const finish = (commit: boolean): void => {
    if (done.current) return
    done.current = true
    if (commit) onCommit(value.trim())
    else onCancel()
  }

  return (
    <input
      className="session__rename"
      value={value}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          cancelled.current = true
          finish(false)
        }
      }}
      onBlur={() => {
        if (!cancelled.current) finish(true)
      }}
      aria-label={t('sidebar.rename')}
    />
  )
}

/**
 * 会话操作菜单。
 *
 * 用 fixed 定位而不是挂在行内：侧栏滚动容器会裁掉溢出的绝对定位元素，
 * 靠近底部的行根本看不到菜单。位置在打开时按视口夹一次。
 */
function SessionMenu({
  x,
  y,
  session,
  meta,
  onRename,
  onTogglePin,
  onToggleArchive,
  onDelete,
  onClose
}: {
  x: number
  y: number
  session: StoredSession
  meta: SessionMeta
  onRename: () => void
  onTogglePin: () => void
  onToggleArchive: () => void
  onDelete: () => void
  onClose: () => void
}): JSX.Element {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // 捕获阶段监听：点在任何地方都先经过这里，菜单能可靠收起
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const width = 176
  const left = Math.min(Math.max(8, x), Math.max(8, window.innerWidth - width - 8))
  // 菜单大约 4 项高；底部放不下就翻到触发按钮上方
  const top = y + 172 > window.innerHeight ? Math.max(8, y - 182) : y

  return (
    <div
      ref={ref}
      className="session-menu"
      style={{ left, top, width }}
      role="menu"
      aria-label={t('sidebar.sessionActions')}
    >
      <button className="session-menu__item" role="menuitem" onClick={onRename}>
        <IconPencil width={13} height={13} />
        <span>{t('sidebar.rename')}</span>
      </button>
      <button className="session-menu__item" role="menuitem" onClick={onTogglePin}>
        <IconPin width={13} height={13} />
        <span>{meta.pinned ? t('sidebar.unpin') : t('sidebar.pin')}</span>
      </button>
      <button className="session-menu__item" role="menuitem" onClick={onToggleArchive}>
        <IconArchive width={13} height={13} />
        <span>{meta.archived ? t('sidebar.unarchive') : t('sidebar.archive')}</span>
      </button>
      <button
        className="session-menu__item is-danger"
        role="menuitem"
        onClick={onDelete}
      >
        <span className="session-menu__glyph">×</span>
        <span>{t('sidebar.deleteShort')}</span>
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
  const { t } = useI18n()
  return (
    <span
      className={`session__cli session__cli--${cli} ${running ? 'is-running' : ''}`}
      title={running ? t('sidebar.cliRunning', { cli: cliDef(cli).name }) : cliDef(cli).name}
    >
      {cli === 'claude' ? (
        <IconClaudeCode />
      ) : cli === 'codex' ? (
        <IconOpenAI />
      ) : (
        <IconDeepSeek />
      )}
    </span>
  )
}
