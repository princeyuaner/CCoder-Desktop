import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  KEYBINDING_COMMANDS,
  KEYBINDING_GROUP_LABEL_KEY,
  KEYBINDING_GROUP_ORDER,
  acceleratorFromEvent,
  defaultBindingOf,
  formatBinding,
  keybindingConflicts,
  normalizeBinding,
  resolveKeybindings,
  type KeybindingCommand,
  type KeybindingCommandGroup,
  type KeybindingOverrides
} from '@shared/keybindings'
import { IconSearch } from '../components/Icons'
import { useI18n } from '../i18n'

/**
 * IDE 里的快捷键设置页签。
 *
 * 交互和 VS Code 一致：点住某条命令的按键再按组合键即可改绑；Esc 取消，
 * Backspace / Delete 清除。改动通过 onChange 交给 IdeApp 立即落盘。
 */
export function KeybindingsTab({
  overrides,
  onChange,
  embedded = false
}: {
  overrides: KeybindingOverrides
  onChange: (next: KeybindingOverrides) => void
  /** 放在设置弹窗里时不再渲染自己的页面标题 */
  embedded?: boolean
}): JSX.Element {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<string | null>(null)

  const resolved = useMemo(() => resolveKeybindings(overrides), [overrides])
  const conflicts = useMemo(() => keybindingConflicts(resolved), [resolved])

  const setOne = useCallback(
    (id: string, value: string | null): void => {
      const next = { ...overrides }
      if (value === null) {
        if (defaultBindingOf(id) === null) delete next[id]
        else next[id] = null
      } else {
        const normalized = normalizeBinding(value)
        const fallback = defaultBindingOf(id)
        if (!normalized || (fallback && normalizeBinding(fallback) === normalized)) {
          delete next[id]
        } else {
          next[id] = normalized
        }
      }
      onChange(next)
    },
    [onChange, overrides]
  )

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      // 捕获阶段拦下：录制时按键不应该激活按钮或触发 IDE 的其它快捷键
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        setRecording(null)
        return
      }
      const plainDelete =
        !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey &&
        (e.key === 'Delete' || e.key === 'Backspace')
      if (plainDelete) {
        e.preventDefault()
        e.stopImmediatePropagation()
        setOne(recording, null)
        setRecording(null)
        return
      }
      if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return
      const accelerator = acceleratorFromEvent(e)
      if (!accelerator) return
      e.preventDefault()
      e.stopImmediatePropagation()
      setOne(recording, accelerator)
      setRecording(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, setOne])

  const labelOf = useCallback(
    (id: string): string => {
      const command = KEYBINDING_COMMANDS.find((c) => c.id === id)
      return command ? t(command.labelKey) : id
    },
    [t]
  )

  const groups = useMemo(() => {
    const term = query.trim().toLowerCase()
    const match = (command: KeybindingCommand): boolean => {
      if (!term) return true
      const text = `${t(command.labelKey)} ${t(KEYBINDING_GROUP_LABEL_KEY[command.group])} ${formatBinding(resolved[command.id])}`
      return text.toLowerCase().includes(term)
    }
    return KEYBINDING_GROUP_ORDER.map((group: KeybindingCommandGroup) => ({
      group,
      commands: KEYBINDING_COMMANDS.filter((c) => c.group === group && match(c))
    })).filter((g) => g.commands.length > 0)
  }, [query, resolved, t])

  const dirty = Object.keys(overrides).length > 0

  return (
    <div className={`ide-kb${embedded ? ' is-embedded' : ''}`}>
      {!embedded && (
        <header className="ide-kb__head">
          <h2>{t('ide.keybindings.title')}</h2>
          <p>{t('ide.keybindings.lead')}</p>
        </header>
      )}

      <div className="ide-kb__bar">
        <label className="ide-kb__search">
          <IconSearch width={13} height={13} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('ide.keybindings.search')}
            spellCheck={false}
          />
        </label>
        <button
          type="button"
          className="ide-kb__btn"
          disabled={!dirty}
          onClick={() => {
            setRecording(null)
            onChange({})
          }}
        >
          {t('ide.keybindings.resetAll')}
        </button>
      </div>
      <p className="ide-kb__tip">{t('ide.keybindings.tip')}</p>

      {groups.map(({ group, commands }) => (
        <section className="ide-kb__group" key={group}>
          <h3>{t(KEYBINDING_GROUP_LABEL_KEY[group])}</h3>
          {commands.map((command) => {
            const current = resolved[command.id]
            const modified = command.id in overrides
            const others = conflicts[command.id]
            return (
              <div className="ide-kb__row" key={command.id}>
                <div className="ide-kb__main">
                  <span className="ide-kb__label">{t(command.labelKey)}</span>
                  {others && others.length > 0 && (
                    <span className="ide-kb__warn">
                      {t('ide.keybindings.conflict', {
                        names: others.map(labelOf).join(', ')
                      })}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className={`ide-kb__key${recording === command.id ? ' is-rec' : ''}`}
                  aria-pressed={recording === command.id}
                  onClick={() =>
                    setRecording((cur) => (cur === command.id ? null : command.id))
                  }
                  onBlur={() => setRecording((cur) => (cur === command.id ? null : cur))}
                >
                  {recording === command.id
                    ? t('ide.keybindings.recording')
                    : current
                      ? formatBinding(current)
                      : t('ide.keybindings.unbound')}
                </button>
                <button
                  type="button"
                  className="ide-kb__reset"
                  disabled={!modified}
                  onClick={() => {
                    setRecording(null)
                    setOne(command.id, defaultBindingOf(command.id))
                  }}
                >
                  {t('ide.keybindings.reset')}
                </button>
              </div>
            )
          })}
        </section>
      ))}

      {groups.length === 0 && <p className="ide-kb__empty">{t('ide.keybindings.empty')}</p>}

      <div className="ide-kb__note">
        <span className="ide-kb__note-mark">i</span>
        <span>{t('ide.keybindings.hint')}</span>
      </div>
    </div>
  )
}
