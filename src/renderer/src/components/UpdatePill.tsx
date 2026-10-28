import { useEffect, useRef, useState } from 'react'
import type { UpdateInstallResult, UpdateState } from '@shared/update'
import { IconDownload } from './Icons'
import { useI18n } from '../i18n'

/**
 * 标题栏里的更新入口。
 *
 * 更新是低频事件，不该常驻占一块主区。这里只留一枚 22px 高的胶囊：
 * 有新版时是版本号 + 圆点，下载中是百分比 + 细进度，装好变成高亮的
 * 「重启并安装」。详情面板只在用户点开时才出现 —— 不主动压内容。
 *
 * 状态、下载、安装都在主进程；这里只做展示和两个动作。
 */
export function UpdatePill({
  state,
  onDownload,
  onInstall
}: {
  state: UpdateState | null
  onDownload(): void
  onInstall(): Promise<UpdateInstallResult>
}): JSX.Element | null {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // 换版本时收起面板；换阶段只清安装态，让「下载」点下去后面板能继续显示进度
  useEffect(() => {
    setOpen(false)
  }, [state?.version])

  useEffect(() => {
    setInstalling(false)
    setInstallError(null)
  }, [state?.version, state?.phase])

  // 点面板外面或按 Esc 收起
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!state) return null

  const { phase } = state
  const visible =
    phase === 'available' ||
    phase === 'downloading' ||
    phase === 'downloaded' ||
    (phase === 'error' && state.errorScope === 'download')

  if (!visible) return null

  const version = state.version ? `v${state.version}` : t('update.newVersion')
  const percent = Math.round(state.percent ?? 0)
  const downloadingTitle =
    state.downloadMode === 'differential'
      ? t('update.downloadingDifferential', { version })
      : state.downloadMode === 'full'
        ? t('update.downloadingFull', { version })
        : t('update.downloading', { version })
  const downloadingPercent =
    state.downloadMode === 'differential'
      ? t('update.differentialPercent', { percent })
      : state.downloadMode === 'full'
        ? t('update.fullPercent', { percent })
        : t('update.downloadingPercent', { percent })

  const title =
    phase === 'available'
      ? t('update.available', { version })
      : phase === 'downloading'
        ? downloadingTitle
        : phase === 'downloaded'
          ? t('update.downloaded', { version })
          : t('update.downloadFailed')

  const install = async (): Promise<void> => {
    setInstalling(true)
    setInstallError(null)
    const r = await onInstall()
    if (!r.ok) {
      setInstalling(false)
      setInstallError(r.message ?? t('update.installFailed'))
    }
    // 成功时应用会立刻退出，不需要再改状态
  }

  return (
    <div className="updpill-wrap" ref={rootRef} aria-live="polite">
      <button
        className={`updpill${phase === 'downloaded' ? ' is-ready' : ''}${
          phase === 'error' ? ' is-error' : ''
        }`}
        onClick={() => setOpen((v) => !v)}
        title={title}
        aria-expanded={open}
      >
        <IconDownload width={11} height={11} />
        {phase === 'available' && (
          <>
            <span>{state.version ? `${t('update.newVersion')} ${version}` : t('update.newVersion')}</span>
            <span className="updpill__dot" />
          </>
        )}
        {phase === 'downloading' && (
          <>
            <span className="updpill__pct">{percent}%</span>
            <span className="updpill__bar">
              <span style={{ width: `${percent}%` }} />
            </span>
          </>
        )}
        {phase === 'downloaded' && <span>{t('update.install')}</span>}
        {phase === 'error' && <span>{t('update.downloadFailed')}</span>}
      </button>

      {open && (
        <div className="updpanel" role="dialog" aria-label={title}>
          <div className="updpanel__head">
            <span className="updpanel__mark">
              <IconDownload width={12} height={12} />
            </span>
            <span className="updpanel__title">{title}</span>
            <button
              className="updpanel__x"
              onClick={() => setOpen(false)}
              title={t('common.close')}
              aria-label={t('common.close')}
            >
              ×
            </button>
          </div>

          {phase === 'available' && (
            <>
              {state.releaseName && <p className="updpanel__sub">{state.releaseName}</p>}
              <p className="updpanel__hint">{t('update.hint')}</p>
              <div className="updpanel__acts">
                <button className="btn btn--primary btn--xs" onClick={onDownload}>
                  <IconDownload width={12} height={12} />
                  {t('update.download')}
                </button>
                <button className="btn btn--ghost btn--xs" onClick={() => setOpen(false)}>
                  {t('update.later')}
                </button>
              </div>
            </>
          )}

          {phase === 'downloading' && (
            <>
              <div className="updpill__bar updpanel__bar">
                <span style={{ width: `${percent}%` }} />
              </div>
              <p className="updpanel__hint">{downloadingPercent}</p>
            </>
          )}

          {phase === 'downloaded' && (
            <>
              <p className="updpanel__hint">{t('update.readyHint')}</p>
              {installError && <p className="updpanel__err">{installError}</p>}
              <div className="updpanel__acts">
                <button
                  className="btn btn--primary btn--xs"
                  onClick={() => void install()}
                  disabled={installing}
                >
                  {installing ? t('update.installing') : t('update.install')}
                </button>
                <button
                  className="btn btn--ghost btn--xs"
                  onClick={() => setOpen(false)}
                  disabled={installing}
                >
                  {t('update.later')}
                </button>
              </div>
            </>
          )}

          {phase === 'error' && (
            <>
              <p className="updpanel__err">{state.error || t('update.errorFallback')}</p>
              <div className="updpanel__acts">
                <button className="btn btn--primary btn--xs" onClick={onDownload}>
                  {t('update.retry')}
                </button>
                <button className="btn btn--ghost btn--xs" onClick={() => setOpen(false)}>
                  {t('update.close')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
