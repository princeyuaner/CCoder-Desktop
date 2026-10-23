import { useState } from 'react'
import type { CodexStatus } from '@shared/codex'
import { useI18n } from '../i18n'

interface Props {
  status: CodexStatus | null
  loading: boolean
  error: string | null
  onRefresh: () => void
  /** 当前渠道已经填了 API Key —— 有它就不依赖 ChatGPT 登录 */
  hasChannelKey: boolean
}

/**
 * Codex 页顶部的安装 / 登录状态。
 *
 * 特意把「装没装」和「登没登录」分开：装好了但没登录时，渠道 API Key
 * 仍然能用；反过来，登录了也可以走渠道。两者都不是对方的必要条件。
 */
export function CodexStatusPanel({
  status,
  loading,
  error,
  onRefresh,
  hasChannelKey
}: Props): JSX.Element {
  const { t } = useI18n()
  if (loading && !status) {
    return (
      <div className="statuscard statuscard--muted">
        <div className="statuscard__icon">
          <span className="spinner" />
        </div>
        <div className="statuscard__main">
          <div className="statuscard__title">{t('codex.checking')}</div>
          <div className="statuscard__meta">{t('codex.checkingMeta')}</div>
        </div>
      </div>
    )
  }

  if (error && !status) {
    return (
      <div className="statuscard statuscard--bad">
        <div className="statuscard__icon">!</div>
        <div className="statuscard__main">
          <div className="statuscard__title">{t('codex.failed')}</div>
          <div className="statuscard__meta">{error}</div>
        </div>
        <div className="statuscard__actions">
          <button className="btn btn--ghost btn--xs" onClick={onRefresh}>
            {t('codex.recheck')}
          </button>
        </div>
      </div>
    )
  }

  const installed = status?.installed === true
  const appServerOk = status?.appServerOk === true

  return (
    <>
      <div className={`statuscard ${installed ? '' : 'statuscard--bad'}`}>
        <div className={`statuscard__icon ${installed ? 'statuscard__icon--ok' : 'statuscard__icon--bad'}`}>
          {installed ? <IconCheck width={18} height={18} /> : '!'}
        </div>
        <div className="statuscard__main">
          <div className="statuscard__title">
            Codex CLI{' '}
            <span className={`badge ${installed ? 'badge--ok' : 'badge--bad'}`}>
              {installed ? t('codex.installed') : t('codex.notInstalled')}
            </span>
          </div>
          <div className="statuscard__meta">
            {installed ? (
              <>
                <code>{status?.version || t('codex.versionUnknown')}</code>
                {' · '}
                <span className="statuscard__path">{status?.path}</span>
                {' · '}
                {appServerOk ? t('codex.appServerOk') : t('codex.appServerBad')}
              </>
            ) : (
              <>
                {t('codex.notInstalledHint')}
                {status?.path && (
                  <>
                    {' '}
                    {t('codex.tried')}<span className="statuscard__path">{status.path}</span>
                  </>
                )}
              </>
            )}
          </div>
          {status?.error && installed && !appServerOk && (
            <pre className="statuscard__error">{status.error}</pre>
          )}
        </div>
        <div className="statuscard__actions">
          <button
            className="btn btn--ghost btn--xs"
            onClick={onRefresh}
            disabled={loading}
          >
            {loading ? t('codex.detecting') : t('codex.recheck')}
          </button>
        </div>
      </div>

      {installed && (
        <AccountCard status={status} hasChannelKey={hasChannelKey} />
      )}

      {!installed && <InstallGuide />}
    </>
  )
}

function AccountCard({
  status,
  hasChannelKey
}: {
  status: CodexStatus | null
  hasChannelKey: boolean
}): JSX.Element {
  const { t } = useI18n()
  if (hasChannelKey) {
    return (
      <div className="statuscard">
        <div className="statuscard__icon statuscard__icon--ok">
          <IconKey width={17} height={17} />
        </div>
        <div className="statuscard__main">
          <div className="statuscard__title">
            {t('codex.channelKey')} <span className="badge badge--ok">{t('codex.channelKeyConfigured')}</span>
          </div>
          <div className="statuscard__meta">
            {t('codex.channelKeyBody')}
          </div>
        </div>
      </div>
    )
  }

  const acc = status?.account ?? null
  if (acc?.kind === 'chatgpt') {
    return (
      <div className="statuscard">
        <div className="statuscard__icon statuscard__icon--ok">
          <IconUser width={17} height={17} />
        </div>
        <div className="statuscard__main">
          <div className="statuscard__title">
            {t('codex.account')} <span className="badge badge--ok">{t('auth.loggedIn')}</span>
          </div>
          <div className="statuscard__meta">
            ChatGPT{acc.plan ? ` ${acc.plan}` : ''}
            {acc.email ? ` · ${acc.email}` : ''}
            {t('codex.sharedHome')}
          </div>
        </div>
      </div>
    )
  }

  if (acc?.kind === 'apiKey') {
    return (
      <div className="statuscard">
        <div className="statuscard__icon statuscard__icon--ok">
          <IconKey width={17} height={17} />
        </div>
        <div className="statuscard__main">
          <div className="statuscard__title">
            {t('codex.account')} <span className="badge badge--ok">API Key</span>
          </div>
          <div className="statuscard__meta">{t('codex.apiKeyBody')}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="statuscard">
      <div className="statuscard__icon">
        <IconUser width={17} height={17} />
      </div>
      <div className="statuscard__main">
        <div className="statuscard__title">
          {t('codex.account')} <span className="badge">{t('codex.notLoggedIn')}</span>
        </div>
        <div className="statuscard__meta">
          {t('codex.loginHint')}
        </div>
      </div>
      <div className="statuscard__actions">
        <button
          className="btn btn--ghost btn--xs"
          onClick={() => void copyText('codex login')}
        >
          {t('codex.copyLogin')}
        </button>
      </div>
    </div>
  )
}

type OsKey = 'windows' | 'macos' | 'linux'

const INSTALL: Record<OsKey, { label: string; command: string }> = {
  windows: {
    label: 'Windows',
    command: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"'
  },
  macos: {
    label: 'macOS',
    command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'
  },
  linux: {
    label: 'Linux',
    command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'
  }
}

const NPM_COMMAND = 'npm install -g @openai/codex'

function InstallGuide(): JSX.Element {
  const { t } = useI18n()
  const platform =
    typeof window !== 'undefined' && window.api?.platform ? window.api.platform : 'win32'
  const [os, setOs] = useState<OsKey>(
    platform === 'darwin' ? 'macos' : platform === 'linux' ? 'linux' : 'windows'
  )
  const [copied, setCopied] = useState('')

  const copy = async (text: string, key: string): Promise<void> => {
    await copyText(text)
    setCopied(key)
    window.setTimeout(() => setCopied(''), 1600)
  }

  return (
    <section className="installguide">
      <h2 className="installguide__title">{t('codex.installTitle')}</h2>
      <p className="installguide__lead">
        {t('codex.installBody')}
      </p>

      <div className="ostabs" role="tablist">
        {(Object.keys(INSTALL) as OsKey[]).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={os === k}
            className={`ostab ${os === k ? 'is-on' : ''}`}
            onClick={() => setOs(k)}
          >
            {INSTALL[k].label}
          </button>
        ))}
      </div>

      <div className="cmdbox">
        <code className="cmdbox__line">{INSTALL[os].command}</code>
        <button
          type="button"
          className="btn btn--ghost btn--xs"
          onClick={() => void copy(INSTALL[os].command, 'install')}
        >
          {copied === 'install' ? t('codex.copied') : t('codex.copy')}
        </button>
      </div>

      <div className="installguide__alt">
        <span>{t('codex.orNpm')}</span>
        <div className="cmdbox cmdbox--inline">
          <code className="cmdbox__line">{NPM_COMMAND}</code>
          <button
            type="button"
            className="btn btn--ghost btn--xs"
            onClick={() => void copy(NPM_COMMAND, 'npm')}
          >
            {copied === 'npm' ? t('codex.copied') : t('codex.copy')}
          </button>
        </div>
      </div>

      <ol className="installguide__steps">
        <li>{t('codex.step1')}</li>
        <li>{t('codex.step2')}</li>
        <li>
          {t('codex.loginStep')}
        </li>
      </ol>
    </section>
  )
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // 剪贴板不可用（权限/非安全上下文）时静默失败，用户仍可手动选中复制
  }
}

/* 几个小图标：和设置页其它图标一样 inline SVG，不引第三方图标库 */

function IconCheck(props: { width: number; height: number }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="m3 8.4 3.1 3.1L13 4.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconKey(props: { width: number; height: number }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <circle cx="5.2" cy="8" r="2.6" />
      <path d="M7.8 8H14M11.4 8v2.2M13 8v1.5" strokeLinecap="round" />
    </svg>
  )
}

function IconUser(props: { width: number; height: number }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <circle cx="8" cy="5.4" r="2.7" />
      <path d="M2.8 13.2c.6-2.4 2.6-3.7 5.2-3.7s4.6 1.3 5.2 3.7" strokeLinecap="round" />
    </svg>
  )
}
