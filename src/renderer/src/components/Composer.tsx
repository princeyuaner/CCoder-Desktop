import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import type { PermissionMode, Usage } from '@shared/events'
import {
  CLIS,
  cliDef,
  EFFORT_HINT,
  EFFORT_LABEL,
  EFFORT_LEVELS,
  type Channel,
  type CliId,
  type EffortLevel,
  type SendKey
} from '@shared/settings'
import type { ImageAttachment } from '@shared/attachment'
import type { IdeCodeRef } from '@shared/ide-chat'
import type { SessionSendInput } from '@shared/session'
import type { QueuedMessage, SendMeta } from '../useChat'
import type { FileMatch } from '@shared/workspace'
import { composeIdeMessage } from '../ideRef'
import { MODE_HINT, MODE_LABEL, PERMISSION_MODES } from '../constants'
import { baseName } from '@shared/path'
import type { ChangedFile } from '../changedFiles'
import { ChangedFiles } from './ChangedFiles'
import { CommandPopup, MentionPopup } from './ComposerPopups'
import { filterCommands, type SlashCommand } from '../commands'
import { IconBrain, IconChevronDown, IconPlus, IconSend } from './Icons'
import { contextPercent, contextWindowOf, fmtTokens } from './format'
import { MAX_IMAGES, readImageFiles } from '../imagePaste'

/** 输入框自动长高的上限 —— 到这儿之后改为框内滚动，别把对话区挤没了 */
const MAX_INPUT_HEIGHT = 180

/** 同一段代码从 IDE 发两次只留一张卡 */
const refKey = (r: IdeCodeRef): string =>
  `${r.kind}:${r.rel}:${r.startLine ?? 0}:${r.endLine ?? 0}`

/** 输入框里的代码卡只露前几行，完整内容在发送时才拼进正文 */
function previewCode(code: string): string {
  const lines = code.split('\n')
  return lines.length > 3 ? `${lines.slice(0, 3).join('\n')}\n…` : lines.join('\n')
}

/** 上下文小环的周长：r=7.5，2πr */
const CTX_RING = 2 * Math.PI * 7.5
/** 详情浮层里那个大环的周长：r=19，2πr */
const CTX_BIG_RING = 2 * Math.PI * 19

interface MentionState {
  /** @ 后面的查询串 */
  query: string
  /** @ 在全文里的下标，插入时从这里替换 */
  start: number
  active: number
  items: FileMatch[]
  loading: boolean
}

interface CommandState {
  /** / 后面的查询串 */
  query: string
  active: number
}

/**
 * 光标前是不是一个 @ 引用。
 *
 * 只在行首或空白后触发 —— 不然 `foo@bar.com` 也会弹文件面板。
 */
function findMention(value: string, caret: number): { query: string; start: number } | null {
  const before = value.slice(0, caret)
  const m = before.match(/(^|[\s])@([^\s@]*)$/)
  if (!m) return null
  return { query: m[2], start: caret - m[2].length - 1 }
}

/** 光标前是不是一个 / 指令；只在输入框最开头触发 */
function findCommand(value: string, caret: number): { query: string } | null {
  if (caret === 0) return null
  const m = value.slice(0, caret).match(/^\/([^\s]*)$/)
  return m ? { query: m[1] } : null
}

interface Props {
  onSend: (input: SessionSendInput, meta?: SendMeta) => void
  onInterrupt: () => void
  running: boolean
  /** 等待队列：运行中发的消息排在这里，轮末自动发送 */
  queue: QueuedMessage[]
  queuePaused: boolean
  onRemoveQueued: (id: string) => void
  onClearQueue: () => void
  /** 取回一条排队消息到输入框；返回 null 表示已经被发走了 */
  onTakeQueued: (id: string) => QueuedMessage | null
  onMoveQueued: (id: string, dir: -1 | 1) => void
  onResumeQueue: () => void
  /** 模型正在提问：输入框锁住，先答题再发消息 */
  locked?: boolean
  /** 这条会话跑在哪个 CLI 上 */
  cli: CliId
  /** 该 CLI 下的渠道，以及当前在用的那个 */
  channels: Channel[]
  activeChannelId: string | null
  model: string
  permissionMode: PermissionMode
  /** 本会话的思考深度（CLI 的 --effort） */
  effort: EffortLevel
  /** 这条会话的工作目录。显示在输入框左上方 —— 文件会写到哪里全看它 */
  cwd: string
  /** 本轮改过的文件。空数组 = 这一轮还没动过文件，那颗按钮就不出现 */
  changedFiles: ChangedFile[]
  /** 发送快捷键：Enter 或 Ctrl/Cmd+Enter */
  sendKey: SendKey
  /** 当前会话里有没有内容 —— 换 CLI 会丢，有内容才值得拦一下 */
  hasConversation: boolean
  /** /status 用 */
  turns: number
  steps: number
  /** 最近一轮的用量 —— 底栏上下文胶囊从这里取 contextTokens */
  usage?: Usage
  onCliChange: (c: CliId) => void
  onChannelChange: (id: string) => void
  onModelChange: (m: string) => void
  onModeChange: (p: PermissionMode) => void
  onEffortChange: (l: EffortLevel) => void
  /** /clear：清空并重开一条 CLI 会话 */
  onClearConversation: () => void
  /** IDE 发来的引用；nonce 变化才收，避免重渲染时重复加 */
  incomingRefs?: { nonce: number; refs: IdeCodeRef[] } | null
  onIncomingConsumed?: () => void
}

export function Composer({
  onSend,
  onInterrupt,
  running,
  queue,
  queuePaused,
  onRemoveQueued,
  onClearQueue,
  onTakeQueued,
  onMoveQueued,
  onResumeQueue,
  locked = false,
  cli,
  channels,
  activeChannelId,
  model,
  permissionMode,
  effort,
  cwd,
  changedFiles,
  sendKey,
  hasConversation,
  turns,
  steps,
  usage,
  onCliChange,
  onChannelChange,
  onModelChange,
  onModeChange,
  onEffortChange,
  onClearConversation,
  incomingRefs,
  onIncomingConsumed
}: Props): JSX.Element {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<ImageAttachment[]>([])
  /** IDE 发来的代码引用：发送前和图片一样挂在输入框上方 */
  const [refs, setRefs] = useState<IdeCodeRef[]>([])
  const [mention, setMention] = useState<MentionState | null>(null)
  const [command, setCommand] = useState<CommandState | null>(null)
  /** 由 /model、/permissions、/effort 打开的底栏选择器 */
  const [openPicker, setOpenPicker] = useState<'model' | 'effort' | 'mode' | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  /** 上下文详情浮层是否展开 */
  const [ctxOpen, setCtxOpen] = useState(false)
  const canSend =
    !locked && (text.trim().length > 0 || attachments.length > 0 || refs.length > 0)

  /** 收下 IDE 送来的引用。nonce 保证同一批只加一次 */
  const lastRefNonce = useRef(0)
  useEffect(() => {
    if (!incomingRefs || incomingRefs.nonce === lastRefNonce.current) return
    lastRefNonce.current = incomingRefs.nonce
    setRefs((cur) => {
      const seen = new Set(cur.map(refKey))
      const add = incomingRefs.refs.filter((r) => !seen.has(refKey(r)))
      return add.length > 0 ? [...cur, ...add] : cur
    })
    onIncomingConsumed?.()
  }, [incomingRefs, onIncomingConsumed])

  const removeRef = (id: string): void => {
    setRefs((cur) => cur.filter((r) => r.id !== id))
  }

  /**
   * 上下文胶囊。
   *
   * 上限从模型名里读（`[1m]` / `-200k`，Claude 默认 200k）；读不出来就只
   * 显示已用 token，不画环 —— 猜一个上限会把百分比算成假数。
   */
  const ctxUsed = usage?.contextTokens && usage.contextTokens > 0 ? usage.contextTokens : null
  const ctxLimit = contextWindowOf(model)
  const ctxPct = contextPercent(ctxUsed ?? undefined, ctxLimit)
  const ctxTitle =
    ctxUsed == null
      ? ''
      : ctxLimit == null
        ? `上下文已用 ${fmtTokens(ctxUsed)} · 上限未知`
        : `上下文已用 ${fmtTokens(ctxUsed)} / ${fmtTokens(ctxLimit)}（${ctxPct}%）· 剩余 ${fmtTokens(Math.max(0, ctxLimit - ctxUsed))}`

  /** 状态色与文案。70% / 90% 两档跟胶囊小环保持一致 */
  const ctxLevel =
    ctxPct == null ? null : ctxPct >= 90 ? 'danger' : ctxPct >= 70 ? 'warn' : 'ok'
  const ctxTone = ctxLevel === 'danger' ? ' is-danger' : ctxLevel === 'warn' ? ' is-warn' : ''
  const ctxStateLabel =
    ctxLevel === 'danger'
      ? '接近上限'
      : ctxLevel === 'warn'
        ? '偏高'
        : ctxLevel === 'ok'
          ? '充裕'
          : null

  /**
   * 上下文构成取 `contextUsage`（**最后一次请求**的四项）。
   *
   * 不能拿 Usage 顶层那四个字段来拆：那是 result 里一轮的累计值，
   * 一轮多次工具往返时会明显大于最后一次请求，拆出来的比例是假的。
   */
  const ctxUsage = usage?.contextUsage
  const ctxParts = ctxUsage
    ? [
        { key: 'cache', label: '缓存读取', value: ctxUsage.cacheReadTokens },
        { key: 'input', label: '输入', value: ctxUsage.inputTokens },
        { key: 'write', label: '缓存写入', value: ctxUsage.cacheCreationTokens },
        { key: 'out', label: '输出', value: ctxUsage.outputTokens }
      ]
    : null
  const ctxPartSum = ctxParts?.reduce((n, p) => n + p.value, 0) ?? 0
  const ctxShare = (v: number): number => (ctxPartSum > 0 ? (v / ctxPartSum) * 100 : 0)
  const ctxSharePct = (v: number): number =>
    ctxPartSum > 0 ? Math.round((v / ctxPartSum) * 100) : 0

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const anchorRef = useRef<HTMLDivElement>(null)
  /** 上下文胶囊 + 详情浮层的外壳，用来判断点击是否在外面 */
  const ctxAnchorRef = useRef<HTMLSpanElement>(null)
  /** @ 检索的请求序号：慢请求回来时如果已经不是最新一次，就丢掉 */
  const mentionSeq = useRef(0)

  const commandItems = useMemo(
    () => (command ? filterCommands(command.query) : []),
    [command]
  )

  /**
   * 输入框随内容长高，到 MAX_INPUT_HEIGHT 为止。
   *
   * 先设 auto 再读 scrollHeight：不重置的话，缩小文本时量到的仍是
   * 上一次的固定高度，框就再也缩不回去了。useLayoutEffect 保证在
   * 浏览器绘制前算完，不会闪一下。
   */
  const fitInput = (): void => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`
  }

  useLayoutEffect(fitInput, [text])

  // 窗口变窄时同样的文字会折成更多行 —— 只靠 [text] 触发会漏掉这种情况
  useEffect(() => {
    window.addEventListener('resize', fitInput)
    return () => window.removeEventListener('resize', fitInput)
  }, [])

  const popupOpen = !!mention || !!command

  /** 弹层打开时点外面 / Esc 收起 */
  useEffect(() => {
    if (!popupOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!anchorRef.current?.contains(e.target as Node)) {
        setMention(null)
        setCommand(null)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setMention(null)
        setCommand(null)
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [popupOpen])

  /** 上下文详情浮层：点外面 / Esc 收起 */
  useEffect(() => {
    if (!ctxOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!ctxAnchorRef.current?.contains(e.target as Node)) setCtxOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setCtxOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [ctxOpen])

  // 开始输入 @ 引用或 / 指令时，详情浮层让位给命令弹层
  useEffect(() => {
    if (mention || command) setCtxOpen(false)
  }, [mention, command])

  /** @ 查询：120ms 防抖；慢请求回来时丢弃过期结果 */
  useEffect(() => {
    if (!mention) return
    if (!cwd) {
      setMention((m) => (m ? { ...m, items: [], loading: false } : m))
      return
    }
    const api = window.api?.workspace
    if (!api) {
      setMention((m) => (m ? { ...m, items: [], loading: false } : m))
      return
    }

    const seq = ++mentionSeq.current
    setMention((m) => (m ? { ...m, loading: true } : m))
    const timer = window.setTimeout(() => {
      void api
        .searchFiles(cwd, mention.query, 20)
        .then((items) => {
          if (seq !== mentionSeq.current) return
          setMention((m) => (m ? { ...m, items, loading: false, active: 0 } : m))
        })
        .catch(() => {
          if (seq !== mentionSeq.current) return
          setMention((m) => (m ? { ...m, items: [], loading: false } : m))
        })
    }, 120)
    return () => window.clearTimeout(timer)
  }, [mention?.query, cwd])

  /** 状态提示三秒半后自动消失 */
  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 3500)
    return () => window.clearTimeout(t)
  }, [toast])

  const showToast = (msg: string): void => setToast(msg)

  /** 输入变化时同步两个触发器；@ 优先于 / */
  const onChange = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    const value = e.target.value
    setText(value)
    const caret = e.target.selectionStart ?? value.length

    const m = findMention(value, caret)
    if (m) {
      setCommand(null)
      setMention((prev) => ({
        query: m.query,
        start: m.start,
        active: 0,
        items: prev?.items ?? [],
        loading: true
      }))
      return
    }

    setMention(null)
    const c = findCommand(value, caret)
    setCommand(c ? { query: c.query, active: 0 } : null)
  }

  /** 把 @query 替换成 @path；目录末尾补 /，继续往下找 */
  const insertMention = (f: FileMatch): void => {
    if (!mention) return
    const el = inputRef.current
    const caret = el?.selectionStart ?? text.length
    // 光标可能已经移到了 @token 中间；从光标往回找 @，再往后吃掉整个 token
    const beforeCaret = text.slice(0, caret)
    const at = beforeCaret.lastIndexOf('@')
    const start =
      at >= 0 && (at === 0 || /\s/.test(beforeCaret[at - 1])) ? at : mention.start
    const tail = text.slice(caret).match(/^[^\s]*/)?.[0].length ?? 0
    const before = text.slice(0, start)
    const after = text.slice(caret + tail)
    const isDir = f.kind === 'dir'
    const insert = `@${f.path}${isDir ? '/' : ' '}`
    const next = before + insert + after
    const pos = before.length + insert.length

    setText(next)
    if (isDir) {
      setMention({
        query: `${f.path}/`,
        start,
        active: 0,
        items: [],
        loading: true
      })
    } else {
      setMention(null)
    }
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(pos, pos)
    })
  }

  /** 执行 / 指令。能本地做的本地做，需要 CLI 的才发出去 */
  const runCommand = (c: SlashCommand): void => {
    if (c.disabled) {
      showToast(`${c.name} 暂未接入`)
      return
    }
    setCommand(null)
    setText('')

    switch (c.action) {
      case 'clear':
        setRefs([])
        onClearConversation()
        showToast('已清空当前对话')
        break
      case 'compact':
        onSend({ text: c.name })
        break
      case 'model':
        setOpenPicker('model')
        break
      case 'permissions':
        setOpenPicker('mode')
        break
      case 'effort':
        setOpenPicker('effort')
        break
      case 'status':
        showToast(
          `模型 ${model || '未选'} · 权限 ${MODE_LABEL[permissionMode]} · 思考 ${EFFORT_LABEL[effort]} · ${turns} 轮 ${steps} 步`
        )
        break
      case 'help':
        setText('/')
        setCommand({ query: '', active: 0 })
        requestAnimationFrame(() => {
          const el = inputRef.current
          el?.focus()
          el?.setSelectionRange(1, 1)
        })
        break
      default:
        break
    }
  }

  /** 弹层打开时先接管方向键 / Enter / Tab / Esc，其余走原来的发送逻辑 */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    // 输入法正在组合（拼音候选还没上屏）时，Enter 是给输入法的 —— 不能抢
    if (e.nativeEvent.isComposing) return

    if (mention) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMention((m) =>
          m && m.items.length ? { ...m, active: (m.active + 1) % m.items.length } : m
        )
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMention((m) =>
          m && m.items.length
            ? { ...m, active: (m.active - 1 + m.items.length) % m.items.length }
            : m
        )
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const f = mention.items[mention.active]
        if (f) {
          e.preventDefault()
          insertMention(f)
          return
        }
        // 没有结果就收起弹层，让 Enter 走原来的发送逻辑
        setMention(null)
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMention(null)
        return
      }
    }

    if (command) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCommand((c) =>
          c && commandItems.length
            ? { ...c, active: (c.active + 1) % commandItems.length }
            : c
        )
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCommand((c) =>
          c && commandItems.length
            ? { ...c, active: (c.active - 1 + commandItems.length) % commandItems.length }
            : c
        )
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const c = commandItems[command.active]
        if (c) {
          e.preventDefault()
          runCommand(c)
          return
        }
        // 没有匹配就收起弹层，让 Enter 按普通消息发出去
        setCommand(null)
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setCommand(null)
        return
      }
    }

    if (sendKey === 'ctrlEnter') {
      // Enter / Shift+Enter 都是换行，Ctrl/Cmd+Enter 才发送
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        submit()
      }
      return
    }

    // Enter 发送，Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  /** 把剪贴板 / 拖入 / 文件选择里的图片读成附件；超过上限的部分直接丢 */
  const addImages = async (files: File[]): Promise<void> => {
    const room = MAX_IMAGES - attachments.length
    if (room <= 0) return
    const imgs = await readImageFiles(files.slice(0, room))
    if (imgs.length === 0) return
    setAttachments((cur) => [...cur, ...imgs].slice(0, MAX_IMAGES))
  }

  const removeImage = (id: string): void =>
    setAttachments((cur) => cur.filter((a) => a.id !== id))

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f)
    if (files.length > 0) {
      // 有图片就不要再把图片的二进制当文本插进输入框
      e.preventDefault()
      void addImages(files)
    }
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'))
    if (files.length === 0) return
    e.preventDefault()
    void addImages(files)
  }

  const submit = (): void => {
    const t = text.trim()
    if (!t && attachments.length === 0 && refs.length === 0) return
    const images = attachments
    // 引用在发送时展开成完整的 <ide_reference> 块；输入框里只留摘要
    const body = composeIdeMessage(t, refs)
    setText('')
    setAttachments([])
    setRefs([])
    setMention(null)
    setCommand(null)
    // meta 只用于「运行中入队」时恢复原稿；直接发送时主进程只读 text/images
    onSend({ text: body, images }, { draft: t, refs })
  }

  /** 把一条排队消息取回输入框。当前已有草稿时接在后面，不覆盖用户正在写的东西 */
  const editQueued = (q: QueuedMessage): void => {
    const taken = onTakeQueued(q.id)
    if (!taken) return
    setText((cur) => (cur.trim() ? `${cur}\n\n${taken.draft}` : taken.draft))
    if (taken.refs.length > 0) {
      setRefs((cur) => {
        const seen = new Set(cur.map(refKey))
        const add = taken.refs.filter((r) => !seen.has(refKey(r)))
        return add.length > 0 ? [...cur, ...add] : cur
      })
    }
    const imgs = taken.images ?? []
    if (imgs.length > 0) {
      setAttachments((cur) => [...cur, ...imgs].slice(0, MAX_IMAGES))
    }
    setMention(null)
    setCommand(null)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  return (
    <div className="composer">
      {/*
        工作目录放在输入框左上方。它是**进程的 cwd**，不是 CLI 的启动参数 ——
        改它等于换一个目录跑，而 --resume 会找不到原会话（会话身份是 (cwd, id)）。
        所以这一条是**这条会话固定的**，要换只能开新会话。
      */}
      {(cwd || changedFiles.length > 0) && (
        // 只露目录名，完整路径放进 title；做成小胶囊，别让它抢输入框的视线。
        // 右边那颗是「本轮改过哪些文件」—— 没有改动时它自己不渲染
        <div className="composer__cwdrow">
          {cwd && (
            <div className="composer__cwd" title={cwd}>
              <span className="composer__cwd-name">{baseName(cwd)}</span>
            </div>
          )}
          <ChangedFiles files={changedFiles} />
        </div>
      )}
      <div className="composer__anchor" ref={anchorRef}>
        {mention && (
          <MentionPopup
            items={mention.items}
            active={mention.active}
            query={mention.query}
            loading={mention.loading}
            scope={cwd ? baseName(cwd) : ''}
            onPick={insertMention}
            onHover={(index) =>
              setMention((m) => (m ? { ...m, active: index } : m))
            }
          />
        )}
        {command && (
          <CommandPopup
            items={commandItems}
            active={command.active}
            query={command.query}
            onPick={runCommand}
            onHover={(index) =>
              setCommand((c) => (c ? { ...c, active: index } : c))
            }
          />
        )}
        {toast && !mention && !command && <div className="composer__toast">{toast}</div>}

        <div
          className={`composer__box ${locked ? 'is-locked' : ''}`}
          onDrop={onDrop}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) e.preventDefault()
          }}
        >
          {queue.length > 0 && (
            <div className={`composer__queue ${queuePaused ? 'is-paused' : ''}`}>
              <div className="composer__queue-head">
                <span className="composer__queue-title">待发送</span>
                <b className="composer__queue-count">{queue.length}</b>
                <span className="composer__queue-hint">
                  {queuePaused ? '已暂停' : '本轮结束后按顺序自动发送'}
                </span>
                {queuePaused ? (
                  <button className="composer__queue-action is-resume" onClick={onResumeQueue}>
                    继续发送
                  </button>
                ) : (
                  <button className="composer__queue-action" onClick={onClearQueue}>
                    全部撤回
                  </button>
                )}
              </div>
              {queue.map((q, i) => (
                <div className="composer__queue-row" key={q.id}>
                  <span className="composer__queue-idx">{i + 1}</span>
                  <span className="composer__queue-text" title={q.draft}>
                    {q.draft.replace(/\s+/g, ' ').trim()}
                  </span>
                  {q.refs.length > 0 && (
                    <span className="composer__queue-meta">引用 {q.refs.length}</span>
                  )}
                  {(q.images?.length ?? 0) > 0 && (
                    <span className="composer__queue-meta">图片 {q.images?.length}</span>
                  )}
                  <span className="composer__queue-acts">
                    {queue.length > 1 && (
                      <>
                        <button
                          title="上移"
                          disabled={i === 0}
                          onClick={() => onMoveQueued(q.id, -1)}
                        >
                          ↑
                        </button>
                        <button
                          title="下移"
                          disabled={i === queue.length - 1}
                          onClick={() => onMoveQueued(q.id, 1)}
                        >
                          ↓
                        </button>
                      </>
                    )}
                    <button onClick={() => editQueued(q)}>编辑</button>
                    <button
                      className="is-del"
                      title="撤回这条"
                      aria-label="撤回这条排队消息"
                      onClick={() => onRemoveQueued(q.id)}
                    >
                      ×
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
          {refs.length > 0 && (
            <div className="composer__refs">
              {refs.map((r) => (
                <div className="composer__ref" key={r.id}>
                  <div className="composer__ref-head">
                    <span className="composer__ref-ico">&lt;/&gt;</span>
                    <span className="composer__ref-name">{r.name}</span>
                    <span className="composer__ref-path" title={r.rel}>
                      {r.rel}
                    </span>
                    <span className="composer__ref-range">
                      {r.kind === 'file'
                        ? `全文 · ${r.totalLines} 行${r.truncated ? ' · 已截断' : ''}`
                        : r.startLine === r.endLine
                          ? `L${r.startLine}`
                          : `L${r.startLine}–${r.endLine}`}
                    </span>
                    <span className="composer__ref-tag">来自 IDE</span>
                    <button
                      className="composer__ref-x"
                      onClick={() => removeRef(r.id)}
                      title="移除引用"
                      aria-label={`移除 ${r.name} 引用`}
                    >
                      ×
                    </button>
                  </div>
                  {r.kind === 'selection' && (
                    <pre className="composer__ref-code">{previewCode(r.code)}</pre>
                  )}
                </div>
              ))}
            </div>
          )}
          {attachments.length > 0 && (
          <div className="composer__attachments">
            {attachments.map((a) => (
              <div
                className="composer__attach"
                key={a.id}
                title={`${a.name}${a.width ? ` · ${a.width}×${a.height}` : ''}${a.size ? ` · ${Math.max(1, Math.round(a.size / 1024))} KB` : ''}`}
              >
                <img
                  src={`data:${a.mediaType};base64,${a.data}`}
                  alt={a.name}
                />
                <button
                  className="composer__attach-x"
                  onClick={() => removeImage(a.id)}
                  title="移除图片"
                  aria-label={`移除 ${a.name}`}
                >
                  ×
                </button>
              </div>
            ))}
            {attachments.length < MAX_IMAGES && (
              <span className="composer__attach-hint">可继续粘贴</span>
            )}
          </div>
        )}
        <textarea
          ref={inputRef}
          className="composer__input selectable"
          rows={1}
          placeholder={locked ? '先回答上面的问题，再继续发消息…' : '发消息或创建任务，/ 调用指令，@ 文件或对话'}
          value={text}
          disabled={locked}
          onChange={onChange}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
        />
        <div className="composer__bar">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              e.target.value = ''
              if (files.length > 0) void addImages(files)
            }}
          />
          <button
            className="iconbtn"
            title="添加图片"
            onClick={() => fileRef.current?.click()}
          >
            <IconPlus width={16} height={16} />
          </button>

          {/* 模型在左、模式在右 —— 模型是每条会话都要挑的，模式基本定了就不动 */}
          <Picker
            className="chip chip--model"
            popClass="picker__pop--left"
            open={openPicker === 'model'}
            onOpenChange={(o) => {
              setOpenPicker(o ? 'model' : null)
              if (o) {
                setMention(null)
                setCommand(null)
              }
            }}
            label={<span>{model || '未选模型'}</span>}
          >
            {(close) => (
              <ModelPicker
                cli={cli}
                channels={channels}
                activeChannelId={activeChannelId}
                model={model}
                hasConversation={hasConversation}
                onCli={onCliChange}
                onChannel={onChannelChange}
                onModel={onModelChange}
                close={close}
              />
            )}
          </Picker>

          <div className="composer__spacer" />

          {ctxUsed != null && (
            <span className="ctxanchor" ref={ctxAnchorRef}>
              <button
                type="button"
                className={`ctxchip${ctxTone}${ctxOpen ? ' is-open' : ''}`}
                title={ctxOpen ? undefined : ctxTitle}
                aria-label={ctxTitle || '上下文用量'}
                aria-haspopup="dialog"
                aria-expanded={ctxOpen}
                onClick={() => {
                  setCtxOpen((v) => !v)
                  // 详情和别的底栏弹层不要同时占着地方
                  setMention(null)
                  setCommand(null)
                  setOpenPicker(null)
                }}
              >
                {ctxPct != null && (
                  <svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true">
                    <circle
                      className="ctxchip__track"
                      cx="10"
                      cy="10"
                      r="7.5"
                      fill="none"
                      strokeWidth="2.4"
                    />
                    <circle
                      className="ctxchip__fill"
                      cx="10"
                      cy="10"
                      r="7.5"
                      fill="none"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeDasharray={`${(ctxPct / 100) * CTX_RING} ${CTX_RING}`}
                      transform="rotate(-90 10 10)"
                    />
                  </svg>
                )}
                <b>{ctxPct != null ? `${ctxPct}%` : fmtTokens(ctxUsed)}</b>
              </button>

              {ctxOpen && (
                <div className="ctxpop" role="dialog" aria-label="上下文用量">
                  <div className="ctxpop__head">
                    <span className="ctxpop__title">上下文用量</span>
                    <span className="ctxpop__scope">最近一次请求</span>
                    {ctxStateLabel && (
                      <span className={`ctxpop__state is-${ctxLevel}`}>{ctxStateLabel}</span>
                    )}
                  </div>

                  <div className="ctxpop__hero">
                    {ctxPct != null && (
                      <span className="ctxpop__ring">
                        <svg width="46" height="46" viewBox="0 0 46 46" aria-hidden="true">
                          <circle
                            className="ctxpop__ring-track"
                            cx="23"
                            cy="23"
                            r="19"
                            fill="none"
                            strokeWidth="3.4"
                          />
                          <circle
                            className={`ctxpop__ring-fill is-${ctxLevel}`}
                            cx="23"
                            cy="23"
                            r="19"
                            fill="none"
                            strokeWidth="3.4"
                            strokeLinecap="round"
                            strokeDasharray={`${(ctxPct / 100) * CTX_BIG_RING} ${CTX_BIG_RING}`}
                            transform="rotate(-90 23 23)"
                          />
                        </svg>
                        <b>{ctxPct}%</b>
                      </span>
                    )}
                    <span className="ctxpop__nums">
                      <span className="ctxpop__used">
                        {fmtTokens(ctxUsed)}
                        {ctxLimit != null && <span> / {fmtTokens(ctxLimit)}</span>}
                      </span>
                      <span className="ctxpop__sub">
                        {ctxLimit != null ? (
                          <>
                            剩余 <b>{fmtTokens(Math.max(0, ctxLimit - ctxUsed))}</b> ·
                            上限按模型名推断
                          </>
                        ) : (
                          '上限未知 · 只显示已用与构成'
                        )}
                      </span>
                    </span>
                  </div>

                  {ctxParts && ctxPartSum > 0 && (
                    <div className="ctxpop__sec">
                      <div className="ctxpop__sec-h">
                        <span>本轮上下文构成</span>
                        <b>合计 {fmtTokens(ctxPartSum)}</b>
                      </div>
                      <div className="ctxpop__stack" aria-hidden="true">
                        {ctxParts.map((p) =>
                          p.value > 0 ? (
                            <i
                              key={p.key}
                              className={`ctxseg--${p.key}`}
                              style={{ width: `${ctxShare(p.value)}%` }}
                            />
                          ) : null
                        )}
                      </div>
                      <div className="ctxpop__legend">
                        {ctxParts.map((p) => (
                          <div className="ctxpop__lg" key={p.key}>
                            <i className={`ctxseg--${p.key}`} />
                            <span>{p.label}</span>
                            <span className="v">{fmtTokens(p.value)}</span>
                            <span className="p">{ctxSharePct(p.value)}%</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {ctxLevel === 'danger' && (
                    <div className="ctxpop__alert">
                      <span>⚠</span>
                      <span>
                        上下文接近上限，建议先用 <code>/compact</code> 压缩，再继续下一轮。
                      </span>
                    </div>
                  )}

                  <div className="ctxpop__foot">
                    点击外部或按 Esc 关闭 · 压缩后数字会随下一轮更新
                  </div>
                </div>
              )}
            </span>
          )}

          {/* 思考深度。跟模型一样是 CLI 启动参数 —— 改了就换进程 + --resume 接回 */}
          <Picker
            className="chip chip--eff"
            open={openPicker === 'effort'}
            onOpenChange={(o) => {
              setOpenPicker(o ? 'effort' : null)
              if (o) {
                setMention(null)
                setCommand(null)
              }
            }}
            label={
              <>
                {/* 五根刻度条只留在弹层滑轨里；收起态用「脑 + 档位」就够了，
                    放回去会把 chip 撑到 128px，比旁边的权限模式宽一倍 */}
                <span className="chip__icon">
                  <IconBrain width={15} height={15} />
                </span>
                <span>{EFFORT_LABEL[effort]}</span>
              </>
            }
          >
            {/* 点回原来那一档由 applyEffort 自己挡掉 —— 那会白白重启一次 CLI 进程，
                而且会在转写区留一条「高 → 高」的废话 */}
            {(close) => (
              <EffortPicker
                value={effort}
                onPick={(l) => {
                  onEffortChange(l)
                  close()
                }}
              />
            )}
          </Picker>

          <Picker
            className="chip chip--mode"
            open={openPicker === 'mode'}
            onOpenChange={(o) => {
              setOpenPicker(o ? 'mode' : null)
              if (o) {
                setMention(null)
                setCommand(null)
              }
            }}
            label={
              <>
                <span className={`chip__dot ${running ? 'is-busy' : ''}`} />
                <span>{MODE_LABEL[permissionMode]}</span>
              </>
            }
          >
            {(close) => (
              <>
                <div className="picker__head">权限模式</div>
                {PERMISSION_MODES.map((m) => (
                  <button
                    key={m}
                    className={`picker__item ${m === permissionMode ? 'is-on' : ''}`}
                    onClick={() => {
                      onModeChange(m)
                      close()
                    }}
                  >
                    <span className="picker__item-name">{MODE_LABEL[m]}</span>
                    <span className="picker__item-hint">{MODE_HINT[m]}</span>
                  </button>
                ))}
              </>
            )}
          </Picker>

          {running ? (
            <>
              {/* 运行中：主按钮仍是停止；有内容时旁边多一个「加入队列」 */}
              {canSend && (
                <button className="queueadd" title="本轮结束后自动发送" onClick={submit}>
                  <span>↵</span>
                  <span>加入队列</span>
                  {queue.length > 0 && <b>{queue.length}</b>}
                </button>
              )}
              <button className="send is-stop" title="停止" onClick={onInterrupt}>
                <span className="send__stop" />
              </button>
            </>
          ) : (
            <button
              className={`send ${canSend ? 'is-ready' : ''}`}
              title="发送"
              disabled={!canSend}
              onClick={submit}
            >
              <IconSend width={16} height={16} />
            </button>
          )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 点外面收起；内容由调用方通过 children 渲染，拿到 close 用来收摊 */
function Picker({
  className,
  popClass = '',
  label,
  open: controlledOpen,
  onOpenChange,
  children
}: {
  className: string
  /** 弹层的额外类。模型选择器在左边，弹层要往左展开，不然会顶出窗口 */
  popClass?: string
  label: ReactNode
  /** 传了就是受控；/model 这类指令需要从外面打开它 */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: (close: () => void) => ReactNode
}): JSX.Element {
  const [innerOpen, setInnerOpen] = useState(false)
  const open = controlledOpen ?? innerOpen
  const ref = useRef<HTMLDivElement>(null)

  const close = (): void => {
    if (controlledOpen === undefined) setInnerOpen(false)
    onOpenChange?.(false)
  }

  const toggle = (): void => {
    const next = !open
    if (controlledOpen === undefined) setInnerOpen(next)
    onOpenChange?.(next)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
    // close 每帧都是新函数；open 变化才需要重新订阅
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <div className="picker" ref={ref}>
      <button className={className} onClick={toggle}>
        {label}
        <IconChevronDown width={13} height={13} />
      </button>
      {open && <div className={`picker__pop ${popClass}`}>{children(close)}</div>}
    </div>
  )
}

/*
 * 别在这里再写一份 baseName：之前这份是从别的文件复制来的，正则被转义弄坏成
 * `/[\/]/`（只切正斜杠），Windows 路径切不开，于是上面同时显示了项目名和完整
 * 路径 —— 两段一模一样的 `C:\Users\...`。统一用 useSessions 里那份。
 */

/** 五档在滑轨上的位置（0%~100%） */
const EFFORT_PCT = (i: number): number => (i / (EFFORT_LEVELS.length - 1)) * 100

/**
 * 思考深度：一根滑轨 + 五个刻度。
 *
 * 为什么不用列表（那是权限模式的做法）：五档之间是**连续**的深浅关系，
 * 列表只能靠读字分辨，滑轨一眼就看得出当前在哪一档、还剩几档可加。
 *
 * 交互：滑轨可以拖（拖的时候只改预览，松手才提交），刻度文字可以直接点。
 * 拖拽过程中每一帧都提交的话，每越过一档就要重启一次 CLI 进程 —— 没必要。
 */
function EffortPicker({
  value,
  onPick
}: {
  value: EffortLevel
  /** 选定了。外面负责把弹层收起来 */
  onPick: (l: EffortLevel) => void
}): JSX.Element {
  /** 拖拽中的临时值；松手前不往外发 */
  const [drag, setDrag] = useState<EffortLevel | null>(null)
  const dragging = useRef(false)
  const railRef = useRef<HTMLDivElement>(null)

  const shown = drag ?? value
  const idx = Math.max(0, EFFORT_LEVELS.indexOf(shown))

  /** 鼠标横坐标 → 最近的一档 */
  const levelAt = (clientX: number): EffortLevel => {
    const el = railRef.current
    if (!el) return value
    const r = el.getBoundingClientRect()
    const t = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    return EFFORT_LEVELS[Math.round(t * (EFFORT_LEVELS.length - 1))]
  }

  return (
    <div className="epick">
      <div className="picker__head">思考深度</div>

      <div
        className="erail"
        ref={railRef}
        onPointerDown={(e) => {
          dragging.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
          setDrag(levelAt(e.clientX))
        }}
        onPointerMove={(e) => {
          if (dragging.current) setDrag(levelAt(e.clientX))
        }}
        onPointerUp={(e) => {
          if (!dragging.current) return
          dragging.current = false
          const lv = levelAt(e.clientX)
          setDrag(null)
          onPick(lv)
        }}
      >
        <div className="erail__fill" style={{ width: `${EFFORT_PCT(idx)}%` }} />
        {EFFORT_LEVELS.map((l, i) => (
          <span key={l} className="erail__tick" style={{ left: `${EFFORT_PCT(i)}%` }} />
        ))}
        <span className="erail__knob" style={{ left: `${EFFORT_PCT(idx)}%` }} />
      </div>

      <div className="erail__lab">
        {EFFORT_LEVELS.map((l) => (
          <button
            key={l}
            className={l === value ? 'is-on' : ''}
            onClick={() => onPick(l)}
          >
            {EFFORT_LABEL[l]}
          </button>
        ))}
      </div>

      <div className="elvl">
        <div className="elvl__t">
          {EFFORT_LABEL[shown]} <em>{shown}</em>
        </div>
        <div className="elvl__d">{EFFORT_HINT[shown]}</div>
      </div>

      {/* 只是相对量感，不是真实数字 —— 别在这里写 token 数 */}
      <div className="emeter">
        <span>更快</span>
        <i style={{ ['--pct' as string]: `${EFFORT_PCT(idx)}%` }} />
        <span>更慢 / 更贵</span>
      </div>
    </div>
  )
}

/**
 * CLI › 渠道 › 模型 三级选择器，三列并排。
 *
 * 为什么不做成一层层点进去：这三样是**同一个决定**的三个部分
 * （用哪个 CLI、走哪个端点、调哪个模型），摊开才能一眼看全自己在用哪套。
 */
function ModelPicker({
  cli,
  channels,
  activeChannelId,
  model,
  hasConversation,
  onCli,
  onChannel,
  onModel,
  close
}: {
  cli: CliId
  channels: Channel[]
  activeChannelId: string | null
  model: string
  hasConversation: boolean
  onCli: (c: CliId) => void
  onChannel: (id: string) => void
  onModel: (m: string) => void
  close: () => void
}): JSX.Element {
  const [draft, setDraft] = useState(model)
  /** 点了别的 CLI、正等着确认的那个 */
  const [confirmCli, setConfirmCli] = useState<CliId | null>(null)
  const ch = channels.find((c) => c.id === activeChannelId) ?? null

  /**
   * 换 CLI 跟换模型/渠道**不是一回事**。
   *
   * 模型和渠道都是 CLI 的启动参数，换完用 `--resume` 接回原会话，上下文不丢。
   * CLI 换了就是另一个 provider、另一套会话记录 —— 接不回来，只能开新的。
   * 所以有内容的时候拦一道，别让人以为还在原来那条会话上。
   */
  const pickCli = (id: CliId): void => {
    if (id === cli) return
    if (hasConversation) {
      setConfirmCli(id)
      return
    }
    onCli(id)
    close()
  }

  // 默认模型置顶，后面接渠道里列的那些候选。去重 + 去掉空行（表单里允许空行）
  const options = Array.from(
    new Set([ch?.model ?? '', ...(ch?.models ?? [])].map((s) => s.trim()).filter(Boolean))
  )

  return (
    <div className="mpick">
      <div className="mpick__cols">
        <div className="mpick__col">
          <div className="mpick__h">CLI</div>
          {CLIS.map((c) => (
            <button
              key={c.id}
              className={`mpick__it ${c.id === cli ? 'is-on' : ''} ${c.ready ? '' : 'is-off'}`}
              disabled={!c.ready}
              onClick={() => pickCli(c.id)}
            >
              <span className="mpick__tick">{c.id === cli ? '✓' : ''}</span>
              <span className="mpick__name">{c.name}</span>
              {!c.ready && <span className="mpick__sub">未接入</span>}
            </button>
          ))}
        </div>

        <div className="mpick__col">
          <div className="mpick__h">渠道 · {cliDef(cli).name}</div>
          {channels.length === 0 && (
            <p className="mpick__empty">这个 CLI 还没配渠道，去设置里加一个。</p>
          )}
          {channels.map((c) => (
            <button
              key={c.id}
              className={`mpick__it ${c.id === activeChannelId ? 'is-on' : ''}`}
              onClick={() => onChannel(c.id)}
            >
              <span className="mpick__tick">{c.id === activeChannelId ? '✓' : ''}</span>
              <span className="mpick__name">{c.name}</span>
            </button>
          ))}
        </div>

        <div className="mpick__col">
          <div className="mpick__h">模型 · {ch?.name ?? '未选渠道'}</div>
          {options.map((m, i) => (
            <button
              key={m}
              className={`mpick__it ${m === model ? 'is-on' : ''}`}
              onClick={() => {
                onModel(m)
                close()
              }}
            >
              <span className="mpick__tick">{m === model ? '✓' : ''}</span>
              <span className="mpick__name mpick__name--mono">{m}</span>
              {i === 0 && <span className="mpick__sub">默认</span>}
            </button>
          ))}
          {options.length === 0 && <p className="mpick__empty">渠道里没填模型名。</p>}

          <div className="mpick__sep" />
          <div className="mpick__input">
            <input
              className="input"
              placeholder="自定义模型名，回车确认"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && draft.trim()) {
                  onModel(draft.trim())
                  close()
                }
              }}
            />
          </div>
        </div>
      </div>

      {confirmCli ? (
        <div className="mpick__warn">
          <div className="mpick__warn-t">换到 {cliDef(confirmCli).name} 会开一条新会话</div>
          <p className="mpick__warn-d">
            换 CLI 不是换启动参数 —— 它用的是另一套会话记录，当前这段对话带不过去。
            换模型和渠道都会 <code>--resume</code> 接回原会话，只有换 CLI 会断。
          </p>
          <div className="mpick__warn-b">
            <button className="mbtn" onClick={() => setConfirmCli(null)}>
              取消
            </button>
            <button
              className="mbtn mbtn--danger"
              onClick={() => {
                onCli(confirmCli)
                close()
              }}
            >
              换过去，开新会话
            </button>
          </div>
        </div>
      ) : (
        <p className="mpick__note">
          换模型 / 换渠道会换进程并用 <code>--resume</code> 接回当前会话，上下文不丢；
          换 CLI 是另一套会话记录，接不回来 —— 会开一条新的。
        </p>
      )}
    </div>
  )
}
