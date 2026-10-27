import { useEffect, useRef } from 'react'
import type { EditorSettings, LspSettings } from '@shared/settings'
import type { KeybindingOverrides } from '@shared/keybindings'
import { useI18n } from '../i18n'
import { EditorSettingsTab, type SettingsSaveState } from './EditorSettingsTab'
import { KeybindingsTab } from './KeybindingsTab'

export type SettingsSection = 'keybindings' | 'editor'

/**
 * IDE 设置弹窗。
 *
 * 快捷键和编辑器设置放在同一个窗口里，用左侧的竖排页签切换；不再占用
 * 编辑器的文件页签。改动仍然由 IdeApp 统一落盘，所以底部只显示保存状态。
 */
export function SettingsDialog({
  tab,
  onTab,
  onClose,
  overrides,
  onKeybindingsChange,
  editor,
  lsp,
  saveState,
  onEditorChange
}: {
  tab: SettingsSection
  onTab: (tab: SettingsSection) => void
  onClose: () => void
  overrides: KeybindingOverrides
  onKeybindingsChange: (next: KeybindingOverrides) => void
  editor: EditorSettings
  lsp: LspSettings
  saveState: SettingsSaveState
  onEditorChange: (patch: { editor?: EditorSettings; lsp?: LspSettings }) => void
}): JSX.Element {
  const { t } = useI18n()
  const dialogRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => previous?.focus?.()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose()
    }
    // 冒泡阶段：快捷键录制会在捕获阶段 stopImmediatePropagation，录制时不会误关弹窗
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
  }, [tab])

  const saveText =
    saveState === 'saving'
      ? t('ide.editorSettings.saving')
      : saveState === 'error'
        ? t('ide.editorSettings.failed')
        : saveState === 'saved'
          ? `✓ ${t('ide.editorSettings.saved')}`
          : t('ide.editorSettings.auto')

  return (
    <div
      className="ide-settings-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="ide-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ide-settings-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <header className="ide-settings__titlebar">
          <span className="ide-settings__icon">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor">
              <path d="M8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6M13 8c0-.3 0-.6-.1-.9l1.2-.9-1.2-2-1.4.5c-.5-.4-1-.6-1.6-.8l-.2-1.4H6.3l-.2 1.4c-.6.2-1.1.5-1.6.8l-1.4-.5-1.2 2 1.2.9c0 .3-.1.6-.1.9s0 .6.1.9l-1.2.9 1.2 2 1.4-.5c.5.4 1 .6 1.6.8l.2 1.4h3.4l.2-1.4c.6-.2 1.1-.5 1.6-.8l1.4.5 1.2-2-1.2-.9c.1-.3.1-.6.1-.9" />
            </svg>
          </span>
          <h2 id="ide-settings-title">{t('ide.settings.title')}</h2>
          <span className="ide-settings__sub">{t('ide.settings.sub')}</span>
          <button
            type="button"
            className="ide-settings__close"
            title={t('common.close')}
            aria-label={t('common.close')}
            onClick={onClose}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor">
              <path d="M3 3l10 10M13 3L3 13" />
            </svg>
          </button>
        </header>

        <div className="ide-settings__main">
          <nav className="ide-settings__nav" role="tablist" aria-label={t('ide.settings.tabs')}>
            <button
              type="button"
              id="ide-settings-tab-keybindings"
              role="tab"
              aria-selected={tab === 'keybindings'}
              aria-controls="ide-settings-panel-keybindings"
              className={`ide-settings__navitem${tab === 'keybindings' ? ' is-on' : ''}`}
              onClick={() => onTab('keybindings')}
            >
              {t('ide.keybindings.title')}
            </button>
            <button
              type="button"
              id="ide-settings-tab-editor"
              role="tab"
              aria-selected={tab === 'editor'}
              aria-controls="ide-settings-panel-editor"
              className={`ide-settings__navitem${tab === 'editor' ? ' is-on' : ''}`}
              onClick={() => onTab('editor')}
            >
              {t('ide.editorSettings.title')}
            </button>
          </nav>

          <div
            className="ide-settings__body"
            id={`ide-settings-panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`ide-settings-tab-${tab}`}
            ref={bodyRef}
          >
            <div className="ide-settings__panel">
              {tab === 'keybindings' ? (
                <KeybindingsTab
                  embedded
                  overrides={overrides}
                  onChange={onKeybindingsChange}
                />
              ) : (
                <>
                  <p className="ide-settings__lead">{t('ide.editorSettings.lead')}</p>
                  <EditorSettingsTab
                    embedded
                    editor={editor}
                    lsp={lsp}
                    saveState={saveState}
                    onChange={onEditorChange}
                  />
                </>
              )}
            </div>
          </div>
        </div>

        <footer className="ide-settings__footer">
          <span className={`ide-settings__save is-${saveState}`} aria-live="polite">
            {saveText}
          </span>
          <span className="ide-settings__note">{t('ide.settings.localOnly')}</span>
          <button type="button" className="ide-settings__done" onClick={onClose}>
            {t('ide.settings.done')}
          </button>
        </footer>
      </div>
    </div>
  )
}
