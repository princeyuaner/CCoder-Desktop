import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { PermissionMode } from '@shared/events'
import type { SessionStatus } from '@shared/session'
import { EFFORT_LABEL_KEY, type EffortLevel, type ToolDetail } from '@shared/settings'
import { formatDuration, formatTimestamp, type MessageKey } from '@shared/i18n'
import { toolFamily, type ToolFallback, type ToolFamily } from '@shared/tool'
import {
  waitingOnModel,
  type ChannelLabel,
  type ChatItem,
  type SystemKey
} from '../useChat'
import type { ImageAttachment } from '@shared/attachment'
import { ImageLightbox } from './ImageLightbox'
import { MarkdownText } from './MarkdownText'
import { fmtClock, fmtTokens, totalTokens } from './format'
import type { TabKey } from './TabBar'
import {
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconOpenInIde,
  IconPencil,
  IconRefresh,
  IconSearch,
  IconSlash,
  IconX
} from './Icons'
import { notify } from '../notice'
import { baseName } from '@shared/path'
import { parseIdeRefs, userMessagePlainText, refRangeLabel, type ParsedIdeRef } from '../ideRef'
import { MODE_LABEL_KEY } from '../constants'
import { useI18n } from '../i18n'
import { useFindInConversation, type FindApi } from '../useFind'

/** 离底部多近算"贴着底部"（像素） */
const NEAR_BOTTOM = 48

/**
 * 多少行打成一包。
 *
 * 一条长会话能有 5000+ 行。每来一个流式 delta，Transcript 都要重新渲染 ——
 * 即使 Row 已经 memo，React 仍要逐行比一遍，5000 次浅比较在开发模式下就是
 * 几十毫秒一帧。按块包起来之后，只有**装着变化那一行**的块会重新渲染，
 * 其余块的 memo 比较走的是"整块 item 引用全等"的快速路径。
 */
const ROW_CHUNK = 40

/** 工具族 → 图标方块里那个字形 */
const FAMILY_GLYPH: Record<ToolFamily, string> = {
  bash: '▸_',
  read: '▤',
  edit: '✎',
  write: '＋',
  search: '⌕',
  task: '☑',
  ask: '?',
  other: '◇'
}

/** 没有可读主题时的兜底文案 */
const TOOL_FALLBACK_KEY: Record<ToolFallback, MessageKey> = {
  command: 'tool.fallback.command',
  file: 'tool.fallback.file',
  search: 'tool.fallback.search',
  webSearch: 'tool.fallback.webSearch',
  webFetch: 'tool.fallback.webFetch',
  question: 'tool.fallback.question',
  task: 'tool.fallback.task',
  todo: 'tool.fallback.todo'
}

/** 工具族 → 行尾那个小标签。other 用工具本名，MCP 那些才分得清 */
const FAMILY_LABEL: Record<ToolFamily, string> = {
  bash: 'BASH',
  read: 'READ',
  edit: 'EDIT',
  write: 'WRITE',
  search: 'SEARCH',
  task: 'TASK',
  ask: 'ASK',
  other: ''
}

/** 对话显示偏好。用 context 是因为 Row 是 memo 过的，逐层传参会把整条链都改一遍 */
interface DisplayPrefs {
  showTimestamps: boolean
  thinkingOpen: boolean
  toolDetail: ToolDetail
  /** 会话工作区 —— 工具卡点开文件时，主进程用它把绝对路径换算成 rel */
  cwd: string
  /**
   * 这一轮还在跑。运行中的工具卡靠它决定要不要继续跳耗时：
   * 进程退出 / 被打断时可能收不到 tool_result，没有这道闸，
   * 已经结束的会话里会一直有个秒表在走。
   */
  live: boolean
  /** 还在跑的后台任务数：轮末据此把「已完成」换成「后台任务运行中」 */
  backgroundRunning: number
  /** 最后一条 turn 分隔条 —— 只有它的状态还跟着实时任务走 */
  lastTurnId: string | null
}

const DEFAULT_DISPLAY: DisplayPrefs = {
  showTimestamps: false,
  thinkingOpen: false,
  toolDetail: 'full',
  cwd: '',
  live: false,
  backgroundRunning: 0,
  lastTurnId: null
}

const DisplayContext = createContext<DisplayPrefs>(DEFAULT_DISPLAY)

/**
 * 消息级动作。单独一个 context：Row 是 memo 过的，把回调当 prop 逐层传会让
 * 整条链每次父组件重渲染都失效 memo。这里的值由父组件 useMemo 稳定住。
 */
interface MessageActions {
  /** 把这条用户消息（含引用卡）放回输入框 */
  onEditMessage?: (item: Extract<ChatItem, { kind: 'user' }>) => void
  /** 重发这一轮的用户消息 —— CLI 侧会当成新的一轮 */
  onRetryTurn?: () => void
  /** 最后一条用户消息的 id；只有它后面那段的「重试」才有意义 */
  lastUserId: string | null
  /** 会话是否在跑：跑着的时候不提供「重试」 */
  busy: boolean
}

const ActionsContext = createContext<MessageActions>({
  lastUserId: null,
  busy: false
})

/** 毫秒 → 「12ms」/「1.4s」 */
function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/**
 * 失败工具卡在折叠态露出的错误摘要。
 *
 * `content` 是 CLI 返回的整段输出，可能几十 KB；这里只挑一行最像错误的，
 * 让失败卡不用展开也能读出原因。退出码有就单独标出来 —— Codex 直接给
 * `Exit code: N`，DSH 的输出里是 `[exit code: N]`。
 */
function errorSummaryOf(content: string | undefined): { code?: string; text: string } {
  const raw = (content ?? '')
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\r\n/g, '\n')
  if (!raw.trim()) return { text: '' }

  const codeMatch =
    raw.match(/\[exit code:\s*(-?\d+)\]/i) ??
    raw.match(/(?:exit code|exited with code|退出码)\s*[:=]?\s*(-?\d+)/i)

  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\[?exit code\b/i.test(l))

  // 优先挑真正说明问题的那一行；没有就退回第一行非空输出
  const hit =
    lines.find((l) =>
      /\b(error|exception|failed|failure|fatal|timed out|timeout|cannot|not found|no such file|permission denied)\b/i.test(
        l
      )
    ) ??
    lines[0] ??
    ''

  return { code: codeMatch?.[1], text: hit.replace(/\s+/g, ' ').slice(0, 300) }
}

/**
 * 运行中的工具卡每 500ms 自己重算一次耗时。
 *
 * 只给 running 行挂定时器，结算后自动清掉；历史回放的 startedAt 是 0，
 * 算出来没意义，直接不跑。
 */
function useToolElapsed(active: boolean, startedAt: number): number | undefined {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!active || !startedAt) return
    const id = window.setInterval(() => tick((n) => n + 1), 500)
    return () => window.clearInterval(id)
  }, [active, startedAt])
  return active && startedAt ? Date.now() - startedAt : undefined
}

/** 折叠时取开头一行当摘要 */
function firstLine(s: string, max = 90): string {
  const t = (s.split('\n').find((l) => l.trim()) ?? '').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 折叠时取最后一行 —— 还在写的时候用它，看得出内容在往前走 */
function lastLine(s: string, max = 90): string {
  const lines = s.split('\n').filter((l) => l.trim())
  const t = (lines[lines.length - 1] ?? '').trim()
  return t.length > max ? `…${t.slice(-max)}` : t
}

interface Props {
  items: ChatItem[]
  tab: TabKey
  /**
   * 会话状态。转写区要分得清两件事：
   * `starting` = 在连 CLI（进程还没起来），`running` = 模型在干活。
   * 对外都是"这一轮没结束"，但对用户是两件事，占位文案不一样。
   */
  status: SessionStatus
  /**
   * 还在跑的子代理数量。Agent/Task 调用不进转写区（由执行台展示），
   * 所以子代理跑着的时候转写区最后一条是"落定"的，会被判成在等模型。
   * 带上这个数才能把占位文案说准。
   */
  agentsRunning: number
  /**
   * 主对话结束后仍在跑的后台任务数。大于 0 时最后一轮的「已完成」
   * 要改成「后台任务运行中」—— 活还没干完，别给用户一个假的结束。
   */
  backgroundRunning: number
  /** 当前等待的起点（Date.now()）。切走再切回来时占位行靠它续上计时 */
  waitingSince?: number
  /** 换会话时用它复位滚动位置 */
  sessionKey: string
  /** 以下三项来自设置 → 通用 → 对话 */
  showTimestamps: boolean
  thinkingOpen: boolean
  toolDetail: ToolDetail
  /** 当前会话的工作区目录（工具卡里的文件要在 IDE 中打开） */
  cwd: string
  /**
   * 消息级动作。不传就不显示那条 hover 工具条（轨迹页、只读回放用不到）。
   */
  onEditMessage?: (item: Extract<ChatItem, { kind: 'user' }>) => void
  onRetryTurn?: () => void
}

export function Transcript({
  items,
  tab,
  status,
  agentsRunning,
  backgroundRunning,
  waitingSince,
  sessionKey,
  showTimestamps,
  thinkingOpen,
  toolDetail,
  cwd,
  onEditMessage,
  onRetryTurn
}: Props): JSX.Element {
  const { t } = useI18n()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  /**
   * 是否跟随最新内容。
   * 用 ref 而不是 state：effect 里要读到**当前**值，state 更新是异步的，
   * 同一批 commit 里读到旧值就会漏滚一次。
   */
  const pinnedRef = useRef(true)
  /**
   * 上一次**由我们**写进去的 scrollTop。
   *
   * 用来分辨这次滚动事件是"用户翻页"还是"内容变高导致的位移"。
   * 只看到 `scrollHeight - scrollTop` 变大就判定用户离开了底部是错的：
   * 切到一条正在跑的会话时，历史记录和新的流式增量会在一两帧里灌进来，
   * 我们刚把 scrollTop 写到底，下一秒内容又长高了 —— 距离变大，
   * 但根本没人滚动，`pinnedRef` 却被翻成 false，之后就不再自动跟随了。
   * 这正是"切换运行中的会话偶尔不定位到最后一行"的根因。
   */
  const autoTopRef = useRef(0)
  /**
   * 切会话后的短暂锁定：这段时间里 scrollTop 的变化基本都是布局造成的
   * （内容高度还没算完、浏览器在夹紧越界的 scrollTop），不要当成用户翻页。
   * 到期后恢复正常判定 —— 用户在这之后自己往上翻，仍然会被尊重。
   */
  const settleUntilRef = useRef(0)
  const [showJump, setShowJump] = useState(false)
  /**
   * 滚动容器的 state 副本。
   *
   * 查找需要拿它跑 TreeWalker，而 `scrollRef.current` 在首帧是 null ——
   * 只传 ref.current 的话 hook 永远拿不到那个节点，要等下一次无关的重渲染
   * 才偶然补上。回调 ref 把"挂上"这件事变成一次 state 更新。
   */
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const bindScroll = useCallback((el: HTMLDivElement | null): void => {
    scrollRef.current = el
    setScrollEl(el)
  }, [])
  // 换会话也要重算：Range 指向的节点已经被卸载了
  const find = useFindInConversation(
    items,
    scrollEl,
    `${sessionKey}\u0000${tab}`,
    status === 'running' || status === 'starting'
  )
  const { openFind } = find
  // effect 只依赖这几个稳定值，不因为输入一个字就重订阅 window 监听
  const findOpen = find.open
  const findFocus = find.focus
  const findClose = find.close

  /**
   * Ctrl+F 打开会话内查找。
   *
   * 挂在 window 上而不是转写区的 keydown：用户可能刚点过输入框外的空白，
   * 焦点不在转写区里。只要没在输入框里打字，Ctrl+F 都应该开查找 ——
   * 输入框里有自己的原生查找行为，不抢。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'f' || e.shiftKey) return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return
      e.preventDefault()
      // 已经开着就只是把焦点送回查找框 —— 这是 Ctrl+F 的第二下
      if (findOpen) findFocus()
      else openFind()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openFind, findOpen, findFocus])

  /**
   * 查找条开着时 Esc 关闭。
   *
   * 不只在输入框里监听：用户可能点了一下转写区（焦点离开了输入框），
   * 这时再按 Esc 也应该退出查找模式。
   */
  useEffect(() => {
    if (!findOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const el = e.target as HTMLElement | null
      if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA') return
      findClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [findOpen, findClose])

  /** 最后一条用户消息 —— 只有它后面那一段有「重试」的意义 */
  const lastUserId = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if (it.kind === 'user') return it.id
    }
    return null
  }, [items])

  const actions = useMemo<MessageActions>(
    () => ({
      onEditMessage,
      onRetryTurn,
      lastUserId,
      busy: status === 'running' || status === 'starting'
    }),
    [onEditMessage, onRetryTurn, lastUserId, status]
  )

  /** 最后一条 turn 分隔条：只有它还需要跟着实时任务状态变 */
  const lastTurnId = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].kind === 'turn') return items[i].id
    }
    return null
  }, [items])

  // 只在设置真的变了时换 context 值，避免每来一个 delta 都把消费方全部重渲染
  const display = useMemo<DisplayPrefs>(
    () => ({
      showTimestamps,
      thinkingOpen,
      toolDetail,
      cwd,
      live: status === 'running' || status === 'starting',
      backgroundRunning,
      lastTurnId
    }),
    [showTimestamps, thinkingOpen, toolDetail, cwd, status, backgroundRunning, lastTurnId]
  )

  /** 贴到底部，并记下浏览器实际落在哪儿（内容比视口短时会被夹到 0） */
  const stickToBottom = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    autoTopRef.current = el.scrollTop
  }, [])

  const scrollToBottom = useCallback(() => {
    pinnedRef.current = true
    setShowJump(false)
    stickToBottom()
  }, [stickToBottom])

  /**
   * 滚动监听用**原生 passive 监听 + rAF 节流**，不走 React 的 onScroll。
   *
   * 两件事：合成事件每条滚动事件都要经过根节点派发一次；而这里每帧最多
   * 需要算一次「离底多远」。一帧几十条 scroll 事件时，那个差值就是白烧的。
   */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let queued = false
    const onScroll = (): void => {
      if (queued) return
      queued = true
      requestAnimationFrame(() => {
        queued = false
        const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM
        /*
         * 只有 scrollTop 真的离开了我们上次写入的位置，才算用户在翻。
         * 内容又长高了几百像素、scrollTop 却纹丝不动 —— 那是流式输出，
         * 不是用户往下翻，继续贴着底部。
         */
        const userMoved = Math.abs(el.scrollTop - autoTopRef.current) > 1
        if (near) pinnedRef.current = true
        else if (userMoved && performance.now() >= settleUntilRef.current) {
          pinnedRef.current = false
        }
        const jump = !pinnedRef.current
        setShowJump((prev) => (prev === jump ? prev : jump))
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // 换会话：直接跳到底部，别让用户自己找
  useEffect(() => {
    pinnedRef.current = true
    settleUntilRef.current = performance.now() + 400
    setShowJump(false)
    stickToBottom()

    /*
     * 这一次 effect 写下的位置往往不是终点。
     *
     * 新会话的内容刚挂进 DOM：content-visibility 的块要等进入视口才按真实
     * 高度排版，历史里的图片要等解码，输入区那侧还可能多出待发送队列 /
     * 提问抽屉 —— 它们都会在接下来的几帧里改高度。只贴一次的话，表现
     * 就是停在倒数第几屏，而且因为 pinned 还是 true，「回到底部」都不出现。
     *
     * 后面靠 ResizeObserver 兜底；这两帧是补上 RO 回调之前的空档。
     */
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      if (!pinnedRef.current) return
      stickToBottom()
      raf2 = requestAnimationFrame(() => {
        if (pinnedRef.current) stickToBottom()
      })
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [sessionKey, stickToBottom])

  /**
   * 视口或内容高度一变，只要还跟着底部就重新贴住。
   *
   * `items` 变引用只能覆盖"又来了新内容"；上面那几帧之后的高度变化
   * （图片解码、字体、content-visibility 的块按真实高度重排、输入区
   * 变高变矮）不会换 items，之前没有任何东西会重新滚动 ——
   * 这就是切到运行中的会话后停在半路的原因。
   */
  useEffect(() => {
    const el = scrollRef.current
    const inner = innerRef.current
    if (!el || !inner || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) stickToBottom()
    })
    ro.observe(el)
    ro.observe(inner)
    return () => ro.disconnect()
  }, [stickToBottom])

  // 轮到对面了、但它还没吐第一个字 —— 这段时间界面上什么都不长。
  // starting 和 running 都算"没结束"，但文案不一样（连 CLI / 想事情）。
  const waiting =
    (status === 'running' || status === 'starting') && waitingOnModel(items[items.length - 1])

  /** items → 块。引用没变的块整块跳过渲染（见 RowChunk） */
  const chunks = useMemo(() => {
    const out: ChatItem[][] = []
    for (let i = 0; i < items.length; i += ROW_CHUNK) out.push(items.slice(i, i + ROW_CHUNK))
    return out
  }, [items])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // 自己刚发了一条：这是明确的操作意图，无论之前翻到哪都跟到底部
    const last = items[items.length - 1]
    if (last?.kind === 'user') {
      pinnedRef.current = true
      setShowJump(false)
    }
    if (!pinnedRef.current) return
    stickToBottom()
    // waiting 必须也在依赖里：占位行**不在 items 里**（它由 status 推出来），
    // 少这一项的话它一出现就把自己撑到可视区外面，半截卡在输入框后面
  }, [items, waiting, stickToBottom])

  return (
    <DisplayContext.Provider value={display}>
      <ActionsContext.Provider value={actions}>
      <div className="transcript-wrap">
        {find.open && (
          <FindBar
            find={find}
            onClose={find.close}
            // 跳转时别让"贴着底部"把滚动位置又拽回去
            onJumped={() => {
              pinnedRef.current = false
            }}
          />
        )}
        <div className="transcript" ref={bindScroll}>
        <div className="transcript__inner" ref={innerRef}>
          {tab === 'trace' ? (
            <TraceView items={items} />
          ) : items.length === 0 ? (
            <p className="empty">{t('transcript.empty')}</p>
          ) : (
            /*
             * 一条事件一个节点。**不需要分组** —— 分组是气泡版才有的问题
             * （连续几条助手侧事件要共用一个头像）。这里每个节点各自成行，
             * 所以 useChat 那边吐什么，这里就画什么，一一对应。
             */
            <div className="tl">
              {chunks.map((c, i) => (
                // 末尾两块不做 content-visibility 跳过：跳到底部时它们必须
                // 按真实高度排版，否则会停在一片估算出来的空白上（见 CSS）
                <RowChunk key={i} items={c} tail={i >= chunks.length - 2} />
              ))}
              {waiting && (
                <PendingRow
                  connecting={status === 'starting'}
                  agentsRunning={agentsRunning}
                  since={waitingSince}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {showJump && (
        <button
          className="jump-bottom"
          onClick={scrollToBottom}
          title={t('transcript.jumpBottom')}
        >
          <IconChevronDown width={14} height={14} />
          {t('transcript.jumpBottom')}
        </button>
      )}
      </div>
      </ActionsContext.Provider>
    </DisplayContext.Provider>
  )
}

/* ── 会话内查找 ─────────────────────────────────────────── */

/**
 * 查找条。浮在转写区右上角，不挤压内容。
 *
 * 按钮的 disabled 用 `total === 0` 判断而不是 `current < 0`：查到了但索引还没
 * 落定时（防抖那 90ms）按一下「下一个」不该毫无反应。
 */
function FindBar({
  find,
  onClose,
  onJumped
}: {
  find: FindApi
  onClose: () => void
  onJumped: () => void
}): JSX.Element {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)

  // 打开就把焦点放进输入框，进来直接敲字
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const jump = (dir: 1 | -1): void => {
    if (find.total === 0) return
    if (dir > 0) find.next()
    else find.prev()
    onJumped()
  }

  return (
    <div className="findbar" role="search">
      <IconSearch width={13} height={13} className="findbar__ico" />
      <input
        ref={inputRef}
        className="findbar__input"
        value={find.query}
        placeholder={t('transcript.findPlaceholder')}
        spellCheck={false}
        onChange={(e) => find.setQuery(e.target.value)}
        onKeyDown={(e) => {
          // 输入法组合中不抢键，否则中文输入会被 Enter 打断
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter') {
            e.preventDefault()
            jump(e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <span
        className={`findbar__count${
          !find.pending && find.query.trim() && find.total === 0 ? ' is-empty' : ''
        }`}
      >
        {find.query.trim()
          ? find.pending
            ? '…'
            : find.total > 0
              ? t('transcript.findCount', { current: find.current + 1, total: find.total })
              : t('transcript.findNone')
          : ''}
      </span>
      <button
        className="findbar__btn"
        disabled={find.total === 0 || find.pending}
        onClick={() => jump(-1)}
        title={t('transcript.findPrev')}
        aria-label={t('transcript.findPrev')}
      >
        <IconChevronLeft width={13} height={13} />
      </button>
      <button
        className="findbar__btn"
        disabled={find.total === 0 || find.pending}
        onClick={() => jump(1)}
        title={t('transcript.findNext')}
        aria-label={t('transcript.findNext')}
      >
        <IconChevronDown width={13} height={13} />
      </button>
      <button
        className="findbar__btn"
        onClick={onClose}
        title={t('common.close')}
        aria-label={t('common.close')}
      >
        <IconX width={13} height={13} />
      </button>
    </div>
  )
}

/* ── 等模型开口时的占位 ─────────────────────────────────── */
function PendingRow({
  connecting,
  agentsRunning,
  since
}: {
  connecting: boolean
  agentsRunning: number
  /** 本次等待的起点（来自会话状态），切会话再回来时不会从 0 重来 */
  since?: number
}): JSX.Element {
  const { t, tn } = useI18n()
  // 子代理跑着的时候，球不在模型那边 —— 说出来比笼统的「等待响应」准确
  const label = connecting
    ? t('transcript.connecting')
    : agentsRunning === 1
      ? t('transcript.waitAgent')
      : agentsRunning > 1
        ? tn('transcript.waitAgents', agentsRunning)
        : t('transcript.waitResponse')

  /*
   * 起点由会话状态给出（`waitingSince`），不是占位行自己挂载的时刻 ——
   * 切到别的会话再切回来时组件会重新挂载，但这段等待没结束，计时得接着走。
   * 万一状态里还没有起点（理论上的首帧），退回到挂载时刻。
   */
  const mountedAt = useRef(Date.now()).current
  const startedAt = since ?? mountedAt
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  return (
    <div className="tl__row">
      <div className="tl__thinkwrap">
        <div className="tl__think">
          <span className="tl__wait">
            <i />
            <i />
            <i />
          </span>
          {/*
            这几种状态不能混，也不能写成"思考中"。
            连进程、等子代理、等模型是三件事；而"等模型"那段我们**并不知道它在想** ——
            它可能在做扩展思考，也可能直接吐正文或直接调工具（不做扩展思考的
            模型压根不会出现「思考」卡，写"思考中"就是凭空说了句假话）。
            只说我们确定的事实：请求发出去了，还没回来。
          */}
          <b className="pulse">{label}</b>
          <span className="tl__waittime" title={t('transcript.waitedFor')}>
            {fmtClock(Math.max(0, now - startedAt))}
          </span>
        </div>
      </div>
    </div>
  )
}

/* ── 一个事件 = 一个节点 ────────────────────────────────── */

/**
 * 用户消息里的图片。
 *
 * 缩略图双击打开大图。状态放在这一层而不是 Row 里：Row 是 memo 的，
 * 打开预览的 setState 如果挂在 Row 上，同一条消息会因为弹层开关整行重渲染。
 */
function UserImages({ images }: { images: ImageAttachment[] }): JSX.Element {
  const { t } = useI18n()
  const [preview, setPreview] = useState<ImageAttachment | null>(null)

  return (
    <>
      <div className="tl__me-imgs">
        {images.map((img) => (
          <img
            key={img.id}
            className="tl__me-img"
            src={`data:${img.mediaType};base64,${img.data}`}
            alt={img.name}
            title={`${img.name} · ${t('transcript.imageHint')}`}
            onDoubleClick={() => setPreview(img)}
          />
        ))}
      </div>
      {preview && (
        <ImageLightbox
          src={`data:${preview.mediaType};base64,${preview.data}`}
          alt={preview.name}
          meta={
            preview.width && preview.height
              ? `${preview.name} · ${preview.width} × ${preview.height}`
              : preview.name
          }
          onClose={() => setPreview(null)}
        />
      )}
    </>
  )
}

/**
 * 一条事件一行。
 *
 * **必须 memo。** 一条长会话能到 5000+ 行、5 万+ DOM 节点；不 memo 的话，
 * 每来一个流式 delta（以及每次「回到底部」按钮显示/隐藏）都会把**全部**行
 * 连同里面的 markdown 重新渲染一遍 —— 实测一次切按钮就卡 500ms。
 * reduce 只替换变化的那一条，其余 item 的对象身份不变，浅比较就够了。
 */
const Row = memo(function Row({ item }: { item: ChatItem }): JSX.Element | null {
  /*
   * 外层只为了给「会话内查找」一个可定位的锚点（data-item-id）。
   * 不能用 display: contents —— 那样元素没有几何信息，scrollIntoView
   * 找不到该滚到哪儿。普通块级包裹不影响里面 .tl__row 自己的布局。
   */
  return (
    <div className="tl__item" data-item-id={item.id}>
      <RowBody item={item} />
    </div>
  )
})

function RowBody({ item }: { item: ChatItem }): JSX.Element | null {
  const { showTimestamps, toolDetail, cwd } = useContext(DisplayContext)
  const { t, locale, text } = useI18n()

  switch (item.kind) {
    case 'user':
      return (
        // 气泡靠右 —— 一眼分得开谁在说
        <div className="tl__row tl__row--me">
          <UserActions item={item} />
          <div className="tl__meblock">
            {item.images && item.images.length > 0 && <UserImages images={item.images} />}
            <UserBubble text={item.text} />
            {showTimestamps && item.at && (
              <span className="tl__me-time">{formatTimestamp(item.at, locale)}</span>
            )}
          </div>
        </div>
      )

    case 'text':
      return (
        <div className="tl__row">
          <div className="tl__say">
            <MarkdownText text={item.text} cwd={cwd} />
            {item.streaming && <span className="cursor" />}
          </div>
        </div>
      )

    case 'thinking':
      return (
        <div className="tl__row">
          <ThinkingLine item={item} />
        </div>
      )

    case 'tool':
      if (toolDetail === 'hidden') return null
      return (
        <div className="tl__row">
          <ToolLine item={item} />
        </div>
      )

    case 'permission':
      return <PermissionTrace item={item} />

    case 'question':
      return <QuestionTrace item={item} />

    case 'error':
      return (
        <div className="tl__row">
          <div className="tl__err">
            <div className="tl__err-h">{t('transcript.error')}</div>
            <pre className="selectable">{text(item.message)}</pre>
          </div>
        </div>
      )

    case 'system':
      return <SystemRow item={item} />

    case 'turn':
      return <TurnSep item={item} />

    default:
      return null
  }
}

/* ── 消息级动作 ─────────────────────────────────────────── */

/**
 * 复制一条用户消息（含引用卡）。
 *
 * 图片只写占位符 —— 剪贴板里塞不下图片数据，而用户要的是"能贴到别处"的文本。
 */
async function copyUserMessage(item: Extract<ChatItem, { kind: 'user' }>): Promise<boolean> {
  const body = userMessagePlainText(item.text)
  const imgs = item.images?.length ?? 0
  const suffix = imgs > 0 ? `\n\n[${imgs} image${imgs > 1 ? 's' : ''}]` : ''
  try {
    await navigator.clipboard.writeText(body + suffix)
    return true
  } catch {
    return false
  }
}

/**
 * 用户消息左侧的 hover 工具条：复制 / 编辑 / 重试。
 *
 * 只在鼠标悬停或键盘聚焦时出现，不占版面。重试只给**最后一条**用户消息 ——
 * 更早那几轮后面还压着别的对话，重发它们只会让模型看到两段矛盾的上下文。
 */
function UserActions({ item }: { item: Extract<ChatItem, { kind: 'user' }> }): JSX.Element | null {
  const { t } = useI18n()
  const { onEditMessage, onRetryTurn, lastUserId, busy } = useContext(ActionsContext)
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)

  if (!onEditMessage && !onRetryTurn) return null
  const canRetry = !!onRetryTurn && item.id === lastUserId && !busy

  const copy = (): void => {
    void copyUserMessage(item).then((ok) => {
      if (!ok) {
        notify(t('transcript.copyFailed'))
        return
      }
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <div className="tl__meactions">
      <button
        className="tl__meact"
        title={copied ? t('common.copied') : t('transcript.copyMessage')}
        aria-label={t('transcript.copyMessage')}
        onClick={copy}
      >
        {copied ? <IconCheck width={12} height={12} /> : <IconCopy width={12} height={12} />}
      </button>
      {onEditMessage && (
        <button
          className="tl__meact"
          title={editing ? t('transcript.editHint') : t('transcript.editMessage')}
          aria-label={t('transcript.editMessage')}
          onClick={() => {
            setEditing(true)
            onEditMessage(item)
            window.setTimeout(() => setEditing(false), 1200)
          }}
        >
          <IconPencil width={12} height={12} />
        </button>
      )}
      {canRetry && (
        <button
          className="tl__meact"
          title={t('transcript.retryTurn')}
          aria-label={t('transcript.retryTurn')}
          onClick={() => onRetryTurn?.()}
        >
          <IconRefresh width={12} height={12} />
        </button>
      )}
    </div>
  )
}

/* ── 用户消息里的 IDE 代码引用 ─────────────────────────── */

/**
 * 用户气泡。发送时正文里带着 `<ide_reference>` 块，这里拆成
 * 「原话 + 引用卡」—— 历史回放读到的是同一份正文，所以刷新后也能还原。
 */
function UserBubble({ text }: { text: string }): JSX.Element | null {
  const parsed = useMemo(() => parseIdeRefs(text), [text])
  if (!parsed.text && parsed.refs.length === 0) return null
  return (
    <>
      {parsed.text && <span className="tl__me selectable">{parsed.text}</span>}
      {parsed.refs.length > 0 && (
        <div className="tl__refs">
          {parsed.refs.map((r, i) => (
            <UserRefCard key={`${r.rel}:${r.lines}:${i}`} item={r} />
          ))}
        </div>
      )}
    </>
  )
}

/** 转写区里的引用卡：默认只露两行，点开后最多展开 500 行 */
function UserRefCard({ item }: { item: ParsedIdeRef }): JSX.Element {
  const [open, setOpen] = useState(false)
  const lines = item.code.split('\n')
  const limit = open ? 500 : 2
  const shown = lines.slice(0, limit)
  const more = lines.length > limit
  return (
    <div className="tl__ref">
      <button className="tl__ref-head" onClick={() => setOpen((o) => !o)} title={item.rel}>
        <span className="tl__ref-ico">&lt;/&gt;</span>
        <span className="tl__ref-name">{baseName(item.rel) || item.rel}</span>
        <span className="tl__ref-path">{item.rel}</span>
        <span className="tl__ref-range">{refRangeLabel(item)}</span>
        {open ? (
          <IconChevronDown width={11} height={11} />
        ) : (
          <IconChevronRight width={11} height={11} />
        )}
      </button>
      <pre className={`tl__ref-code${open ? ' is-open' : ''}`}>
        {shown.join('\n')}
        {more ? '\n…' : ''}
      </pre>
    </div>
  )
}

/**
 * 一包行。**只有这一包的 item 变了才重渲染。**
 *
 * `items.slice()` 每次都产生新数组，所以不能靠默认的浅比较 —— 逐项比**引用**：
 * 内容没动的块整块跳过，连子元素都不用重建。行只在末尾追加、最多替换最后一条，
 * 分块边界不会错位。
 */
const RowChunk = memo(
  function RowChunk({ items, tail }: { items: ChatItem[]; tail: boolean }): JSX.Element {
    return (
      <div className={`tl__chunk${tail ? ' is-tail' : ''}`}>
        {items.map((it) => (
          <Row key={it.id} item={it} />
        ))}
      </div>
    )
  },
  (a, b) =>
    a.tail === b.tail &&
    (a.items === b.items ||
      (a.items.length === b.items.length && a.items.every((x, i) => x === b.items[i])))
)

/* ── 思考 ───────────────────────────────────────────────── */

function ThinkingLine({ item }: { item: Extract<ChatItem, { kind: 'thinking' }> }): JSX.Element {
  const { t } = useI18n()
  const { thinkingOpen } = useContext(DisplayContext)
  const [open, setOpen] = useState(thinkingOpen)
  const bodyRef = useRef<HTMLPreElement>(null)

  // 设置里切换「默认展开/折叠」时，已经渲染出来的思考块也立刻跟上
  useEffect(() => {
    setOpen(thinkingOpen)
  }, [thinkingOpen])

  /*
   * 折着的时候也要有一行。跑的时候取**最后**一行 —— 跟着最新内容走，
   * 看得出它在想；跑完了取**开头**一行 —— 回顾时开头比结尾有用。
   */
  const preview = item.streaming ? lastLine(item.text) : firstLine(item.text)

  // 展开的正文框自己有滚动条，跟着最新一行走，不然一直在顶部
  useEffect(() => {
    if (!open) return
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [item.text, open])

  return (
    <div className="tl__thinkwrap">
      <button className="tl__think" onClick={() => setOpen((o) => !o)}>
        {open ? (
          <IconChevronDown width={11} height={11} />
        ) : (
          <IconChevronRight width={11} height={11} />
        )}
        <b>{item.streaming ? t('transcript.thinking') : t('transcript.thought')}</b>
        {!open && preview && <span className="tl__peek"> · {preview}</span>}
      </button>
      {open && (
        <pre className="tl__thinkbody selectable" ref={bodyRef}>
          {item.text}
        </pre>
      )}
    </div>
  )
}

/* ── 工具 ───────────────────────────────────────────────── */

/**
 * 一条工具调用。
 *
 * 折叠行**不摊命令原文**：Bash 显示模型写的 `description`，文件工具显示
 * 文件名 + 父目录 + 增删行数。命令 / 完整路径都还在，悬停看 title，
 * 点开看展开区 —— 长会话里一半以上的行都是工具调用，让命令占主角
 * 会把整条转写刷成终端日志。
 *
 * 文件名本身是「在 IDE 中打开」的入口：Read / Write / Edit 都带绝对路径，
 * 图片文件由 IDE 的图片查看器接手；右侧 chevron 才是展开详情。
 */
function ToolLine({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }): JSX.Element {
  const { t } = useI18n()
  const { toolDetail, cwd, live } = useContext(DisplayContext)
  const [open, setOpen] = useState(false)
  const family = toolFamily(item.name)
  // Bash 永远有命令可看；文件工具要等结果回来才有内容
  const hasBody = !!item.command || !!item.content
  /** 只有「完整」模式才允许展开；精简模式永远是一行 */
  const expandable = toolDetail === 'full' && hasBody
  /** 「精简」把目录和工具族标签收掉，只留图标 + 主题 + 统计 + 耗时 */
  const showMeta = toolDetail === 'full'
  const label = FAMILY_LABEL[family] || item.name.toUpperCase()
  /** 运行中的耗时自己跳；结算后用的是结果里的真实耗时 */
  const elapsed = useToolElapsed(item.status === 'running' && live, item.startedAt)
  const time =
    item.status === 'running'
      ? elapsed !== undefined
        ? fmtMs(elapsed)
        : ''
      : // 拒绝没有执行过程，写耗时会被误读成"跑了 76ms 才被拒"
        item.status === 'denied'
        ? '—'
        : item.ms !== undefined
          ? fmtMs(item.ms)
          : ''
  /** 失败时在折叠态留一行摘要，不展开也能看出错在哪 */
  const err = item.status === 'error' ? errorSummaryOf(item.content) : null
  const showError = !!err?.text && expandable && !open
  const stateLabel =
    item.status === 'ok'
      ? t('transcript.toolOk')
      : item.status === 'error'
        ? t('transcript.toolFailed')
        : item.status === 'denied'
          ? t('transcript.toolDenied')
          : t('transcript.running')
  const stat = item.stat
  const showStat = !!stat && (stat.added > 0 || stat.removed > 0)
  /** 文件类工具（Read / Write / Edit…）才有 path；点击去 IDE 里看 */
  const openable = !!item.path && !!cwd

  /**
   * 在 IDE 里打开这个文件。图片（png/jpg…）由 IDE 自己的查看器接手 ——
   * 主进程只认 `rel`，扩展名决定开文本还是图片标签页。
   */
  const openInIde = (): void => {
    if (!item.path || !cwd) return
    void window.api?.ide
      ?.openFile(cwd, item.path, item.line)
      .then((r) => {
        if (!r.ok && r.message) notify(r.message)
      })
      .catch((err) =>
        notify(
          t('transcript.openIdeFailed', {
            error: err instanceof Error ? err.message : String(err)
          })
        )
      )
  }

  return (
    <div className={`tool is-${item.status} tool--${toolDetail}`}>
      {/*
        外行用 div 不用 button：里面还要放「文件名」和「展开」两个真按钮，
        嵌套按钮是非法 HTML，点哪个都会触发外层的展开。
      */}
      <div
        className={`tool__row${expandable ? ' is-clickable' : ''}`}
        onClick={expandable ? () => setOpen((o) => !o) : undefined}
        title={item.command || item.path || item.subject}
      >
        <span className={`tool__ico tool__ico--${family}`}>{FAMILY_GLYPH[family]}</span>
        {openable ? (
          <button
            className="tool__subject tool__subject--open"
            title={
              item.line
                ? t('transcript.openInIde', { path: item.path!, line: item.line! })
                : t('transcript.openInIdeNoLine', { path: item.path! })
            }
            onClick={(e) => {
              e.stopPropagation()
              openInIde()
            }}
          >
            <span className="tool__subjtext">
              {item.subject ||
                item.summary ||
                (item.fallback ? t(TOOL_FALLBACK_KEY[item.fallback]) : item.name)}
            </span>
            <IconOpenInIde width={11} height={11} className="tool__ideico" />
          </button>
        ) : (
          <span className="tool__subject">
            {item.subject ||
              item.summary ||
              (item.fallback ? t(TOOL_FALLBACK_KEY[item.fallback]) : item.name)}
          </span>
        )}
        {stat && showStat && (
          <span className="tool__stat">
            {stat.added > 0 && <span className="is-add">+{stat.added}</span>}
            {stat.removed > 0 && <span className="is-del">−{stat.removed}</span>}
          </span>
        )}
        {showMeta && item.dir && <span className="tool__dir">{item.dir}</span>}
        {showMeta && <span className="tool__name">{label}</span>}
        <span
          className={`tool__state tool__state--${item.status}`}
          title={stateLabel}
          role={item.status === 'ok' ? 'img' : undefined}
          {...(item.status === 'ok' ? { 'aria-label': stateLabel } : {})}
        >
          {item.status === 'ok' && <IconCheck width={10} height={10} />}
          {item.status === 'error' && (
            <>
              <IconX width={10} height={10} />
              {stateLabel}
            </>
          )}
          {item.status === 'denied' && (
            <>
              <IconSlash width={10} height={10} />
              {stateLabel}
            </>
          )}
          {item.status === 'running' && (
            <>
              <span className="tool__spin" aria-hidden="true" />
              {stateLabel}
            </>
          )}
        </span>
        <span className="tool__time">{time}</span>
        {expandable && (
          <button
            className="tool__chev"
            title={open ? t('transcript.collapseDetail') : t('transcript.expandDetail')}
            aria-expanded={open}
            onClick={(e) => {
              e.stopPropagation()
              setOpen((o) => !o)
            }}
          >
            {open ? (
              <IconChevronDown width={12} height={12} />
            ) : (
              <IconChevronRight width={12} height={12} />
            )}
          </button>
        )}
      </div>
      {showError && err && (
        <button
          type="button"
          className="tool__err"
          title={t('transcript.expandError')}
          onClick={(e) => {
            e.stopPropagation()
            setOpen(true)
          }}
        >
          {err.code && (
            <span className="tool__errcode">{t('transcript.exitCode', { code: err.code })}</span>
          )}
          <span className="tool__errmsg">{err.text}</span>
          <span className="tool__errmore">{t('transcript.expandError')} ›</span>
        </button>
      )}
      {open && expandable && (
        <div className="tool__body">
          {item.command && <pre className="tool__cmd selectable">{item.command}</pre>}
          {item.content && <pre className="tool__out selectable">{item.content}</pre>}
        </div>
      )}
    </div>
  )
}

/* ── 一轮结束 ───────────────────────────────────────────── */

/* ── 设置切换留痕 ───────────────────────────────────────── */

/**
 * 每一项切换的名字、字形和色号。
 *
 * 颜色是**跟着输入区那个 chip 走的**：思考深度紫、权限模式琥珀，
 * 一眼就知道刚才动的是哪个开关，不用读字。
 */
const SYS_META: Record<SystemKey, { labelKey: MessageKey; glyph: string; tone: string }> = {
  effort: { labelKey: 'transcript.sys.effort', glyph: '◈', tone: 'eff' },
  permissionMode: { labelKey: 'transcript.sys.permissionMode', glyph: '◆', tone: 'perm' },
  model: { labelKey: 'transcript.sys.model', glyph: '◇', tone: 'model' },
  channel: { labelKey: 'transcript.sys.channel', glyph: '⇄', tone: 'chan' },
  auth: { labelKey: 'transcript.sys.auth', glyph: '◎', tone: 'chan' }
}

/**
 * 一个切换留痕：小药丸 + 一行灰字。
 *
 * 为什么不做成卡片（方案 C）：一次切换占的版面比助手一整段回答还大，
 * 连切几次转写区就变日志了。药丸够用 —— 要的只是"这里被动过"，
 * 具体怎么换进程在 chip 和设置页里都能查到。
 *
 * 文案写「下一轮生效」是**必须的**：reconfigure 立刻收掉旧进程，
 * 但新进程要等下一次发送才拉起来（ensureSession 是懒的）。
 * 此刻写"已切换完成"就是假话。
 */
function SystemRow({ item }: { item: Extract<ChatItem, { kind: 'system' }> }): JSX.Element {
  const { t } = useI18n()
  const m = SYS_META[item.key]
  const renderValue = (v: string | ChannelLabel): string => {
    switch (item.key) {
      case 'model':
        return (v as string) || t('chat.noModel')
      case 'permissionMode':
        return t(MODE_LABEL_KEY[v as PermissionMode])
      case 'effort':
        return t(EFFORT_LABEL_KEY[v as EffortLevel])
      case 'channel':
      case 'auth': {
        const c = v as ChannelLabel
        return c.kind === 'official'
          ? t('auth.officialAccount')
          : c.name || t('settings.channel.none')
      }
    }
  }
  const from = renderValue(item.from)
  const to = renderValue(item.to)
  const full = `${t(m.labelKey)} ${from} → ${to}`
  return (
    <div className="tl__row">
      <div className="tl__sys">
        <span className={`tl__pill is-${m.tone}`} title={full}>
          <span className="tl__pill-sym">{m.glyph}</span>
          <span className="tl__pill-k">{t(m.labelKey)}</span>
          <span className="tl__pill-v">
            {from} → <b>{to}</b>
          </span>
        </span>
        <span className="tl__sys-more">{t('transcript.nextTurn')}</span>
      </div>
    </div>
  )
}

function TurnSep({ item }: { item: Extract<ChatItem, { kind: 'turn' }> }): JSX.Element {
  const { t, tn, locale } = useI18n()
  const { backgroundRunning, lastTurnId } = useContext(DisplayContext)
  /*
   * 最后一轮结束时后台任务可能还在跑（比如后台打包）。这时不能写
   * 「已完成」—— 用户会以为活干完了，结果却还没回来。
   * 更早的轮次保持原样：那些轮本来就结束了。
   */
  const pendingBackground = backgroundRunning > 0 && item.id === lastTurnId
  const bits: string[] = [
    pendingBackground
      ? tn('transcript.turnBackgroundRunning', backgroundRunning)
      : t('transcript.turnDone')
  ]
  // 历史回放拿不到每轮耗时（jsonl 里没这个字段），此时就不显示
  if (item.durationMs) {
    bits.push(t('transcript.duration', { duration: formatDuration(item.durationMs, locale) }))
  }
  if (item.steps) bits.push(tn('count.steps', item.steps))
  if (item.usage) bits.push(`${fmtTokens(totalTokens(item.usage))} tok`)
  if (item.at) bits.push(formatTimestamp(item.at, locale))
  return <div className="tl__sep">{bits.join(' · ')}</div>
}

/* ── 审批留痕 ───────────────────────────────────────────── */

/**
 * 审批在转写区留下的一条痕。
 *
 * 审批本身是**弹窗**（见 PermissionModal），这里只记"这一步被问过、你答了什么"。
 * 不留这一条的话，回看时整条转写就是断的 —— 工具卡明明白白跑了一次 Edit，
 * 却找不到任何"它被批准过"的痕迹，而那恰恰是最该留档的动作。
 *
 * 用跟设置切换同一种药丸，读起来是一类东西："某个非对话的事件在这里发生了"。
 */
function PermissionTrace({
  item
}: {
  item: Extract<ChatItem, { kind: 'permission' }>
}): JSX.Element {
  const { t } = useI18n()
  const pending = item.state === 'pending'
  const label = pending
    ? t('transcript.permissionWaiting')
    : item.state === 'allowed'
      ? t('transcript.permissionAllowed')
      : t('transcript.permissionDenied')
  const tone = pending ? 'perm' : item.state === 'allowed' ? 'ok' : 'deny'
  const what = item.summary ? `${item.tool} · ${item.summary}` : item.tool

  return (
    <div className="tl__row">
      <div className="tl__sys">
        <span
          className={`tl__pill is-${tone}`}
          title={t('transcript.permissionTitle', { what, label })}
        >
          <span className="tl__pill-sym">◆</span>
          <span className="tl__pill-k">{t('transcript.permission')}</span>
          <span className="tl__pill-v">{what}</span>
          <b className="tl__pill-state">{label}</b>
        </span>
        {!pending && (
          <span className="tl__sys-more">
            {item.remembered ? t('transcript.remembered') : t('transcript.once')}
          </span>
        )}
      </div>
    </div>
  )
}

/* ── 提问留痕 ───────────────────────────────────────────── */

/**
 * 提问在转写里留下的那条痕。
 *
 * 提问本身是输入框上方的抽屉（见 QuestionDrawer）；这里只记「问过什么、
 * 答了什么」。青色是和审批的黄色刻意分开的 —— 提问不是许可。
 */
function QuestionTrace({
  item
}: {
  item: Extract<ChatItem, { kind: 'question' }>
}): JSX.Element {
  const { t } = useI18n()
  const pending = item.state === 'pending'
  const label = pending
    ? t('transcript.questionWaiting')
    : item.state === 'answered'
      ? t('transcript.questionAnswered')
      : t('transcript.questionSkipped')
  const tone = pending ? 'ask' : item.state === 'answered' ? 'ok' : 'deny'
  const first = item.questions[0]
  const what = first ? first.header || first.question : t('transcript.questionFallback')
  const detail = item.answers
    ? Object.entries(item.answers)
        .map(
          ([q, v]) =>
            `${q} → ${Array.isArray(v) ? v.join(t('common.listSeparator')) : v}`
        )
        .join(' · ')
    : ''

  return (
    <div className="tl__row">
      <div className="tl__sys">
        <span
          className={`tl__pill is-${tone}`}
          title={`${t('transcript.questionTitle', { what, label })}${detail ? `\n${detail}` : ''}`}
        >
          <span className="tl__pill-sym">?</span>
          <span className="tl__pill-k">{t('transcript.question')}</span>
          <span className="tl__pill-v">{what}</span>
          <b className="tl__pill-state">{label}</b>
        </span>
        {!pending && detail && <span className="tl__answer">{detail}</span>}
      </div>
    </div>
  )
}

/* ── 轨迹页 ─────────────────────────────────────────────── */

function TraceView({ items }: { items: ChatItem[] }): JSX.Element {
  const { t } = useI18n()
  const tools = items.filter((m): m is Extract<ChatItem, { kind: 'tool' }> => m.kind === 'tool')
  if (tools.length === 0) {
    return <p className="empty">{t('transcript.traceEmpty')}</p>
  }
  return (
    <ol className="trace">
      {tools.map((t) => (
        <li key={t.id} className="trace__item" data-item-id={t.id}>
          <span className={`trace__dot is-${t.status}`} />
          <span className="trace__name">{t.name}</span>
          <code className="inline-code">{t.summary || '—'}</code>
        </li>
      ))}
    </ol>
  )
}
