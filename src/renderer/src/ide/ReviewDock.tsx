import { useEffect, useMemo, useState } from 'react'
import type { VcsDiffData, VcsDiffSource, VcsStatus } from '@shared/vcs'
import type { MessageKey } from '@shared/i18n'
import { parseDiff, type DiffHunk } from './diff'
import { useI18n } from '../i18n'

/**
 * 右侧「审阅」栏。
 *
 * 数据来自现有 VCS 状态和 `vcs.diff`，只做只读汇总：
 * 文件列表 → 选中文件 → 与 HEAD 比较的 hunk 摘要。点击 hunk 打开现有
 * diff 页签，真正的接受 / 拒绝仍然在源代码管理里完成。
 */
export function ReviewDock({
  cwd,
  status,
  activeRel,
  onOpenDiff,
  onOpenScm,
  onClose
}: {
  cwd: string
  status: VcsStatus | null
  activeRel?: string
  onOpenDiff: (rel: string) => void
  onOpenScm: () => void
  onClose: () => void
}): JSX.Element {
  const { t } = useI18n()
  const files = status?.files ?? []
  const fileSignature = useMemo(
    () => files.map((f) => `${f.rel}:${f.status}:${f.staged}:${f.unstaged}`).join('|'),
    [files]
  )
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<VcsDiffData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 文件列表刷新后保持当前选择；当前编辑器里的文件有改动时优先选它
  useEffect(() => {
    setSelected((prev) => {
      const has = (rel: string | null): boolean =>
        !!rel && files.some((f) => f.rel === rel)
      if (has(prev)) return prev
      if (has(activeRel ?? null)) return activeRel ?? null
      return files[0]?.rel ?? null
    })
  }, [cwd, status, activeRel, files])

  useEffect(() => {
    if (!selected) {
      setDiff(null)
      setError(null)
      return
    }
    const file = files.find((f) => f.rel === selected)
    const source: VcsDiffSource = file?.untracked ? 'working' : 'head'
    let cancelled = false
    setLoading(true)
    setError(null)
    setDiff(null)
    void window.api?.vcs
      .diff({ cwd, rel: selected, source })
      .then((r) => {
        if (cancelled) return
        if (r.ok) setDiff(r.data)
        else setError(r.error.message)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // 文件状态变化（保存 / 外部改动）后重新取 diff，保持审阅栏是最新的
  }, [cwd, selected, fileSignature])

  const hunks = useMemo(() => {
    if (!diff || diff.binary) return []
    return parseDiff(diff.diff)
  }, [diff])

  const branch = status?.repo
    ? status.repo.kind === 'git'
      ? status.repo.branch || t('ide.noBranch')
      : status.repo.headShort
    : t('ide.noVcs')

  const counts = status?.counts
  const totalAdd = diff && !diff.binary ? diff.added : 0
  const totalRemoved = diff && !diff.binary ? diff.removed : 0

  return (
    <aside className="ide-review" aria-label={t('ide.review.title')}>
      <header className="ide-review-head">
        <div className="ide-review-eyebrow">REVIEW</div>
        <div className="ide-review-title-row">
          <span className="ide-review-title">{t('ide.review.title')}</span>
          <span className="ide-review-count">{files.length}</span>
          <button
            type="button"
            className="ide-review-close"
            title={t('ide.review.hide')}
            aria-label={t('ide.review.hide')}
            onClick={onClose}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor">
              <path d="m4 4 8 8M12 4l-8 8" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="ide-review-sub">
          <span>{branch}</span>
          <span className="sep">·</span>
          <span>{t('ide.review.vsHead')}</span>
        </div>
      </header>

      <div className="ide-review-scroll">
        <div className="ide-review-card">
          <span className="ide-review-card-icon">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor">
              <circle cx="4.5" cy="3.5" r="1.4" />
              <circle cx="4.5" cy="12.5" r="1.4" />
              <circle cx="11.5" cy="5.5" r="1.4" />
              <path d="M4.5 4.9v6.2M11.5 6.9v1.2a3 3 0 0 1-3 3h-4" strokeLinecap="round" />
            </svg>
          </span>
          <div className="ide-review-card-text">
            <b>{branch}</b>
            <span>
              {status
                ? t('ide.review.summary', {
                    files: files.length,
                    staged: counts?.staged ?? 0,
                    unstaged: counts?.unstaged ?? 0
                  })
                : t('ide.review.noRepo')}
            </span>
          </div>
          <span className={`ide-review-live${status ? ' is-on' : ''}`} />
        </div>

        <div className="ide-review-section">
          <span>{t('ide.review.changed')}</span>
          <span className="count">{files.length}</span>
        </div>

        <div className="ide-review-list">
          {files.length === 0 && (
            <div className="ide-review-empty">
              {status ? t('ide.review.clean') : t('ide.review.noRepo')}
            </div>
          )}
          {files.map((file) => {
            const active = file.rel === selected
            return (
              <div className={`ide-review-file${active ? ' is-open' : ''}`} key={file.rel}>
                <button
                  type="button"
                  className="ide-review-file-head"
                  onClick={() => setSelected(file.rel)}
                  title={file.rel}
                >
                  <span className={`ide-review-node is-${file.status.toLowerCase()}`} />
                  <span className={`ide-review-badge is-${file.status.toLowerCase()}`}>
                    {file.status}
                  </span>
                  <span className="ide-review-path">{file.rel}</span>
                  <svg
                    className="ide-review-chev"
                    width="10"
                    height="10"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                  >
                    <path d="m6 4 4 4-4 4" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>

                {active && (
                  <div className="ide-review-hunks">
                    {loading && (
                      <div className="ide-review-hint">{t('ide.review.loading')}</div>
                    )}
                    {!loading && error && (
                      <div className="ide-review-hint is-error">{error}</div>
                    )}
                    {!loading && !error && diff?.binary && (
                      <div className="ide-review-hint">{t('ide.review.binary')}</div>
                    )}
                    {!loading && !error && !diff?.binary && hunks.length === 0 && (
                      <div className="ide-review-hint">{t('ide.review.noHunks')}</div>
                    )}
                    {!loading &&
                      !error &&
                      !diff?.binary &&
                      hunks.map((hunk, i) => (
                        <button
                          type="button"
                          className="ide-review-hunk"
                          key={`${file.rel}-${i}`}
                          onClick={() => onOpenDiff(file.rel)}
                          title={t('ide.review.openDiff')}
                        >
                          <span className="ide-review-range">{hunkRange(hunk)}</span>
                          <span className="ide-review-hlabel">{hunkLabel(hunk, t)}</span>
                          <span className="ide-review-hstat">
                            <em>+{hunkAdds(hunk)}</em>
                            <em>−{hunkDels(hunk)}</em>
                          </span>
                        </button>
                      ))}
                    {!loading && !error && diff && !diff.binary && hunks.length > 0 && (
                      <button
                        type="button"
                        className="ide-review-open"
                        onClick={() => onOpenDiff(file.rel)}
                      >
                        {t('ide.review.openDiff')}
                        <span className="ide-review-total">
                          <em>+{totalAdd}</em>
                          <em>−{totalRemoved}</em>
                        </span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <footer className="ide-review-foot">
        <button type="button" className="ide-review-primary" onClick={onOpenScm}>
          {t('ide.review.openScm')}
        </button>
        <button
          type="button"
          className="ide-review-ghost"
          onClick={() => selected && onOpenDiff(selected)}
          disabled={!selected}
        >
          {t('ide.review.openSelected')}
        </button>
      </footer>
    </aside>
  )
}

function hunkRange(hunk: DiffHunk): string {
  const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(hunk.header)
  if (!m) return hunk.header
  const start = Number(m[1])
  const count = m[2] === undefined ? 1 : Number(m[2])
  return count > 1 ? `L${start}–${start + count - 1}` : `L${start}`
}

function hunkLabel(hunk: DiffHunk, t: (key: MessageKey) => string): string {
  const changed = hunk.rows.filter((r) => r.kind !== 'ctx')
  const textOf = (r: (typeof changed)[number]): string =>
    (r.right?.text ?? r.left?.text ?? '').trim()
  // 跳过只有括号 / 逗号的行，挑第一行有内容的改动做摘要
  const useful = changed.find((r) => {
    const text = textOf(r)
    return text.length > 0 && !/^[{}\[\](),;]+$/.test(text)
  })
  const target = useful ?? changed[0]
  const text = target ? textOf(target) : ''
  if (!text) return t('ide.review.codeChange')
  return text.length > 42 ? `${text.slice(0, 42)}…` : text
}

function hunkAdds(hunk: DiffHunk): number {
  return hunk.rows.filter((r) => r.kind === 'add' || r.kind === 'change').length
}

function hunkDels(hunk: DiffHunk): number {
  return hunk.rows.filter((r) => r.kind === 'del' || r.kind === 'change').length
}
