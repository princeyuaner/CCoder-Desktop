import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from 'react'
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
  IconCheck,
  IconClock,
  IconDeepSeek,
  IconFolder,
  IconGear,
  IconMore,
  IconPencil,
  IconPin,
  IconPlugin,
  IconPlus,
  IconOpenAI,
  IconSearch,
  IconSelectSquare,
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
   * 上一轮以错误收尾的会话（CLI session id）。
   * 行尾写「错误」，优先于「已完成」—— 跑挂了不能看起来像正常结束。
   */
  failed: ReadonlySet<string>
  /**
   * 卡在审批上的后台会话（CLI 的 session id）。
   * 当前会话不在里面显示跑马灯 —— 它的审批面板就在主区里。
   */
  pending: ReadonlyMap<string, PendingApproval>
  /**
   * 后台任务还在跑的会话（CLI session id）。
   *
   * 主对话那一轮已经结束、后台 shell 还没跑完时用它 —— 行尾写
   * 「后台运行中」，不能标成「已完成」。
   */
  background: ReadonlySet<string>
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
  /**
   * 弹系统目录选择器，挑一个目录加进列表。
   * 标题由调用方给：新建工作区时用「新建工作区」。
   */
  onPickWorkspace: (title?: string) => void
  onDeleteSession: (s: StoredSession) => void
  /**
   * 批量删除。侧栏只负责把勾选出来的会话交上去，
   * 确认弹窗和逐条删除都在 App —— 那里才知道谁是当前会话、要回收哪个 controller。
   */
  onDeleteSessions: (list: StoredSession[]) => void
  /**
   * 每次批量删除结束后重置勾选。`keep` 里的键留着 —— 那是失败的几条，
   * 它们还在列表上，用户最可能的下一步是「再删一次」。
   */
  selectionReset: { nonce: number; keep: string[] }
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
  failed,
  pending,
  background,
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
  onDeleteSessions,
  selectionReset,
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
  /**
   * 批量选择模式。勾选键统一用 `sessionMetaKey` —— 同一个 CLI id 可以在
   * 不同工作区各出现一次，只按 id 存会把两条会话一起勾上。
   */
  const [selecting, setSelecting] = useState(false)
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set())

  const exitSelect = (): void => {
    setSelecting(false)
    setChecked(new Set())
  }

  /*
   * 批量删除结束后重置勾选。只保留没删掉的那几条（`keep`），其余一律清掉；
   * 全删干净时就退出选择模式 —— 停在一屏空勾选框上没有意义。
   */
  useEffect(() => {
    if (selectionReset.nonce === 0) return
    const keep = new Set(selectionReset.keep)
    setChecked(keep)
    if (keep.size === 0) setSelecting(false)
  }, [selectionReset])

  /**
   * Esc 退出选择模式。
   *
   * 三处细节：
   *  - 重命名输入框里按 Esc 是它自己的事；
   *  - 右键菜单开着时 Esc 先关菜单；
   *  - **有模态弹窗时不管** —— 确认删除弹窗的 Esc 是「取消这次删除」，
   *    侧栏要是同时把勾选也清了，用户关掉弹窗会发现白勾一遍。
   */
  useEffect(() => {
    if (!selecting) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (menu || renamingKey !== null) return
      if (document.querySelector('.modal')) return
      exitSelect()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selecting, menu, renamingKey])

  const toggleChecked = (s: StoredSession): void => {
    const key = sessionMetaKey(s.cli, s.cwd, s.id)
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** 组头全选 / 取消全选。半选状态下点一下是「全选」—— 常见的邮箱交互 */
  const toggleGroup = (list: StoredSession[]): void => {
    const keys = list.map((s) => sessionMetaKey(s.cli, s.cwd, s.id))
    const all = keys.length > 0 && keys.every((k) => checked.has(k))
    setChecked((prev) => {
      const next = new Set(prev)
      for (const k of keys) {
        if (all) next.delete(k)
        else next.add(k)
      }
      return next
    })
  }

  /**
   * 勾选集合 → 会话记录。
   *
   * 侧栏只认**当前列表里真的还在**的会话：会话可能在勾过之后被别处删掉、
   * 或随「显示已归档」开关淡出列表。直接按集合计数会让底部写着「已选 3 条」
   * 却只交上去 2 条 —— 这里以解析结果为准。
   */
  const picked = useMemo(() => {
    if (checked.size === 0) return []
    const out: StoredSession[] = []
    for (const ws of workspaces) {
      for (const s of ws.sessions) {
        if (checked.has(sessionMetaKey(s.cli, s.cwd, s.id))) out.push(s)
      }
    }
    return out
  }, [checked, workspaces])

  const openMenu = (s: StoredSession, x: number, y: number): void => {
    setMenu({ s, x, y })
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
        <button
          className="iconbtn iconbtn--sm sidebar__newws"
          title={t('sidebar.newWorkspace')}
          aria-label={t('sidebar.newWorkspace')}
          onClick={() => onPickWorkspace(t('sidebar.newWorkspace'))}
        >
          <IconPlus width={14} height={14} />
        </button>
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
          {/*
            批量选择入口。跟搜索 / 排序一样常驻在这一排 —— 藏进 hover 的话，
            用户永远发现不了这个功能。选择模式下变成「退出」，位置不跳。
          */}
          <button
            className={`iconbtn ${selecting ? 'is-on' : ''}`}
            title={selecting ? t('sidebar.selectModeDone') : t('sidebar.selectMode')}
            aria-pressed={selecting}
            onClick={() => {
              if (selecting) {
                exitSelect()
                return
              }
              // 进来时先收起右键菜单和重命名输入框：它们都是「单条会话」的操作，
              // 挂在选择模式上面只会挡住勾选
              setMenu(null)
              setRenamingKey(null)
              setSelecting(true)
            }}
          >
            <IconSelectSquare width={14} height={14} />
          </button>
        </div>
      </div>

      <div className={`sidebar__scroll ${selecting ? 'is-selecting' : ''}`}>
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
            failed={failed}
            pending={pending}
            background={background}
            activeId={activeId}
            worktreeBranches={worktreeBranches}
            meta={meta}
            renamingKey={renamingKey}
            selecting={selecting}
            checked={checked}
            onSelect={onSelect}
            onRequestNewSession={onRequestNewSession}
            onCloseWorkspace={onCloseWorkspace}
            onOpenIde={onOpenIde}
            onDeleteSession={onDeleteSession}
            onRefresh={onRefresh}
            onOpenMenu={openMenu}
            onCommitRename={commitRename}
            onCancelRename={() => setRenamingKey(null)}
            onToggleChecked={toggleChecked}
            onToggleGroup={(list) => toggleGroup(list)}
          />
        ))}
      </div>

      {selecting && (
        <BatchBar
          count={picked.length}
          onCancel={exitSelect}
          onDelete={() => onDeleteSessions(picked)}
        />
      )}

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
  failed,
  pending,
  background,
  activeId,
  worktreeBranches,
  meta,
  renamingKey,
  selecting,
  checked,
  onSelect,
  onRequestNewSession,
  onCloseWorkspace,
  onOpenIde,
  onDeleteSession,
  onRefresh,
  onOpenMenu,
  onCommitRename,
  onCancelRename,
  onToggleChecked,
  onToggleGroup
}: {
  ws: WorkspaceView
  running: Set<string>
  completed: ReadonlySet<string>
  /** 上一轮跑挂了的会话 */
  failed: ReadonlySet<string>
  pending: ReadonlyMap<string, PendingApproval>
  background: ReadonlySet<string>
  activeId: string | null
  worktreeBranches: Record<string, string>
  meta: SessionMetaMap
  renamingKey: string | null
  /** 批量选择模式 */
  selecting: boolean
  checked: ReadonlySet<string>
  onSelect: (s: StoredSession) => void
  onRequestNewSession: (cwd: string) => void
  onCloseWorkspace: (cwd: string) => void
  onOpenIde: (cwd: string) => void
  onDeleteSession: (s: StoredSession) => void
  onRefresh: () => void
  onOpenMenu: (s: StoredSession, x: number, y: number) => void
  onCommitRename: (s: StoredSession, value: string) => void
  onCancelRename: () => void
  onToggleChecked: (s: StoredSession) => void
  /**
   * 组头全选。传的是**当前可见池**：只看工作树时，「全选」应当只选
   * 这一屏列出来的那几条，而不是连带把组里隐藏的普通会话也勾上。
   */
  onToggleGroup: (list: StoredSession[]) => void
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

  /** 组头全选：当前可见池里勾了几条。半选态用 minus */
  const checkedInPool = pool.filter((s) =>
    checked.has(sessionMetaKey(s.cli, s.cwd, s.id))
  ).length
  const groupAll = pool.length > 0 && checkedInPool === pool.length
  const groupSome = checkedInPool > 0 && !groupAll

  // 工作树都关掉后别把筛选状态留着，下次再出现工作树时会莫名其妙只剩几行
  useEffect(() => {
    if (onlyWorktree && worktreeCount === 0) setOnlyWorktree(false)
  }, [onlyWorktree, worktreeCount])

  return (
    <div className="wsgroup">
      {/* 两个按钮常驻；目录名被省略时靠 title 看全路径。 */}
      <div className="wsgroup__head" title={ws.cwd}>
        {/*
          选择模式下组头多一个全选。文件夹图标留在原位 —— 它仍然是
          「打开 IDE」的入口，不因为进入选择模式就失效。
        */}
        {selecting && (
          <CheckBox
            checked={groupAll}
            mixed={groupSome}
            label={t('sidebar.selectAllGroup', { name: ws.name })}
            onToggle={() => onToggleGroup(pool)}
          />
        )}
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
            failed={failed.has(s.id)}
            background={background.has(s.id)}
            approval={pending.get(s.id)}
            renaming={renamingKey === key}
            selecting={selecting}
            checked={checked.has(key)}
            onSelect={() => {
              // 选择模式下点整行就是勾选：这时候用户的目标是"挑几条"，
              // 不是"切过去看看"，多一层"先找到勾选框"反而是障碍
              if (selecting) {
                onToggleChecked(s)
                return
              }
              onSelect(s)
              onRefresh()
            }}
            onToggleChecked={() => onToggleChecked(s)}
            onDelete={() => onDeleteSession(s)}
            onOpenMenu={(x, y) => onOpenMenu(s, x, y)}
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
  failed,
  background,
  approval,
  renaming,
  selecting,
  checked,
  onSelect,
  onToggleChecked,
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
  /** 上一轮以错误收尾 */
  failed: boolean
  /** 主对话已结束，但后台任务还在跑 */
  background: boolean
  /** 这条会话正在等的审批；没有就是 undefined */
  approval?: PendingApproval
  /** 正在内联重命名 */
  renaming: boolean
  /** 批量选择模式：整行点击变成勾选，行首出现勾选框 */
  selecting: boolean
  checked: boolean
  onSelect: () => void
  onToggleChecked: () => void
  onDelete: () => void
  onOpenMenu: (x: number, y: number) => void
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
          <CliMark cli={s.cli} running={(running || background) && !waiting} />
          <RenameInput initial={title} onCommit={onCommitRename} onCancel={onCancelRename} />
        </div>
      </div>
    )
  }

  return (
    <div
      className={`session ${active ? 'is-active' : ''} ${waiting ? 'is-pending' : ''} ${
        archived ? 'is-archived' : ''
      } ${selecting ? 'is-selecting' : ''} ${checked ? 'is-checked' : ''}`}
      onContextMenu={(e) => {
        // 右键整行弹出操作菜单，位置跟着光标走。
        // 选择模式下不弹：那几项都是「对单条会话做点什么」，跟批量选择是两套心智。
        e.preventDefault()
        if (selecting) return
        onOpenMenu(e.clientX, e.clientY)
      }}
    >
      <button
        className="session__main"
        onClick={onSelect}
        // 选择模式下把整行的语义也换掉：读屏念的是「勾选 / 取消」而不是「打开」
        aria-pressed={selecting ? checked : undefined}
        aria-label={selecting ? (checked ? t('sidebar.unselectRow') : t('sidebar.selectRow')) : undefined}
        title={`${title}\n${s.cwd}\n${cliDef(s.cli).name}${
          branch ? `\n${branch}` : ''
        }${waiting ? `\n${label}: ${detail}` : ''}`}
      >
        {selecting && (
          <CheckBox
            checked={checked}
            label={checked ? t('sidebar.unselectRow') : t('sidebar.selectRow')}
            decorative
            onToggle={onToggleChecked}
          />
        )}
        {/*
          等审批时进程还活着，但卡在用户这里 —— 不是"在干活"，
          别让图标继续跳，把注意力留给跑马灯。
        */}
        <CliMark cli={s.cli} running={(running || background) && !waiting} />
        {pinned && (
          <IconPin
            className="session__pin"
            width={11}
            height={11}
            aria-label={t('sidebar.pinned')}
          />
        )}
        <span className="session__text">
          <span className="session__line1">
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
                  running || background
                    ? 'session__time--running'
                    : failed
                      ? 'session__time--error'
                      : done
                        ? 'session__time--done'
                        : ''
                }`}
              >
                {running
                  ? t('sidebar.running')
                  : background
                    ? t('sidebar.backgroundRunning')
                    : failed
                      ? t('sidebar.failed')
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
      {/*
        选择模式下隐藏「更多」和「×」：整行点击已经是勾选，这两个按钮
        要么会误伤（×），要么跟批量操作抢注意力。退出模式后照旧。
      */}
      {!selecting && (
        <>
          <button
            className="session__more"
            title={t('sidebar.sessionActions')}
            aria-haspopup="menu"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              onOpenMenu(r.left, r.bottom + 5)
            }}
          >
            <IconMore width={14} height={14} />
          </button>
          <button className="session__del" title={t('sidebar.deleteSession')} onClick={onDelete}>
            ×
          </button>
        </>
      )}
    </div>
  )
}

/**
 * 批量选择用的勾选框。
 *
 * 自绘成 span 而不是用 input[type=checkbox]：会话行本身是 button，
 * input 嵌不进去；这里也不在表单里，自绘更容易跟侧栏的 20px 网格对齐。
 * 组头那个用 role="checkbox" 对读屏发声；行内那个是纯装饰（行自己报状态）。
 */
function CheckBox({
  checked,
  mixed = false,
  label,
  decorative = false,
  onToggle
}: {
  checked: boolean
  /** 半选：组里只勾了一部分 */
  mixed?: boolean
  label: string
  /**
   * 纯装饰。放在整行 button 里时用 —— 那个 button 自己已经用 aria-pressed
   * 表达了勾选状态，这里再挂一个 checkbox 角色，读屏会念两遍。
   */
  decorative?: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <span
      className={`cbx ${checked ? 'is-on' : ''} ${mixed ? 'is-mixed' : ''}`}
      role={decorative ? undefined : 'checkbox'}
      aria-checked={decorative ? undefined : mixed ? 'mixed' : checked}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : label}
      tabIndex={-1}
      title={decorative ? undefined : label}
      onClick={(e) => {
        // 行本身是个 button：不拦住会「先勾选、再被 onClick 翻回去」
        e.stopPropagation()
        onToggle()
      }}
    >
      {checked && <IconCheck width={10} height={10} />}
    </span>
  )
}

/**
 * 侧栏底部的批量操作条。选择模式下才出现，位置在「设置」上方 ——
 * 离鼠标最近，也不会把会话列表往下挤。
 */
function BatchBar({
  count,
  onDelete,
  onCancel
}: {
  count: number
  onDelete: () => void
  onCancel: () => void
}): JSX.Element {
  const { tn } = useI18n()
  return (
    <div className="batchbar" role="toolbar">
      <span className="batchbar__count">{tn('sidebar.selectedCount', count)}</span>
      <button
        className="batchbar__btn batchbar__btn--danger"
        disabled={count === 0}
        onClick={onDelete}
      >
        {tn('sidebar.selectDelete', count)}
      </button>
      <button className="batchbar__btn" onClick={onCancel}>
        {tn('sidebar.selectCancel', count)}
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
