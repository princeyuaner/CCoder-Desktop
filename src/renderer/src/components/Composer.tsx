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
import type { NativeCommand } from '@shared/commands'
import {
  CLIS,
  cliDef,
  EFFORT_HINT_KEY,
  EFFORT_LABEL_KEY,
  effortLevelsFor,
  emptyCliConfig,
  type Channel,
  type CliConfig,
  type CliId,
  type EffortLevel,
  type SendKey
} from '@shared/settings'
import type { MessageKey } from '@shared/i18n'
import { sameModel } from '@shared/model'
import type { ImageAttachment } from '@shared/attachment'
import type { IdeCodeRef } from '@shared/ide-chat'
import type { SessionSendInput, SessionSendResult } from '@shared/session'
import type { QueuedMessage, SendMeta } from '../useChat'
import type { FileMatch } from '@shared/workspace'
import { composeIdeMessage } from '../ideRef'
import { MODE_HINT_KEY, MODE_LABEL_KEY, PERMISSION_MODES } from '../constants'
import { useI18n } from '../i18n'
import { baseName } from '@shared/path'
import type { ChangedFile } from '../changedFiles'
import { ChangedFiles } from './ChangedFiles'
import { CommandPopup, MentionPopup } from './ComposerPopups'
import { buildCommandItems, filterCommands, type PopupCommand } from '../commands'
import {
  IconBrain,
  IconChevronDown,
  IconClaudeCode,
  IconDeepSeek,
  IconOpenAI,
  IconPlus,
  IconSend
} from './Icons'
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

/**
 * 三列选择器落下的一套选择 —— 用哪个 CLI、走哪个端点、调哪个模型。
 *
 * 三者是同一个决定的三个部分，所以统一从 `onSelect` 提交，
 * 跨 CLI 时由父组件决定怎么切（那会开一条新会话）。
 */
export interface ModelSelection {
  cli: CliId
  channelId?: string
  /** 选 Claude 的「官方账号」伪来源 */
  official?: boolean
  model?: string
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
  /** 所有 CLI 的配置 —— 选择器悬停预览别的 CLI 的渠道时要用 */
  cliConfigs: Record<CliId, CliConfig>
  /** 该 CLI 当前在用的渠道 */
  activeChannelId: string | null
  model: string
  permissionMode: PermissionMode
  /** 本会话的思考深度（CLI 的 --effort） */
  effort: EffortLevel
  /** 这条会话的工作目录。显示在输入框左上方 —— 文件会写到哪里全看它 */
  cwd: string
  /** 本轮改过的文件。空数组 = 这一轮还没动过文件，那颗按钮就不出现 */
  changedFiles: ChangedFile[]
  /** 当前 CLI 上报的原生指令；Codex / dsh 的静态表在渲染层直接合入 */
  nativeCommands: NativeCommand[]
  /** 宿主动作做不了的 CLI 原生指令（如 Codex compact）交给主进程 */
  onRunCommand: (name: string, args?: string) => Promise<SessionSendResult>
  /** 发送快捷键：Enter 或 Ctrl/Cmd+Enter */
  sendKey: SendKey
  /** 当前会话里有没有内容 —— 换 CLI 会丢，有内容才值得拦一下 */
  hasConversation: boolean
  /** /status 用 */
  turns: number
  steps: number
  /** 最近一轮的用量 —— 底栏上下文胶囊从这里取 contextTokens */
  usage?: Usage
  /** 模型选择器里落下一套选择：CLI / 渠道 / 模型，点哪一列都走这里 */
  onSelect: (sel: ModelSelection) => void
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
  cliConfigs,
  activeChannelId,
  model,
  permissionMode,
  effort,
  cwd,
  changedFiles,
  nativeCommands,
  onRunCommand,
  sendKey,
  hasConversation,
  turns,
  steps,
  usage,
  onSelect,
  onModeChange,
  onEffortChange,
  onClearConversation,
  incomingRefs,
  onIncomingConsumed
}: Props): JSX.Element {
  const { t, tn } = useI18n()
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

  const curCfg = cliConfigs[cli] ?? emptyCliConfig(cli)
  /** Claude 的官方登录模式：不显示渠道名，显示「官方账号」 */
  const official =
    (cli === 'claude' || cli === 'dsh') && curCfg.authMode === 'official'
  /** 胶囊里要显示渠道名。没选渠道时也要占位，免得只看到一个模型名又不知道走的哪儿 */
  const channel = official
    ? null
    : (curCfg.channels).find((c) => c.id === activeChannelId) ?? null

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
   * 百分比优先用 provider 上报的值：dsh / codex 会把 CLI 的真实窗口一起报上来，
   * 模型名里没有 `[1m]` / `-200k` 标记时也能画环。Claude 不发这个字段，退回按
   * 模型名推断（读不出来就只显示已用 token —— 猜一个上限会把百分比算成假数）。
   */
  const ctxUsed = usage?.contextTokens && usage.contextTokens > 0 ? usage.contextTokens : null
  const ctxLimit = contextWindowOf(model)
  const ctxReportedPct =
    usage?.contextPercent != null && usage.contextPercent > 0
      ? Math.min(100, usage.contextPercent)
      : null
  const ctxPct = ctxReportedPct ?? contextPercent(ctxUsed ?? undefined, ctxLimit)
  const ctxTitle =
    ctxUsed == null
      ? ''
      : ctxLimit == null
        ? ctxReportedPct != null
          ? t('composer.ctx.usedPctUnknown', {
              used: fmtTokens(ctxUsed),
              pct: ctxReportedPct
            })
          : t('composer.ctx.usedUnknown', { used: fmtTokens(ctxUsed) })
        : t('composer.ctx.used', {
            used: fmtTokens(ctxUsed),
            limit: fmtTokens(ctxLimit),
            pct: ctxPct ?? 0,
            left: fmtTokens(Math.max(0, ctxLimit - ctxUsed))
          })

  /** 状态色与文案。70% / 90% 两档跟胶囊小环保持一致 */
  const ctxLevel =
    ctxPct == null ? null : ctxPct >= 90 ? 'danger' : ctxPct >= 70 ? 'warn' : 'ok'
  const ctxTone = ctxLevel === 'danger' ? ' is-danger' : ctxLevel === 'warn' ? ' is-warn' : ''
  const ctxStateLabel =
    ctxLevel === 'danger'
      ? t('composer.ctx.nearLimit')
      : ctxLevel === 'warn'
        ? t('composer.ctx.high')
        : ctxLevel === 'ok'
          ? t('composer.ctx.plenty')
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
        { key: 'cache', labelKey: 'composer.ctx.cacheRead' as MessageKey, value: ctxUsage.cacheReadTokens },
        { key: 'input', labelKey: 'composer.ctx.input' as MessageKey, value: ctxUsage.inputTokens },
        { key: 'write', labelKey: 'composer.ctx.cacheWrite' as MessageKey, value: ctxUsage.cacheCreationTokens },
        { key: 'out', labelKey: 'composer.ctx.output' as MessageKey, value: ctxUsage.outputTokens }
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

  const allCommands = useMemo(
    () => buildCommandItems(t, cli, nativeCommands),
    [t, cli, nativeCommands]
  )
  const commandItems = useMemo(
    () => (command ? filterCommands(allCommands, command.query) : []),
    [command, allCommands]
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

  /** 把一段文本塞进输入框；命令参数和 @ 引用共用一套聚焦逻辑 */
  const insertCommandText = (value: string, caret = value.length): void => {
    setText(value)
    requestAnimationFrame(() => {
      const el = inputRef.current
      el?.focus()
      el?.setSelectionRange(caret, caret)
    })
  }

  /** CLI 原生指令：能直接发给 CLI 的发，宿主动作映射不了的走 app 动作 */
  const runNativeCommand = (c: PopupCommand): void => {
    if (c.run === 'send') {
      /*
       * 有参数提示的先填 `/name `，让用户补完再发送；没有提示的直接执行。
       * 直接发送会走普通用户消息通道，CLI 自己识别 slash 指令。
       */
      if (c.argumentHint) insertCommandText(`${c.name} `)
      else onSend({ text: c.name })
      return
    }

    switch (c.action) {
      case 'plan':
        onModeChange('plan')
        break
      case 'insert':
        if (c.insert === '@') {
          setText('@')
          setMention({ query: '', start: 0, active: 0, items: [], loading: true })
          requestAnimationFrame(() => {
            const el = inputRef.current
            el?.focus()
            el?.setSelectionRange(1, 1)
          })
        } else if (c.insert) {
          insertCommandText(c.insert)
        }
        break
      default:
        break
    }
  }

  /** 宿主动作做不了的指令交给主进程（目前是 Codex 的 compact） */
  const runProviderCommand = (name: string): void => {
    void onRunCommand(name)
      .then((r) => {
        if (!r.ok) {
          showToast(r.message ?? t('composer.toast.commandUnsupported'))
          return
        }
        if (name === 'compact') showToast(t('composer.toast.compactStarted'))
      })
      .catch(() => showToast(t('composer.toast.commandUnsupported')))
  }

  /** 执行 / 指令。能本地做的本地做，需要 CLI 的才发出去 */
  const runCommand = (c: PopupCommand): void => {
    if (c.disabled) {
      showToast(t('composer.toast.notReady', { name: c.name }))
      return
    }
    setCommand(null)
    setText('')

    if (c.run === 'send') {
      runNativeCommand(c)
      return
    }

    switch (c.action) {
      case 'clear':
        setRefs([])
        onClearConversation()
        showToast(t('composer.toast.cleared'))
        break
      case 'compact':
        /*
         * Claude 自己会分发 /compact；Codex 需要 app-server 的
         * thread/compact/start；dsh 的 ACP 没有这个能力 —— 直接提示，
         * 不能为了报错先白拉起一个 dsh 进程。
         */
        if (cli === 'claude') onSend({ text: c.name })
        else if (cli === 'codex') runProviderCommand('compact')
        else showToast(t('composer.toast.commandUnsupported'))
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
          t('composer.status', {
            model: model || t('composer.status.noModel'),
            mode: t(MODE_LABEL_KEY[permissionMode]),
            effort: t(EFFORT_LABEL_KEY[effort]),
            turns,
            steps
          })
        )
        break
      case 'plan':
        onModeChange('plan')
        break
      case 'insert':
        runNativeCommand(c)
        break
      case 'help':
        insertCommandText('/', 1)
        setCommand({ query: '', active: 0 })
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
            cli={cli}
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
                <span className="composer__queue-title">{t('composer.queue.title')}</span>
                <b className="composer__queue-count">{queue.length}</b>
                <span className="composer__queue-hint">
                  {queuePaused ? t('composer.queue.paused') : t('composer.queue.hint')}
                </span>
                {queuePaused ? (
                  <button className="composer__queue-action is-resume" onClick={onResumeQueue}>
                    {t('composer.queue.resume')}
                  </button>
                ) : (
                  <button className="composer__queue-action" onClick={onClearQueue}>
                    {t('composer.queue.clear')}
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
                    <span className="composer__queue-meta">
                      {tn('composer.queue.refs', q.refs.length)}
                    </span>
                  )}
                  {(q.images?.length ?? 0) > 0 && (
                    <span className="composer__queue-meta">
                      {tn('composer.queue.images', q.images?.length ?? 0)}
                    </span>
                  )}
                  <span className="composer__queue-acts">
                    {queue.length > 1 && (
                      <>
                        <button
                          title={t('composer.queue.up')}
                          disabled={i === 0}
                          onClick={() => onMoveQueued(q.id, -1)}
                        >
                          ↑
                        </button>
                        <button
                          title={t('composer.queue.down')}
                          disabled={i === queue.length - 1}
                          onClick={() => onMoveQueued(q.id, 1)}
                        >
                          ↓
                        </button>
                      </>
                    )}
                    <button onClick={() => editQueued(q)}>{t('composer.queue.edit')}</button>
                    <button
                      className="is-del"
                      title={t('composer.queue.remove')}
                      aria-label={t('composer.queue.removeAria')}
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
                        ? `${tn('composer.ref.whole', r.totalLines)}${r.truncated ? ` · ${t('composer.ref.truncated')}` : ''}`
                        : r.startLine === r.endLine
                          ? `L${r.startLine}`
                          : `L${r.startLine}–${r.endLine}`}
                    </span>
                    <span className="composer__ref-tag">{t('composer.ref.fromIde')}</span>
                    <button
                      className="composer__ref-x"
                      onClick={() => removeRef(r.id)}
                      title={t('composer.ref.remove')}
                      aria-label={t('composer.ref.removeAria', { name: r.name })}
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
                  title={t('composer.attach.remove')}
                  aria-label={t('composer.attach.removeAria', { name: a.name })}
                >
                  ×
                </button>
              </div>
            ))}
            {attachments.length < MAX_IMAGES && (
              <span className="composer__attach-hint">{t('composer.attach.hint')}</span>
            )}
          </div>
        )}
        <textarea
          ref={inputRef}
          className="composer__input selectable"
          rows={1}
          placeholder={
            locked ? t('composer.placeholder.locked') : t('composer.placeholder.normal')
          }
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
            title={t('composer.addImage')}
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
            label={
              <>
                {/* 先说明走哪个 CLI、哪个渠道，再说用什么模型 —— 同名模型挂在
                    两个渠道上时，光看模型名分不出差别 */}
                <span className={`chip__cli chip__cli--${cli}`}>
                  {cli === 'claude' ? (
                    <IconClaudeCode width={14} height={14} />
                  ) : cli === 'codex' ? (
                    <IconOpenAI width={14} height={14} />
                  ) : (
                    <IconDeepSeek width={14} height={14} />
                  )}
                </span>
                <span className="chip__channel">
                  {official
                    ? cli === 'dsh'
                      ? t('auth.harnessCredentials')
                      : t('auth.officialAccount')
                    : channel?.name?.trim() || t('settings.channel.none')}
                </span>
                <span className="chip__sep">·</span>
                <span className="chip__model">
                  {model || (official ? t('composer.cliDefault') : t('chat.noModel'))}
                </span>
              </>
            }
          >
            {(close) => (
              <ModelPicker
                cli={cli}
                cliConfigs={cliConfigs}
                activeChannelId={activeChannelId}
                model={model}
                hasConversation={hasConversation}
                onSelect={onSelect}
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
                aria-label={ctxTitle || t('composer.ctx.aria')}
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
                <div
                  className="ctxpop"
                  role="dialog"
                  aria-label={t('composer.ctx.aria')}
                >
                  <div className="ctxpop__head">
                    <span className="ctxpop__title">{t('composer.ctx.title')}</span>
                    <span className="ctxpop__scope">{t('composer.ctx.recentRequest')}</span>
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
                        {ctxLimit != null
                          ? t('composer.ctx.remaining', {
                              tokens: fmtTokens(Math.max(0, ctxLimit - ctxUsed))
                            })
                          : t('composer.ctx.limitUnknown')}
                      </span>
                    </span>
                  </div>

                  {ctxParts && ctxPartSum > 0 && (
                    <div className="ctxpop__sec">
                      <div className="ctxpop__sec-h">
                        <span>{t('composer.ctx.breakdown')}</span>
                        <b>{t('composer.ctx.total', { tokens: fmtTokens(ctxPartSum) })}</b>
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
                            <span>{t(p.labelKey)}</span>
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
                        {t('composer.ctx.nearAlertPrefix')}
                        <code>/compact</code>
                        {t('composer.ctx.nearAlertSuffix')}
                      </span>
                    </div>
                  )}

                  <div className="ctxpop__foot">{t('composer.ctx.foot')}</div>
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
                <span>{t(EFFORT_LABEL_KEY[effort])}</span>
              </>
            }
          >
            {/* 点回原来那一档由 applyEffort 自己挡掉 —— 那会白白重启一次 CLI 进程，
                而且会在转写区留一条「高 → 高」的废话 */}
            {(close) => (
              <EffortPicker
                value={effort}
                levels={effortLevelsFor(cli)}
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
                <span>{t(MODE_LABEL_KEY[permissionMode])}</span>
              </>
            }
          >
            {(close) => (
              <>
                <div className="picker__head">{t('composer.mode')}</div>
                {PERMISSION_MODES.map((m) => (
                  <button
                    key={m}
                    className={`picker__item ${m === permissionMode ? 'is-on' : ''}`}
                    onClick={() => {
                      onModeChange(m)
                      close()
                    }}
                  >
                    <span className="picker__item-name">{t(MODE_LABEL_KEY[m])}</span>
                    <span className="picker__item-hint">{t(MODE_HINT_KEY[m])}</span>
                  </button>
                ))}
              </>
            )}
          </Picker>

          {running ? (
            <>
              {/* 运行中：主按钮仍是停止；有内容时旁边多一个「加入队列」 */}
              {canSend && (
                <button
                  className="queueadd"
                  title={t('composer.queueaddHint')}
                  onClick={submit}
                >
                  <span>↵</span>
                  <span>{t('composer.queueadd')}</span>
                  {queue.length > 0 && <b>{queue.length}</b>}
                </button>
              )}
              <button className="send is-stop" title={t('composer.stop')} onClick={onInterrupt}>
                <span className="send__stop" />
              </button>
            </>
          ) : (
            <button
              className={`send ${canSend ? 'is-ready' : ''}`}
              title={t('composer.send')}
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

/** 某一档在滑轨上的位置（0%~100%） */
const effortPct = (i: number, count: number): number =>
  count <= 1 ? 0 : (i / (count - 1)) * 100

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
  levels,
  onPick
}: {
  value: EffortLevel
  /** Claude 五档；Codex 多一档 Ultra */
  levels: EffortLevel[]
  /** 选定了。外面负责把弹层收起来 */
  onPick: (l: EffortLevel) => void
}): JSX.Element {
  const { t } = useI18n()
  /** 拖拽中的临时值；松手前不往外发 */
  const [drag, setDrag] = useState<EffortLevel | null>(null)
  const dragging = useRef(false)
  const railRef = useRef<HTMLDivElement>(null)

  const shown = drag ?? value
  const idx = Math.max(0, levels.indexOf(shown))

  /** 鼠标横坐标 → 最近的一档 */
  const levelAt = (clientX: number): EffortLevel => {
    const el = railRef.current
    if (!el) return value
    const r = el.getBoundingClientRect()
    const t = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    return levels[Math.round(t * (levels.length - 1))]
  }

  return (
    <div className="epick">
      <div className="picker__head">{t('composer.effort')}</div>

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
        <div className="erail__fill" style={{ width: `${effortPct(idx, levels.length)}%` }} />
        {levels.map((l, i) => (
          <span
            key={l}
            className="erail__tick"
            style={{ left: `${effortPct(i, levels.length)}%` }}
          />
        ))}
        <span
          className="erail__knob"
          style={{ left: `${effortPct(idx, levels.length)}%` }}
        />
      </div>

      <div className="erail__lab">
        {levels.map((l) => (
          <button
            key={l}
            className={l === value ? 'is-on' : ''}
            onClick={() => onPick(l)}
          >
            {t(EFFORT_LABEL_KEY[l])}
          </button>
        ))}
      </div>

      <div className="elvl">
        <div className="elvl__t">
          {t(EFFORT_LABEL_KEY[shown])} <em>{shown}</em>
        </div>
        <div className="elvl__d">{t(EFFORT_HINT_KEY[shown])}</div>
      </div>

      {/* 只是相对量感，不是真实数字 —— 别在这里写 token 数 */}
      <div className="emeter">
        <span>{t('composer.effort.faster')}</span>
        <i style={{ ['--pct' as string]: `${effortPct(idx, levels.length)}%` }} />
        <span>{t('composer.effort.slower')}</span>
      </div>
    </div>
  )
}

/**
 * 三列的行高 / 表头高度 / 内边距，用来把弹层高度锁死。
 * 跟 chat.css 里 `.mpick__it`（34px）、`.mpick__h`（23px）、`.mpick__col`（5px 内边距）
 * 保持一致 —— 改样式时记得一起改。
 */
const MPICK_ROW_H = 34
const MPICK_HEAD_H = 23
const MPICK_COL_PAD = 10
/** 三列最多长到多高（沿用原来的 300px 上限），超出后列内滚动 */
const MPICK_COL_MAX_H = 300
/** 官方登录模式的模型列：默认 + sonnet / opus / haiku */
const OFFICIAL_MODEL_ROWS = 4

/**
 * CLI › 渠道 › 模型 三级选择器，三列并排。
 *
 * 为什么不做成一层层点进去：这三样是**同一个决定**的三个部分
 * （用哪个 CLI、走哪个端点、调哪个模型），摊开才能一眼看全自己在用哪套。
 *
 * 三列之间是**悬停级联**：指针停在哪个 CLI 上，渠道列就展开它下面的渠道；
 * 停在哪个渠道上，模型列就展开那个渠道的模型。悬停只预览、不提交 ——
 * 否则滑过 Codex 就会把会话换掉。点下去才算数。
 */
function ModelPicker({
  cli,
  cliConfigs,
  activeChannelId,
  model,
  hasConversation,
  onSelect,
  close
}: {
  cli: CliId
  cliConfigs: Record<CliId, CliConfig>
  activeChannelId: string | null
  model: string
  hasConversation: boolean
  onSelect: (sel: ModelSelection) => void
  close: () => void
}): JSX.Element {
  const { t } = useI18n()
  /** 自定义模型名的输入。留空 —— 用当前模型预填会和上面的列表项长得一模一样 */
  /** 点了别的 CLI、正等着确认的那一套选择 */
  const [confirm, setConfirm] = useState<ModelSelection | null>(null)
  /** 悬停预览的 CLI；null = 没悬停，两列跟着当前会话的 CLI 走 */
  const [hoverCli, setHoverCli] = useState<CliId | null>(null)
  /** 悬停预览的渠道 —— 带上所属 CLI，免得换列时把上一列的悬停带过来 */
  const [hoverChannel, setHoverChannel] = useState<{ cli: CliId; id: string } | null>(null)
  /** 悬停在 Claude 的「官方账号」伪条目上 */
  const [hoverOfficial, setHoverOfficial] = useState(false)

  /** 右两列现在展开的是哪套配置：悬停的优先，没悬停就回到当前 CLI */
  const viewCli = hoverCli ?? cli
  const viewCfg = cliConfigs[viewCli] ?? emptyCliConfig(viewCli)
  const officialActive =
    (viewCli === 'claude' || viewCli === 'dsh') && viewCfg.authMode === 'official'
  /** 这个 CLI 自己当前在用的渠道；官方模式下没有渠道 */
  const inUseChannelId = officialActive
    ? null
    : viewCli === cli
      ? activeChannelId
      : viewCfg.activeChannelId
  /** 模型列要展开的渠道：悬停的那个优先，否则用它自己的在用渠道 */
  const shownChannelId =
    hoverChannel && hoverChannel.cli === viewCli ? hoverChannel.id : inUseChannelId
  const ch = viewCfg.channels.find((c) => c.id === shownChannelId) ?? null
  /** 模型列现在展开的是官方账号（悬停预览也算） */
  const officialShown =
    (viewCli === 'claude' || viewCli === 'dsh') &&
    (hoverOfficial || (officialActive && !hoverChannel))
  /** 模型列现在显示的就是这条会话在用的模型，才配打勾 */
  const modelInUse =
    viewCli === cli &&
    (officialShown ? officialActive : !officialActive && shownChannelId === activeChannelId)

  const clearHover = (): void => {
    setHoverCli(null)
    setHoverChannel(null)
    setHoverOfficial(false)
  }

  /**
   * 换 CLI 跟换模型/渠道**不是一回事**。
   *
   * 模型和渠道都是 CLI 的启动参数，换完用 `--resume` 接回原会话，上下文不丢。
   * CLI 换了就是另一个 provider、另一套会话记录 —— 接不回来，只能开新的。
   * 所以有内容的时候拦一道，别让人以为还在原来那条会话上。
   *
   * 返回 true 表示已经提交，false 表示挂起了确认条。
   */
  const commit = (sel: ModelSelection): boolean => {
    if (sel.cli !== cli && hasConversation) {
      setConfirm(sel)
      return false
    }
    onSelect(sel)
    return true
  }

  /** 点 CLI：只换 CLI，右边两列跟着刷新；选择器继续开着，接着挑渠道和模型 */
  const pickCli = (id: CliId): void => {
    if (id === cli) return
    commit({ cli: id })
  }

  /** 点渠道：落到它所属的 CLI 上；如果这列正预览着别的 CLI，这一下会顺带换过去 */
  const pickChannel = (c: Channel): void => {
    commit({ cli: viewCli, channelId: c.id })
  }

  /** 点「官方账号 / Harness 凭据」：切回无渠道模式，模型沿用设置里的默认值 */
  const pickOfficial = (): void => {
    if (commit({ cli: viewCli, official: true })) close()
  }

  /**
   * 点模型：模型属于模型列当前展开的那个来源（渠道或官方账号），一起提交。
   * 渠道没变就不必再记一次「渠道 A → A」。
   */
  const pickModel = (m: string): void => {
    if (officialShown) {
      if (commit({ cli: viewCli, official: true, model: m })) close()
      return
    }
    const channelId =
      shownChannelId && shownChannelId !== inUseChannelId ? shownChannelId : undefined
    if (commit({ cli: viewCli, channelId, model: m })) close()
  }

  // 默认模型置顶，后面接渠道里列的那些候选。去重 + 去掉空行（表单里允许空行）
  const options = Array.from(
    new Set([ch?.model ?? '', ...(ch?.models ?? [])].map((s) => s.trim()).filter(Boolean))
  )

  /**
   * 无渠道模式的模型列：设置里的默认模型 + 几个常用别名。
   *
   * 还要把**这条会话自己正在用的模型**塞进去 —— 模型是会话级的，
   * 它可能和设置里的默认值不同（甚至是个不在常用列表里的自定义名）。
   * 不补这一项，选择器就画不出「当前用它」的勾。
   */
  const officialModel = (viewCfg.officialModel ?? '').trim()
  const sessionModel = (viewCli === cli ? model : '').trim()
  const officialOptions = Array.from(
    new Set([
      officialModel,
      ...(viewCli === 'dsh'
        ? ['deepseek-flash', 'deepseek-v4-pro']
        : ['sonnet', 'opus', 'haiku']
      ),
      ...(sessionModel ? [sessionModel] : [])
    ])
  ).map((m) => ({ value: m, label: m || t('composer.picker.default') }))
  /** 勾选口径：会话有显式模型看会话，没有就看设置里的默认值 */
  const officialInUse = sessionModel || officialModel
  const officialIsOn = (value: string): boolean =>
    modelInUse &&
    ((value === '' && officialInUse === '') || sameModel(value, officialInUse))

  /**
   * 弹层高度锁成「所有预览里最长的那一列」。
   *
   * 悬停会切换右边两列的内容。弹层贴着输入框**向上**展开（bottom 定位），
   * 高度一变，整块内容就在指针下面上下平移 —— 指针落到别的行上，预览又切回去，
   * 真实鼠标的 1px 漂移就足够让它来回抖。锁死高度后，悬停只换内容不换尺寸。
   */
  const modelRowCount = (c: Channel): number =>
    new Set([c.model, ...c.models].map((s) => s.trim()).filter(Boolean)).size
  const previewRows = Math.max(
    CLIS.length,
    ...CLIS.map((c) => {
      const chans = cliConfigs[c.id]?.channels ?? []
      const officialRow = c.id === 'claude' || c.id === 'dsh' ? 1 : 0
      let rows = chans.length + officialRow
      for (const chn of chans) rows = Math.max(rows, modelRowCount(chn))
      return officialRow ? Math.max(rows, OFFICIAL_MODEL_ROWS) : rows
    })
  )
  const colsHeight = Math.min(
    MPICK_COL_MAX_H,
    MPICK_COL_PAD + MPICK_HEAD_H + previewRows * MPICK_ROW_H
  )

  /** 渠道列的方形头像：取名字首字，英文大写。比放一排一样的云朵图标好认。 */
  const avatarOf = (name: string): string => name.trim().slice(0, 1).toUpperCase() || '?'

  return (
    <div className="mpick" onMouseLeave={clearHover}>
      <div className="mpick__cols" style={{ height: colsHeight }}>
        <div className="mpick__col">
          <div className="mpick__h">CLI</div>
          {CLIS.map((c) => (
            <button
              key={c.id}
              className={`mpick__it ${c.id === cli ? 'is-on' : ''} ${
                hoverCli === c.id && c.id !== cli ? 'is-preview' : ''
              } ${c.ready ? '' : 'is-off'}`}
              disabled={!c.ready}
              onMouseEnter={() => {
                if (!c.ready) return
                setHoverCli(c.id)
                setHoverChannel(null)
                // 官方 / Harness 凭据行只在 Claude / dsh 这一列；换到别的 CLI 时别把预览带过去
                setHoverOfficial(false)
              }}
              onClick={() => pickCli(c.id)}
            >
              <span className={`mpick__ico mpick__ico--${c.id}`}>
                {c.id === 'claude' ? (
                  <IconClaudeCode width={15} height={15} />
                ) : c.id === 'codex' ? (
                  <IconOpenAI width={15} height={15} />
                ) : (
                  <IconDeepSeek width={15} height={15} />
                )}
              </span>
              <span className="mpick__name">{c.name}</span>
              {!c.ready && (
                <span className="mpick__sub">{t('settings.nav.notReady')}</span>
              )}
              <span className="mpick__tick">{c.id === cli ? '✓' : ''}</span>
            </button>
          ))}
        </div>

        <div className="mpick__col">
          <div className="mpick__h">
            {t('composer.picker.channel')}{' '}
            <span className="mpick__hctx">· {cliDef(viewCli).name}</span>
          </div>

          {(viewCli === 'claude' || viewCli === 'dsh') && (
            <button
              className={`mpick__it ${
                viewCli === cli && officialActive ? 'is-on' : ''
              } ${
                hoverOfficial && !(viewCli === cli && officialActive) ? 'is-preview' : ''
              }`}
              onMouseEnter={() => {
                setHoverOfficial(true)
                setHoverChannel(null)
              }}
              onClick={pickOfficial}
            >
              <span className={`mpick__ico mpick__ico--${viewCli}`}>
                {viewCli === 'claude' ? (
                  <IconClaudeCode width={15} height={15} />
                ) : (
                  <IconDeepSeek width={15} height={15} />
                )}
              </span>
              <span className="mpick__name">
                {viewCli === 'claude'
                  ? t('composer.picker.official')
                  : t('composer.picker.officialDsh')}
              </span>
              <span className="mpick__tick">
                {viewCli === cli && officialActive ? '✓' : ''}
              </span>
            </button>
          )}

          {viewCfg.channels.length === 0 && !officialActive && (
            <p className="mpick__empty">
              {viewCli === 'claude'
                ? t('composer.picker.noChannelClaude')
                : viewCli === 'dsh'
                  ? t('composer.picker.noChannelDsh')
                  : t('composer.picker.noChannel')}
            </p>
          )}
          {viewCfg.channels.map((c) => {
            const on =
              !officialActive &&
              (viewCli === cli
                ? c.id === activeChannelId
                : c.id === viewCfg.activeChannelId)
            return (
              <button
                key={c.id}
                className={`mpick__it ${on ? 'is-on' : ''} ${
                  hoverChannel?.cli === viewCli && hoverChannel.id === c.id && !on
                    ? 'is-preview'
                    : ''
                }`}
                onMouseEnter={() => {
                  setHoverChannel({ cli: viewCli, id: c.id })
                  setHoverOfficial(false)
                }}
                onClick={() => pickChannel(c)}
              >
                <span className="mpick__avatar">{avatarOf(c.name)}</span>
                <span className="mpick__name">{c.name}</span>
                <span className="mpick__tick">{on ? '✓' : ''}</span>
              </button>
            )
          })}
        </div>

        <div className="mpick__col mpick__col--models">
          <div className="mpick__h">
            {t('composer.picker.model')}{' '}
            <span className="mpick__hctx">
              ·{' '}
              {officialShown
                ? t('auth.officialAccount')
                : ch?.name ?? t('settings.channel.none')}
            </span>
          </div>
          {officialShown
            ? officialOptions.map((o, i) => (
                <button
                  key={o.value || '__default__'}
                  className={`mpick__it ${officialIsOn(o.value) ? 'is-on' : ''}`}
                  onClick={() => pickModel(o.value)}
                >
                  <span className="mpick__name mpick__name--mono">{o.label}</span>
                  {i === 0 && (
                    <span className="mpick__pill">{t('composer.picker.defaultPill')}</span>
                  )}
                  <span className="mpick__tick">{officialIsOn(o.value) ? '✓' : ''}</span>
                </button>
              ))
            : options.map((m, i) => (
                <button
                  key={m}
                  className={`mpick__it ${modelInUse && sameModel(m, model) ? 'is-on' : ''}`}
                  onClick={() => pickModel(m)}
                >
                  <span className="mpick__name mpick__name--mono">{m}</span>
                  {i === 0 && (
                    <span className="mpick__pill">{t('composer.picker.defaultPill')}</span>
                  )}
                  <span className="mpick__tick">
                    {modelInUse && sameModel(m, model) ? '✓' : ''}
                  </span>
                </button>
              ))}
          {!officialShown && options.length === 0 && (
            <p className="mpick__empty">{t('composer.picker.emptyModels')}</p>
          )}
        </div>
      </div>

      {confirm ? (
        <div className="mpick__warn">
          <div className="mpick__warn-t">
            {t('composer.picker.warnTitle', { cli: cliDef(confirm.cli).name })}
          </div>
          <p className="mpick__warn-d">{t('composer.picker.warnBody')}</p>
          <div className="mpick__warn-b">
            <button className="mbtn" onClick={() => setConfirm(null)}>
              {t('common.cancel')}
            </button>
            <button
              className="mbtn mbtn--danger"
              onClick={() => {
                const sel = confirm
                setConfirm(null)
                onSelect(sel)
                // 只是换 CLI 就把选择器留着，接着挑渠道；模型都选完了才收摊
                if (sel.model) close()
              }}
            >
              {t('composer.picker.switch')}
            </button>
          </div>
        </div>
      ) : (
        <p className="mpick__note">
          <span className="mpick__note-ico">i</span>
          <span>
            <b>{t('composer.picker.noteModel')}</b>
            {t('composer.picker.noteModelBody')}
            <code>--resume</code>
            <b>{t('composer.picker.noteCli')}</b>
            {t('composer.picker.noteCliBody')}
          </span>
        </p>
      )}
    </div>
  )
}
