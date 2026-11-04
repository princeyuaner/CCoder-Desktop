import { useEffect } from 'react'
import { IDE_ENCODINGS, type IdeEncoding } from '@shared/ide'
import type { MessageKey } from '@shared/i18n'
import { useI18n } from '../i18n'

/** 编码名称的 i18n key；状态栏和菜单共用 */
export const ENCODING_LABEL_KEY: Record<IdeEncoding, MessageKey> = {
  utf8: 'ide.encoding.utf8',
  utf8bom: 'ide.encoding.utf8bom',
  gbk: 'ide.encoding.gbk',
  big5: 'ide.encoding.big5',
  shiftjis: 'ide.encoding.shiftjis',
  eucjp: 'ide.encoding.eucjp',
  euckr: 'ide.encoding.euckr',
  utf16le: 'ide.encoding.utf16le',
  utf16be: 'ide.encoding.utf16be',
  utf32le: 'ide.encoding.utf32le',
  utf32be: 'ide.encoding.utf32be',
  windows1252: 'ide.encoding.windows1252',
  windows1251: 'ide.encoding.windows1251',
  windows1250: 'ide.encoding.windows1250',
  windows1253: 'ide.encoding.windows1253',
  windows1254: 'ide.encoding.windows1254',
  windows1255: 'ide.encoding.windows1255',
  windows1256: 'ide.encoding.windows1256',
  windows1257: 'ide.encoding.windows1257',
  windows1258: 'ide.encoding.windows1258',
  windows874: 'ide.encoding.windows874',
  iso88592: 'ide.encoding.iso88592',
  iso88595: 'ide.encoding.iso88595',
  iso88596: 'ide.encoding.iso88596',
  iso88597: 'ide.encoding.iso88597',
  iso88598: 'ide.encoding.iso88598',
  iso88599: 'ide.encoding.iso88599',
  koi8r: 'ide.encoding.koi8r'
}

/**
 * 点状态栏编码时弹出的菜单。
 *
 * 「重新打开」用于把 UTF-8 误认成 GBK（或反过来）的文件读对；
 * 「保存时使用」用于把当前内容转换成另一种编码写盘。
 */
export function EncodingMenu({
  current,
  autoDetected,
  dirty,
  onReopen,
  onReopenAuto,
  onSave,
  onClose
}: {
  current: IdeEncoding
  autoDetected: boolean
  dirty: boolean
  onReopen: (encoding: IdeEncoding) => void
  onReopenAuto: () => void
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
        <button
          type="button"
          data-encoding-section="reopen"
          data-encoding="auto"
          disabled={dirty}
          onClick={() => {
            onClose()
            onReopenAuto()
          }}
        >
          {t('ide.encoding.auto')}
          {autoDetected && <em>{t('ide.encoding.current')}</em>}
        </button>
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
