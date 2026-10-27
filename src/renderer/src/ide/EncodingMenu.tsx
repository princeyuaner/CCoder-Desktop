import { useEffect } from 'react'
import { IDE_ENCODINGS, type IdeEncoding } from '@shared/ide'
import type { MessageKey } from '@shared/i18n'
import { useI18n } from '../i18n'

/** 编码名称的 i18n key；状态栏和菜单共用 */
export const ENCODING_LABEL_KEY: Record<IdeEncoding, MessageKey> = {
  utf8: 'ide.encoding.utf8',
  utf8bom: 'ide.encoding.utf8bom',
  gbk: 'ide.encoding.gbk',
  utf16le: 'ide.encoding.utf16le',
  utf16be: 'ide.encoding.utf16be'
}

/**
 * 点状态栏编码时弹出的菜单。
 *
 * 「重新打开」用于把 UTF-8 误认成 GBK（或反过来）的文件读对；
 * 「保存时使用」用于把当前内容转换成另一种编码写盘。
 */
export function EncodingMenu({
  current,
  dirty,
  onReopen,
  onSave,
  onClose
}: {
  current: IdeEncoding
  dirty: boolean
  onReopen: (encoding: IdeEncoding) => void
  onSave: (encoding: IdeEncoding) => void
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
      <div className="ide-ctx ide-enc" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ide-enc-head">{t('ide.encoding.reopen')}</div>
        {IDE_ENCODINGS.map((encoding) => (
          <button
            key={encoding}
            type="button"
            data-encoding-section="reopen"
            data-encoding={encoding}
            disabled={dirty}
            onClick={() => {
              onClose()
              onReopen(encoding)
            }}
          >
            {t(ENCODING_LABEL_KEY[encoding])}
            {encoding === current && <em>{t('ide.encoding.current')}</em>}
          </button>
        ))}
        {dirty && <div className="ide-enc-hint">{t('ide.encoding.unsaved')}</div>}

        <span className="ide-ctx-sep" />

        <div className="ide-enc-head">{t('ide.encoding.save')}</div>
        {IDE_ENCODINGS.map((encoding) => (
          <button
            key={encoding}
            type="button"
            data-encoding-section="save"
            data-encoding={encoding}
            onClick={() => {
              onClose()
              onSave(encoding)
            }}
          >
            {t(ENCODING_LABEL_KEY[encoding])}
            {encoding === current && <em>{t('ide.encoding.current')}</em>}
          </button>
        ))}
      </div>
    </div>
  )
}
