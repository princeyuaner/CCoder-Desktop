import { useEffect, useMemo, useRef, useState } from 'react'
import { monaco } from './monaco-setup'
import { useI18n } from '../i18n'

/**
 * 状态栏的语言模式选择器。
 *
 * 只改当前缓冲区在 Monaco 里的 language id，不重读文件、不猜测内容。
 * 列表直接用 Monaco 注册的语言（和「按语言配置缩进」共用同一套 id）。
 */

export function LanguageMenu({
  current,
  onPick,
  onClose
}: {
  current: string
  onPick: (languageId: string) => void
  onClose: () => void
}): JSX.Element {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const languages = useMemo(() => {
    const list = monaco.languages
      .getLanguages()
      .map((item) => ({ id: item.id, label: item.aliases?.[0] ?? item.id }))
      .sort((a, b) => a.label.localeCompare(b.label))
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (item) => item.id.toLowerCase().includes(q) || item.label.toLowerCase().includes(q)
    )
  }, [query])

  return (
    <div
      className="ide-ctx-overlay"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <div
        className="ide-ctx ide-enc ide-lang"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="ide-enc-head">{t('ide.language.title')}</div>
        <input
          ref={inputRef}
          className="ide-lang-search"
          value={query}
          placeholder={t('ide.language.search')}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="ide-lang-list">
          {languages.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === current ? 'is-current' : undefined}
              onClick={() => {
                onClose()
                onPick(item.id)
              }}
            >
              <span>{item.label}</span>
              {item.id === current && <em>{t('ide.language.current')}</em>}
            </button>
          ))}
          {languages.length === 0 && (
            <div className="ide-lang-empty">{t('ide.language.empty')}</div>
          )}
        </div>
      </div>
    </div>
  )
}
