import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  EDITOR_AUTO_SAVE_DELAYS,
  EDITOR_AUTO_SAVE_LABEL_KEY,
  EDITOR_CURSOR_BLINKING_LABEL_KEY,
  EDITOR_CURSOR_SMOOTH_LABEL_KEY,
  EDITOR_CURSOR_STYLE_LABEL_KEY,
  EDITOR_FONT_SIZES,
  EDITOR_LETTER_SPACINGS,
  EDITOR_LINE_HEIGHTS,
  EDITOR_LINE_HIGHLIGHT_LABEL_KEY,
  EDITOR_LINE_NUMBERS_LABEL_KEY,
  EDITOR_RULERS_MAX,
  EDITOR_TAB_SIZES,
  EDITOR_TERMINAL_LINE_HEIGHTS,
  EDITOR_WHITESPACE_LABEL_KEY,
  EDITOR_WORD_WRAP_LABEL_KEY,
  type EditorAutoSave,
  type EditorCursorBlinking,
  type EditorCursorSmooth,
  type EditorCursorStyle,
  type EditorLineHighlight,
  type EditorLineNumbers,
  type EditorSettings,
  type EditorWhitespace,
  type EditorWordWrap,
  type LspSettings
} from '@shared/settings'
import { useI18n } from '../i18n'
import { monaco } from './monaco-setup'

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

  const languages = useMemo(
    () =>
      monaco.languages
        .getLanguages()
        .map((item) => ({ id: item.id, label: item.aliases?.[0] ?? item.id }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    []
  )

  const configuredLanguages = useMemo(
    () => Object.keys(editor.languages).sort((a, b) => a.localeCompare(b)),
    [editor.languages]
  )

  const addLanguage = (id: string): void => {
    if (!id || editor.languages[id]) return
    patchEditor({
      languages: {
        ...editor.languages,
        [id]: { tabSize: editor.tabSize, insertSpaces: editor.insertSpaces }
      }
    })
  }

  const patchLanguage = (
    id: string,
    patch: Partial<{ tabSize: number; insertSpaces: boolean }>
  ): void => {
    const current = editor.languages[id]
    if (!current) return
    patchEditor({
      languages: { ...editor.languages, [id]: { ...current, ...patch } }
    })
  }

  const removeLanguage = (id: string): void => {
    if (!editor.languages[id]) return
    const next = { ...editor.languages }
    delete next[id]
    patchEditor({ languages: next })
  }

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

            {editor.wordWrap === 'bounded' && (
              <Field
                label={t('settings.editor.wordWrapColumn')}
                hint={t('settings.editor.wordWrapColumnHint')}
              >
                <NumberField
                  value={editor.wordWrapColumn}
                  min={20}
                  max={300}
                  onCommit={(n) => patchEditor({ wordWrapColumn: n })}
                />
              </Field>
            )}

            <Field label={t('settings.editor.lineHeight')} hint={t('settings.editor.lineHeightHint')}>
              <Select
                value={editor.lineHeight}
                onChange={(v) => patchEditor({ lineHeight: Number(v) })}
              >
                {EDITOR_LINE_HEIGHTS.map((n) => (
                  <option key={n} value={n}>
                    {n}×
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label={t('settings.editor.letterSpacing')}
              hint={t('settings.editor.letterSpacingHint')}
            >
              <Select
                value={editor.letterSpacing}
                onChange={(v) => patchEditor({ letterSpacing: Number(v) })}
              >
                {EDITOR_LETTER_SPACINGS.map((n) => (
                  <option key={n} value={n}>
                    {n}px
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label={t('settings.editor.fontLigatures')}
              hint={t('settings.editor.fontLigaturesHint')}
            >
              <Toggle
                on={editor.fontLigatures}
                label={editor.fontLigatures ? t('common.enabled') : t('common.disabled')}
                onChange={(on) => patchEditor({ fontLigatures: on })}
              />
            </Field>

            <Field
              label={t('settings.editor.fontFamily')}
              hint={t('settings.editor.fontFamilyHint')}
            >
              <TextField
                value={editor.fontFamily}
                placeholder={t('settings.editor.fontFamilyPlaceholder')}
                onCommit={(v) => patchEditor({ fontFamily: v })}
              />
            </Field>
          </div>
        </section>

        <section className="ide-es__section">
          <h3>{t('ide.editorSettings.section.appearance')}</h3>
          <div className="ide-es__card">
            <Field label={t('settings.editor.cursorStyle')}>
              <Select
                value={editor.cursorStyle}
                onChange={(v) => patchEditor({ cursorStyle: v as EditorCursorStyle })}
              >
                {(Object.keys(EDITOR_CURSOR_STYLE_LABEL_KEY) as EditorCursorStyle[]).map((k) => (
                  <option key={k} value={k}>
                    {t(EDITOR_CURSOR_STYLE_LABEL_KEY[k])}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label={t('settings.editor.cursorBlinking')}>
              <Select
                value={editor.cursorBlinking}
                onChange={(v) => patchEditor({ cursorBlinking: v as EditorCursorBlinking })}
              >
                {(Object.keys(EDITOR_CURSOR_BLINKING_LABEL_KEY) as EditorCursorBlinking[]).map(
                  (k) => (
                    <option key={k} value={k}>
                      {t(EDITOR_CURSOR_BLINKING_LABEL_KEY[k])}
                    </option>
                  )
                )}
              </Select>
            </Field>

            <Field label={t('settings.editor.cursorSmooth')}>
              <Select
                value={editor.cursorSmoothCaretAnimation}
                onChange={(v) =>
                  patchEditor({ cursorSmoothCaretAnimation: v as EditorCursorSmooth })
                }
              >
                {(Object.keys(EDITOR_CURSOR_SMOOTH_LABEL_KEY) as EditorCursorSmooth[]).map((k) => (
                  <option key={k} value={k}>
                    {t(EDITOR_CURSOR_SMOOTH_LABEL_KEY[k])}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label={t('settings.editor.lineHighlight')}>
              <Select
                value={editor.renderLineHighlight}
                onChange={(v) => patchEditor({ renderLineHighlight: v as EditorLineHighlight })}
              >
                {(Object.keys(EDITOR_LINE_HIGHLIGHT_LABEL_KEY) as EditorLineHighlight[]).map(
                  (k) => (
                    <option key={k} value={k}>
                      {t(EDITOR_LINE_HIGHLIGHT_LABEL_KEY[k])}
                    </option>
                  )
                )}
              </Select>
            </Field>

            <Field label={t('settings.editor.whitespace')} hint={t('settings.editor.whitespaceHint')}>
              <Select
                value={editor.renderWhitespace}
                onChange={(v) => patchEditor({ renderWhitespace: v as EditorWhitespace })}
              >
                {(Object.keys(EDITOR_WHITESPACE_LABEL_KEY) as EditorWhitespace[]).map((k) => (
                  <option key={k} value={k}>
                    {t(EDITOR_WHITESPACE_LABEL_KEY[k])}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label={t('settings.editor.controlCharacters')}
              hint={t('settings.editor.controlCharactersHint')}
            >
              <Toggle
                on={editor.renderControlCharacters}
                label={editor.renderControlCharacters ? t('common.enabled') : t('common.disabled')}
                onChange={(on) => patchEditor({ renderControlCharacters: on })}
              />
            </Field>
          </div>
        </section>

        <section className="ide-es__section">
          <h3>{t('ide.editorSettings.section.guides')}</h3>
          <div className="ide-es__card">
            <Field label={t('settings.editor.lineNumbers')}>
              <Select
                value={editor.lineNumbers}
                onChange={(v) => patchEditor({ lineNumbers: v as EditorLineNumbers })}
              >
                {(Object.keys(EDITOR_LINE_NUMBERS_LABEL_KEY) as EditorLineNumbers[]).map((k) => (
                  <option key={k} value={k}>
                    {t(EDITOR_LINE_NUMBERS_LABEL_KEY[k])}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label={t('settings.editor.indentationGuides')}
              hint={t('settings.editor.indentationGuidesHint')}
            >
              <Toggle
                on={editor.indentationGuides}
                label={editor.indentationGuides ? t('common.enabled') : t('common.disabled')}
                onChange={(on) => patchEditor({ indentationGuides: on })}
              />
            </Field>

            <Field
              label={t('settings.editor.bracketPairGuides')}
              hint={t('settings.editor.bracketPairGuidesHint')}
            >
              <Toggle
                on={editor.bracketPairGuides}
                label={editor.bracketPairGuides ? t('common.enabled') : t('common.disabled')}
                onChange={(on) => patchEditor({ bracketPairGuides: on })}
              />
            </Field>

            <Field label={t('settings.editor.rulers')} hint={t('settings.editor.rulersHint')}>
              <NumberField
                value={editor.rulers}
                min={0}
                max={EDITOR_RULERS_MAX}
                onCommit={(n) => patchEditor({ rulers: n })}
              />
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

            <Field
              label={t('settings.editor.stickyScroll')}
              hint={t('settings.editor.stickyScrollHint')}
            >
              <Toggle
                on={editor.stickyScroll}
                label={
                  editor.stickyScroll ? t('common.enabled') : t('common.disabled')
                }
                onChange={(on) => patchEditor({ stickyScroll: on })}
              />
            </Field>

            <Field
              label={t('settings.editor.autoReveal')}
              hint={t('settings.editor.autoRevealHint')}
            >
              <Toggle
                on={editor.autoRevealInExplorer}
                label={
                  editor.autoRevealInExplorer ? t('common.enabled') : t('common.disabled')
                }
                onChange={(on) => patchEditor({ autoRevealInExplorer: on })}
              />
            </Field>

            <Field
              label={t('settings.editor.smoothScrolling')}
              hint={t('settings.editor.smoothScrollingHint')}
            >
              <Toggle
                on={editor.smoothScrolling}
                label={editor.smoothScrolling ? t('common.enabled') : t('common.disabled')}
                onChange={(on) => patchEditor({ smoothScrolling: on })}
              />
            </Field>

            <Field
              label={t('settings.editor.mouseWheelZoom')}
              hint={t('settings.editor.mouseWheelZoomHint')}
            >
              <Toggle
                on={editor.mouseWheelZoom}
                label={editor.mouseWheelZoom ? t('common.enabled') : t('common.disabled')}
                onChange={(on) => patchEditor({ mouseWheelZoom: on })}
              />
            </Field>
          </div>
        </section>

        <section className="ide-es__section">
          <h3>{t('ide.editorSettings.section.terminal')}</h3>
          <div className="ide-es__card">
            <Field label={t('settings.editor.terminalFontSize')}>
              <Select
                value={editor.terminalFontSize}
                onChange={(v) => patchEditor({ terminalFontSize: Number(v) })}
              >
                {EDITOR_FONT_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}px
                  </option>
                ))}
              </Select>
            </Field>

            <Field label={t('settings.editor.terminalLineHeight')}>
              <Select
                value={editor.terminalLineHeight}
                onChange={(v) => patchEditor({ terminalLineHeight: Number(v) })}
              >
                {EDITOR_TERMINAL_LINE_HEIGHTS.map((n) => (
                  <option key={n} value={n}>
                    {n}×
                  </option>
                ))}
              </Select>
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

            <Field
              label={t('settings.editor.formatOnSave')}
              hint={t('settings.editor.formatOnSaveHint')}
            >
              <Toggle
                on={editor.formatOnSave}
                label={editor.formatOnSave ? t('common.enabled') : t('common.disabled')}
                onChange={(on) => patchEditor({ formatOnSave: on })}
              />
            </Field>
          </div>
        </section>

        <section className="ide-es__section">
          <h3>{t('ide.editorSettings.section.languages')}</h3>
          <div className="ide-es__card">
            <Field
              label={t('settings.editor.languageAdd')}
              hint={t('settings.editor.languagesHint')}
            >
              <Select value="" onChange={(id) => addLanguage(id)}>
                <option value="">{t('settings.editor.languagePlaceholder')}</option>
                {languages
                  .filter((item) => !editor.languages[item.id])
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
              </Select>
            </Field>

            {configuredLanguages.length === 0 && (
              <div className="ide-es__empty">{t('settings.editor.languageNone')}</div>
            )}

            {configuredLanguages.map((id) => {
              const item = editor.languages[id]
              if (!item) return null
              const label =
                languages.find((entry) => entry.id === id)?.label ?? id
              return (
                <div className="ide-es__langrow" key={id}>
                  <span className="ide-es__langname" title={id}>
                    {label}
                  </span>
                  <Select
                    value={item.tabSize}
                    onChange={(value) => patchLanguage(id, { tabSize: Number(value) })}
                  >
                    {EDITOR_TAB_SIZES.map((n) => (
                      <option key={n} value={n}>
                        {t('settings.editor.languageTab', { n })}
                      </option>
                    ))}
                  </Select>
                  <Select
                    value={item.insertSpaces ? 'spaces' : 'tab'}
                    onChange={(value) =>
                      patchLanguage(id, { insertSpaces: value === 'spaces' })
                    }
                  >
                    <option value="spaces">{t('settings.editor.indent.spaces')}</option>
                    <option value="tab">{t('settings.editor.indent.tab')}</option>
                  </Select>
                  <button
                    type="button"
                    className="ide-es__remove"
                    title={t('settings.editor.languageRemove')}
                    onClick={() => removeLanguage(id)}
                  >
                    ×
                  </button>
                </div>
              )
            })}
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

/**
 * 文本设置先放本地草稿，失焦或 Enter 再提交。
 *
 * 设置保存会把内容规范化（trim / 过滤控制字符），逐键写回会让
 * 「Fira Code」这种带空格的字体名在输入过程中被 trim 成「FiraCode」。
 */
function TextField({
  value,
  placeholder,
  onCommit
}: {
  value: string
  placeholder?: string
  onCommit: (value: string) => void
}): JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  // 直接读事件里的值，不依赖 draft 闭包：输入和失焦可能落在同一批更新里
  const commit = (next: string): void => {
    if (next !== value) onCommit(next)
  }
  return (
    <span className="ide-es__input">
      <input
        type="text"
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          // 不 blur：让本地草稿先恢复，避免 blur 时把刚放弃的值提交出去
          if (e.key === 'Escape') setDraft(value)
        }}
      />
    </span>
  )
}

/** 数字设置同样在失焦 / Enter 时提交，避免逐键夹取把输入打断 */
function NumberField({
  value,
  min,
  max,
  onCommit
}: {
  value: number
  min: number
  max: number
  onCommit: (value: number) => void
}): JSX.Element {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (raw: string): void => {
    if (raw.trim() === '') {
      setDraft(String(value))
      return
    }
    const n = Math.round(Number(raw))
    if (!Number.isFinite(n)) {
      setDraft(String(value))
      return
    }
    const next = Math.min(max, Math.max(min, n))
    setDraft(String(next))
    if (next !== value) onCommit(next)
  }
  return (
    <span className="ide-es__input is-number">
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setDraft(String(value))
        }}
      />
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
