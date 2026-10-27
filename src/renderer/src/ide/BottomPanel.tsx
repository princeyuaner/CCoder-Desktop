import type { ReactNode } from 'react'
import { useI18n } from '../i18n'
import { ProblemsList } from './ProblemsList'
import type { IdeProblem } from './problems'

export type BottomTab = 'problems' | 'terminal'

export function BottomPanel({
  open,
  tab,
  onTab,
  onClose,
  problems,
  onJump,
  terminal
}: {
  open: boolean
  tab: BottomTab
  onTab: (tab: BottomTab) => void
  onClose: () => void
  problems: IdeProblem[]
  onJump: (rel: string, line: number) => void
  terminal: ReactNode
}): JSX.Element {
  const { t } = useI18n()
  const errors = problems.filter((p) => p.severity === 'error').length
  const warnings = problems.filter((p) => p.severity === 'warning').length

  return (
    <div className={`ide-panel is-${tab} ${open ? '' : 'is-hidden'}`}>
      <div className="ide-panel-head">
        <button
          className={`ide-panel-tab ${tab === 'problems' ? 'on' : ''}`}
          onClick={() => onTab('problems')}
        >
          {t('ide.problems.title')}
          {errors > 0 && <em className="is-error">{errors}</em>}
          {warnings > 0 && <em className="is-warning">{warnings}</em>}
        </button>
        <button
          className={`ide-panel-tab ${tab === 'terminal' ? 'on' : ''}`}
          onClick={() => onTab('terminal')}
        >
          {t('ide.terminal.title')}
        </button>
        <span className="ide-panel-spacer" />
        <button
          className="ide-iconbtn ide-panel-close"
          title={t('ide.command.closePanel')}
          onClick={onClose}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M4 4l8 8M12 4l-8 8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      <div className="ide-panel-body">
        <div className={`ide-panel-pane ${tab === 'problems' ? '' : 'is-hidden'}`}>
          <ProblemsList problems={problems} onJump={onJump} />
        </div>
        <div className={`ide-panel-pane is-term ${tab === 'terminal' ? '' : 'is-hidden'}`}>
          {terminal}
        </div>
      </div>
    </div>
  )
}
