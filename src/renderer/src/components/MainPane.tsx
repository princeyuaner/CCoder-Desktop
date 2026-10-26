import { useEffect, useRef, useState } from 'react'
import { activeChannelOf, cliConfig, type CliId } from '@shared/settings'
import { sameModel } from '@shared/model'
import type { ChatActiveInfo, IdeCodeRef } from '@shared/ide-chat'
import { parseIdeRefs } from '../ideRef'
import { MODE_LABEL_KEY } from '../constants'
import { useSettings } from '../useSettings'
import { useI18n } from '../i18n'
import {
  disposeNewChat,
  disposeStoredChat,
  useChat,
  type ChannelLabel,
  type ChatItem
} from '../useChat'
import type { Active } from '../App'
import { ChatHeader } from './ChatHeader'
import { ConfirmModal } from './ConfirmModal'
import { IconArrowRight, IconBranch, IconOpenInIde } from './Icons'
import { notify } from '../notice'
import { isBackgroundAgent } from '../run-state'
import { TabBar, type TabKey } from './TabBar'
import { Transcript } from './Transcript'
import { Composer, type ModelSelection } from './Composer'
import { StatusBar } from './StatusBar'
import { PermissionModal } from './PermissionModal'
import { QuestionDrawer } from './QuestionDrawer'
import { RunPanel } from './RunPanel'

interface Props {
  active: Active
  /** 本地重命名后的标题；null = 用会话记录里的原标题 */
  titleOverride?: string | null
  /**
   * 这条已有会话自己选过的模型（来自 session-meta）。
   * 打开会话时作为启动参数传下去，不能套用别的对话或全局默认。
   */
  initialModel?: string
  /** 把会话级模型选择写进 session-meta；新会话要等拿到 CLI id 才有 key */
  onPersistModel?: (cli: CliId, cwd: string, id: string, model: string) => void
  /** 设置里「默认工作目录」留空时，新会话落到哪 —— 通常是上次打开的那个目录 */
  fallbackCwd: string
  /** 会话列表读完了没。没读完 fallbackCwd 还是空的，这时候建会话会跑错地方 */
  cwdReady: boolean
  /**
   * 会话元数据读完没。没读完时 initialModel 还是空串 —— 抢在它前面建会话，
   * 已有会话就会丢掉自己记下的模型。默认 true（没有元数据也能跑）。
   */
  metaReady?: boolean
  /** /clear：切到同目录下的一条新会话 */
  onNewSession: (cwd?: string) => void
  /** 把当前会话（含真实 cwd / 标题）报给 App，再转给主进程 */
  onActiveInfo: (info: ChatActiveInfo) => void
  /** IDE 发来的代码引用，等 Composer 收下 */
  incomingRefs: { nonce: number; refs: IdeCodeRef[] } | null
  onIncomingConsumed: () => void
}

/** 当前会话跑在一条 linked worktree 里时，顶部信息条要显示的内容 */
interface WorktreeInfo {
  branch: string
  path: string
  mainPath: string
  mainBranch: string
}

export function MainPane({
  active,
  titleOverride,
  initialModel,
  onPersistModel,
  fallbackCwd,
  cwdReady,
  metaReady = true,
  onNewSession,
  onActiveInfo,
  incomingRefs,
  onIncomingConsumed
}: Props): JSX.Element {
  const { t, text } = useI18n()
  const [tab, setTab] = useState<TabKey>('chat')
  /** 新会话用哪个 CLI。换 CLI 就是另一套 provider + 另一份会话记录，等于开新会话 */
  const [pickedCli, setPickedCli] = useState<CliId>('claude')
  /**
   * 这条会话跑在哪个 CLI 上。
   *
   * 打开已有会话时**由那条会话自己决定** —— 会话身份是 (cli, cwd, id)，
   * 拿错的 CLI 去 --resume 是找不到的。新会话才用用户挑的那个。
   */
  const cli: CliId = active.kind === 'stored' ? active.cli : pickedCli
  const { settings, loading, save } = useSettings()

  /**
   * 打开已有会话时用它的 cwd —— CLI 靠 cwd 找那份记录，不能拿默认目录顶替。
   * 新会话：设置里填了就用填的，没填就沿用上次打开的目录（见 App 的 lastCwd），
   * 一路都没有才落到空串，主进程会兜到用户主目录。
   */
  const cwd =
    active.kind === 'stored'
      ? active.cwd
      : // 在工作区标题的「+」上开的新会话带着自己的目录，优先用它
        active.cwd || settings.defaultCwd.trim() || fallbackCwd
  /**
   * 标题旁的分支小标签 + 工作树信息条。
   *
   * 只做展示：读不到 / 不是仓库就什么都不显示。linked worktree 里的会话
   * 会多一条顶部信息条，能直接打开 IDE 或把分支合并进主工作树。
   */
  const [branch, setBranch] = useState('')
  const [worktree, setWorktree] = useState<WorktreeInfo | null>(null)
  useEffect(() => {
    let alive = true
    setBranch('')
    setWorktree(null)
    if (!cwd) return
    const api = window.api?.vcs
    if (!api) return
    void (async () => {
      try {
        const detected = await api.detect(cwd)
        const repo = detected.ok ? detected.data.repo : null
        if (!alive || !repo || repo.kind !== 'git') return
        // detached HEAD 的 branch 是占位字符串，不值得占一个标签
        if (!repo.detached) setBranch(repo.branch)

        const listed = await api.worktreeList({ cwd })
        if (!alive || !listed.ok) return
        const current = listed.data.worktrees.find((w) => w.current)
        const main = listed.data.worktrees.find((w) => w.main)
        if (!current || current.main || !current.exists || !current.branch || !main) return
        setWorktree({
          branch: current.branch,
          path: current.path,
          mainPath: main.path,
          // 主工作树 detached 时没有目标分支，信息条照样显示，只是不给合并
          mainBranch: main.branch ?? ''
        })
      } catch {
        // 读不到 VCS 信息不影响会话本身
      }
    })()
    return () => {
      alive = false
    }
  }, [cwd])

  const [mergeOpen, setMergeOpen] = useState(false)
  const [merging, setMerging] = useState(false)

  const doMerge = async (): Promise<void> => {
    if (!worktree || merging) return
    setMergeOpen(false)
    setMerging(true)
    try {
      const r = await window.api?.vcs.mergeWorktree({ cwd, branch: worktree.branch })
      if (!r) return
      if (!r.ok) {
        notify(r.error.message)
        return
      }
      notify(
        r.data.merged
          ? t('worktree.mergeDone', { source: r.data.branch, target: r.data.target })
          : t('worktree.mergeNothing')
      )
    } catch (err) {
      notify(err instanceof Error ? err.message : t('errors.unknownReason'))
    } finally {
      setMerging(false)
    }
  }

  const resumeId = active.kind === 'stored' ? active.id : null
  /** 这条会话的身份：已有会话是它的 id，新会话是序号。换会话时转写区靠它复位 */
  const sessionKey =
    active.kind === 'stored' ? `${active.cwd}\u0000${active.id}` : `new\u0000${active.n}`

  const chat = useChat({
    cli,
    cwd,
    permissionMode: settings.permissionMode,
    effort: cliConfig(settings, cli).effort,
    // 打开已有会话时用它自己记下的模型；新会话交给选择器 / 默认值
    model: active.kind === 'stored' ? (initialModel ?? '') : '',
    resumeId,
    // 新会话每次点都换一个序号，不然连点两次时依赖没变，会话不会重建
    freshKey: active.kind === 'new' ? active.n : undefined,
    // 设置、会话列表和会话元数据都加载完再建会话 —— 否则会用到默认的
    // cwd/权限模式，或者一个还没播种的 fallbackCwd，会话就跑到主目录去了；
    // 元数据没到还会丢掉已有会话自己记下的模型
    enabled: !loading && cwdReady && metaReady
  })

  // busy 而不是 status === 'running'：连 CLI 的那段（starting）也算这一轮在跑，
  // 不然"连接中"的时候发送键还是发送键，没法停
  const running = chat.busy
  /**
   * 执行台的「进行中」。
   *
   * 主对话这一轮结束了，后台子代理可能还在跑 —— 只看 chat.busy 会把它
   * 误标成已完成。只要还有 running 的代理，面板就继续显示运行中。
   */
  const agentsRunning = chat.run.agents.filter((a) => a.status === 'running').length
  /**
   * 后台 shell / workflow / 后台子代理还在跑。
   *
   * 主对话这一轮可能已经结束，但它们没跑完 —— 执行台要继续显示运行中，
   * 轮末也不能写「已完成」。
   */
  const backgroundRunning =
    chat.run.background.filter((b) => b.status === 'running').length +
    // 后台启动的子代理同样可能在轮末之后继续跑
    chat.run.agents.filter(
      (a) =>
        a.status === 'running' &&
        // 历史回放里的 startedAt=0，不能当成还在跑
        a.startedAt > 0 &&
        isBackgroundAgent(a)
    ).length
  const panelLive = running || agentsRunning > 0 || backgroundRunning > 0

  /**
   * 执行台的展开状态。
   *
   * `null` = 跟着数据走：一旦本轮有任务或子代理就自动展开。
   * 用户手动收起来之后记 false，这一轮不再自己弹开；换会话时复位。
   */
  const [panelPref, setPanelPref] = useState<boolean | null>(null)
  const hasRunInfo =
    chat.run.tasks.length > 0 ||
    chat.run.agents.length > 0 ||
    chat.run.background.length > 0
  const panelOpen = hasRunInfo && (panelPref ?? true)

  useEffect(() => {
    setPanelPref(null)
  }, [cli, sessionKey])
  const cfg = cliConfig(settings, cli)
  /**
   * 不挂渠道的模式：Claude 用官方 OAuth，dsh 用 DSH_HOME 里已有的 Harness 凭据。
   * 两者都靠 officialModel 兜底。
   */
  const official = (cli === 'claude' || cli === 'dsh') && cfg.authMode === 'official'
  const activeCh = official ? null : activeChannelOf(settings, cli)

  /*
   * 上下文胶囊要算百分比，就得知道上下文窗口上限；上限只写在模型名的
   * 标记里（`deepseek-v4.1-flash[1m]`）。
   *
   * 打开已有会话时 CLI **还没启动**（首次发送才 spawn），所以 chat.model
   * 是空的；而历史记录里的模型名是 API 规范化后的 id，`[1m]` 已经被抹掉了
   * （dsh 那边 `deepseek-v4.1-flash` 会落成 `deepseek-flash`）。两种情况下
   * 都算不出窗口，胶囊只能退回显示「340.9k」这种绝对值。
   *
   * 渠道配置里的模型名是用户填的原始串，按同一口径（去标记 + 别名归一）
   * 匹配，就能把窗口信息补回来，顺便让胶囊显示用户熟悉的那个写法。
   */
  const modelPool = official
    ? [cfg.officialModel]
    : [activeCh?.model ?? '', ...(activeCh?.models ?? [])].filter(
        (m) => m.trim().length > 0
      )
  const matchedModel = chat.model.trim()
    ? modelPool.find((m) => sameModel(m, chat.model))
    : undefined
  /**
   * 展示 / 算窗口用的模型名。
   *
   * **会话自己报过的模型优先**：`cfg` 来自全局设置，而模型是每条会话独立
   * 选的。另一条对话改了设置里的默认模型时，这条会话仍然跑在自己的模型上，
   * 不能跟着显示成新的默认值。
   * chat.model 为空（还没启动 / 历史里没记）时，才回落到渠道或设置的默认值；
   * 匹配上配置里的原始写法则优先用它，取回 `[1m]` 这类会话语义。
   */
  const displayModel = chat.model
    ? matchedModel ?? chat.model
    : official
      ? cfg.officialModel
      : activeCh?.model ?? ''

  /**
   * 会话级模型选择的落盘。
   *
   * 已有会话的 id 立刻就有；新会话要等第一条消息发出、CLI 回报自己的 id
   * 才知道这条记录会落在哪个 key 下 —— 先记在 pendingModelSave 里，
   * 等 id 到了再补写。
   */
  const pendingModelSave = useRef<string | null>(null)
  const persistModel = (model: string): void => {
    if (!onPersistModel) return
    if (active.kind === 'stored') {
      onPersistModel(active.cli, active.cwd, active.id, model)
      return
    }
    const id = chat.sessionId
    if (id) onPersistModel(cli, chat.sessionCwd || cwd, id, model)
    else pendingModelSave.current = model
  }

  useEffect(() => {
    if (active.kind !== 'new' || !onPersistModel) return
    const id = chat.sessionId
    const model = pendingModelSave.current
    if (!id || model === null) return
    pendingModelSave.current = null
    onPersistModel(cli, chat.sessionCwd || cwd, id, model)
  }, [active.kind, chat.sessionId, chat.sessionCwd, cli, cwd, onPersistModel])

  /**
   * 跨 CLI 选模型时，新会话对象要下一次渲染才建好 —— 先把模型记下来，
   * 等它出现再补上。否则 `applyModel` 会落到刚被换掉的那条会话上。
   */
  const pendingModel = useRef<{ cli: CliId; model: string } | null>(null)

  useEffect(() => {
    const p = pendingModel.current
    if (!p) return
    // 只在这一帧确实切到了目标 CLI 时才用；否则（比如看的是已有会话，
    // 换 CLI 并不会真的生效）丢掉，别让它留到下一次新会话上
    pendingModel.current = null
    if (p.cli === cli) {
      chat.applyModel(p.model)
      persistModel(p.model)
    }
  }, [cli, chat])

  /**
   * 模型选择器落下一套选择。三列是**同一个决定**的三个部分（哪个 CLI、
   * 哪个端点、哪个模型），点哪一列都从这里走。
   *
   * 渠道和模型都是**启动参数**（就是注入给 CLI 的那几个环境变量），
   * 不换进程不生效 —— 改完设置还得让会话重开一个进程；主进程 spawn 时
   * 会自己重新读一遍当前渠道，这里不用把渠道传下去。
   *
   * **模型只作用于当前会话**：它不落盘成 `officialModel`（那是新会话的
   * 默认值，设置页里单独管）。把会话级选择写进全局配置，会让同一 CLI 的
   * 其他对话跟着切换 —— 这正是「A 换模型 B 也变」的来源。
   *
   * 换 CLI 则是另一条会话（另一套 provider + 另一份记录），旧 controller
   * 必须收掉 —— 否则它会挂在后台，而且没有侧栏行能再点回来。
   */
  const pickSelection = (sel: ModelSelection): void => {
    const targetCfg = cliConfig(settings, sel.cli)

    // 凭据来源跟着选择一起落盘：选官方账号 → official；选真实渠道 → channel。
    // 渠道配置原样保留。
    //
    // 只写**真正变了**的字段：换模型（没换渠道 / 来源）不应该产生一次设置保存，
    // 否则会顺带触发一轮全局设置广播，完全是噪音。
    const patch: Partial<typeof targetCfg> = {}
    if (sel.channelId && sel.channelId !== targetCfg.activeChannelId) {
      patch.activeChannelId = sel.channelId
    }
    if (sel.official) {
      if (targetCfg.authMode !== 'official') patch.authMode = 'official'
    } else if (sel.channelId && (sel.cli === 'claude' || sel.cli === 'dsh')) {
      if (targetCfg.authMode !== 'channel') patch.authMode = 'channel'
    }

    const persist =
      Object.keys(patch).length > 0
        ? save({
            ...settings,
            clis: {
              ...settings.clis,
              [sel.cli]: { ...targetCfg, ...patch }
            }
          })
        : Promise.resolve(settings)

    /*
     * **先落盘再改会话**。
     *
     * 主进程的 settingsSave 会调 SettingsManager.settingsChanged()：切换凭据
     * 来源时它会清掉会话里显式设过的模型。如果 applyModel 抢在保存前面到达，
     * 用户刚选的模型会被随后到达的 settingsChanged 清掉。
     */
    void persist
      .then(() => {
        if (sel.cli !== cli) {
          if (active.kind === 'new') disposeNewChat(cli, active.n)
          setPickedCli(sel.cli)
          // 新会话的 controller 还没建好，模型等它出现再应用
          if (sel.model) pendingModel.current = { cli: sel.cli, model: sel.model }
          return
        }

        // 同一条 CLI：渠道 / 模型都是启动参数，重开进程并 --resume 接回会话
        // 留痕存的是结构化名字，翻译交给渲染时做
        const chanLabel = (cid: string | null): ChannelLabel => ({
          kind: 'channel',
          name: targetCfg.channels.find((c) => c.id === cid)?.name || ''
        })
        const officialLabel: ChannelLabel = { kind: 'official' }

        if (sel.official) {
          // 已经在官方模式时只需要应用模型，别再留一条「官方账号 → 官方账号」
          if (!official) chat.applyAuth(chanLabel(targetCfg.activeChannelId), officialLabel)
        } else if (sel.channelId) {
          chat.applyChannel(
            official ? officialLabel : chanLabel(targetCfg.activeChannelId),
            chanLabel(sel.channelId)
          )
        }
        // '' 是选择器里的「默认（CLI 决定）」—— 也要落到会话上，把之前的
        // 显式模型清掉；用 undefined 判断，不能用真假值（空串会被漏掉）
        if (sel.model !== undefined) {
          chat.applyModel(sel.model)
          persistModel(sel.model)
        }
      })
      .catch(() => undefined)
  }

  /**
   * /clear：清空就是停掉当前会话再开一条新的。
   * 后台保留的是「切走」的会话，不是「被清空」的会话。
   */
  const clearConversation = (): void => {
    if (active.kind === 'stored') disposeStoredChat(active.cli, active.cwd, active.id)
    else disposeNewChat(cli, active.n)
    onNewSession(cwd)
  }

  /**
   * 待回答的审批。**同时只弹第一条** —— 弹窗天生一次只能问一件事，
   * 后面排队的等这条答完自动顶上，右上角的 1/N 让用户知道还排着几条。
   */
  const pending = chat.items.filter(
    (i): i is Extract<ChatItem, { kind: 'permission' }> =>
      i.kind === 'permission' && i.state === 'pending'
  )

  /**
   * 待回答的提问。和审批一样一次只显示一组；一组里可以有多道题，
   * 由 QuestionDrawer 自己分步走完。
   */
  const pendingQuestions = chat.items.filter(
    (i): i is Extract<ChatItem, { kind: 'question' }> =>
      i.kind === 'question' && i.state === 'pending'
  )

  // 本轮改过的文件：输入框左上角那颗按钮由 Composer 自己渲染。
  // 数据来自 file_change 事件（工具、子代理、轮末磁盘快照都会汇进来）。
  const changedFiles = chat.files

  const firstUser = chat.items.find((i) => i.kind === 'user')
  // 首条消息可能带着 IDE 代码引用块，标题只取用户自己写的那部分
  const firstText =
    firstUser && firstUser.kind === 'user' ? parseIdeRefs(firstUser.text).text.trim() : ''
  const title =
    active.kind === 'stored'
      ? titleOverride || active.title
      : firstUser && firstUser.kind === 'user'
        ? firstText
          ? firstText.slice(0, 40)
          : firstUser.images?.length
            ? t('chat.title.imageMessage')
            : t('chat.title.newSession')
        : t('chat.title.newSession')

  /*
   * IDE 的「发送到聊天」要知道主窗口现在停在哪个工作区 / 哪条会话。
   * 这里报的是**有效 cwd**（含设置里的默认目录和侧栏兜底），
   * App 自己算不出来。
   */
  const activeId = active.kind === 'stored' ? active.id : null
  useEffect(() => {
    onActiveInfo({
      cwd,
      cli,
      id: activeId,
      title,
      isNew: active.kind === 'new'
    })
  }, [cwd, cli, activeId, title, active.kind, onActiveInfo])

  return (
    <main className={`mainpane ${panelOpen ? 'has-panel' : ''}`}>
      <div className="chatcol">
        <ChatHeader
          title={title}
          branch={branch}
          modeLabel={t(MODE_LABEL_KEY[chat.permissionMode])}
          hasRunInfo={hasRunInfo}
          panelOpen={panelOpen}
          live={panelLive}
          onTogglePanel={() => setPanelPref(!panelOpen)}
        />

        {worktree && (
          <div className="wtbar" title={worktree.path}>
            <span className="wtbar__badge">
              <IconBranch width={12} height={12} />
              {t('worktree.badge')}
            </span>
            <span className="wtbar__branch">{worktree.branch}</span>
            <code className="wtbar__path">{worktree.path}</code>
            <div className="wtbar__right">
              <button
                className="wtbar__btn"
                onClick={() => void window.api?.ide?.open(cwd)}
              >
                <IconOpenInIde width={12} height={12} />
                {t('worktree.openInIde')}
              </button>
              {worktree.mainBranch && (
                <button
                  className="wtbar__btn wtbar__btn--primary"
                  disabled={merging}
                  onClick={() => setMergeOpen(true)}
                >
                  <IconArrowRight width={12} height={12} />
                  {merging
                    ? t('worktree.merging')
                    : t('worktree.mergeTo', { branch: worktree.mainBranch })}
                </button>
              )}
            </div>
          </div>
        )}

        {active.kind === 'stored' && (
          <div className="resume-bar" title={active.cwd}>
            {t('chat.resumeBar', { cwd: active.cwd })}
          </div>
        )}

        {chat.notice && (
          <div className="notice">
            <span>{text(chat.notice)}</span>
            <button
              className="iconbtn iconbtn--sm"
              onClick={chat.clearNotice}
              title={t('common.close')}
            >
              ×
            </button>
          </div>
        )}

        <TabBar active={tab} onChange={setTab} />
        <Transcript
          items={chat.items}
          tab={tab}
          status={chat.status}
          agentsRunning={agentsRunning}
          backgroundRunning={backgroundRunning}
          // 等待占位的计时起点跟着会话状态走，切走再切回来能续上
          waitingSince={chat.waitingSince}
          // 换会话时转写区的滚动位置要复位。带上 cli —— 换 CLI 也是换会话
          sessionKey={`${cli}\u0000${sessionKey}`}
          showTimestamps={settings.showTimestamps}
          thinkingOpen={settings.thinkingOpen}
          toolDetail={settings.toolDetail}
          cwd={cwd}
        />
        {/*
          提问抽屉：贴在输入框上方，不遮转写区。
          输入框会被锁住 —— 答题和发新消息不能同时进行。
        */}
        {pendingQuestions[0] && (
          <QuestionDrawer
            key={pendingQuestions[0].id}
            item={pendingQuestions[0]}
            pendingCount={pendingQuestions.length}
            onAnswer={chat.answerQuestion}
          />
        )}

        <Composer
          onSend={(input, meta) => void chat.send(input, meta)}
          onInterrupt={chat.interrupt}
          running={running}
          queue={chat.queue}
          queuePaused={chat.queuePaused}
          onRemoveQueued={chat.removeQueued}
          onClearQueue={chat.clearQueue}
          onTakeQueued={chat.takeQueued}
          onMoveQueued={chat.moveQueued}
          onResumeQueue={chat.resumeQueue}
          locked={pendingQuestions.length > 0}
          cli={cli}
          cliConfigs={settings.clis}
          activeChannelId={official ? null : cfg.activeChannelId}
          model={displayModel}
          permissionMode={chat.permissionMode}
          effort={chat.effort}
          cwd={cwd}
          changedFiles={changedFiles}
          nativeCommands={chat.nativeCommands}
          onRunCommand={chat.runCommand}
          sendKey={settings.sendKey}
          hasConversation={chat.items.length > 0}
          turns={chat.turns}
          steps={chat.steps}
          usage={chat.usage}
          onSelect={pickSelection}
          onModeChange={chat.applyPermissionMode}
          onEffortChange={chat.applyEffort}
          onClearConversation={clearConversation}
          incomingRefs={incomingRefs}
          onIncomingConsumed={onIncomingConsumed}
        />
        <StatusBar
          turns={chat.turns}
          steps={chat.steps}
          usage={chat.usage}
          live={chat.busy}
          liveRate={chat.liveRate}
        />
      </div>

      {/*
        执行台：有任务或子代理时自动出现在右侧。收起来之后正文恢复原宽，
        顶部那个面板按钮随时能再打开。
      */}
      {panelOpen && (
        <RunPanel
          // 换会话时把卡片里的弹窗选择一起清掉
          key={`${cli}\u0000${sessionKey}`}
          run={chat.run}
          live={panelLive}
          running={running}
          onInterrupt={chat.interrupt}
          onCollapse={() => setPanelPref(false)}
          onOpenTrace={() => {
            setTab('trace')
            setPanelPref(false)
          }}
        />
      )}

      {/*
        审批弹窗挂在最外层，不再塞进转写区。一次只弹一条 ——
        后面排队的等这条答完自动顶上（pendingCount 会显示 1/N）。
      */}
      {pending[0] && (
        <PermissionModal item={pending[0]} pendingCount={pending.length} onRespond={chat.respond} />
      )}

      {mergeOpen && worktree && (
        <ConfirmModal
          title={t('worktree.mergeTitle', { branch: worktree.mainBranch })}
          badge={t('worktree.badge')}
          confirmLabel={t('worktree.mergeConfirm')}
          onCancel={() => setMergeOpen(false)}
          onConfirm={() => void doMerge()}
        >
          <div className="wtmerge">
            <div className="wtmerge__flow">
              <code>{worktree.branch}</code>
              <IconArrowRight width={13} height={13} />
              <code>{worktree.mainBranch}</code>
            </div>
            <p className="wtmerge__body">
              {t('worktree.mergeBody', {
                source: worktree.branch,
                target: worktree.mainBranch
              })}
            </p>
          </div>
        </ConfirmModal>
      )}
    </main>
  )
}
