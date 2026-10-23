import { useEffect, useState } from 'react'
import type { UpdateInstallResult, UpdateState } from '@shared/update'
import { IconDownload } from './Icons'
import { useI18n } from '../i18n'

/**
 * 右下角的更新提醒。
 *
 * 只负责展示与两个动作：下载、重启安装。检查频率、下载、安装都在主进程，
 * 这里不做任何更新逻辑判断 —— 避免界面和主进程对「当前能做什么」各说各话。
 */
export function UpdateToast({
  state,
  onDownload,
  onInstall
}: {
  state: UpdateState | null
  onDownload(): void
  onInstall(): Promise<UpdateInstallResult>
}): JSX.Element | null {
  const { t } = useI18n()
  const [hidden, setHidden] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)

  // 换版本或换阶段时重新出现：用户点了「下载」之后必须能看到进度
  useEffect(() => {
    setHidden(false)
    setInstalling(false)
    setInstallError(null)
  }, [state?.version, state?.phase])

  if (!state) return null

  const { phase } = state
  const visible =
    phase === 'available' ||
    phase === 'downloading' ||
    phase === 'downloaded' ||
    (phase === 'error' && state.errorScope === 'download')

  if (!visible || hidden) return null

  const version = state.version ? `v${state.version}` : t('update.newVersion')
  const percent = Math.round(state.percent ?? 0)

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
    <aside className="updtoast" role="status" aria-live="polite">
      <div className="updtoast__head">
        <span className="updtoast__mark">
          <IconDownload width={14} height={14} />
        </span>
        <span className="updtoast__title">
          {phase === 'available' && t('update.available', { version })}
          {phase === 'downloading' && t('update.downloading', { version })}
          {phase === 'downloaded' && t('update.downloaded', { version })}
          {phase === 'error' && t('update.downloadFailed')}
        </span>
        {phase !== 'downloading' && (
          <button
            className="updtoast__x"
            onClick={() => setHidden(true)}
            title={t('update.laterTitle')}
            aria-label={t('common.close')}
          >
            ×
          </button>
        )}
      </div>

      {phase === 'available' && (
        <>
          {state.releaseName && <p className="updtoast__sub">{state.releaseName}</p>}
          <p className="updtoast__hint">{t('update.hint')}</p>
          <div className="updtoast__acts">
            <button className="btn btn--primary btn--xs" onClick={onDownload}>
              <IconDownload width={12} height={12} />
              {t('update.download')}
            </button>
            <button className="btn btn--ghost btn--xs" onClick={() => setHidden(true)}>
              {t('update.later')}
            </button>
          </div>
        </>
      )}

      {phase === 'downloading' && (
        <>
          <div className="updtoast__bar" aria-hidden="true">
            <span style={{ width: `${percent}%` }} />
          </div>
          <p className="updtoast__hint">
            {t('update.downloadingPercent', { percent })}
          </p>
        </>
      )}

      {phase === 'downloaded' && (
        <>
          <p className="updtoast__hint">{t('update.readyHint')}</p>
          {installError && <p className="updtoast__err">{installError}</p>}
          <div className="updtoast__acts">
            <button
              className="btn btn--primary btn--xs"
              onClick={() => void install()}
              disabled={installing}
            >
              {installing ? t('update.installing') : t('update.install')}
            </button>
            <button
              className="btn btn--ghost btn--xs"
              onClick={() => setHidden(true)}
              disabled={installing}
            >
              {t('update.later')}
            </button>
          </div>
        </>
      )}

      {phase === 'error' && (
        <>
          <p className="updtoast__err">
            {state.error || t('update.errorFallback')}
          </p>
          <div className="updtoast__acts">
            <button className="btn btn--primary btn--xs" onClick={onDownload}>
              {t('update.retry')}
            </button>
            <button className="btn btn--ghost btn--xs" onClick={() => setHidden(true)}>
              {t('update.close')}
            </button>
          </div>
        </>
      )}
    </aside>
  )
}
