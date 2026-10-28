import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatItem } from './useChat'

/**
 * 会话内查找（Ctrl+F）。
 *
 * 为什么用 CSS Custom Highlight API 而不是把匹配包成 `<mark>`：
 * 转写区是流式渲染、每条消息由很多子组件拼出来（富文本、工具卡、引用卡）。
 * 要把命中的文本包进元素，就得在每个渲染分支里都改一遍结构，还得保证
 * 流式增量到来时不丢包装 —— 那是把整套转写渲染翻新一遍。
 *
 * Highlight API 只往 DOM **画**一层高亮，不碰结构：拿到所有文本节点后
 * 用 Range 圈出命中即可。缺点是被 `content-visibility: auto` 跳过的块
 * 没有可用的几何信息（`scrollIntoView` 不可靠），所以"跳到第 N 处"走的是
 * 另一条路：按 item 定位，直接滚动那一行。
 */

/** 单条消息最多高亮多少处 —— 防止在一条巨型工具输出里匹配几十万次 */
const MAX_PER_ITEM = 200
/** 一次查找最多高亮多少处；再多也没人会翻 */
const MAX_TOTAL = 2000

const HL_ALL = 'ccoder-find'
const HL_CURRENT = 'ccoder-find-current'

interface FindHit {
  /** ChatItem.id —— 用来滚动到那一行 */
  itemId: string
  /** 在这条 item 里的第几处，只用于计数 */
  index: number
}

export interface FindApi {
  open: boolean
  query: string
  /** 当前停在第几处（0 基）；-1 = 没有命中 */
  current: number
  /** 总命中数 */
  total: number
  /**
   * 查询串已经变了、但还没扫完。
   *
   * 防抖窗口里 total 还是上一次的（可能是 0）—— 界面据此先别显示「无匹配」，
   * 否则用户每敲一个字都会看到一次红色的「无匹配」闪一下。
   */
  pending: boolean
  openFind(): void
  /** 已经开着时把焦点送回输入框（第二下 Ctrl+F） */
  focus(): void
  setQuery(q: string): void
  /** 关闭并清掉所有高亮 */
  close(): void
  next(): void
  prev(): void
}

/**
 * 一条 item 参与查找的纯文本。
 *
 * 刻意只取"看得到的字"。工具输出、思考块、引用代码都算 —— 用户搜报错原文
 * 时正是在这些地方找。图片没有文本，自然落空。
 */
function itemText(it: ChatItem): string {
  switch (it.kind) {
    case 'user':
    case 'text':
    case 'thinking':
      return it.text
    case 'tool':
      return [it.command, it.subject, it.summary, it.content].filter(Boolean).join('\n')
    case 'permission':
      return [it.tool, it.summary].filter(Boolean).join(' ')
    case 'question':
      return it.questions.map((q) => [q.header, q.question].filter(Boolean).join(' ')).join('\n')
    case 'error':
      return typeof it.message === 'string' ? it.message : ''
    default:
      return ''
  }
}

/** 在所有文本节点里找 needle；Range 与命中列表按文档顺序产出 */
function collect(root: HTMLElement, needle: string): { ranges: Range[]; hits: FindHit[] } {
  const ranges: Range[] = []
  const hits: FindHit[] = []
  if (!needle) return { ranges, hits }

  const lower = needle.toLowerCase()
  const perItem = new Map<string, number>()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement
      // 脚本 / 样式 / 输入框不该被搜到
      if (!parent) return NodeFilter.FILTER_REJECT
      const tag = parent.tagName
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA') {
        return NodeFilter.FILTER_REJECT
      }
      return node.nodeValue?.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    }
  })

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? ''
    const hay = text.toLowerCase()
    const itemId = node.parentElement?.closest<HTMLElement>('[data-item-id]')?.dataset.itemId ?? ''
    let from = 0
    let i = hay.indexOf(lower, from)
    while (i >= 0) {
      const seen = perItem.get(itemId) ?? 0
      if (itemId && seen >= MAX_PER_ITEM) break
      const r = document.createRange()
      r.setStart(node, i)
      r.setEnd(node, i + needle.length)
      ranges.push(r)
      if (itemId) {
        perItem.set(itemId, seen + 1)
        hits.push({ itemId, index: seen })
      } else {
        // 不在任何消息行里的文本（空态提示等）也高亮，但不参与跳转计数
        hits.push({ itemId: '', index: 0 })
      }
      if (ranges.length >= MAX_TOTAL) return { ranges, hits }
      from = i + needle.length
      i = hay.indexOf(lower, from)
    }
  }
  return { ranges, hits }
}

/** 把主高亮 / 当前高亮写进 registry；不支持时安静退回（只是没有颜色） */
function paint(all: Range[], current: Range | null): void {
  const reg = typeof CSS !== 'undefined' ? CSS.highlights : undefined
  if (!reg) return
  try {
    if (all.length === 0) {
      reg.delete(HL_ALL)
      reg.delete(HL_CURRENT)
      return
    }
    reg.set(HL_ALL, new Highlight(...all))
    if (current) reg.set(HL_CURRENT, new Highlight(current))
    else reg.delete(HL_CURRENT)
  } catch {
    // Range 所在节点被卸载了之类；下一次查找会重算
  }
}

function clearPaint(): void {
  const reg = typeof CSS !== 'undefined' ? CSS.highlights : undefined
  if (!reg) return
  try {
    reg.delete(HL_ALL)
    reg.delete(HL_CURRENT)
  } catch {
    // 同上
  }
}

/** 滚动到某一处命中。块被 content-visibility 跳过时浏览器会先把它排版出来 */
function revealHit(hit: FindHit, root: HTMLElement | null): void {
  if (!hit.itemId) return
  const scope = root ?? document
  const safe =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(hit.itemId)
      : hit.itemId.replace(/["\\]/g, '\\$&')
  const row = scope.querySelector<HTMLElement>(`[data-item-id="${safe}"]`)
  row?.scrollIntoView({ block: 'center', inline: 'nearest' })
}

/**
 * 搜索状态机。
 *
 * `items` 每次流式增量都会换引用，但只有**文本内容真的变了**才需要重算 ——
 * 用一个按 id + 长度拼的签名挡住无谓的重复扫描；真正重算前再防抖一次。
 */
/** 输入停下多久之后真的去扫 DOM */
const DEBOUNCE_MS = 90
/**
 * 正在流式输出时用更长的间隔。
 *
 * 每来一个 delta 内容长度就变，签名跟着变 → 会触发重扫；长会话一次全量
 * TreeWalker 要几毫秒，11 次/秒就够呛。流式期间用户多半只是"看着高亮跟上来"，
 * 400ms 一次的观感是一样的。
 */
const LIVE_DEBOUNCE_MS = 400

export function useFindInConversation(
  items: ChatItem[],
  scrollEl: HTMLDivElement | null,
  /** 视图变了（对话 / 轨迹）也要重算 —— DOM 整个换了 */
  revision = '',
  /** 这一轮还在跑：重扫间隔放长 */
  live = false
): FindApi {
  const [open, setOpen] = useState(false)
  const [query, setQueryState] = useState('')
  const [current, setCurrent] = useState(-1)
  const [total, setTotal] = useState(0)
  const [pending, setPending] = useState(false)
  const hitsRef = useRef<FindHit[]>([])
  const rangesRef = useRef<Range[]>([])
  const currentRef = useRef(-1)
  /** 每次重算 +1；防抖回来时如果序号变了就丢掉那次结果 */
  const seqRef = useRef(0)
  const timerRef = useRef<number | null>(null)

  /** 内容签名：id + 文本长度。够挡住"流式 delta 只追加"的重复扫描 */
  const sig = useMemo(
    () => `${revision}\u0000${items.map((i) => `${i.id}:${itemText(i).length}`).join('|')}`,
    [items, revision]
  )

  const apply = useCallback(
    (q: string, root: HTMLDivElement | null, keepIndex: boolean): void => {
      setPending(false)
      if (!root || !q.trim()) {
        hitsRef.current = []
        rangesRef.current = []
        clearPaint()
        currentRef.current = -1
        setTotal(0)
        setCurrent(-1)
        return
      }
      const { ranges, hits } = collect(root, q.trim())
      rangesRef.current = ranges
      hitsRef.current = hits
      setTotal(hits.length)
      if (hits.length === 0) {
        currentRef.current = -1
        setCurrent(-1)
        clearPaint()
        return
      }
      const idx = keepIndex && currentRef.current >= 0
        ? Math.min(currentRef.current, hits.length - 1)
        : 0
      currentRef.current = idx
      setCurrent(idx)
      paint(ranges, ranges[idx] ?? null)
      if (!keepIndex) revealHit(hits[idx], root)
    },
    []
  )

  /** 防抖重算。textChanged=false 表示消息内容变了，不是查询串变了 */
  const schedule = useCallback(
    (q: string, textChanged: boolean): void => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      const seq = ++seqRef.current
      const wait = textChanged ? DEBOUNCE_MS : live ? LIVE_DEBOUNCE_MS : DEBOUNCE_MS
      // 查询串一动就标成"待扫描"，界面别拿上一轮的 0 去显示「无匹配」
      if (textChanged) setPending(true)
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        if (seq !== seqRef.current) return
        apply(q, scrollEl, !textChanged)
      }, wait)
    },
    [apply, scrollEl, live]
  )

  const setQuery = useCallback(
    (q: string): void => {
      setQueryState(q)
      schedule(q, true)
    },
    [schedule]
  )

  /** 消息内容 / 滚动容器变了：保持当前位置，只重画 */
  useEffect(() => {
    if (!open || !query.trim()) return
    schedule(query, false)
    // sig 是内容摘要；query 由 setQuery 自己触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, open, scrollEl])

  const close = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    seqRef.current++
    setOpen(false)
    setQueryState('')
    setTotal(0)
    setCurrent(-1)
    setPending(false)
    currentRef.current = -1
    hitsRef.current = []
    rangesRef.current = []
    clearPaint()
  }, [])

  const step = useCallback(
    (dir: 1 | -1): void => {
      const hits = hitsRef.current
      if (hits.length === 0) return
      const idx = (currentRef.current + dir + hits.length) % hits.length
      currentRef.current = idx
      setCurrent(idx)
      paint(rangesRef.current, rangesRef.current[idx] ?? null)
      revealHit(hits[idx], scrollEl)
    },
    [scrollEl]
  )

  const next = useCallback((): void => step(1), [step])
  const prev = useCallback((): void => step(-1), [step])

  const openFind = useCallback((): void => setOpen(true), [])

  /**
   * 第二下 Ctrl+F 只把焦点送回输入框。
   *
   * 用 DOM 查询而不是 ref 下发：FindBar 在 Transcript 的 JSX 里，把 ref
   * 穿回 hook 要再加一层接口，而这里的 id 只此一处，不会撞。
   */
  const focus = useCallback((): void => {
    const el = document.querySelector<HTMLInputElement>('.findbar__input')
    el?.focus()
    el?.select()
  }, [])

  // 关闭 / 卸载时一定要把 registry 清干净，否则高亮会留在下一次渲染里
  useEffect(() => clearPaint, [])

  return useMemo(
    () => ({ open, query, current, total, pending, openFind, focus, setQuery, close, next, prev }),
    [open, query, current, total, pending, openFind, focus, setQuery, close, next, prev]
  )
}
