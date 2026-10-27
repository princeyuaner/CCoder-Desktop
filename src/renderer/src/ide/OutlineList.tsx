import { useState } from 'react'
import { useI18n } from '../i18n'
import type { OutlineSymbol } from './outline'

export function OutlineList({
  symbols,
  onJump
}: {
  symbols: OutlineSymbol[]
  onJump: (line: number) => void
}): JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(true)

  return (
    <div className={`ide-outline ${open ? '' : 'is-collapsed'}`}>
      <button className="ide-outline-head" onClick={() => setOpen((v) => !v)}>
        <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d={open ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span>{t('ide.outline.title')}</span>
        <em>{symbols.length}</em>
      </button>
      {open && (
        <div className="ide-outline-list">
          {symbols.length === 0 ? (
            <div className="ide-emptyhint">{t('ide.outline.empty')}</div>
          ) : (
            symbols.map((s, i) => (
              <button
                key={`${s.line}:${s.column}:${s.name}:${i}`}
                className={`ide-outline-row is-${s.kind}`}
                style={{ paddingLeft: 10 + Math.min(3, s.depth) * 12 }}
                title={`${s.name} · ${s.line}`}
                onClick={() => onJump(s.line)}
              >
                <i className="ide-outline-kind" />
                <span className="ide-outline-name">{s.name}</span>
                <em>{s.line}</em>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
