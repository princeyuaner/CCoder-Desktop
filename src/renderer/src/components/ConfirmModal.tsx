import { useEffect, useRef, type ReactNode } from 'react'

/**
 * 一个通用的确认弹窗，用在**不可逆**的操作上（现在只有"删除会话"）。
 *
 * 跟审批弹窗共用一套外观（`.modal*`），但重心相反：
 * 审批弹窗的默认键是"放行"（那是常见选择），这里默认键是**取消** ——
 * 确认按钮不绑回车，Esc 才是取消。删东西的时候，手滑的代价不对称。
 */
export function ConfirmModal({
  title,
  badge,
  children,
  confirmLabel,
  onConfirm,
  onCancel
}: {
  title: string
  /** 顶部那个小标签，如「不可恢复」 */
  badge?: string
  children: ReactNode
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  const dlgRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    dlgRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 焦点在按钮上时让按钮自己处理，否则回车会既点按钮又走这里
      if ((e.target as HTMLElement | null)?.tagName === 'BUTTON') return
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
      // 回车**不**确认 —— 破坏性操作不该有快捷键
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="modal">
      <div className="modal__scrim" onClick={onCancel} />
      <div
        className="modal__dlg is-danger"
        ref={dlgRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal__h">
          {badge && <span className="modal__badge">{badge}</span>}
          <span className="modal__t">{title}</span>
        </div>
        <div className="modal__b">{children}</div>
        <div className="modal__f">
          <span className="modal__sp" />
          <button className="btn btn--primary" onClick={onCancel}>
            取消<span className="kbd">Esc</span>
          </button>
          <button className="btn btn--danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
