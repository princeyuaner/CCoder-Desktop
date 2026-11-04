import { useEffect } from 'react'
import type { IdeEol } from '@shared/ide'
import { useI18n } from '../i18n'

/**
 * 状态栏的换行符菜单。
 *
 * 只改缓冲区里的 `eol`，下一次保存按新值落盘；取消 / Esc 不改。
 */
export function EolMenu({
  current,
  onPick,
  onClose
}: {
  current: IdeEol
  onPick: (eol: IdeEol) => void
  onClose: () => void
}): JSX.Element {
  const { t } = useI18n()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="ide-ctx-overlay"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <div className="ide-ctx ide-enc ide-eol" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ide-enc-head">{t('ide.eol.title')}</div>
        {(['lf', 'crlf'] as const).map((eol) => (
          <button
            key={eol}
            type="button"
            onClick={() => {
              onClose()
              onPick(eol)
            }}
          >
            <span>{eol === 'lf' ? 'LF' : 'CRLF'}</span>
            {eol === current && <em>{t('ide.encoding.current')}</em>}
          </button>
        ))}
        <div className="ide-enc-hint">{t('ide.eol.hint')}</div>
      </div>
    </div>
  )
}
