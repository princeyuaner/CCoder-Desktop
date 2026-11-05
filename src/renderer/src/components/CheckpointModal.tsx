import { useEffect, useRef, useState } from 'react'
import { formatRelativeTime } from '@shared/i18n'
import type {
  CheckpointFileChange,
  SessionCheckpointInfo,
  SessionCheckpointList,
  SessionCheckpointPreview,
  SessionCheckpointRestore
} from '@shared/session'
import { useI18n } from '../i18n'
import { IconAlert, IconCheck, IconChevronRight, IconClock, IconX } from './Icons'

/**
 * 文件检查点弹窗。
 *
 * 恢复是破坏性操作，走两步：先预览「会动哪些文件」，再点一次确认。
 * 主进程在真正写盘前还会自动拍一份备份，所以恢复本身可以再恢复回来。
 */
export function CheckpointModal({
  busy,
  onClose,
  load,
  preview,
  restore,
  onRestored
}: {
  busy: boolean
  onClose: () => void
  load: () => Promise<SessionCheckpointList>
  preview: (id: string) => Promise<SessionCheckpointPreview>
  restore: (id: string) => Promise<SessionCheckpointRestore>
  onRestored: () => void
}): JSX.Element {
  const { t, tn, locale } = useI18n()
  const [items, setItems] = useState<SessionCheckpointInfo[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [previewData, setPreviewData] = useState<SessionCheckpointPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [result, setResult] = useState<SessionCheckpointRestore | null>(null)
  const [actionError, setActionError] = useState('')
  const [reloadSeq, setReloadSeq] = useState(0)
  const seq = useRef(0)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    let alive = true
    const n = ++seq.current
    setLoadError('')
    void load().then((r) => {
      if (!alive || seq.current !== n) return
      setItems(r.checkpoints)
      if (!r.ok || r.message) setLoadError(r.message ?? '')
    })
    return () => {
      alive = false
    }
  }, [load, reloadSeq])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !restoring) {
        e.preventDefault()
        onCloseRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [restoring])

  /** 点一条检查点：先算差异，不直接改盘 */
  const pick = async (id: string): Promise<void> => {
    if (restoring) return
    setSelected(id)
    setConfirming(false)
    setResult(null)
    setActionError('')
    setPreviewData(null)
    setPreviewing(true)
    const n = ++seq.current
    const r = await preview(id)
    if (seq.current !== n) return
    setPreviewing(false)
    if (!r.ok) {
      setActionError(r.message ?? t('errors.unknownReason'))
      return
    }
    setPreviewData(r)
  }

  const doRestore = async (): Promise<void> => {
    if (!selected || restoring) return
    setRestoring(true)
    setActionError('')
    const r = await restore(selected)
    setRestoring(false)
    if (!r.ok) {
      setActionError(r.message ?? t('errors.unknownReason'))
      return
    }
    setResult(r)
    setConfirming(false)
    setPreviewData(null)
    setSelected(null)
    onRestored()
    setReloadSeq((n) => n + 1)
  }

  const files = previewData?.files ?? []
  const shown = files.slice(0, 80)

  return (
    <div className="modal">
      <div className="modal__scrim" onClick={() => !restoring && onClose()} />
      <div
        className="modal__dlg ckpt"
        role="dialog"
        aria-modal="true"
        aria-label={t('checkpoint.title')}
      >
        <div className="modal__h">
          <span className="modal__badge">
            <IconClock width={12} height={12} />
          </span>
          <span className="modal__t">{t('checkpoint.title')}</span>
          <button
            className="iconbtn iconbtn--sm ckpt__close"
            onClick={onClose}
            disabled={restoring}
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            <IconX width={14} height={14} />
          </button>
        </div>

        <div className="modal__b ckpt__body">
          <p className="ckpt__sub">{t('checkpoint.subtitle')}</p>

          {busy && (
            <div className="ckpt__warn">
              <IconAlert width={14} height={14} />
              <span>{t('checkpoint.busy')}</span>
            </div>
          )}

          {result && (
            <div className="ckpt__ok">
              <IconCheck width={14} height={14} />
              <span>
                {t('checkpoint.restored', {
                  restored: result.restored,
                  deleted: result.deleted
                })}
              </span>
            </div>
          )}

          {loadError && <div className="ckpt__error">{loadError}</div>}

          {items === null ? (
            <div className="ckpt__empty">{t('common.loading')}</div>
          ) : items.length === 0 ? (
            <div className="ckpt__empty">
              <p>{t('checkpoint.empty')}</p>
              <p className="ckpt__hint">{t('checkpoint.emptyHint')}</p>
            </div>
          ) : (
            <ul className="ckpt__list">
              {items.map((c) => {
                const active = selected === c.id
                return (
                  <li key={c.id}>
                    <button
                      className={`ckpt__row${active ? ' is-active' : ''}`}
                      onClick={() => void pick(c.id)}
                      disabled={restoring}
                    >
                      <span className="ckpt__mark">
                        <IconClock width={14} height={14} />
                      </span>
                      <span className="ckpt__main">
                        <span className="ckpt__line">
                          <b>
                            {c.kind === 'restore-backup'
                              ? t('checkpoint.backup')
                              : t('checkpoint.turn', { n: c.turn })}
                          </b>
                          <span className="ckpt__time">
                            {formatRelativeTime(c.at, locale, 'ago')}
                          </span>
                        </span>
                        <span className="ckpt__prompt">
                          {c.prompt ||
                            (c.kind === 'restore-backup'
                              ? t('checkpoint.backup')
                              : t('checkpoint.autoTurn'))}
                        </span>
                      </span>
                      <IconChevronRight width={13} height={13} />
                    </button>

                    {active && (
                      <div className="ckpt__preview">
                        {previewing ? (
                          <div className="ckpt__hint">{t('common.loading')}</div>
                        ) : actionError ? (
                          <div className="ckpt__error">{actionError}</div>
                        ) : previewData ? (
                          previewData.files.length === 0 ? (
                            <div className="ckpt__hint">{t('checkpoint.noChanges')}</div>
                          ) : (
                            <>
                              <div className="ckpt__count">
                                {tn('checkpoint.preview', previewData.total)}
                              </div>
                              <ul className="ckpt__files">
                                {shown.map((f) => (
                                  <CheckpointFileRow key={`${f.status}:${f.path}`} file={f} />
                                ))}
                              </ul>
                              {previewData.total > shown.length && (
                                <div className="ckpt__hint">
                                  {tn('checkpoint.more', previewData.total - shown.length)}
                                </div>
                              )}

                              {confirming ? (
                                <div className="ckpt__confirm">
                                  <div className="ckpt__confirm-text">
                                    <b>{t('checkpoint.confirmTitle')}</b>
                                    <p>{t('checkpoint.confirmBody')}</p>
                                  </div>
                                  <div className="ckpt__actions">
                                    <button
                                      className="btn"
                                      onClick={() => setConfirming(false)}
                                      disabled={restoring}
                                    >
                                      {t('common.cancel')}
                                    </button>
                                    <button
                                      className="btn btn--danger"
                                      onClick={() => void doRestore()}
                                      disabled={restoring || busy}
                                    >
                                      {restoring
                                        ? t('checkpoint.restoring')
                                        : t('checkpoint.confirmRestore')}
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <div className="ckpt__actions">
                                  <button
                                    className="btn btn--primary"
                                    onClick={() => setConfirming(true)}
                                    disabled={restoring || busy}
                                  >
                                    {t('checkpoint.restore')}
                                  </button>
                                </div>
                              )}
                            </>
                          )
                        ) : null}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="modal__f">
          <span className="modal__sp" />
          <button className="btn" onClick={onClose} disabled={restoring}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 一条文件差异：状态只描述「恢复会做什么」，不是 Git 的 XY */
function CheckpointFileRow({ file }: { file: CheckpointFileChange }): JSX.Element {
  const { t } = useI18n()
  const label =
    file.status === 'added'
      ? t('checkpoint.file.added')
      : file.status === 'deleted'
        ? t('checkpoint.file.deleted')
        : t('checkpoint.file.modified')
  return (
    <li className={`ckpt__file is-${file.status}`}>
      <span className="ckpt__status">{label}</span>
      <span className="ckpt__path" title={file.path}>
        {file.path}
      </span>
    </li>
  )
}
