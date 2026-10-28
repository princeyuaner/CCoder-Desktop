import { useEffect, useMemo, useState } from 'react'
import type { VcsDiffData } from '@shared/vcs'
import { diffStat, parseDiff, wordDiff, type DiffSeg, type DiffSide, type DiffRow } from './diff'
import { useI18n } from '../i18n'

/**
 * 一次最多渲染多少行 diff。
 *
 * 初始提交 / 超大文件一次可能有几万行，全量挂到 DOM 上会直接把渲染进程卡住。
 * 分批渲染，剩下的用「再显示」按钮追加。
 */
const PAGE_ROWS = 2000

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
function RowPair({ row }: { row: DiffRow }): JSX.Element {
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
        tone={row.kind === 'ctx' ? 'ctx' : row.kind === 'change' || row.kind === 'del' ? 'del' : 'empty'}
      />
      <DiffCell
        side={row.right}
        segs={words?.right}
        tone={row.kind === 'ctx' ? 'ctx' : row.kind === 'change' || row.kind === 'add' ? 'add' : 'empty'}
      />
    </>
  )
}

export function VcsDiffView({ data }: { data: VcsDiffData }): JSX.Element {
  const { t } = useI18n()
  const hunks = useMemo(() => parseDiff(data.diff), [data.diff])
  const stat = useMemo(() => diffStat(data.diff), [data.diff])
  const totalRows = useMemo(() => hunks.reduce((n, h) => n + h.rows.length, 0), [hunks])

  /**
   * 最长的一行有多少个字符。
   *
   * diffbody 靠 `--diff-col-ch × 2 + 固定宽度` 撑开横向滚动：两栏各占一半，
   * 只要整块够宽，最长的那行就一定完整露得出来。不出这个值的话 50% 宽度
   * 会把长行右半截直接切掉，用户也没法横向拖过去看。
   */
  const colCh = useMemo(() => {
    let max = 0
    for (const h of hunks) {
      for (const r of h.rows) {
        const len = Math.max(r.left?.text?.length ?? 0, r.right?.text?.length ?? 0)
        if (len > max) max = len
      }
    }
    return max
  }, [hunks])

  const [limit, setLimit] = useState(PAGE_ROWS)
  // 换一份 diff 时重新从头分批，别把上一份的展开进度带过来
  useEffect(() => {
    setLimit(PAGE_ROWS)
  }, [data.diff])

  const visible = useMemo(() => {
    let left = limit
    const out: { hunk: (typeof hunks)[number]; rows: (typeof hunks)[number]['rows'] }[] = []
    for (const h of hunks) {
      if (left <= 0) break
      const rows = h.rows.slice(0, left)
      left -= rows.length
      out.push({ hunk: h, rows })
    }
    return out
  }, [hunks, limit])

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
      <div className="ide-diffhead">
        <span>{label}</span>
        {data.untracked && <em>{t('diff.untracked')}</em>}
        {data.truncated && <em>{t('diff.truncated')}</em>}
        <span className="ide-spacer" />
        {stat.added > 0 && <b className="ide-add">+{stat.added}</b>}
        {stat.removed > 0 && <b className="ide-del">−{stat.removed}</b>}
      </div>
      <div
        className={`ide-diffbody ${data.untracked ? 'is-untracked' : ''}`}
        style={{ ['--diff-col-ch' as string]: `${colCh}ch` }}
      >
        {visible.map(({ hunk, rows }, hi) => (
          <div key={hi} className="ide-hunkblock">
            <div className="ide-hunk">{hunk.header}</div>
            {rows.map((r, ri) => (
              <div key={ri} className={`ide-drow ${data.untracked ? 'is-untracked' : ''}`}>
                {data.untracked ? (
                  <DiffCell side={r.right} tone="add" />
                ) : (
                  <RowPair row={r} />
                )}
              </div>
            ))}
          </div>
        ))}
        {totalRows > limit && (
          <div className="ide-diffmore">
            <span>
              {t('diff.more', { limit, total: totalRows })}
            </span>
            <button type="button" onClick={() => setLimit((n) => n + PAGE_ROWS)}>
              {t('diff.showMore', { n: PAGE_ROWS })}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
