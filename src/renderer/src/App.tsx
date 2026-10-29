import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { sessionMetaKey, type StoredSession } from '@shared/session'
import { cliDef, sameCwd, type CliAuthMode, type CliId } from '@shared/settings'
import { disposeIdleNewChats, disposeStoredChat } from './useChat'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { SessionSearch } from './components/SessionSearch'
import { MainPane } from './components/MainPane'
import { NewSessionDialog } from './components/NewSessionDialog'
import { SettingsPage } from './components/SettingsPage'
import { ConfirmModal } from './components/ConfirmModal'
import { WhatsNewModal } from './components/WhatsNewModal'
import { baseName, cwdKey } from '@shared/path'
import { useSessions, type WorkspaceView } from './useSessions'
import { metaOf, displayTitle, useSessionMeta } from './useSessionMeta'
import type { RecentAddDir } from '@shared/add-dirs'
import { useWorktreeMap } from './useWorktreeMap'
import { useSettings } from './useSettings'
import { useWhatsNew } from './useWhatsNew'
import { configureDoneNotify } from './done-notify'
import { useUpdater } from './useUpdater'
import { applyAppearance } from './appearance'
import { applyLanguageSetting, useI18n } from './i18n'
import { onNotice } from './notice'
import type { ChatActiveInfo, IdeCodeRef, IdeSendPayload } from '@shared/ide-chat'
import './styles/shell.css'
import './styles/chat.css'
import './styles/settings.css'
import './styles/mcp.css'
import './styles/skills.css'
import './styles/hooks.css'
import './styles/panel.css'
import './styles/update.css'
import './styles/whats-new.css'
import './styles/search.css'
import './styles/newsession.css'
/* 浅色覆盖必须最后加载（或靠选择器权重压过组件样式），这里放最后一行 */
import './styles/theme-light.css'

type View = 'chat' | 'settings'

/**
 * 当前打开的是新会话，还是磁盘上某条已有会话。
 *
 * `n` 是**新会话的序号**，每点一次「新会话」加一。
 * 没有它的话 `{ kind: 'new' }` 前后是同一个值 —— MainPane 里 useChat 的依赖
 * 一个都没变，会话不会重建、转写区不会清空，用户看到的就是"点了没反应"。
 * 它同时是这条会话的身份：同一个 n 就是同一条会话。
 *
 * `cwd` 是「在某个工作区下开新会话」时指定的目录；不指定就走
 * 「默认工作目录 → 上次打开的目录」那条链。
 */
export type Active =
  | { kind: 'new'; n: number; cwd?: string }
  | { kind: 'stored'; id: string; cwd: string; title: string; cli: CliId }

/**
 * 把一批会话按 cwd 分组，用于批量删除确认页。
 *
 * 用 `sameCwd` 归并而不是直接拿 cwd 当键：同一目录在记录里可能是正斜杠
 * 也可能反斜杠，按原串分组会出现两个看起来一模一样的标题。
 */
function groupByCwd(list: StoredSession[]): [string, StoredSession[]][] {
  const out: [string, StoredSession[]][] = []
  for (const s of list) {
    const hit = out.find(([cwd]) => sameCwd(cwd, s.cwd))
    if (hit) hit[1].push(s)
    else out.push([s.cwd, [s]])
  }
  return out
}

export function App(): JSX.Element {
  const { t, tn } = useI18n()
  const [view, setView] = useState<View>('chat')
  const [active, setActive] = useState<Active>({ kind: 'new', n: 0 })
  /**
   * 新会话序号。**只增不减**，且不能从当前 active 推导 ——
   * 否则从已有会话点回「新会话」时 n 会重置，可能撞上一条仍在后台跑的
   * 新会话 controller，被错误地复用。
   */
  const newSeq = useRef(0)
  /**
   * 侧栏眼里「用户正在看的是哪条会话」。
   *
   * 只有对话真的露出来时才算：设置页会把对话整个盖住，这时候连当前
   * 会话也应该在侧栏挂「已完成」提醒（和审批提醒的规则一致）。
   */
  const activeStoredId = view === 'chat' && active.kind === 'stored' ? active.id : null
  const {
    workspaces,
    loading,
    running,
    completed,
    failed,
    pending: pendingApprovals,
    background,
    sort,
    toggleSort,
    refresh
  } = useSessions(activeStoredId)
  const { settings, save } = useSettings()
  const updater = useUpdater()
  /** 版本号变化后，启动时弹一次本次更新说明 */
  const whatsNew = useWhatsNew(updater.state?.currentVersion)
  /** 重命名 / 置顶 / 归档 / 会话级模型 —— 应用本地元数据，不写回 CLI 记录 */
  const { meta, loading: metaLoading, update: updateSessionMeta } = useSessionMeta()
  /**
   * 把会话级模型选择写进元数据。
   *
   * 新会话拿到 CLI id 之前没有 key，MainPane 会先存着，等 id 到了再调这里。
   */
  const persistSessionModel = useCallback(
    (cli: CliId, cwd: string, id: string, model: string): void => {
      void updateSessionMeta({ cli, cwd, id }, { model })
    },
    [updateSessionMeta]
  )
  /**
   * 会话级渠道 / 来源选择。和模型一样只写 session-meta ——
   * 写进设置会让同一 CLI 的其他对话跟着切（A 换渠道 B 也变）。
   */
  const persistSessionAuth = useCallback(
    (
      cli: CliId,
      cwd: string,
      id: string,
      patch: { authMode?: CliAuthMode; channelId?: string }
    ): void => {
      void updateSessionMeta({ cli, cwd, id }, patch)
    },
    [updateSessionMeta]
  )
  /**
   * 会话级附加目录。和模型 / 渠道一样只写 session-meta，不写设置。
   * 新会话拿到 CLI id 之前由 MainPane 暂存，id 到了再补写。
   */
  const persistSessionAddDirs = useCallback(
    (cli: CliId, cwd: string, id: string, addDirs: string[]): void => {
      void updateSessionMeta({ cli, cwd, id }, { addDirs })
    },
    [updateSessionMeta]
  )

  /**
   * 「最近使用」的附加目录：从别的会话的 session-meta 里聚合。
   *
   * 只做建议，不会自动带进新会话。同一目录被多条会话用过时保留最近活跃
   * 的那条的标题；按会话 updatedAt 倒序，最多 5 条。
   */
  const recentAddDirs = useMemo<RecentAddDir[]>(() => {
    const currentKey =
      active.kind === 'stored' ? sessionMetaKey(active.cli, active.cwd, active.id) : null
    const byDir = new Map<string, { path: string; title: string; at: number }>()
    for (const ws of workspaces) {
      for (const s of ws.sessions) {
        // --add-dir 只对 Claude 生效，别把别的 CLI 的元数据混进来
        if (s.cli !== 'claude') continue
        const key = sessionMetaKey(s.cli, s.cwd, s.id)
        if (key === currentKey) continue
        const dirs = meta[key]?.addDirs
        if (!dirs?.length) continue
        const title = displayTitle(s, meta)
        for (const path of dirs) {
          const k = cwdKey(path)
          const prev = byDir.get(k)
          if (!prev || s.updatedAt > prev.at) byDir.set(k, { path, title, at: s.updatedAt })
        }
      }
    }
    return [...byDir.values()]
      .sort((a, b) => b.at - a.at)
      .slice(0, 5)
      .map(({ path, title }) => ({ path, title }))
  }, [active, workspaces, meta])
  const [searchOpen, setSearchOpen] = useState(false)
  /** 默认收起已归档会话；侧栏底部有入口临时显示 */
  const [showArchived, setShowArchived] = useState(false)

  // 设置落盘（或启动时读完）后立刻应用语言 / 主题 / 缩放 / 字体
  useEffect(() => {
    applyLanguageSetting(settings.language)
    applyAppearance(settings)
  }, [settings])

  // Ctrl/Cmd+K 打开会话搜索 —— 侧栏那个图标只有 hover 才浮出来，给条明路
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  /** 等着确认删除的那条会话。null = 没在删 */
  const [pendingDelete, setPendingDelete] = useState<Pick<
    StoredSession,
    'id' | 'cwd' | 'cli' | 'title'
  > | null>(null)
  /** 等着确认批量删除的会话；null / 空数组 = 没在删 */
  const [pendingDeleteBatch, setPendingDeleteBatch] = useState<StoredSession[] | null>(null)
  /**
   * 每次批量删除结束时通知侧栏重置勾选。
   *
   * `keep` 是**没删掉**的那几条的键 —— 侧栏清空其余勾选、退出选择模式，
   * 但把这几个留着，用户再点「删除」就能直接重试。
   */
  const [selectionReset, setSelectionReset] = useState<{
    nonce: number
    keep: string[]
  }>({ nonce: 0, keep: [] })
  /** 删除失败的说明，浮在顶上 */
  const [notice, setNotice] = useState<string | null>(null)
  /** 启动时发现旧 MCP 条目 → 轻量确认弹窗；确认后直接打开 MCP 页 */
  const [migrationPrompt, setMigrationPrompt] = useState(0)
  const [openMcpSettings, setOpenMcpSettings] = useState(false)

  // 深层组件（工具卡 → IDE）走轻量事件总线报告失败，统一在这里显示
  useEffect(() => onNotice(setNotice), [])

  // 旧版私有 MCP store 还有条目时，启动后弹一次确认
  useEffect(() => {
    let alive = true
    window.api?.mcp
      ?.migration()
      .then((m) => {
        if (alive && m.count > 0) setMigrationPrompt(m.count)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  /**
   * IDE 发来的代码引用。
   *
   * App 只负责「切到目标会话 + 把引用往下传」，真正塞进输入框是 Composer
   * 的事。pending 保留到 Composer 确认收下为止 —— 切会话/切设置页时
   * Composer 可能晚一拍挂载，提前清掉就丢了。
   */
  const [incomingRefs, setIncomingRefs] = useState<{
    nonce: number
    refs: IdeCodeRef[]
  } | null>(null)
  const activeInfoRef = useRef<ChatActiveInfo | null>(null)
  /** 引用批次号：只增不减，Composer 靠它判断“这一批是新到的” */
  const refSeq = useRef(0)

  const reportActive = useCallback((info: ChatActiveInfo): void => {
    activeInfoRef.current = info
    window.api?.chat?.reportActive(info)
  }, [])

  /**
   * 用户主动打开过的目录。没打开过就是空串。
   */
  const [pickedCwd, setPickedCwd] = useState('')

  /**
   * 侧栏只列**用户手动打开过**的目录（settings.openedCwds）。
   *
   * 不列全部：~/.claude/projects 里有几十个目录、三百多份会话，全是这些年
   * 随手 cd 过去跑过一次留下的。默认全铺出来，侧栏就是一份文件系统索引。
   *
   * 打开过的目录**哪怕磁盘上还没有会话**也要列出来 —— 刚打开一个新项目、
   * 还没发过消息时，它得有地方待着。
   */
  const opened = settings.openedCwds
  /**
   * openedCwds 里哪些是 linked worktree、属于哪个主工作区。
   *
   * 侧栏把工作树的会话并回主工作区分组 —— 否则每建一个工作树，就多出
   * 一个同名项目的工作区，侧栏会被切成好几段。
   */
  const worktreeMap = useWorktreeMap(opened)
  const worktreeBranches = useMemo(() => {
    const out: Record<string, string> = {}
    // 用 cwdKey 而不是原字符串：会话记录里的 cwd 是反斜杠，工作树映射里
    // 的键来自 openedCwds / git，可能是正斜杠，直接查表会对不上。
    for (const [cwd, info] of Object.entries(worktreeMap)) out[cwdKey(cwd)] = info.branch
    return out
  }, [worktreeMap])

  const visible = useMemo<WorkspaceView[]>(() => {
    const groups = new Map<string, WorkspaceView>()
    for (const cwd of opened) {
      // 工作树只在「主工作区也开着」时并过去；主目录被关掉就保留它自己的组
      const info = worktreeMap[cwd]
      const mainCwd = info
        ? opened.find((c) => sameCwd(c, info.mainCwd))
        : undefined
      const groupCwd = mainCwd ?? cwd
      let group = groups.get(groupCwd)
      if (!group) {
        group = { cwd: groupCwd, name: baseName(groupCwd), sessions: [] }
        groups.set(groupCwd, group)
      }
      const hit = workspaces.find((w) => sameCwd(w.cwd, cwd))
      if (hit) group.sessions.push(...hit.sessions)
    }

    const cmp =
      sort === 'created'
        ? (a: StoredSession, b: StoredSession): number =>
            b.createdAt - a.createdAt ||
            b.updatedAt - a.updatedAt ||
            a.id.localeCompare(b.id)
        : (a: StoredSession, b: StoredSession): number =>
            b.updatedAt - a.updatedAt ||
            b.createdAt - a.createdAt ||
            a.id.localeCompare(b.id)

    const out: WorkspaceView[] = []
    for (const group of groups.values()) {
      const sessions = group.sessions.filter((s) => {
        if (!metaOf(s, meta).archived || showArchived) return true
        // 归档只是从默认列表里收起来：正在跑 / 等审批 / 用户正看着的那条不能消失
        // 正在跑 / 等审批 / 后台还有任务：归档了也得留在列表里，否则用户看不到它
        if (
          running.has(s.id) ||
          pendingApprovals.has(s.id) ||
          background.has(s.id)
        ) {
          return true
        }
        return (
          active.kind === 'stored' && active.id === s.id && sameCwd(active.cwd, s.cwd)
        )
      })

      // 合并了多个 cwd 的会话，必须重新按当前排序排一次
      sessions.sort(cmp)
      // 置顶优先。sort 是稳定的，上面的创建 / 最近活动排序不会被打破。
      sessions.sort(
        (a, b) =>
          Number(metaOf(b, meta).pinned === true) -
          Number(metaOf(a, meta).pinned === true)
      )
      out.push({ ...group, sessions })
    }
    return out
  }, [
    opened,
    workspaces,
    meta,
    showArchived,
    running,
    pendingApprovals,
    background,
    active,
    sort,
    worktreeMap
  ])

  /** 只数侧栏里看得到的工作区 —— 搜索能找到全部，但"已归档 N"说的是当前列表 */
  const archivedCount = useMemo(() => {
    let n = 0
    for (const cwd of opened) {
      const hit = workspaces.find((w) => sameCwd(w.cwd, cwd))
      if (!hit) continue
      for (const s of hit.sessions) if (metaOf(s, meta).archived) n++
    }
    return n
  }, [opened, workspaces, meta])

  /** 待删批次里有几条在跑 —— 决定确认页要不要挂「会先停进程」那条警告 */
  const runningCount = useMemo(() => {
    if (!pendingDeleteBatch) return 0
    let n = 0
    for (const s of pendingDeleteBatch) if (running.has(s.id)) n++
    return n
  }, [pendingDeleteBatch, running])

  /** 搜索要跨所有工作区，包括没在侧栏里打开的 */
  const allSessions = useMemo(
    () => workspaces.flatMap((w) => w.sessions),
    [workspaces]
  )

  /**
   * 跑完通知：开关 + 会话标题解析。
   *
   * 通知由模块级的 ChatController 触发（它不在 React 树上），所以这里把
   * 「设置开不开」和「这条会话显示什么标题」注册进去。标题优先用重命名后的
   * 名字 —— 通知里写着 CLI 原标题、侧栏却是用户改过的名字，会对不上。
   */
  useEffect(() => {
    configureDoneNotify({
      enabled: settings.notifyOnDone,
      titleOf: (cli, cwd, id) => {
        const hit = workspaces.find((w) => sameCwd(w.cwd, cwd))?.sessions.find((s) => s.id === id)
        return hit ? metaOf(hit, meta).title || hit.title : ''
      }
    })
  }, [settings.notifyOnDone, workspaces, meta])

  /**
   * 「上次打开的目录」。设置里「默认工作目录」留空时，新会话就用它。
   *
   * 不这么做的话会掉到用户主目录去 —— 那几乎永远不是你想干活的地方，
   * 会话也就跑到了侧栏里一个不相干的工作区下面。
   *
   * **在渲染期算出来，不用 useEffect 播种**：会话列表是异步到的，
   * 用 effect 播种会比 loading 落地晚一帧 —— 那一帧里 useChat 已经拿着
   * 空 cwd 把会话建起来了，于是启动时白白多出一次 session:start。
   * 优先取还开着的工作区，全关掉了才退回到列表里最近的那个。
   */
  const lastCwd = pickedCwd || visible[0]?.cwd || workspaces[0]?.cwd || ''

  /** 只认身份字段：调用方可能来自侧栏（完整记录）或 IDE 投递（只有目标信息） */
  const openStored = (s: Pick<StoredSession, 'id' | 'cwd' | 'title' | 'cli'>): void => {
    // 切走之后，刚才那条没发过消息的新会话就再也点不回来了 —— 顺手收掉
    disposeIdleNewChats()
    setActive({ kind: 'stored', id: s.id, cwd: s.cwd, title: s.title, cli: s.cli })
    setPickedCwd(s.cwd)
    setView('chat')
  }

  const newSession = (cwd?: string): void => {
    // 没发过消息的新会话没有侧栏行，离开就回收；有消息的可能正在后台跑，留着
    disposeIdleNewChats()
    newSeq.current += 1
    setActive({ kind: 'new', n: newSeq.current, cwd })
    if (cwd) setPickedCwd(cwd)
    setView('chat')
  }

  /**
   * 点了通知 → 切到那条会话。
   *
   * 会话可能已经不在磁盘上了（被删 / 工作区被收起来）：这时什么都不做 ——
   * 主进程已经把窗口拎到前台了，用户自己能看到侧栏。
   *
   * 订阅用 ref 包一层，避免每次会话表刷新都重新订阅；回调里读到的永远是
   * 最新那份列表和最新的 openStored。
   */
  const focusRef = useRef<(s: StoredSession) => void>(() => undefined)
  focusRef.current = openStored
  const sessionListRef = useRef<StoredSession[]>([])
  sessionListRef.current = allSessions

  useEffect(() => {
    return window.api?.chat?.onFocusSession((target) => {
      if (!target?.id || !target.cwd) return
      const hit = sessionListRef.current.find(
        (s) => s.id === target.id && sameCwd(s.cwd, target.cwd)
      )
      if (hit) focusRef.current(hit)
    })
  }, [])

  /**
   * 侧栏「+」：先选分支 / 工作树，再开会话。
   *
   * 选中的分支可能落在一个新建（或复用）的工作树目录里 —— 那个目录要
   * 先加进侧栏白名单，否则会话跑起来了却在侧栏里找不到入口。
   */
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null)

  const startNewSession = async (targetCwd: string): Promise<void> => {
    setNewSessionCwd(null)
    // 等目录真正进白名单再开会话：主窗口的 VCS 调用按 openedCwds 授权，
    // 新工作树还没落盘时 detect 会被拒，标题旁的分支标签就刷不出来。
    try {
      await openWorkspace(targetCwd)
    } finally {
      // 设置落盘失败也不能挡住开新会话
      newSession(targetCwd)
    }
  }

  /**
   * 关闭工作区。**只是收起来，一个文件都不删** —— 目录是 CLI 的地盘，
   * 我们没权力删。收起来的列表落盘，底部有入口能放回来。
   */
  /** 打开一个目录。合并去重（同一个目录两种斜杠写法也算同一个） */
  const openWorkspace = async (cwd: string): Promise<void> => {
    if (opened.some((c) => sameCwd(c, cwd))) return
    await save({ ...settings, openedCwds: [cwd, ...opened] })
  }

  /** 从列表里去掉。**不删任何文件** —— 目录还在，随时能再打开 */
  const closeWorkspace = (cwd: string): void => {
    // 刚从这个目录开过会话的话，把它从"上次打开的目录"里摘掉 ——
    // 不然下一次开新会话会悄悄落进一个你刚关掉的地方
    if (pickedCwd && sameCwd(pickedCwd, cwd)) setPickedCwd('')
    void save({ ...settings, openedCwds: opened.filter((c) => !sameCwd(c, cwd)) })
  }

  /**
   * 弹系统目录选择器。`title` 只是对话框标题 —— 选了目录就加进侧栏，
   * 不在这里建文件夹；原生选择器自己带「新建文件夹」。
   */
  const pickWorkspace = async (title?: string): Promise<void> => {
    const dir = await window.api?.sessions.pickDir(title)
    if (dir) await openWorkspace(dir)
  }

  /**
   * 从搜索结果打开一条会话。
   *
   * 搜索覆盖所有 CLI 记录，包括没在侧栏里打开过的工作区 —— 那边点进来后
   * 得先把目录加进白名单，否则会话打开了、侧栏里却找不到它。
   */
  const openFromSearch = (s: StoredSession): void => {
    if (!opened.some((c) => sameCwd(c, s.cwd))) void openWorkspace(s.cwd)
    openStored(s)
    setSearchOpen(false)
  }

  const confirmDelete = async (): Promise<void> => {
    const s = pendingDelete
    setPendingDelete(null)
    if (!s) return

    const r = await window.api?.sessions.delete(s.cwd, s.id)
    if (r && !r.ok) {
      setNotice(
        t('errors.deleteFailed', { error: r.message ?? t('errors.unknownReason') })
      )
      return
    }
    // 主进程已经按 provider id 停过进程了；渲染进程这边的 controller（可能在
    // 后台跑着）也要一起摘掉，否则它还会继续收事件、占着内存。
    disposeStoredChat(s.cli, s.cwd, s.id)
    // 删掉的正好是当前打开的那条 —— 退回新会话，别停在一个已经不存在的会话上
    if (active.kind === 'stored' && active.id === s.id) newSession()
    void refresh()
  }

  /**
   * 批量删除。
   *
   * 逐条调同一个 IPC，而不是在主进程新开一个 batch 接口：每条删除要做的
   * 事完全一样（先停进程、删记录、清元数据），失败原因也各不相同，
   * 聚合在渲染层才能把「删了几条、哪条失败」讲清楚。
   *
   * 部分失败时不整批回滚 —— 已经删掉的文件回不来，界面据实报告即可。
   * 但**失败的那几条要留在勾选里**：它们还在列表上，用户最可能的下一步
   * 就是再删一次，把勾选一起清掉等于逼他重新挑。
   */
  const confirmDeleteBatch = async (): Promise<void> => {
    const list = pendingDeleteBatch
    setPendingDeleteBatch(null)
    if (!list || list.length === 0) return

    let done = 0
    let firstError: string | null = null
    let activeRemoved = false
    const failed: StoredSession[] = []

    for (const s of list) {
      const r = await window.api?.sessions.delete(s.cwd, s.id)
      if (r && !r.ok) {
        firstError ??= r.message ?? t('errors.unknownReason')
        failed.push(s)
        continue
      }
      done += 1
      // 和单条删除一样：主进程收的是 CLI 进程，渲染层这边的 controller 也要摘掉
      disposeStoredChat(s.cli, s.cwd, s.id)
      if (active.kind === 'stored' && active.id === s.id && sameCwd(active.cwd, s.cwd)) {
        activeRemoved = true
      }
    }

    // 当前正看着的会话被删掉 —— 退回新会话，别停在一条已经不存在的记录上
    if (activeRemoved) newSession()

    if (firstError !== null) {
      setNotice(
        done === list.length
          ? t('errors.deleteFailed', { error: firstError })
          : t('sidebar.deleteBatchPartial', {
              done,
              failed: failed.length,
              error: firstError
            })
      )
    }
    /*
     * 删干净的批次：清空勾选、退出选择模式。
     * 有失败的：只留失败那几条勾着，让「再试一次」不用重新挑。
     */
    setSelectionReset({
      nonce: selectionReset.nonce + 1,
      keep: failed.map((s) => sessionMetaKey(s.cli, s.cwd, s.id))
    })
    void refresh()
  }

  /**
   * 收到 IDE 的引用：先保证当前会话就是目标会话，再把引用交给 Composer。
   *
   * handler 挂在 ref 上，只订阅一次 IPC；这样里面读到的 active / 切会话
   * 函数永远是最新一版，不用因为依赖变化反复重订。
   */
  const attachRef = useRef<(payload: IdeSendPayload) => void>(() => undefined)
  attachRef.current = (payload) => {
    const { target, refs } = payload
    if (!target?.cwd || !Array.isArray(refs) || refs.length === 0) return

    const cur = activeInfoRef.current
    const sameTarget =
      !!cur &&
      sameCwd(cur.cwd, target.cwd) &&
      (target.id ? cur.id === target.id : cur.isNew)

    if (!sameTarget) {
      if (target.id) {
        openStored({
          id: target.id,
          cwd: target.cwd,
          title: target.title,
          cli: target.cli
        })
      } else {
        newSession(target.cwd)
      }
    }

    setView('chat')
    // 同一轮里连发两次时累加；Composer 收下后再清空
    refSeq.current += 1
    const nonce = refSeq.current
    setIncomingRefs((prev) => ({
      nonce,
      refs: [...(prev?.refs ?? []), ...refs]
    }))
  }

  useEffect(() => {
    return window.api?.chat?.onAttachRefs((p) => attachRef.current(p))
  }, [])

  /**
   * IDE 请求「在工作树目录开新会话」。
   *
   * 工作区白名单已经由主进程合并并广播，这里只切到新会话；
   * **不要**再调用 openWorkspace —— 渲染层拿旧快照整份保存会覆盖主进程的合并。
   */
  const openSessionRef = useRef<(cwd: string) => void>(() => undefined)
  openSessionRef.current = (cwd) => {
    if (typeof cwd === 'string' && cwd.trim()) newSession(cwd)
  }

  useEffect(() => {
    return window.api?.workspace?.onOpenSession((cwd) => openSessionRef.current(cwd))
  }, [])

  /** 工作树被删除后，别让下一次普通「新会话」落进一个已经不存在的地方 */
  useEffect(() => {
    if (pickedCwd && !settings.openedCwds.some((c) => sameCwd(c, pickedCwd))) {
      setPickedCwd('')
    }
  }, [pickedCwd, settings.openedCwds])

  return (
    <div className="app">
      <TitleBar update={updater} />
      <div className="app__body">
        {/*
          设置页会把审批面板整个盖住 —— 这时候连「当前会话」也该提醒。
          所以只有真正看着对话时才把 active 传下去。
        */}
        <Sidebar
          workspaces={visible}
          loading={loading}
          running={running}
          completed={completed}
          failed={failed}
          pending={pendingApprovals}
          background={background}
          sort={sort}
          onToggleSort={toggleSort}
          activeId={activeStoredId}
          worktreeBranches={worktreeBranches}
          onSelect={openStored}
          onRequestNewSession={setNewSessionCwd}
          onCloseWorkspace={closeWorkspace}
          onOpenIde={(cwd) => void window.api?.ide?.open(cwd)}
          onPickWorkspace={(title) => void pickWorkspace(title)}
          onDeleteSession={setPendingDelete}
          onDeleteSessions={(list) => setPendingDeleteBatch(list)}
          selectionReset={selectionReset}
          onRefresh={() => void refresh()}
          onOpenSettings={() => setView('settings')}
          onOpenSearch={() => setSearchOpen(true)}
          meta={meta}
          onUpdateMeta={updateSessionMeta}
          showArchived={showArchived}
          archivedCount={archivedCount}
          onToggleArchived={() => setShowArchived((v) => !v)}
        />
        {view === 'settings' ? (
          <SettingsPage
            initialPage={openMcpSettings ? 'mcp' : undefined}
            onBack={() => {
              setView('chat')
              setOpenMcpSettings(false)
            }}
          />
        ) : (
          <MainPane
            active={active}
            // 重命名只存在于本地元数据里；标题栏优先用它，清空后回落到 CLI 原标题
            titleOverride={
              active.kind === 'stored'
                ? (meta[sessionMetaKey(active.cli, active.cwd, active.id)]?.title ?? null)
                : null
            }
            // 这条会话自己记下的模型。和标题一样，只有已有会话才有
            initialModel={
              active.kind === 'stored'
                ? (meta[sessionMetaKey(active.cli, active.cwd, active.id)]?.model ?? '')
                : ''
            }
            // 渠道 / 来源同样按会话取：别的对话切了渠道不该带过来
            initialAuthMode={
              active.kind === 'stored'
                ? meta[sessionMetaKey(active.cli, active.cwd, active.id)]?.authMode
                : undefined
            }
            initialChannelId={
              active.kind === 'stored'
                ? meta[sessionMetaKey(active.cli, active.cwd, active.id)]?.channelId
                : undefined
            }
            initialAddDirs={
              active.kind === 'stored'
                ? meta[sessionMetaKey(active.cli, active.cwd, active.id)]?.addDirs
                : undefined
            }
            onPersistModel={persistSessionModel}
            onPersistAuth={persistSessionAuth}
            onPersistAddDirs={persistSessionAddDirs}
            recentAddDirs={recentAddDirs}
            // 默认工作目录留空时的兜底。会话列表没读完就建会话会用到空 cwd，
            // 所以 MainPane 要等 loading 落了才动手
            fallbackCwd={lastCwd}
            cwdReady={!loading}
            metaReady={!metaLoading}
            onNewSession={newSession}
            onActiveInfo={reportActive}
            incomingRefs={incomingRefs}
            onIncomingConsumed={() => setIncomingRefs(null)}
            /**
             * 标题栏「•••」用的当前会话元数据。新会话还没有身份，
             * 重命名 / 置顶 / 归档 / 删除都不会出现在菜单里。
             */
            sessionMeta={
              active.kind === 'stored'
                ? meta[sessionMetaKey(active.cli, active.cwd, active.id)]
                : undefined
            }
            onUpdateMeta={(patch) => {
              if (active.kind === 'stored') void updateSessionMeta(active, patch)
            }}
            onDeleteActive={() => {
              if (active.kind === 'stored') setPendingDelete(active)
            }}
          />
        )}
      </div>

      {notice && (
        <div className="notice notice--float">
          <span>{notice}</span>
          <button
            className="iconbtn iconbtn--sm"
            onClick={() => setNotice(null)}
            title={t('common.close')}
          >
            ×
          </button>
        </div>
      )}

      {searchOpen && (
        <SessionSearch
          sessions={allSessions}
          meta={meta}
          onClose={() => setSearchOpen(false)}
          onSelect={openFromSearch}
        />
      )}

      {newSessionCwd && (
        <NewSessionDialog
          cwd={newSessionCwd}
          onCancel={() => setNewSessionCwd(null)}
          onStart={startNewSession}
        />
      )}

      {migrationPrompt > 0 && (
        <ConfirmModal
          title={t('mcp.migrate.title')}
          badge={t('mcp.migrate.kicker')}
          confirmLabel={t('mcp.migrate.review')}
          onCancel={() => setMigrationPrompt(0)}
          onConfirm={() => {
            setMigrationPrompt(0)
            setOpenMcpSettings(true)
            setView('settings')
          }}
        >
          <p>{t('mcp.migrate.startupBody', { count: migrationPrompt })}</p>
          <p className="delinfo__warn">{t('mcp.migrate.startupHint')}</p>
        </ConfirmModal>
      )}

      {pendingDelete && (
        <ConfirmModal
          title={t('chat.delete.title')}
          badge={t('chat.delete.badge')}
          confirmLabel={t('chat.delete.confirm')}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
        >
          <div className="delinfo">
            <div className="delinfo__title">
              {meta[sessionMetaKey(pendingDelete.cli, pendingDelete.cwd, pendingDelete.id)]
                ?.title || pendingDelete.title}
            </div>
            <div className="delinfo__path">
              {pendingDelete.cwd} · {pendingDelete.id.slice(0, 8)}
            </div>
            <p className="delinfo__warn">{t('chat.delete.body')}</p>
          </div>
        </ConfirmModal>
      )}
      {pendingDeleteBatch && pendingDeleteBatch.length > 0 && (
        <ConfirmModal
          title={tn('sidebar.deleteBatchTitle', pendingDeleteBatch.length)}
          badge={t('chat.delete.badge')}
          confirmLabel={tn('sidebar.deleteBatchConfirm', pendingDeleteBatch.length)}
          onCancel={() => setPendingDeleteBatch(null)}
          onConfirm={() => void confirmDeleteBatch()}
        >
          <div className="delinfo">
            {/*
              按工作区分组列出。同一批可能跨多个目录，
              平铺一列长标题看不出「删的是哪几组」，也没法先扫一眼定位。
            */}
            {groupByCwd(pendingDeleteBatch).map(([cwd, list]) => (
              <div className="delbatch__group" key={cwd}>
                <div className="delbatch__cwd">{cwd}</div>
                {list.map((s) => {
                  const key = sessionMetaKey(s.cli, s.cwd, s.id)
                  return (
                    <div className="delbatch__row" key={key}>
                      <span className="delbatch__cli">{cliDef(s.cli).name}</span>
                      <span className="delbatch__title">{meta[key]?.title || s.title}</span>
                      {running.has(s.id) && (
                        <span className="delbatch__state">
                          {t('sidebar.running')}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
            <p className="delinfo__warn">{t('sidebar.deleteBatchBody')}</p>
            {runningCount > 0 && (
              <p className="delinfo__warn delinfo__warn--run">
                <b>{tn('sidebar.deleteBatchRunning', runningCount)}</b>
                {' · '}
                {t('sidebar.deleteBatchRunningWarn')}
              </p>
            )}
          </div>
        </ConfirmModal>
      )}
      {whatsNew.pending && (
        <WhatsNewModal
          release={whatsNew.pending.release}
          welcome={whatsNew.pending.welcome}
          onClose={whatsNew.dismiss}
        />
      )}
    </div>
  )
}
