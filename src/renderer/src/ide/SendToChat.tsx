import { useEffect, useRef, useState } from 'react'
import type { ChatTargetInfo, IdeCodeRef } from '@shared/ide-chat'
import type { IdeTextFile } from '@shared/ide'
import { buildIdeRef, MAX_REF_LINES } from './ref'
import { formatRelativeTime } from '@shared/i18n'
import { useI18n } from '../i18n'

/**
 * 从 IDE 把代码 / 文件送进聊天输入框前的确认层。
 *
 * 目标会话由主进程给出：同工作区当前会话优先，其次最近会话。
 * 这里不做任何磁盘读写，代码内容由调用方（已经读好的文件）传进来。
 */

export interface SendAnchor {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface SendDraft {
  refs: IdeCodeRef[]
  /** 选区超过上限时：refs 为空，让用户选截断还是整文件 */
  oversized?: { file: IdeTextFile; startLine: number; endLine: number }
  anchor: SendAnchor | null
}

interface Props {
  cwd: string
  draft: SendDraft
  onClose: () => void
  onSent: (target: ChatTargetInfo) => void
}

function preview(code: string): string {
  const lines = code.split('\n')
  return lines.length > 3 ? `${lines.slice(0, 3).join('\n')}\n…` : lines.join('\n')
}

export function SendToChat({ cwd, draft, onClose, onSent }: Props): JSX.Element {
  const { t, locale } = useI18n()
  const metaOf = (target: ChatTargetInfo): string => {
    if (target.kind === 'active') return t('send.current')
    if (target.isNew) return t('send.newSession')
    return target.updatedAt
      ? formatRelativeTime(target.updatedAt, locale, 'ago')
      : t('send.sameWorkspace')
  }
  const [targets, setTargets] = useState<ChatTargetInfo[]>([])
  const [target, setTarget] = useState<ChatTargetInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [picker, setPicker] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const popRef = useRef<HTMLDivElement>(null)

  // 每次打开都重新拿目标：主窗口可能刚切过工作区 / 新开了一条会话
  useEffect(() => {
    let alive = true
    setLoading(true)
    const p = window.api?.chat?.targets(cwd)
    if (!p) {
      setLoading(false)
      setError(t('send.unsupported'))
      return
    }
    p.then((list) => {
      if (!alive) return
      setTargets(list)
      setTarget(list[0] ?? null)
    })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : t('send.targetFailed'))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [cwd])

  // Esc / 点外面关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onDown = (e: MouseEvent): void => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [onClose])

  const send = async (refsToSend: IdeCodeRef[]): Promise<void> => {
    if (!target || busy || refsToSend.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const api = window.api?.chat
      if (!api) {
        setError(t('send.unsupported'))
        return
      }
      const r = await api.sendRefs({ target, refs: refsToSend })
      if (!r.ok) {
        setError(r.message ?? t('errors.sendFailed'))
        return
      }
      onSent(target)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.sendFailed'))
    } finally {
      setBusy(false)
    }
  }

  /** 超长选区的两个出口 */
  const oversizedActions = (() => {
    const o = draft.oversized
    if (!o) return null
    const lines = o.file.text.split('\n')
    const start = o.startLine
    const cutEnd = Math.min(o.endLine, start + MAX_REF_LINES - 1)
    const clipped = buildIdeRef(
      o.file,
      cwd,
      'selection',
      lines.slice(start - 1, cutEnd).join('\n'),
      start,
      cutEnd
    )
    const whole = buildIdeRef(o.file, cwd, 'file', o.file.text)
    return { clipped, whole, total: o.endLine - o.startLine + 1 }
  })()

  const W = 452
  const a = draft.anchor
  const left = a
    ? Math.max(12, Math.min(window.innerWidth - W - 12, a.right - W))
    : Math.round((window.innerWidth - W) / 2)
  const top = a
    ? a.bottom + 360 < window.innerHeight
      ? a.bottom + 8
      : Math.max(52, a.top - 360)
    : 72

  return (
    <div className="ide-sendpop" style={{ left, top, width: W }} ref={popRef}>
      <div className="ide-sendpop__head">
        <span className="ide-sendpop__title">{t('send.title')}</span>
        <span className="ide-sendpop__esc">Esc</span>
      </div>

      <div className="ide-sendpop__sec">
        <div className="ide-sendpop__label">{t('send.target')}</div>
        {loading && <div className="ide-sendpop__muted">{t('send.loading')}</div>}
        {!loading && target && (
          <>
            <button
              className={`ide-target${targets.length > 1 ? ' is-pickable' : ''}`}
              onClick={() => targets.length > 1 && setPicker((p) => !p)}
              disabled={targets.length <= 1}
              aria-haspopup={targets.length > 1 ? 'listbox' : undefined}
              aria-expanded={picker}
            >
              <span className="ide-target__dot" />
              <span className="ide-target__name">{target.title}</span>
              <span className="ide-target__meta">{metaOf(target)}</span>
              {targets.length > 1 && <span className="ide-target__caret">▾</span>}
            </button>
            {picker && targets.length > 1 && (
              <div className="ide-target-list" role="listbox">
                {targets.map((t) => (
                  <button
                    key={`${t.kind}:${t.id ?? 'new'}`}
                    className={`ide-target-opt${t.id === target.id && t.kind === target.kind ? ' is-on' : ''}`}
                    role="option"
                    aria-selected={t.id === target.id && t.kind === target.kind}
                    onClick={() => {
                      setTarget(t)
                      setPicker(false)
                    }}
                  >
                    <span className="ide-target-opt__name">{t.title}</span>
                    <span className="ide-target-opt__meta">{metaOf(t)}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {!loading && !target && !error && (
          <div className="ide-sendpop__muted">{t('send.noTarget')}</div>
        )}
      </div>

      {draft.oversized && oversizedActions ? (
        <div className="ide-sendpop__sec">
          <div className="ide-sendpop__warn">
            {t('send.oversized', {
              n: oversizedActions.total,
              max: MAX_REF_LINES
            })}
          </div>
          <div className="ide-sendpop__note">
            {t('send.oversizedNote', { max: MAX_REF_LINES })}
            {draft.oversized.file.truncated && t('send.truncatedFile')}
          </div>
        </div>
      ) : (
        <div className="ide-sendpop__sec">
          {draft.refs.map((r) => (
            <div className="ide-refpreview" key={r.id}>
              <div className="ide-refpreview__head">
                <span className="ide-refpreview__ico">&lt;/&gt;</span>
                <span className="ide-refpreview__name">{r.name}</span>
                <span className="ide-refpreview__range">
                  {r.kind === 'file'
                    ? t('send.wholeLines', { n: r.totalLines })
                    : r.startLine === r.endLine
                      ? `L${r.startLine}`
                      : `L${r.startLine}–${r.endLine}`}
                </span>
              </div>
              <div className="ide-refpreview__path" title={r.rel}>
                {r.rel}
              </div>
              {r.truncated && (
                <div className="ide-sendpop__note">{t('send.fileTooLarge')}</div>
              )}
              {r.kind === 'selection' && <pre className="ide-refpreview__code">{preview(r.code)}</pre>}
            </div>
          ))}
        </div>
      )}

      {error && <div className="ide-sendpop__err">{error}</div>}

      <div className="ide-sendpop__foot">
        {draft.oversized && oversizedActions ? (
          <>
            <span className="ide-sendpop__hint">{t('send.hintOversized')}</span>
            <button
              className="ide-sendpop__ghost"
              disabled={!target || busy}
              onClick={() => void send([oversizedActions.whole])}
            >
              {t('send.wholeFile')}
            </button>
            <button
              className="ide-sendpop__send"
              disabled={!target || busy}
              onClick={() => void send([oversizedActions.clipped])}
            >
              {t('send.firstLines', { n: MAX_REF_LINES })}
            </button>
          </>
        ) : (
          <>
            <span className="ide-sendpop__hint">{t('send.hint')}</span>
            <button
              className="ide-sendpop__send"
              disabled={!target || busy || draft.refs.length === 0}
              onClick={() => void send(draft.refs)}
            >
              {busy ? t('send.sending') : t('send.send')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
