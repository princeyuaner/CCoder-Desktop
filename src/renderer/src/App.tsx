import { useCallback, useEffect, useRef, useState } from 'react'
import type { StoredSession } from '@shared/session'
import { sameCwd, type CliId } from '@shared/settings'
import { disposeIdleNewChats, disposeStoredChat } from './useChat'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { MainPane } from './components/MainPane'
import { SettingsPage } from './components/SettingsPage'
import { ConfirmModal } from './components/ConfirmModal'
import { UpdateToast } from './components/UpdateToast'
import { baseName } from '@shared/path'
import { useSessions, type WorkspaceView } from './useSessions'
import { useSettings } from './useSettings'
import { useUpdater } from './useUpdater'
import { applyAppearance } from './appearance'
import { applyLanguageSetting, useI18n } from './i18n'
import { onNotice } from './notice'
import type { ChatActiveInfo, IdeCodeRef, IdeSendPayload } from '@shared/ide-chat'
import './styles/shell.css'
import './styles/chat.css'
import './styles/settings.css'
import './styles/panel.css'
import './styles/update.css'
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

export function App(): JSX.Element {
  const { t } = useI18n()
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
    pending: pendingApprovals,
    sort,
    toggleSort,
    refresh
  } = useSessions(activeStoredId)
  const { settings, save } = useSettings()
  const updater = useUpdater()

  // 设置落盘（或启动时读完）后立刻应用语言 / 主题 / 缩放 / 字体
  useEffect(() => {
    applyLanguageSetting(settings.language)
    applyAppearance(settings)
  }, [settings])
  /** 等着确认删除的那条会话。null = 没在删 */
  const [pendingDelete, setPendingDelete] = useState<StoredSession | null>(null)
  /** 删除失败的说明，浮在顶上 */
  const [notice, setNotice] = useState<string | null>(null)

  // 深层组件（工具卡 → IDE）走轻量事件总线报告失败，统一在这里显示
  useEffect(() => onNotice(setNotice), [])

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
  const visible: WorkspaceView[] = opened.map((cwd) => {
    const hit = workspaces.find((w) => sameCwd(w.cwd, cwd))
    return hit ?? { cwd, name: baseName(cwd), sessions: [] }
  })

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
   * 关闭工作区。**只是收起来，一个文件都不删** —— 目录是 CLI 的地盘，
   * 我们没权力删。收起来的列表落盘，底部有入口能放回来。
   */
  /** 打开一个目录。合并去重（同一个目录两种斜杠写法也算同一个） */
  const openWorkspace = (cwd: string): void => {
    if (opened.some((c) => sameCwd(c, cwd))) return
    void save({ ...settings, openedCwds: [cwd, ...opened] })
  }

  /** 从列表里去掉。**不删任何文件** —— 目录还在，随时能再打开 */
  const closeWorkspace = (cwd: string): void => {
    // 刚从这个目录开过会话的话，把它从"上次打开的目录"里摘掉 ——
    // 不然下一次开新会话会悄悄落进一个你刚关掉的地方
    if (pickedCwd && sameCwd(pickedCwd, cwd)) setPickedCwd('')
    void save({ ...settings, openedCwds: opened.filter((c) => !sameCwd(c, cwd)) })
  }

  /** 弹系统目录选择器 */
  const pickWorkspace = async (): Promise<void> => {
    const dir = await window.api?.sessions.pickDir()
    if (dir) openWorkspace(dir)
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
      <TitleBar />
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
          pending={pendingApprovals}
          sort={sort}
          onToggleSort={toggleSort}
          activeId={activeStoredId}
          onSelect={openStored}
          onNewSession={newSession}
          onCloseWorkspace={closeWorkspace}
          onOpenIde={(cwd) => void window.api?.ide?.open(cwd)}
          onPickWorkspace={() => void pickWorkspace()}
          onDeleteSession={setPendingDelete}
          onRefresh={() => void refresh()}
          onOpenSettings={() => setView('settings')}
        />
        {view === 'settings' ? (
          <SettingsPage onBack={() => setView('chat')} />
        ) : (
          <MainPane
            active={active}
            // 默认工作目录留空时的兜底。会话列表没读完就建会话会用到空 cwd，
            // 所以 MainPane 要等 loading 落了才动手
            fallbackCwd={lastCwd}
            cwdReady={!loading}
            onNewSession={newSession}
            onActiveInfo={reportActive}
            incomingRefs={incomingRefs}
            onIncomingConsumed={() => setIncomingRefs(null)}
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

      <UpdateToast
        state={updater.state}
        onDownload={updater.download}
        onInstall={updater.install}
      />

      {pendingDelete && (
        <ConfirmModal
          title={t('chat.delete.title')}
          badge={t('chat.delete.badge')}
          confirmLabel={t('chat.delete.confirm')}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
        >
          <div className="delinfo">
            <div className="delinfo__title">{pendingDelete.title}</div>
            <div className="delinfo__path">
              {pendingDelete.cwd} · {pendingDelete.id.slice(0, 8)}
            </div>
            <p className="delinfo__warn">{t('chat.delete.body')}</p>
          </div>
        </ConfirmModal>
      )}
    </div>
  )
}
