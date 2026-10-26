import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import {
  sessionMetaKey,
  type SessionMetaMap,
  type SessionSearchHit,
  type StoredSession
} from '@shared/session'
import { cliDef, type CliId } from '@shared/settings'
import { formatRelativeTime } from '@shared/i18n'
import { useI18n } from '../i18n'
import { displayTitle } from '../useSessionMeta'
import { IconClaudeCode, IconDeepSeek, IconOpenAI, IconSearch } from './Icons'

/** 单字符没有区分度，还会触发一次全量扫描 */
const MIN_QUERY = 2
/** 输入停下后再去扫盘，别每敲一个字都跑一遍 */
const DEBOUNCE_MS = 260
/** 每批向主进程要多少条内容命中 */
const CONTENT_BATCH = 20
/** 合并标题命中后最多展示多少条 */
const MAX_RESULTS = 80

/**
 * 跨会话搜索。
 *
 * 标题在渲染层匹配（这里才知道用户改过的名字），对话内容交给主进程扫描
 * CLI 记录。两边按 (cli, cwd, id) 合并：同一条会话标题和内容都命中时
 * 只显示一行，但保留内容片段。
 */
export function SessionSearch({
  sessions,
  meta,
  onClose,
  onSelect
}: {
  sessions: StoredSession[]
  meta: SessionMetaMap
  onClose: () => void
  onSelect: (s: StoredSession) => void
}): JSX.Element {
  const { t, tn, locale } = useI18n()
  const [query, setQuery] = useState('')
  const [content, setContent] = useState<{
    query: string
    hits: SessionSearchHit[]
    truncated: boolean
  }>({ query: '', hits: [], truncated: false })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  /** 分批扫描进度；total=0 时还不显示 */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const seq = useRef(0)
  const rows = useRef<(HTMLButtonElement | null)[]>([])

  const q = query.trim()
  const lower = q.toLowerCase()
  const enough = lower.length >= MIN_QUERY

  /** 标题 / 路径命中 —— 本地就能算，不必等主进程 */
  const titleHits = useMemo(() => {
    if (!enough) return []
    const out: SessionSearchHit[] = []
    for (const s of sessions) {
      const title = displayTitle(s, meta)
      if (
        !title.toLowerCase().includes(lower) &&
        !s.cwd.toLowerCase().includes(lower)
      ) {
        continue
      }
      out.push({
        ...s,
        snippet: '',
        matches: 1,
        field: 'title'
      })
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt)
    return out
  }, [sessions, meta, lower, enough])

  useEffect(() => {
    if (!enough) {
      seq.current++
      setContent({ query: '', hits: [], truncated: false })
      setLoading(false)
      setProgress(null)
      setError('')
      return
    }

    if (!window.api?.sessions.search) {
      setLoading(false)
      return
    }

    const mySeq = ++seq.current
    let alive = true
    setLoading(true)
    setError('')
    setProgress(null)

    /**
     * 主进程按批扫描（每批最多约 1 秒），这里循环要下一批。
     *
     * 不能等一次全量扫描：冷启动几百份记录要十秒以上，搜索框会一直空着。
     * 现在标题命中立刻出现，内容命中每批追加一次，进度条同步往前走。
     */
    const run = async (): Promise<void> => {
      let offset = 0
      let merged: SessionSearchHit[] = []
      let truncated = false

      try {
        for (;;) {
          if (seq.current !== mySeq || !alive) return
          const r = await window.api!.sessions.search(q, CONTENT_BATCH, offset)
          if (seq.current !== mySeq || !alive) return

          const batch = Array.isArray(r?.hits) ? r.hits : []
          if (batch.length > 0) {
            const byKey = new Map<string, SessionSearchHit>()
            for (const h of merged) byKey.set(sessionMetaKey(h.cli, h.cwd, h.id), h)
            for (const h of batch) {
              const k = sessionMetaKey(h.cli, h.cwd, h.id)
              const prev = byKey.get(k)
              // 同一条会话理论上只会被扫一次；真重叠了就以新的片段为准
              byKey.set(k, prev ? { ...prev, snippet: h.snippet, matches: h.matches } : h)
            }
            merged = [...byKey.values()]
          }

          truncated = truncated || r?.truncated === true
          if (merged.length >= MAX_RESULTS) truncated = true
          setContent({ query: lower, hits: merged, truncated })

          const total = typeof r?.total === 'number' ? r.total : 0
          const next = typeof r?.nextOffset === 'number' ? r.nextOffset : offset
          setProgress(total > 0 ? { done: Math.min(next, total), total } : null)

          const done = r?.done !== false
          if (done || merged.length >= MAX_RESULTS || next <= offset) break
          offset = next
          // 把主线程让出来一帧，下一批 IPC 和界面渲染才有机会插进来
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
        }

        if (seq.current === mySeq && alive) setLoading(false)
      } catch (e: unknown) {
        if (seq.current !== mySeq || !alive) return
        setContent({ query: '', hits: [], truncated: false })
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      }
    }

    const timer = window.setTimeout(() => void run(), DEBOUNCE_MS)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [q, lower, enough])

  /** 只认当前 query 的结果，避免旧请求的片段串到新搜索里 */
  const currentContent = content.query === lower ? content.hits : []

  const results = useMemo(() => {
    const byKey = new Map<string, SessionSearchHit>()
    const keyOf = (h: SessionSearchHit): string => sessionMetaKey(h.cli, h.cwd, h.id)

    for (const h of titleHits) byKey.set(keyOf(h), h)
    for (const h of currentContent) {
      const k = keyOf(h)
      const prev = byKey.get(k)
      // 标题命中的行也把内容片段带上，用户能直接看到上下文
      if (prev) byKey.set(k, { ...prev, snippet: h.snippet, matches: h.matches })
      else byKey.set(k, h)
    }

    const all = [...byKey.values()]
    all.sort((a, b) => {
      const rank = (h: SessionSearchHit): number => (h.field === 'title' ? 0 : 1)
      return rank(a) - rank(b) || b.updatedAt - a.updatedAt
    })
    return all.slice(0, MAX_RESULTS)
  }, [titleHits, currentContent])

  useEffect(() => {
    setActiveIndex(0)
  }, [lower])

  // 焦点可能已经移到结果行上，Esc 不能只依赖输入框的 keydown
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, results.length - 1)))
  }, [results.length])

  useEffect(() => {
    rows.current[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const openAt = (index: number): void => {
    const hit = results[index]
    if (!hit) return
    onSelect(hit)
    onClose()
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    // 中文输入法确认候选词的回车不能当成"打开"
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, Math.max(0, results.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      openAt(activeIndex)
    }
  }

  const truncated = content.query === lower && content.truncated

  return (
    <div className="search" role="dialog" aria-modal="true" aria-label={t('search.title')}>
      <div className="search__scrim" onClick={onClose} />
      <div className="search__panel">
        <div className="search__head">
          <IconSearch width={16} height={16} className="search__icon" />
          <input
            className="search__input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('search.placeholder')}
            autoFocus
            spellCheck={false}
            aria-label={t('search.placeholder')}
          />
          {loading && (
            <span className="search__loading">
              {progress && progress.total > 0
                ? t('search.progress', { done: progress.done, total: progress.total })
                : t('search.searching')}
            </span>
          )}
          <button className="search__close" onClick={onClose} title={t('common.close')}>
            ×
          </button>
        </div>

        <div className="search__body">
          {!enough ? (
            <p className="search__hint">{t('search.hint')}</p>
          ) : error ? (
            <p className="search__hint is-error">{t('search.failed', { error })}</p>
          ) : results.length === 0 ? (
            loading ? (
              <p className="search__hint">{t('search.searching')}</p>
            ) : (
              <p className="search__hint">{t('search.empty')}</p>
            )
          ) : (
            results.map((hit, i) => {
              const title = displayTitle(hit, meta)
              return (
                <button
                  key={sessionMetaKey(hit.cli, hit.cwd, hit.id)}
                  ref={(el) => {
                    rows.current[i] = el
                  }}
                  className={`search__row ${i === activeIndex ? 'is-active' : ''}`}
                  // 直接传命中的那条，而不是回头按 i 取 results ——
                  // 内容结果还在追加时，索引对应的行可能已经换了
                  onClick={() => {
                    onSelect(hit)
                    onClose()
                  }}
                  onMouseEnter={() => setActiveIndex(i)}
                >
                  <CliIcon cli={hit.cli} />
                  <span className="search__texts">
                    <span className="search__title">
                      <Highlight text={title} query={q} />
                    </span>
                    <span className="search__sub">
                      <span className="search__cwd" title={hit.cwd}>
                        <Highlight text={hit.cwd} query={q} />
                      </span>
                      <span className="search__dot">·</span>
                      <span>{cliDef(hit.cli).name}</span>
                      <span className="search__dot">·</span>
                      <span>{formatRelativeTime(hit.updatedAt, locale, 'short')}</span>
                    </span>
                    {hit.snippet && (
                      <span className="search__snippet">
                        <Highlight text={hit.snippet} query={q} />
                      </span>
                    )}
                  </span>
                  {hit.matches > 1 && (
                    <span className="search__count">
                      {tn('search.matchCount', hit.matches)}
                    </span>
                  )}
                </button>
              )
            })
          )}
        </div>

        <div className="search__foot">
          <span>{t('search.footer')}</span>
          <span className="search__foot-gap" />
          {truncated && <span>{t('search.truncated')}</span>}
          {enough && results.length > 0 && (
            <span>{tn('search.resultCount', results.length)}</span>
          )}
        </div>
      </div>
    </div>
  )
}

function CliIcon({ cli }: { cli: CliId }): JSX.Element {
  return (
    <span className={`search__cli search__cli--${cli}`} title={cliDef(cli).name}>
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

/**
 * 把 query 命中的部分包成 <mark>。
 *
 * 用 indexOf 而不是 RegExp：搜索词里出现 `(`、`.` 时不该被当成语法。
 * 单条文本最多标 50 处，避免极端输入把 DOM 撑爆。
 */
function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  const q = query.trim().toLowerCase()
  if (!q) return text

  const lower = text.toLowerCase()
  const parts: ReactNode[] = []
  let from = 0
  let at = lower.indexOf(q)
  let guard = 0

  while (at >= 0 && guard < 50) {
    if (at > from) parts.push(text.slice(from, at))
    parts.push(<mark key={`${at}-${guard}`}>{text.slice(at, at + q.length)}</mark>)
    from = at + q.length
    at = lower.indexOf(q, from)
    guard++
  }
  if (from < text.length) parts.push(text.slice(from))
  return <>{parts}</>
}
