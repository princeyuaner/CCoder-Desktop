import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../i18n'

export interface CommandItem {
  id: string
  label: string
  group?: string
  keybinding?: string
  run: () => void | Promise<void>
}

export function CommandPalette({
  commands,
  onClose
}: {
  commands: CommandItem[]
  onClose: () => void
}): JSX.Element {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) =>
      `${c.group ?? ''} ${c.label} ${c.keybinding ?? ''}`.toLowerCase().includes(q)
    )
  }, [commands, query])

  useEffect(() => {
    setActive(0)
  }, [query])

  const choose = (item?: CommandItem): void => {
    const picked = item ?? items[active]
    if (!picked) return
    onClose()
    void picked.run()
  }

  return (
    <div className="ide-overlay" onMouseDown={onClose}>
      <div className="ide-qo ide-palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ide-qo-input">
          <span className="ide-palette-glyph">&gt;</span>
          <input
            ref={inputRef}
            value={query}
            placeholder={t('ide.command.placeholder')}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(items.length - 1, a + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(0, a - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                choose()
              }
            }}
          />
        </div>
        <div className="ide-qo-list ide-palette-list">
          {items.map((c, i) => (
            <button
              key={c.id}
              className={`ide-qo-row ide-palette-row ${i === active ? 'on' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(c)}
            >
              <span className="ide-palette-label">{c.label}</span>
              {c.group && <span className="ide-palette-group">{c.group}</span>}
              {c.keybinding && <kbd>{c.keybinding}</kbd>}
            </button>
          ))}
          {items.length === 0 && (
            <div className="ide-emptyhint">{t('ide.command.empty')}</div>
          )}
        </div>
        <div className="ide-qo-foot">
          <span>{t('ide.keySelect')}</span>
          <span>{t('ide.keyOpen')}</span>
          <span>{t('ide.keyClose')}</span>
        </div>
      </div>
    </div>
  )
}
