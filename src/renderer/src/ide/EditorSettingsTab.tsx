import type { ReactNode } from 'react'
import {
  EDITOR_AUTO_SAVE_DELAYS,
  EDITOR_AUTO_SAVE_LABEL_KEY,
  EDITOR_FONT_SIZES,
  EDITOR_TAB_SIZES,
  EDITOR_WORD_WRAP_LABEL_KEY,
  type EditorAutoSave,
  type EditorSettings,
  type EditorWordWrap,
  type LspSettings
} from '@shared/settings'
import { useI18n } from '../i18n'

export type SettingsSaveState = 'idle' | 'saving' | 'saved' | 'error'

/**
 * IDE 里的编辑器设置页签。
 *
 * 与主设置页不同，这里的改动直接写回 `settings.editor` / `settings.lsp`，
 * 由 IdeApp 统一落盘；Monaco 和 LSP 通过现有状态立即生效。
 */
export function EditorSettingsTab({
  editor,
  lsp,
  saveState,
  onChange,
  embedded = false
}: {
  editor: EditorSettings
  lsp: LspSettings
  saveState: SettingsSaveState
  onChange: (patch: { editor?: EditorSettings; lsp?: LspSettings }) => void
  /** 放在设置弹窗里时由弹窗统一显示页标题和保存状态 */
  embedded?: boolean
}): JSX.Element {
  const { t } = useI18n()

  const patchEditor = (patch: Partial<EditorSettings>): void =>
    onChange({ editor: { ...editor, ...patch } })

  return (
    <div className={`ide-es${embedded ? ' is-embedded' : ''}`}>
      <div className="ide-es__inner">
        {!embedded && (
          <header className="ide-es__head">
            <div>
              <h2>{t('ide.editorSettings.heading')}</h2>
              <p>{t('ide.editorSettings.lead')}</p>
            </div>
            <span className={`ide-es__save is-${saveState}`}>
              {saveState === 'saving'
                ? t('ide.editorSettings.saving')
                : saveState === 'error'
                  ? t('ide.editorSettings.failed')
                  : saveState === 'saved'
                    ? `✓ ${t('ide.editorSettings.saved')}`
                    : t('ide.editorSettings.auto')}
            </span>
          </header>
        )}

        <section className="ide-es__section">
          <h3>{t('ide.editorSettings.section.text')}</h3>
          <div className="ide-es__card">
            <Field label={t('settings.editor.fontSize')} hint={t('settings.editor.fontSizeHint')}>
              <Select value={editor.fontSize} onChange={(v) => patchEditor({ fontSize: Number(v) })}>
                {EDITOR_FONT_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}px
                  </option>
                ))}
              </Select>
            </Field>

            <Field label={t('settings.editor.tabSize')} hint={t('settings.editor.tabSizeHint')}>
              <Select value={editor.tabSize} onChange={(v) => patchEditor({ tabSize: Number(v) })}>
                {EDITOR_TAB_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label={t('settings.editor.indent')}>
              <Select
                value={editor.insertSpaces ? 'spaces' : 'tab'}
                onChange={(v) => patchEditor({ insertSpaces: v === 'spaces' })}
              >
                <option value="spaces">{t('settings.editor.indent.spaces')}</option>
                <option value="tab">{t('settings.editor.indent.tab')}</option>
              </Select>
            </Field>

            <Field label={t('settings.editor.wordWrap')} hint={t('settings.editor.wordWrapHint')}>
              <Select
                value={editor.wordWrap}
                onChange={(v) => patchEditor({ wordWrap: v as EditorWordWrap })}
              >
                {(Object.keys(EDITOR_WORD_WRAP_LABEL_KEY) as EditorWordWrap[]).map((k) => (
                  <option key={k} value={k}>
                    {t(EDITOR_WORD_WRAP_LABEL_KEY[k])}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </section>

        <section className="ide-es__section">
          <h3>{t('ide.editorSettings.section.display')}</h3>
          <div className="ide-es__card">
            <Field label={t('settings.editor.minimap')} hint={t('settings.editor.minimapHint')}>
              <Toggle
                on={editor.minimap}
                label={
                  editor.minimap
                    ? t('settings.editor.minimap.on')
                    : t('settings.editor.minimap.off')
                }
                onChange={(on) => patchEditor({ minimap: on })}
              />
            </Field>
          </div>
        </section>

        <section className="ide-es__section">
          <h3>{t('ide.editorSettings.section.save')}</h3>
          <div className="ide-es__card">
            <Field label={t('settings.editor.autoSave')} hint={t('settings.editor.autoSaveHint')}>
              <Select
                value={editor.autoSave}
                onChange={(v) => patchEditor({ autoSave: v as EditorAutoSave })}
              >
                {(Object.keys(EDITOR_AUTO_SAVE_LABEL_KEY) as EditorAutoSave[]).map((k) => (
                  <option key={k} value={k}>
                    {t(EDITOR_AUTO_SAVE_LABEL_KEY[k])}
                  </option>
                ))}
              </Select>
            </Field>

            {editor.autoSave === 'afterDelay' && (
              <Field
                label={t('settings.editor.autoSaveDelay')}
                hint={t('settings.editor.autoSaveDelayHint')}
              >
                <Select
                  value={editor.autoSaveDelayMs}
                  onChange={(v) => patchEditor({ autoSaveDelayMs: Number(v) })}
                >
                  {EDITOR_AUTO_SAVE_DELAYS.map((ms) => (
                    <option key={ms} value={ms}>
                      {ms / 1000}s
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            <Field
              label={t('settings.editor.trimWhitespace')}
              hint={t('settings.editor.trimWhitespaceHint')}
            >
              <Toggle
                on={editor.trimTrailingWhitespace}
                label={
                  editor.trimTrailingWhitespace ? t('common.enabled') : t('common.disabled')
                }
                onChange={(on) => patchEditor({ trimTrailingWhitespace: on })}
              />
            </Field>
          </div>
        </section>

        <section className="ide-es__section">
          <h3>{t('ide.editorSettings.section.lsp')}</h3>
          <div className="ide-es__card">
            <Field label={t('settings.lsp.enabled')} hint={t('ide.editorSettings.lspHint')}>
              <Toggle
                on={lsp.enabled}
                label={lsp.enabled ? t('common.enabled') : t('common.disabled')}
                onChange={(enabled) => onChange({ lsp: { enabled } })}
              />
            </Field>
          </div>
        </section>

        <div className="ide-es__note">
          <span className="ide-es__note-mark">i</span>
          <span>{t('ide.editorSettings.note')}</span>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="ide-es__field">
      <span className="ide-es__label">{label}</span>
      <div className="ide-es__body">
        {children}
        {hint && <p className="ide-es__hint">{hint}</p>}
      </div>
    </div>
  )
}

function Select({
  value,
  onChange,
  children
}: {
  value: string | number
  onChange: (value: string) => void
  children: ReactNode
}): JSX.Element {
  return (
    <span className="ide-es__select">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </span>
  )
}

function Toggle({
  on,
  label,
  onChange
}: {
  on: boolean
  label: string
  onChange: (on: boolean) => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`ide-es__switch${on ? ' is-on' : ''}`}
      onClick={() => onChange(!on)}
    >
      <span className="ide-es__track" />
      <span>{label}</span>
    </button>
  )
}
