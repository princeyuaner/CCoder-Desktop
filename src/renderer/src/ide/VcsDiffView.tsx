import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { VcsDiffData } from '@shared/vcs'
import {
  buildFullFile,
  diffStat,
  parseDiff,
  toUnifiedRows,
  wordDiff,
  type DiffHunk,
  type DiffSeg,
  type DiffSide,
  type FullFileRow,
  type UnifiedRow
} from './diff'
import { useI18n } from '../i18n'

/**
 * 一次最多渲染多少行。
 *
 * 整文件视图也要防超大文件：初始只挂 2000 行，导航到更后面的差异时
 * 自动把窗口撑到目标位置；剩下的仍由「再显示」追加。
 */
const PAGE_ROWS = 2000

const MODE_KEY = 'ccoder:ide:diff:mode'
const COLLAPSE_KEY = 'ccoder:ide:diff:collapse'

type ViewMode = 'split' | 'uni'

function readMode(): ViewMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'uni' ? 'uni' : 'split'
  } catch {
    return 'split'
  }
}

function readCollapse(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch {
    return false
  }
}

/* ── 回落：只有差异块（完整文本拿不到时） ─────────────── */

function DiffCell({
  side,
  tone,
  segs
}: {
  side: DiffSide | null
  tone: 'ctx' | 'add' | 'del' | 'empty'
  segs?: DiffSeg[] | null
}): JSX.Element {
  const mark = tone === 'add' ? '+' : tone === 'del' ? '−' : ''
  return (
    <div className={`ide-dcell is-${tone}`}>
      <span className="ide-dln">{side?.no ?? ''}</span>
      <span className="ide-dmk">{mark}</span>
      <span className="ide-dtext">
        {segs ? (
          segs.map((s, i) =>
            s.changed ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>
          )
        ) : (
          (side?.text ?? '')
        )}
      </span>
    </div>
  )
}

/** 一对改动词逐词比过再渲染；纯增 / 纯删没有对照，整行都是新内容 */
function RowPair({ row }: { row: FullFileRow }): JSX.Element {
  const words = useMemo(
    () =>
      row.kind === 'change' && row.left?.text != null && row.right?.text != null
        ? wordDiff(row.left.text, row.right.text)
        : null,
    [row]
  )
  return (
    <>
      <DiffCell
        side={row.left}
        segs={words?.left}
        tone={
          row.kind === 'ctx'
            ? 'ctx'
            : row.kind === 'change' || row.kind === 'del'
              ? 'del'
              : 'empty'
        }
      />
      <DiffCell
        side={row.right}
        segs={words?.right}
        tone={
          row.kind === 'ctx'
            ? 'ctx'
            : row.kind === 'change' || row.kind === 'add'
              ? 'add'
              : 'empty'
        }
      />
    </>
  )
}

/** 旧的差异块视图；完整文本不可用、二进制、截断或 combined diff 时使用 */
function HunkDiffView({
  data,
  hunks
}: {
  data: VcsDiffData
  hunks: DiffHunk[]
}): JSX.Element {
  const { t } = useI18n()
  const stat = useMemo(() => diffStat(data.diff), [data.diff])
  const totalRows = useMemo(() => hunks.reduce((n, h) => n + h.rows.length, 0), [hunks])

  const [limit, setLimit] = useState(PAGE_ROWS)
  // 换一份 diff 时重新从头分批，别把上一份的展开进度带过来
  useEffect(() => {
    setLimit(PAGE_ROWS)
  }, [data.diff])

  const visible = useMemo(() => {
    let left = limit
    const out: { hunk: DiffHunk; rows: DiffHunk['rows'] }[] = []
    for (const h of hunks) {
      if (left <= 0) break
      const rows = h.rows.slice(0, left)
      left -= rows.length
      out.push({ hunk: h, rows })
    }
    return out
  }, [hunks, limit])

  const label =
    data.source === 'staged'
      ? t('diff.staged')
      : data.source === 'head'
        ? t('diff.head')
        : data.source === 'revision'
          ? data.revision
            ? t('diff.revision', { rev: data.revision.slice(0, 8) })
            : t('diff.commit')
          : t('diff.working')

  return (
    <div className="ide-diffwrap">
      {data.fullTextOmitted && (
        <div className="ide-fdiff-fallback">{t('diff.fullFileFallback')}</div>
      )}
      <div className="ide-diffhead">
        <span>{label}</span>
        {data.untracked && <em>{t('diff.untracked')}</em>}
        {data.truncated && <em>{t('diff.truncated')}</em>}
        <span className="ide-spacer" />
        {stat.added > 0 && <b className="ide-add">+{stat.added}</b>}
        {stat.removed > 0 && <b className="ide-del">−{stat.removed}</b>}
      </div>
      <div className={`ide-diffbody ${data.untracked ? 'is-untracked' : ''}`}>
        {visible.map(({ hunk, rows }, hi) => (
          <div key={hi} className="ide-hunkblock">
            <div className="ide-hunk">{hunk.header}</div>
            {rows.map((r, ri) => (
              <div key={ri} className={`ide-drow ${data.untracked ? 'is-untracked' : ''}`}>
                {data.untracked ? (
                  <DiffCell side={r.right} tone="add" />
                ) : (
                  <RowPair row={{ kind: r.kind, left: r.left, right: r.right, change: null }} />
                )}
              </div>
            ))}
          </div>
        ))}
        {totalRows > limit && (
          <div className="ide-diffmore">
            <span>{t('diff.more', { limit, total: totalRows })}</span>
            <button type="button" onClick={() => setLimit((n) => n + PAGE_ROWS)}>
              {t('diff.showMore', { n: PAGE_ROWS })}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/* ── 整文件视图 ─────────────────────────────────────────── */

type DisplayItem =
  | { type: 'row'; mode: 'split'; row: FullFileRow }
  | { type: 'row'; mode: 'uni'; row: UnifiedRow }
  | { type: 'gap'; count: number }

interface DisplayState {
  items: DisplayItem[]
  changeFirst: Map<number, number>
}

/** 折叠时每组改动前后各留 2 行上下文，中间压成一条可点击的「未修改」带 */
function wantKeep(change: number | null, rows: Array<{ change: number | null }>, i: number): boolean {
  if (change != null) return true
  for (let d = 1; d <= 2; d++) {
    const a = rows[i - d]
    const b = rows[i + d]
    if ((a && a.change != null) || (b && b.change != null)) return true
  }
  return false
}

function buildSplitDisplay(rows: FullFileRow[], collapse: boolean): DisplayState {
  const items: DisplayItem[] = []
  const changeFirst = new Map<number, number>()
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!collapse || wantKeep(row.change, rows, i)) {
      if (row.change != null && !changeFirst.has(row.change)) {
        changeFirst.set(row.change, items.length)
      }
      items.push({ type: 'row', mode: 'split', row })
    } else {
      let j = i
      while (j < rows.length && !wantKeep(rows[j].change, rows, j)) j++
      items.push({ type: 'gap', count: j - i })
      i = j - 1
    }
  }
  return { items, changeFirst }
}

function buildUniDisplay(rows: UnifiedRow[], collapse: boolean): DisplayState {
  const items: DisplayItem[] = []
  const changeFirst = new Map<number, number>()
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!collapse || wantKeep(row.change, rows, i)) {
      if (row.change != null && !changeFirst.has(row.change)) {
        changeFirst.set(row.change, items.length)
      }
      items.push({ type: 'row', mode: 'uni', row })
    } else {
      let j = i
      while (j < rows.length && !wantKeep(rows[j].change, rows, j)) j++
      items.push({ type: 'gap', count: j - i })
      i = j - 1
    }
  }
  return { items, changeFirst }
}

function renderSegs(text: string, segs?: DiffSeg[]): JSX.Element {
  if (!segs) return <>{text}</>
  return (
    <>
      {segs.map((s, i) =>
        s.changed ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>
      )}
    </>
  )
}

function longTitle(text?: string): string | undefined {
  return text && text.length > 90 ? text : undefined
}

const SplitRowView = memo(function SplitRowView({
  row,
  active,
  first,
  last
}: {
  row: FullFileRow
  active: boolean
  first: boolean
  last: boolean
}): JSX.Element {
  const words = useMemo(
    () =>
      row.kind === 'change' && row.left?.text != null && row.right?.text != null
        ? wordDiff(row.left.text, row.right.text)
        : null,
    [row]
  )
  const leftCls = !row.left ? 'is-empty' : row.kind === 'ctx' ? '' : 'is-del'
  const rightCls = !row.right ? 'is-empty' : row.kind === 'ctx' ? '' : 'is-add'
  const leftMark = row.kind === 'ctx' || !row.left ? '' : '−'
  const rightMark = row.kind === 'ctx' || !row.right ? '' : '+'
  const cls = [
    'ide-fdiff-row',
    `is-${row.kind}`,
    active ? 'is-active' : '',
    first ? 'is-active-first' : '',
    last ? 'is-active-last' : ''
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div className={cls} data-change={row.change ?? undefined}>
      <div className={`ide-fdiff-half left ${leftCls}`}>
        <span className="ide-fdiff-ln">{row.left?.no ?? ''}</span>
        <span className="ide-fdiff-mk">{leftMark}</span>
        <span className="ide-fdiff-tx" title={longTitle(row.left?.text)}>
          <span className="ide-fdiff-tx-inner">
            {renderSegs(row.left?.text ?? '', words?.left)}
          </span>
        </span>
      </div>
      <div className={`ide-fdiff-half right ${rightCls}`}>
        <span className="ide-fdiff-ln">{row.right?.no ?? ''}</span>
        <span className="ide-fdiff-mk">{rightMark}</span>
        <span className="ide-fdiff-tx" title={longTitle(row.right?.text)}>
          <span className="ide-fdiff-tx-inner">
            {renderSegs(row.right?.text ?? '', words?.right)}
          </span>
        </span>
      </div>
    </div>
  )
})

const UniRowView = memo(function UniRowView({
  row,
  active,
  first,
  last
}: {
  row: UnifiedRow
  active: boolean
  first: boolean
  last: boolean
}): JSX.Element {
  const segs = useMemo(() => {
    if (row.kind === 'ctx' || row.pairText == null) return undefined
    const words = wordDiff(
      row.kind === 'del' ? row.text : row.pairText,
      row.kind === 'del' ? row.pairText : row.text
    )
    return row.kind === 'del' ? words.left : words.right
  }, [row])
  const mark = row.kind === 'del' ? '−' : row.kind === 'add' ? '+' : ''
  const cls = [
    'ide-fdiff-row',
    'is-uni',
    `is-${row.kind}`,
    active ? 'is-active' : '',
    first ? 'is-active-first' : '',
    last ? 'is-active-last' : ''
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div className={cls} data-change={row.change ?? undefined}>
      <span className="ide-fdiff-ln old">{row.oldNo ?? ''}</span>
      <span className="ide-fdiff-ln new">{row.newNo ?? ''}</span>
      <span className="ide-fdiff-mk">{mark}</span>
      <span className="ide-fdiff-tx" title={longTitle(row.text)}>
        <span className="ide-fdiff-tx-inner">{renderSegs(row.text, segs)}</span>
      </span>
    </div>
  )
})

function GapRow({ count, onExpand }: { count: number; onExpand: () => void }): JSX.Element {
  const { t } = useI18n()
  return (
    <button type="button" className="ide-fdiff-gap" onClick={onExpand}>
      <span>⋯</span>
      <span>{t('diff.unchangedLines', { n: count })}</span>
      <span className="ide-fdiff-gline" />
      <span>{t('diff.expand')}</span>
    </button>
  )
}

function FullFileDiff({
  data,
  hunks
}: {
  data: VcsDiffData
  hunks: DiffHunk[]
}): JSX.Element {
  const { t } = useI18n()
  const before = data.beforeText ?? ''
  const after = data.afterText ?? ''
  const model = useMemo(() => buildFullFile(before, after, hunks), [before, after, hunks])

  const [mode, setMode] = useState<ViewMode>(readMode)
  const [collapse, setCollapse] = useState<boolean>(readCollapse)
  const [active, setActive] = useState(0)
  const [limit, setLimit] = useState(PAGE_ROWS)

  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const hbarRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const pendingScroll = useRef(true)
  const activeRef = useRef(0)
  activeRef.current = active
  /** 当前查看的是哪一份 diff；同一文件刷新时不要重置浏览位置 */
  const identity = `${data.rel}\u0000${data.source}\u0000${data.revision ?? ''}`
  const identityRef = useRef(identity)

  // 只构建当前模式的显示模型：整文件可能有几万行，切到统一视图时才需要
  // 拆成扁平行，没必要在并排模式下也常驻一份。
  const display = useMemo(
    () =>
      mode === 'split'
        ? buildSplitDisplay(model.rows, collapse)
        : buildUniDisplay(toUnifiedRows(model.rows), collapse),
    [mode, model.rows, collapse]
  )
  const visible = useMemo(() => display.items.slice(0, limit), [display.items, limit])
  const changeFirst = display.changeFirst

  const stat = useMemo(
    () =>
      model.changes.reduce(
        (acc, c) => ({ added: acc.added + c.added, removed: acc.removed + c.removed }),
        { added: 0, removed: 0 }
      ),
    [model.changes]
  )

  /** 最长行，只用于横向滚动条的行程；不参与列宽计算 */
  const colCh = useMemo(() => {
    let max = 0
    for (const r of model.rows) {
      const len = Math.max(r.left?.text?.length ?? 0, r.right?.text?.length ?? 0)
      if (len > max) max = len
      if (max >= 500) return 500
    }
    return max
  }, [model.rows])

  const activeFirst = useMemo(
    () =>
      visible.findIndex((it) => it.type === 'row' && it.row.change === active),
    [visible, active]
  )
  const activeLast = useMemo(() => {
    for (let i = visible.length - 1; i >= 0; i--) {
      const it = visible[i]
      if (it.type === 'row' && it.row.change === active) return i
    }
    return -1
  }, [visible, active])

  /*
   * 只有切换到另一份 diff 才回到第一处。
   *
   * 同一个文件的 diff 会被文件监听 / VCS 状态刷新反复更新（Agent 写盘、
   * 保存、外部编辑……）。如果每次都 setActive(0) + 滚到第一处，正在看的
   * 位置就会周期性「闪一下」。这里保留当前位置，只在差异数变少时收敛。
   */
  useEffect(() => {
    if (identityRef.current !== identity) {
      identityRef.current = identity
      setActive(0)
      setLimit(PAGE_ROWS)
      pendingScroll.current = true
      if (hbarRef.current) hbarRef.current.scrollLeft = 0
      contentRef.current?.style.setProperty('--fdiff-hx', '0px')
      return
    }
    setActive((cur) => Math.min(cur, Math.max(0, model.changes.length - 1)))
  }, [identity, model.changes.length])

  /* 视图偏好跨窗口共用 */
  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode)
    } catch {
      // localStorage 满了不影响使用
    }
  }, [mode])
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapse ? '1' : '0')
    } catch {
      // 同上
    }
  }, [collapse])

  const scrollToActive = useCallback((): void => {
    const sc = scrollRef.current
    const content = contentRef.current
    if (!sc || !content) return
    const els = content.querySelectorAll<HTMLElement>(
      `[data-change="${activeRef.current}"]`
    )
    if (els.length === 0) return
    const first = els[0]
    const last = els[els.length - 1]
    const top = first.offsetTop
    const bottom = last.offsetTop + last.offsetHeight
    const viewTop = sc.scrollTop
    const viewH = sc.clientHeight
    const pad = 70
    if (top >= viewTop + pad && bottom <= viewTop + viewH - pad) return
    const block = bottom - top
    sc.scrollTop = Math.max(
      0,
      block < viewH - pad * 2 ? top - (viewH - block) / 2 : top - pad
    )
  }, [])

  const updateViewport = useCallback((): void => {
    const sc = scrollRef.current
    const vp = viewportRef.current
    if (!sc || !vp) return
    const ratio = sc.scrollTop / Math.max(1, sc.scrollHeight - sc.clientHeight)
    const h = Math.max(
      6,
      Math.min(100, (sc.clientHeight / Math.max(1, sc.scrollHeight)) * 100)
    )
    vp.style.height = `${h}%`
    vp.style.top = `${ratio * (100 - h)}%`
  }, [])

  useLayoutEffect(() => {
    const target = changeFirst.get(active)
    if (target != null && target >= limit) {
      // 目标在已渲染窗口之外：先撑开，下一次渲染再滚
      setLimit(Math.min(display.items.length, target + PAGE_ROWS))
      return
    }
    if (!pendingScroll.current) return
    pendingScroll.current = false
    scrollToActive()
    updateViewport()
  }, [
    active,
    changeFirst,
    display.items.length,
    limit,
    mode,
    collapse,
    scrollToActive,
    updateViewport
  ])

  useEffect(() => {
    const sc = scrollRef.current
    if (!sc) return
    sc.addEventListener('scroll', updateViewport, { passive: true })
    const ro = new ResizeObserver(updateViewport)
    ro.observe(sc)
    if (contentRef.current) ro.observe(contentRef.current)
    updateViewport()
    return () => {
      sc.removeEventListener('scroll', updateViewport)
      ro.disconnect()
    }
  }, [updateViewport, mode, collapse, display.items.length, limit])

  /* 横向滚动条：拖动时只平移正文，行号和加减号保持不动 */
  useEffect(() => {
    const hb = hbarRef.current
    if (!hb) return
    let raf = 0
    const apply = (): void => {
      const max = Math.max(0, hb.scrollWidth - hb.clientWidth)
      if (hb.scrollLeft > max) hb.scrollLeft = max
      contentRef.current?.style.setProperty('--fdiff-hx', `-${hb.scrollLeft}px`)
    }
    const schedule = (): void => {
      if (raf) return
      raf = window.requestAnimationFrame(() => {
        raf = 0
        apply()
      })
    }
    hb.addEventListener('scroll', schedule, { passive: true })
    const ro = new ResizeObserver(schedule)
    ro.observe(hb)
    apply()
    return () => {
      if (raf) window.cancelAnimationFrame(raf)
      hb.removeEventListener('scroll', schedule)
      ro.disconnect()
    }
  }, [mode, colCh])

  /* Shift + 滚轮 / 触控板横向手势：滚 diff 时也能左右查看 */
  useEffect(() => {
    const sc = scrollRef.current
    const hb = hbarRef.current
    if (!sc || !hb) return
    const onWheel = (e: WheelEvent): void => {
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY)
      if (!e.shiftKey && !horizontal) return
      const delta = e.deltaX || e.deltaY
      if (!delta) return
      hb.scrollLeft += delta
      e.preventDefault()
    }
    sc.addEventListener('wheel', onWheel, { passive: false })
    return () => sc.removeEventListener('wheel', onWheel)
  }, [])

  const go = useCallback(
    (delta: number): void => {
      const n = model.changes.length
      if (n === 0) return
      pendingScroll.current = true
      setActive((cur) => (cur + delta + n) % n)
    },
    [model.changes.length]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, [contenteditable="true"]')
      ) {
        return
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          go(e.key === 'ArrowDown' ? 1 : -1)
        }
        return
      }
      if (!e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'F7') {
        e.preventDefault()
        go(e.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go])

  const switchMode = (next: ViewMode): void => {
    if (mode === next) return
    pendingScroll.current = true
    setMode(next)
  }

  const toggleCollapse = (): void => {
    pendingScroll.current = true
    setCollapse((v) => !v)
  }

  const expand = (): void => {
    if (!collapse) return
    pendingScroll.current = true
    setCollapse(false)
  }

  const onContentClick = (e: React.MouseEvent): void => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-change]')
    if (!el) return
    const ci = Number(el.dataset.change)
    if (!Number.isFinite(ci)) return
    pendingScroll.current = false
    setActive(ci)
  }

  const jumpTo = (ci: number): void => {
    pendingScroll.current = true
    setActive(ci)
  }

  const onMapClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest('.ide-fdiff-tick')) return
    const sc = scrollRef.current
    if (!sc) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
    sc.scrollTop = ratio * (sc.scrollHeight - sc.clientHeight)
  }

  const lineCount = model.totalRight || model.totalLeft
  const leftLabel =
    data.repoKind === 'svn'
      ? data.source === 'revision'
        ? t('diff.parent')
        : 'BASE'
      : data.source === 'revision'
        ? t('diff.parent')
        : data.source === 'working'
          ? t('diff.index')
          : 'HEAD'
  const rightLabel =
    data.source === 'staged'
      ? t('diff.staged')
      : data.source === 'revision'
        ? t('diff.commit')
        : t('diff.working')

  return (
    <div
      className="ide-fdiff"
      style={{ ['--fdiff-col-ch' as string]: `${colCh}ch` }}
    >
      <div className="ide-fdiff-bar">
        <span className="ide-fdiff-scope">{t('diff.fullFile')}</span>
        <span className="ide-fdiff-meta">
          {t('diff.lineCount', { n: lineCount })} ·{' '}
          {t('diff.changeCount', { n: model.changes.length })}
        </span>
        {data.untracked && <em className="ide-fdiff-chip">{t('diff.untracked')}</em>}
        <span className="ide-fdiff-stats">
          {stat.added > 0 && <b className="ide-add">+{stat.added}</b>}
          {stat.removed > 0 && <b className="ide-del">−{stat.removed}</b>}
        </span>
        <span className="ide-fdiff-spacer" />
        <div className="ide-fdiff-seg">
          <button
            type="button"
            className={mode === 'split' ? 'is-on' : ''}
            onClick={() => switchMode('split')}
          >
            {t('diff.split')}
          </button>
          <button
            type="button"
            className={mode === 'uni' ? 'is-on' : ''}
            onClick={() => switchMode('uni')}
          >
            {t('diff.unified')}
          </button>
        </div>
        <button
          type="button"
          className={`ide-fdiff-toggle ${collapse ? 'is-on' : ''}`}
          onClick={toggleCollapse}
        >
          <span className="ide-fdiff-box" />
          {t('diff.collapseUnchanged')}
        </button>
        <span className="ide-fdiff-vline" />
        <div className="ide-fdiff-navs">
          <button
            type="button"
            className="ide-fdiff-nav"
            disabled={model.changes.length === 0}
            title={`${t('diff.prevChange')} (Alt+↑)`}
            onClick={() => go(-1)}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor">
              <path d="M8 12.5v-9M4.2 7.3 8 3.5l3.8 3.8" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <span className="ide-fdiff-counter">
            <b>{model.changes.length ? active + 1 : 0}</b> / {model.changes.length}
          </span>
          <button
            type="button"
            className="ide-fdiff-nav"
            disabled={model.changes.length === 0}
            title={`${t('diff.nextChange')} (Alt+↓)`}
            onClick={() => go(1)}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor">
              <path d="M8 3.5v9M4.2 8.7 8 12.5l3.8-3.8" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        <kbd className="ide-fdiff-kbd" title={t('diff.keyboardHint')}>
          Alt ↑↓
        </kbd>
      </div>

      <div className={`ide-fdiff-area ${mode === 'uni' ? 'is-uni' : ''}`}>
        <div className="ide-fdiff-head">
          <div className="ide-fdiff-side">
            <span className="ide-fdiff-dot" />
            {leftLabel} · {t('diff.baseline')}
          </div>
          <div className="ide-fdiff-side is-work">
            <span className="ide-fdiff-dot" />
            {rightLabel} · {t('diff.currentFile')}
          </div>
        </div>
        <div className="ide-fdiff-main">
          <div className="ide-fdiff-col">
            <div className="ide-fdiff-scroll" ref={scrollRef} onClick={onContentClick}>
              <div className="ide-fdiff-content" ref={contentRef}>
              {visible.map((it, i) =>
                it.type === 'gap' ? (
                  <GapRow key={`gap-${i}`} count={it.count} onExpand={expand} />
                ) : it.mode === 'split' ? (
                  <SplitRowView
                    key={i}
                    row={it.row}
                    active={it.row.change === active}
                    first={i === activeFirst}
                    last={i === activeLast}
                  />
                ) : (
                  <UniRowView
                    key={i}
                    row={it.row}
                    active={it.row.change === active}
                    first={i === activeFirst}
                    last={i === activeLast}
                  />
                )
              )}
              {display.items.length > limit && (
                <div className="ide-fdiff-more">
                  <span>
                    {t('diff.more', { limit, total: display.items.length })}
                  </span>
                  <button type="button" onClick={() => setLimit((n) => n + PAGE_ROWS)}>
                    {t('diff.showMore', { n: PAGE_ROWS })}
                  </button>
                </div>
              )}
              </div>
            </div>
            <div className="ide-fdiff-hbar" ref={hbarRef}>
              <div className="ide-fdiff-hspacer" />
            </div>
          </div>
          <div
            className="ide-fdiff-map"
            onClick={onMapClick}
            title={t('diff.keyboardHint')}
          >
            <div className="ide-fdiff-vp" ref={viewportRef} />
            {model.changes.map((c) => (
              <button
                key={c.index}
                type="button"
                className={`ide-fdiff-tick ${c.index === active ? 'is-on' : ''}`}
                style={{
                  top: `${((changeFirst.get(c.index) ?? 0) / Math.max(1, display.items.length)) * 100}%`
                }}
                title={`${c.index + 1} / ${model.changes.length} · +${c.added} −${c.removed}`}
                onClick={(e) => {
                  e.stopPropagation()
                  jumpTo(c.index)
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── 对外入口 ───────────────────────────────────────────── */

export const VcsDiffView = memo(function VcsDiffView({
  data
}: {
  data: VcsDiffData
}): JSX.Element {
  const { t } = useI18n()
  const hunks = useMemo(() => parseDiff(data.diff), [data.diff])

  if (data.binary) {
    return (
      <div className="ide-binary">
        <div className="ide-binary-t">{t('diff.binary')}</div>
        <div className="ide-binary-s">
          {data.repoKind === 'git' ? t('diff.binaryGit') : t('diff.binarySvn')}
        </div>
      </div>
    )
  }

  if (data.propertyChange && hunks.length === 0) {
    return <pre className="ide-vcs-propdiff">{data.diff || t('diff.propsOnly')}</pre>
  }

  if (!data.diff.trim()) {
    return (
      <div className="ide-binary">
        <div className="ide-binary-t">
          {data.truncated ? t('diff.tooLarge') : t('diff.noChanges')}
        </div>
        <div className="ide-binary-s">
          {data.truncated ? t('diff.truncatedBody') : t('diff.noChangesBody')}
        </div>
      </div>
    )
  }

  // 冲突时 git 给的是 combined diff（`diff --cc` / `@@@`），parseDiff 不认；
  // 与其显示一片空白，不如把原始 diff 原样摊开。
  if (hunks.length === 0) {
    return <pre className="ide-vcs-propdiff">{data.diff}</pre>
  }

  const canFull =
    !data.truncated &&
    typeof data.beforeText === 'string' &&
    typeof data.afterText === 'string'

  return canFull ? (
    <FullFileDiff data={data} hunks={hunks} />
  ) : (
    <HunkDiffView data={data} hunks={hunks} />
  )
})
