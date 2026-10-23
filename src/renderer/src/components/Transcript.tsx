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
import type { SessionStatus } from '@shared/session'
import type { ToolDetail } from '@shared/settings'
import { toolFamily, type ToolFamily } from '@shared/tool'
import type { ChatItem, SystemKey } from '../useChat'
import { RichText } from './rich'
import { fmtClock, fmtDuration, fmtTokens, totalTokens } from './format'
import type { TabKey } from './TabBar'
import { IconChevronDown, IconChevronRight, IconOpenInIde } from './Icons'
import { notify } from '../notice'
import { baseName } from '@shared/path'
import { parseIdeRefs, refRangeLabel, type ParsedIdeRef } from '../ideRef'

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
}

const DEFAULT_DISPLAY: DisplayPrefs = {
  showTimestamps: false,
  thinkingOpen: false,
  toolDetail: 'full',
  cwd: ''
}

const DisplayContext = createContext<DisplayPrefs>(DEFAULT_DISPLAY)

/** 毫秒 → 「12ms」/「1.4s」 */
function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
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
  /** 换会话时用它复位滚动位置 */
  sessionKey: string
  /** 以下三项来自设置 → 通用 → 对话 */
  showTimestamps: boolean
  thinkingOpen: boolean
  toolDetail: ToolDetail
  /** 当前会话的工作区目录（工具卡里的文件要在 IDE 中打开） */
  cwd: string
}

export function Transcript({
  items,
  tab,
  status,
  agentsRunning,
  sessionKey,
  showTimestamps,
  thinkingOpen,
  toolDetail,
  cwd
}: Props): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
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

  // 只在设置真的变了时换 context 值，避免每来一个 delta 都把消费方全部重渲染
  const display = useMemo<DisplayPrefs>(
    () => ({ showTimestamps, thinkingOpen, toolDetail, cwd }),
    [showTimestamps, thinkingOpen, toolDetail, cwd]
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
      <div className="transcript-wrap">
        <div className="transcript" ref={scrollRef}>
        <div className="transcript__inner" ref={innerRef}>
          {tab === 'trace' ? (
            <TraceView items={items} />
          ) : items.length === 0 ? (
            <p className="empty">发一条消息开始 —— 渠道配好后这里就会出字。</p>
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
                <PendingRow connecting={status === 'starting'} agentsRunning={agentsRunning} />
              )}
            </div>
          )}
        </div>
      </div>

      {showJump && (
        <button className="jump-bottom" onClick={scrollToBottom} title="回到底部">
          <IconChevronDown width={14} height={14} />
          回到底部
        </button>
      )}
      </div>
    </DisplayContext.Provider>
  )
}

/* ── 等模型开口时的占位 ─────────────────────────────────── */

/**
 * 什么时候算"轮到模型了但还没吐字"。
 *
 * 判据是**最后一条是什么**：只要最后一条是"已经落定、且不该再往下长"的东西，
 * 就说明球在模型那边。反过来，正在流式的正文/思考、正在跑的工具、
 * 等人点同意的审批卡，都各自有活着的表现，不用再叠一个占位。
 */
function waitingOnModel(last: ChatItem | undefined): boolean {
  if (!last) return false
  switch (last.kind) {
    case 'user': // 刚发出去，第一个 token 还没回来
    case 'turn': // 上一轮结束，这一轮还没开始吐
      return true
    case 'tool':
      return last.status !== 'running' // 工具跑完了，等模型接着说
    case 'permission':
      return last.state !== 'pending' // 审批已答复，等模型接着跑
    case 'question':
      return last.state !== 'pending' // 提问已答复，等模型接着说
    case 'text':
    case 'thinking':
      return !last.streaming // 这一段说完了，等下一段
    default:
      return false // 出错之类：不是在等模型
  }
}

function PendingRow({
  connecting,
  agentsRunning
}: {
  connecting: boolean
  agentsRunning: number
}): JSX.Element {
  // 子代理跑着的时候，球不在模型那边 —— 说出来比笼统的「等待响应」准确
  const label = connecting
    ? '正在连接 CLI…'
    : agentsRunning === 1
      ? '等待子代理完成…'
      : agentsRunning > 1
        ? `等待 ${agentsRunning} 个子代理完成…`
        : '等待响应…'

  /*
   * 这段等待从占位行出现时算起，每秒跳一次。
   * 用本地 state 而不是把时间传进来：占位行只在「真的在等」时挂载，
   * 挂载时刻就是等待起点；工具跑完、模型再度安静时会自然重新计时。
   */
  const [startedAt] = useState(() => Date.now())
  const [now, setNow] = useState(startedAt)
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
          <span className="tl__waittime" title="已等待时间">
            {fmtClock(now - startedAt)}
          </span>
        </div>
      </div>
    </div>
  )
}

/* ── 一个事件 = 一个节点 ────────────────────────────────── */

/**
 * 一条事件一行。
 *
 * **必须 memo。** 一条长会话能到 5000+ 行、5 万+ DOM 节点；不 memo 的话，
 * 每来一个流式 delta（以及每次「回到底部」按钮显示/隐藏）都会把**全部**行
 * 连同里面的 markdown 重新渲染一遍 —— 实测一次切按钮就卡 500ms。
 * reduce 只替换变化的那一条，其余 item 的对象身份不变，浅比较就够了。
 */
const Row = memo(function Row({ item }: { item: ChatItem }): JSX.Element | null {
  const { showTimestamps, toolDetail } = useContext(DisplayContext)

  switch (item.kind) {
    case 'user':
      return (
        // 气泡靠右 —— 一眼分得开谁在说
        <div className="tl__row tl__row--me">
          <div className="tl__meblock">
            {item.images && item.images.length > 0 && (
              <div className="tl__me-imgs">
                {item.images.map((img) => (
                  <img
                    key={img.id}
                    className="tl__me-img"
                    src={`data:${img.mediaType};base64,${img.data}`}
                    alt={img.name}
                    title={img.name}
                  />
                ))}
              </div>
            )}
            <UserBubble text={item.text} />
            {showTimestamps && item.at && <span className="tl__me-time">{item.at}</span>}
          </div>
        </div>
      )

    case 'text':
      return (
        <div className="tl__row">
          <div className="tl__say">
            <RichText text={item.text} />
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
            <div className="tl__err-h">出错</div>
            <pre className="selectable">{item.message}</pre>
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
})

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
        <b>{item.streaming ? '思考中…' : '思考'}</b>
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
  const { toolDetail, cwd } = useContext(DisplayContext)
  const [open, setOpen] = useState(false)
  const family = toolFamily(item.name)
  // Bash 永远有命令可看；文件工具要等结果回来才有内容
  const hasBody = !!item.command || !!item.content
  /** 只有「完整」模式才允许展开；精简模式永远是一行 */
  const expandable = toolDetail === 'full' && hasBody
  /** 「精简」把目录和工具族标签收掉，只留图标 + 主题 + 统计 + 耗时 */
  const showMeta = toolDetail === 'full'
  const label = FAMILY_LABEL[family] || item.name.toUpperCase()
  const time = item.status === 'running' ? '运行中' : item.ms !== undefined ? fmtMs(item.ms) : ''
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
      .catch((err) => notify(`无法打开 IDE：${err instanceof Error ? err.message : String(err)}`))
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
                ? `在 IDE 中打开 ${item.path}:${item.line}`
                : `在 IDE 中打开 ${item.path}`
            }
            onClick={(e) => {
              e.stopPropagation()
              openInIde()
            }}
          >
            <span className="tool__subjtext">{item.subject || item.summary || item.name}</span>
            <IconOpenInIde width={11} height={11} className="tool__ideico" />
          </button>
        ) : (
          <span className="tool__subject">{item.subject || item.summary || item.name}</span>
        )}
        {stat && showStat && (
          <span className="tool__stat">
            {stat.added > 0 && <span className="is-add">+{stat.added}</span>}
            {stat.removed > 0 && <span className="is-del">−{stat.removed}</span>}
          </span>
        )}
        {showMeta && item.dir && <span className="tool__dir">{item.dir}</span>}
        {showMeta && <span className="tool__name">{label}</span>}
        <span className="tool__time">{time}</span>
        {expandable && (
          <button
            className="tool__chev"
            title={open ? '收起详情' : '展开详情'}
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
const SYS_META: Record<SystemKey, { label: string; glyph: string; tone: string }> = {
  effort: { label: '思考深度', glyph: '◈', tone: 'eff' },
  permissionMode: { label: '权限模式', glyph: '◆', tone: 'perm' },
  model: { label: '模型', glyph: '◇', tone: 'model' },
  channel: { label: '渠道', glyph: '⇄', tone: 'chan' },
  auth: { label: '凭据来源', glyph: '◎', tone: 'chan' }
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
  const m = SYS_META[item.key]
  const full = `${m.label} ${item.from} → ${item.to}`
  return (
    <div className="tl__row">
      <div className="tl__sys">
        <span className={`tl__pill is-${m.tone}`} title={full}>
          <span className="tl__pill-sym">{m.glyph}</span>
          <span className="tl__pill-k">{m.label}</span>
          <span className="tl__pill-v">
            {item.from} → <b>{item.to}</b>
          </span>
        </span>
        <span className="tl__sys-more">下一轮生效 · 上下文不丢</span>
      </div>
    </div>
  )
}

function TurnSep({ item }: { item: Extract<ChatItem, { kind: 'turn' }> }): JSX.Element {
  const bits: string[] = ['已完成']
  // 历史回放拿不到每轮耗时（jsonl 里没这个字段），此时就不显示
  if (item.durationMs) bits.push(`用时 ${fmtDuration(item.durationMs)}`)
  if (item.steps) bits.push(`${item.steps} 步`)
  if (item.usage) bits.push(`${fmtTokens(totalTokens(item.usage))} tok`)
  if (item.at) bits.push(item.at)
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
  const pending = item.state === 'pending'
  const label = pending ? '等待许可' : item.state === 'allowed' ? '已允许' : '已拒绝'
  const tone = pending ? 'perm' : item.state === 'allowed' ? 'ok' : 'deny'
  const what = item.summary ? `${item.tool} · ${item.summary}` : item.tool

  return (
    <div className="tl__row">
      <div className="tl__sys">
        <span className={`tl__pill is-${tone}`} title={`审批 ${what} —— ${label}`}>
          <span className="tl__pill-sym">◆</span>
          <span className="tl__pill-k">审批</span>
          <span className="tl__pill-v">{what}</span>
          <b className="tl__pill-state">{label}</b>
        </span>
        {!pending && (
          <span className="tl__sys-more">
            {item.remembered ? '本会话内不再询问该工具' : '仅此一次'}
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
  const pending = item.state === 'pending'
  const label = pending ? '等待回答' : item.state === 'answered' ? '已答' : '已跳过'
  const tone = pending ? 'ask' : item.state === 'answered' ? 'ok' : 'deny'
  const first = item.questions[0]
  const what = first ? first.header || first.question : '提问'
  const detail = item.answers
    ? Object.entries(item.answers)
        .map(([q, v]) => `${q} → ${Array.isArray(v) ? v.join('、') : v}`)
        .join(' · ')
    : ''

  return (
    <div className="tl__row">
      <div className="tl__sys">
        <span
          className={`tl__pill is-${tone}`}
          title={`提问 ${what} —— ${label}${detail ? `\n${detail}` : ''}`}
        >
          <span className="tl__pill-sym">?</span>
          <span className="tl__pill-k">提问</span>
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
  const tools = items.filter((m): m is Extract<ChatItem, { kind: 'tool' }> => m.kind === 'tool')
  if (tools.length === 0) {
    return <p className="empty">本会话还没有工具调用。</p>
  }
  return (
    <ol className="trace">
      {tools.map((t) => (
        <li key={t.id} className="trace__item">
          <span className={`trace__dot is-${t.status}`} />
          <span className="trace__name">{t.name}</span>
          <code className="inline-code">{t.summary || '—'}</code>
        </li>
      ))}
    </ol>
  )
}
