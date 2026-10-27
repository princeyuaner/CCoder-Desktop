import { useMemo } from 'react'
import { useI18n } from '../i18n'
import type { IdeProblem } from './problems'

export function ProblemsList({
  problems,
  onJump
}: {
  problems: IdeProblem[]
  onJump: (rel: string, line: number) => void
}): JSX.Element {
  const { t } = useI18n()

  const groups = useMemo(() => {
    const map = new Map<string, IdeProblem[]>()
    for (const p of problems) {
      const list = map.get(p.rel)
      if (list) list.push(p)
      else map.set(p.rel, [p])
    }
    return [...map.entries()]
  }, [problems])

  if (problems.length === 0) {
    return <div className="ide-panel-empty">{t('ide.problems.empty')}</div>
  }

  return (
    <div className="ide-problems">
      {groups.map(([rel, list]) => (
        <div key={rel} className="ide-problem-group">
          <div className="ide-problem-file" title={rel}>
            {rel}
            <em>{list.length}</em>
          </div>
          {list.map((p, i) => (
            <button
              key={`${p.line}:${p.column}:${i}`}
              className={`ide-problem-row is-${p.severity}`}
              title={`${p.message}\n${t('ide.problems.jumpHint')}`}
              onClick={() => onJump(p.rel, p.line)}
            >
              <i className="ide-problem-dot" />
              <span className="ide-problem-msg">{p.message}</span>
              <span className="ide-problem-pos">
                [{p.line}, {p.column}]
              </span>
              <span className="ide-problem-src">{p.source}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
