import { useEffect, useMemo, useState } from 'react'
import type { VcsDiffData } from '@shared/vcs'
import { diffStat, parseDiff, type DiffSide } from './diff'

/**
 * 一次最多渲染多少行 diff。
 *
 * 初始提交 / 超大文件一次可能有几万行，全量挂到 DOM 上会直接把渲染进程卡住。
 * 分批渲染，剩下的用「再显示」按钮追加。
 */
const PAGE_ROWS = 2000

function DiffCell({
  side,
  tone
}: {
  side: DiffSide | null
  tone: 'ctx' | 'add' | 'del' | 'empty'
}): JSX.Element {
  return (
    <div className={`ide-dcell is-${tone}`}>
      <span className="ide-dln">{side?.no ?? ''}</span>
      <span className="ide-dtext">{side?.text ?? ''}</span>
    </div>
  )
}

export function VcsDiffView({ data }: { data: VcsDiffData }): JSX.Element {
  const hunks = useMemo(() => parseDiff(data.diff), [data.diff])
  const stat = useMemo(() => diffStat(data.diff), [data.diff])
  const totalRows = useMemo(() => hunks.reduce((n, h) => n + h.rows.length, 0), [hunks])

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
        <div className="ide-binary-t">二进制文件</div>
        <div className="ide-binary-s">
          {data.repoKind === 'git' ? 'Git 不提供文本 diff。' : 'SVN 将文件标记为二进制类型。'}
        </div>
      </div>
    )
  }

  if (data.propertyChange && hunks.length === 0) {
    return <pre className="ide-vcs-propdiff">{data.diff || '只有属性变化'}</pre>
  }

  if (!data.diff.trim()) {
    return (
      <div className="ide-binary">
        <div className="ide-binary-t">{data.truncated ? '文件过大' : '没有差异'}</div>
        <div className="ide-binary-s">
          {data.truncated
            ? '只读取了前 2 MB，无法生成完整 diff。'
            : '这个文件在当前范围内没有可显示的改动。'}
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
      ? '已暂存'
      : data.source === 'head'
        ? '与 HEAD 比较'
        : data.source === 'revision'
          ? data.revision
            ? `提交 ${data.revision.slice(0, 8)}`
            : '提交'
          : '工作区更改'

  return (
    <div className="ide-diffwrap">
      <div className="ide-diffhead">
        <span>{label}</span>
        {data.untracked && <em>未跟踪 · 整份新增</em>}
        {data.truncated && <em>内容过大，已截断</em>}
        <span className="ide-spacer" />
        {stat.added > 0 && <b className="ide-add">+{stat.added}</b>}
        {stat.removed > 0 && <b className="ide-del">−{stat.removed}</b>}
      </div>
      <div className="ide-diffbody">
        {visible.map(({ hunk, rows }, hi) => (
          <div key={hi} className="ide-hunkblock">
            <div className="ide-hunk">{hunk.header}</div>
            {rows.map((r, ri) => (
              <div key={ri} className={`ide-drow ${data.untracked ? 'is-untracked' : ''}`}>
                {data.untracked ? (
                  <DiffCell side={r.right} tone="add" />
                ) : (
                  <>
                    <DiffCell
                      side={r.left}
                      tone={
                        r.kind === 'ctx'
                          ? 'ctx'
                          : r.kind === 'change' || r.kind === 'del'
                            ? 'del'
                            : 'empty'
                      }
                    />
                    <DiffCell
                      side={r.right}
                      tone={
                        r.kind === 'ctx'
                          ? 'ctx'
                          : r.kind === 'change' || r.kind === 'add'
                            ? 'add'
                            : 'empty'
                      }
                    />
                  </>
                )}
              </div>
            ))}
          </div>
        ))}
        {totalRows > limit && (
          <div className="ide-diffmore">
            <span>
              diff 较大，已显示前 {limit} 行（共 {totalRows} 行）
            </span>
            <button type="button" onClick={() => setLimit((n) => n + PAGE_ROWS)}>
              再显示 {PAGE_ROWS} 行
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
