import { useState } from 'react'
import type { DshStatus } from '@shared/dsh'
import type { CliAuthMode } from '@shared/settings'
import { useI18n } from '../i18n'

interface Props {
  status: DshStatus | null
  loading: boolean
  error: string | null
  onRefresh: () => void
  authMode: CliAuthMode
  onAuthMode: (m: CliAuthMode) => void
  officialModel: string
  onOfficialModel: (v: string) => void
  /** 当前渠道已经填了 API Key —— 有它就不依赖 DSH_HOME 里的凭据 */
  hasChannelKey: boolean
}

/**
 * DeepSeek Harness 页顶部的安装 / 运行时状态。
 *
 * dsh 和 Claude/Codex 最大的不同：它的凭据可以完全不经过我们 ——
 * 用户在终端里跑过 dsh、在 `~/.dsh/.credentials.yaml` 里配过 key，
 * 我们只要把 DSH_HOME 指对就能直接用。所以这里把「Harness 凭据」和
 * 「API 渠道」并列成两种凭据来源，而不是强迫用户再抄一份 key。
 */
export function DshStatusPanel({
  status,
  loading,
  error,
  onRefresh,
  authMode,
  onAuthMode,
  officialModel,
  onOfficialModel,
  hasChannelKey
}: Props): JSX.Element {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)

  if (loading && !status) {
    return (
      <div className="statuscard statuscard--muted">
        <div className="statuscard__icon">
          <span className="spinner" />
        </div>
        <div className="statuscard__main">
          <div className="statuscard__title">{t('dsh.checking')}</div>
          <div className="statuscard__meta">{t('dsh.checkingMeta')}</div>
        </div>
      </div>
    )
  }

  if (error && !status) {
    return (
      <div className="statuscard statuscard--bad">
        <div className="statuscard__icon">!</div>
        <div className="statuscard__main">
          <div className="statuscard__title">{t('dsh.failed')}</div>
          <div className="statuscard__meta">{error}</div>
        </div>
        <div className="statuscard__actions">
          <button className="btn btn--ghost btn--xs" onClick={onRefresh}>
            {t('dsh.recheck')}
          </button>
        </div>
      </div>
    )
  }

  const installed = status?.installed === true
  const nodeOk = status?.nodeOk === true

  return (
    <>
      <div className={`statuscard ${installed && nodeOk ? '' : 'statuscard--bad'}`}>
        <div
          className={`statuscard__icon ${
            installed && nodeOk ? 'statuscard__icon--ok' : 'statuscard__icon--bad'
          }`}
        >
          {installed && nodeOk ? <IconCheck width={18} height={18} /> : '!'}
        </div>
        <div className="statuscard__main">
          <div className="statuscard__title">
            DeepSeek Harness{' '}
            <span className={`badge ${installed && nodeOk ? 'badge--ok' : 'badge--bad'}`}>
              {installed ? (nodeOk ? t('dsh.installed') : t('dsh.nodeBad')) : t('dsh.notInstalled')}
            </span>
          </div>
          <div className="statuscard__meta">
            {installed ? (
              <>
                <code>{status?.version || t('dsh.versionUnknown')}</code>
                {' · '}
                <span className="statuscard__path">{status?.path}</span>
              </>
            ) : (
              <>
                {t('dsh.notInstalledHint')}
                {status?.path && (
                  <>
                    {' '}
                    {t('dsh.tried')}
                    <span className="statuscard__path">{status.path}</span>
                  </>
                )}
              </>
            )}
          </div>
          {status?.home && (
            <div className="statuscard__meta">
              {t('dsh.home')} <span className="statuscard__path">{status.home}</span>
            </div>
          )}
          {status?.node && (
            <div className="statuscard__meta">
              {t('dsh.node')} <span className="statuscard__path">{status.node}</span>
            </div>
          )}
          {status?.error && <pre className="statuscard__error">{status.error}</pre>}
        </div>
        <div className="statuscard__actions">
          <button className="btn btn--ghost btn--xs" onClick={onRefresh} disabled={loading}>
            {loading ? t('dsh.detecting') : t('dsh.recheck')}
          </button>
        </div>
      </div>

      {installed && nodeOk && (
        <section className="chform chform--sep">
          <h2 className="chform__title">{t('dsh.credentialsTitle')}</h2>
          {/* 和 Claude 官方登录页同一套 authpick 卡片：标题 + 一句说明，
              而不是「思考深度」那种紧凑分段按钮 —— 两个 CLI 的设置页要长得一样 */}
          <div className="authpick">
            <button
              className={`authpick__it ${authMode === 'official' ? 'is-on' : ''}`}
              onClick={() => onAuthMode('official')}
            >
              <span className="authpick__t">{t('dsh.harnessCredentials')}</span>
              <span className="authpick__d">
                {t('dsh.harnessCredentialsBody', { home: status?.sharedHome || status?.home || '' })}
              </span>
            </button>
            <button
              className={`authpick__it ${authMode === 'channel' ? 'is-on' : ''}`}
              onClick={() => onAuthMode('channel')}
            >
              <span className="authpick__t">{t('dsh.channelCredentials')}</span>
              <span className="authpick__d">
                {hasChannelKey
                  ? t('dsh.channelCredentialsBody')
                  : t('dsh.channelCredentialsEmpty')}
              </span>
            </button>
          </div>

          {authMode === 'official' && (
            <div className="field">
              <label className="field__label">{t('dsh.officialModel')}</label>
              <div className="field__body">
                <input
                  className="input"
                  value={officialModel}
                  onChange={(e) => onOfficialModel(e.target.value)}
                  placeholder="deepseek-v4.1-flash"
                />
                <p className="field__hint">{t('dsh.officialModelHint')}</p>
              </div>
            </div>
          )}
        </section>
      )}

      {!installed && (
        <section className="installguide">
          <h2 className="installguide__title">{t('dsh.installTitle')}</h2>
          <p className="installguide__lead">{t('dsh.installBody')}</p>
          <div className="cmdbox">
            <code className="cmdbox__line">npm install -g @deepseek-ai/dsh</code>
            <button
              type="button"
              className="btn btn--ghost btn--xs"
              onClick={() => void copyText('npm install -g @deepseek-ai/dsh', setCopied)}
            >
              {copied ? t('dsh.copied') : t('dsh.copy')}
            </button>
          </div>
          <p className="installguide__lead">{t('dsh.installNode')}</p>
          <ol className="installguide__steps">
            <li>{t('dsh.step1')}</li>
            <li>{t('dsh.step2')}</li>
          </ol>
        </section>
      )}

      {installed && !nodeOk && (
        <section className="installguide">
          <h2 className="installguide__title">{t('dsh.nodeBadTitle')}</h2>
          <p className="installguide__lead">{t('dsh.nodeBadBody')}</p>
        </section>
      )}
    </>
  )
}

async function copyText(text: string, setCopied: (v: boolean) => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  } catch {
    // 剪贴板不可用时静默失败，用户仍可手动选中复制
  }
}

function IconCheck(props: { width: number; height: number }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="m3 8.4 3.1 3.1L13 4.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
