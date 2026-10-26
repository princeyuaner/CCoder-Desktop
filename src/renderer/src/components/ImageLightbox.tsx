import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../i18n'

/**
 * 图片大图预览。
 *
 * 挂在 `document.body` 上而不是留在消息行里：转写区是 `overflow: auto`
 * 的滚动容器，弹层放进去会被裁掉（还会被 `content-visibility` 的块影响）。
 *
 * 只负责「看」：点遮罩、点关闭或按 Esc 退出，不提供缩放 —— 图片本身已经
 * 按视口等比限制，缩放留给系统看图工具。
 */
export function ImageLightbox({
  src,
  alt,
  meta,
  onClose
}: {
  src: string
  alt: string
  /** 底部一行小字（文件名 · 尺寸） */
  meta?: string
  onClose: () => void
}): JSX.Element {
  const { t } = useI18n()
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="imgview" role="dialog" aria-modal="true" aria-label={alt}>
      <div className="imgview__scrim" onClick={onClose} />
      <img className="imgview__img" src={src} alt={alt} draggable={false} />
      {meta && <div className="imgview__meta">{meta}</div>}
      <button
        ref={closeRef}
        className="imgview__close"
        onClick={onClose}
        title={t('common.close')}
        aria-label={t('common.close')}
      >
        ×
      </button>
    </div>,
    document.body
  )
}
