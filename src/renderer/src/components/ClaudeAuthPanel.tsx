import { useState } from 'react'
import type { CliAuthMode } from '@shared/settings'
import type { ClaudeAuthApi } from '../useClaudeAuth'
import { useI18n } from '../i18n'

const INSTALL_COMMAND = 'npm install -g @anthropic-ai/claude-code'

interface Props {
  auth: ClaudeAuthApi
  authMode: CliAuthMode
  officialModel: string
  /** 当前有多少条会话在跑 —— 退出登录前提醒一下 */
  runningSessions: number
  onAuthMode(mode: CliAuthMode): void
  onOfficialModel(v: string): void
}

/**
 * Claude Code 官方登录面板。
 *
 * 和 Codex 的状态卡不同，这里多了「应用内登录」：CLI 会打印授权 URL，
 * 用户在浏览器里完成后把授权码粘回来。登录进程归主进程所有，这个面板
 * 只是它的一层视图。
 */
export function ClaudeAuthPanel({
  auth,
  authMode,
  officialModel,
  runningSessions,
  onAuthMode,
  onOfficialModel
}: Props): JSX.Element {
  const { t } = useI18n()
  const [code, setCode] = useState('')
  const [showLog, setShowLog] = useState(false)
  const [confirmLogout, setConfirmLogout] = useState(false)
  const [copied, setCopied] = useState('')

  const status = auth.status
  const installed = status?.installed === true
  const loggedIn = status?.loggedIn === true

  const copy = async (text: string, key: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      window.setTimeout(() => setCopied(''), 1600)
    } catch {
      // 剪贴板不可用时用户还能手动选中复制
    }
  }

  const submit = async (): Promise<void> => {
    const r = await auth.submitCode(code)
    if (r.ok) setCode('')
  }

  /* ── 安装 / 版本 ────────────────────────────────────── */

  let card: JSX.Element
  if (auth.loading && !status) {
    card = (
      <div className="statuscard statuscard--muted">
        <div className="statuscard__icon">
          <span className="spinner" />
        </div>
        <div className="statuscard__main">
          <div className="statuscard__title">{t('auth.checking')}</div>
          <div className="statuscard__meta">{t('auth.checkingMeta')}</div>
        </div>
      </div>
    )
  } else if (!status && auth.error) {
    card = (
      <div className="statuscard statuscard--bad">
        <div className="statuscard__icon">!</div>
        <div className="statuscard__main">
          <div className="statuscard__title">{t('auth.failed')}</div>
          <div className="statuscard__meta">{auth.error}</div>
        </div>
        <div className="statuscard__actions">
          <button className="btn btn--ghost btn--xs" onClick={() => void auth.refresh()}>
            {t('auth.recheck')}
          </button>
        </div>
      </div>
    )
  } else if (!installed) {
    card = (
      <div className="statuscard statuscard--bad">
        <div className="statuscard__icon statuscard__icon--bad">!</div>
        <div className="statuscard__main">
          <div className="statuscard__title">
            Claude Code <span className="badge badge--bad">{t('auth.notInstalled')}</span>
          </div>
          <div className="statuscard__meta">
            {t('auth.notInstalledHint')}
            <code className="authcmd">{INSTALL_COMMAND}</code>
            {status?.path && (
              <>
                {' '}
                {t('auth.tried')}<span className="statuscard__path">{status.path}</span>
              </>
            )}
          </div>
        </div>
        <div className="statuscard__actions">
          <button
            className="btn btn--ghost btn--xs"
            onClick={() => void copy(INSTALL_COMMAND, 'install')}
          >
            {copied === 'install' ? t('auth.copied') : t('auth.copyInstall')}
          </button>
          <button className="btn btn--ghost btn--xs" onClick={() => void auth.refresh()}>
            {t('auth.recheck')}
          </button>
        </div>
      </div>
    )
  } else {
    card = (
      <div className="statuscard">
        <div className="statuscard__icon statuscard__icon--ok">
          <span className="authdot" />
        </div>
        <div className="statuscard__main">
          <div className="statuscard__title">
            Claude Code <span className="badge badge--ok">{t('auth.installed')}</span>
          </div>
          <div className="statuscard__meta">
            <code>{status.version || t('auth.versionUnknown')}</code>
            {' · '}
            <span className="statuscard__path">{status.path}</span>
          </div>
          {status.error && <pre className="statuscard__error">{status.error}</pre>}
        </div>
        <div className="statuscard__actions">
          <button
            className="btn btn--ghost btn--xs"
            onClick={() => void auth.refresh()}
            disabled={auth.loading}
          >
            {auth.loading ? t('auth.detecting') : t('auth.recheck')}
          </button>
        </div>
      </div>
    )
  }

  /* ── 登录状态 ──────────────────────────────────────── */

  const identity = status
    ? [status.email, status.organizationName, status.subscriptionType].filter(Boolean).join(' · ')
    : ''
  const method = status?.authMethod && status.authMethod !== 'none' ? status.authMethod : ''

  return (
    <div className="authpanel">
      {card}

      {installed && (
        <div className="statuscard">
          <div
            className={`statuscard__icon ${loggedIn ? 'statuscard__icon--ok' : ''}`}
          >
            {loggedIn ? '✓' : '◎'}
          </div>
          <div className="statuscard__main">
            <div className="statuscard__title">
              {t('auth.officialAccount')}{' '}
              {loggedIn ? (
                <span className="badge badge--ok">{t('auth.loggedIn')}</span>
              ) : (
                <span className="badge">{t('auth.notLoggedIn')}</span>
              )}
            </div>
            <div className="statuscard__meta">
              {loggedIn
                ? identity || t('auth.loggedInVia')
                : t('auth.officialNeedsLogin')}
              {loggedIn && method && (
                <>
                  {' · '}
                  <span className="authmeta">{method}</span>
                </>
              )}
            </div>
            {authMode === 'official' && !loggedIn && (
              <p className="authwarn">
                {t('auth.officialModeNotLoggedIn')}
              </p>
            )}
            {auth.error && <p className="authwarn">{auth.error}</p>}
          </div>
          <div className="statuscard__actions">
            {loggedIn ? (
              confirmLogout ? (
                <>
                  <button
                    className="btn btn--danger btn--xs"
                    onClick={() => {
                      setConfirmLogout(false)
                      void auth.logout()
                    }}
                  >
                    {t('auth.confirmLogout')}
                  </button>
                  <button
                    className="btn btn--ghost btn--xs"
                    onClick={() => setConfirmLogout(false)}
                  >
                    {t('auth.cancel')}
                  </button>
                </>
              ) : (
                <button
                  className="btn btn--ghost btn--xs"
                  onClick={() => {
                    if (runningSessions > 0) setConfirmLogout(true)
                    else void auth.logout()
                  }}
                  disabled={auth.busy}
                >
                  {t('auth.logout')}
                </button>
              )
            ) : (
              <button
                className="btn btn--ghost btn--xs"
                onClick={() => void auth.startLogin()}
                disabled={auth.busy}
              >
                {auth.busy ? t('auth.loggingIn') : t('auth.login')}
              </button>
            )}
          </div>
        </div>
      )}

      {confirmLogout && runningSessions > 0 && (
        <p className="authwarn authwarn--block">
          {t('auth.runningWarning', { n: runningSessions })}
        </p>
      )}

      {/* ── 登录流程 ─────────────────────────────────── */}
      {auth.phase !== 'idle' && auth.phase !== 'success' && (
        <section className="authflow">
          <div className="authflow__head">
            <span className={`authflow__state is-${auth.phase}`}>
              {auth.phase === 'starting' && t('auth.phase.starting')}
              {auth.phase === 'waiting' && t('auth.phase.waiting')}
              {auth.phase === 'verifying' && t('auth.phase.verifying')}
              {auth.phase === 'failed' && t('auth.phase.failed')}
              {auth.phase === 'cancelled' && t('auth.phase.cancelled')}
            </span>
            {auth.busy && (
              <button className="btn btn--ghost btn--xs" onClick={() => void auth.cancelLogin()}>
                {t('auth.cancelLogin')}
              </button>
            )}
          </div>

          {auth.message && <p className="authwarn">{auth.message}</p>}

          {auth.url && (
            <div className="authurlrow">
              <span className="authurlrow__label">{t('auth.urlLabel')}</span>
              <code className="authurl" title={auth.url}>
                {auth.url}
              </code>
              <div className="authurlrow__acts">
                <button
                  className="btn btn--ghost btn--xs"
                  onClick={() => void copy(auth.url ?? '', 'url')}
                >
                  {copied === 'url' ? t('auth.copied') : t('auth.copyUrl')}
                </button>
                <button
                  className="btn btn--ghost btn--xs"
                  onClick={() => window.open(auth.url ?? '', '_blank')}
                >
                  {t('auth.openBrowser')}
                </button>
              </div>
            </div>
          )}

          {auth.busy && (
            <div className="authcoderow">
              <input
                className="input"
                placeholder={t('auth.codePlaceholder')}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && code.trim()) void submit()
                }}
                spellCheck={false}
              />
              <button
                className="btn btn--primary btn--xs"
                onClick={() => void submit()}
                disabled={!code.trim() || auth.phase === 'verifying'}
              >
                {t('auth.submitCode')}
              </button>
            </div>
          )}

          <p className="authnote">
            {t('auth.codeNote')}
          </p>

          {auth.output && (
            <div className="authlogwrap">
              <button className="authlogtoggle" onClick={() => setShowLog((v) => !v)}>
                {showLog ? t('auth.hideLog') : t('auth.showLog')}
              </button>
              {showLog && <pre className="authlog">{auth.output}</pre>}
            </div>
          )}
        </section>
      )}

      {/* ── 凭据来源 ─────────────────────────────────── */}
      <section className="chform chform--sep">
        <h2 className="chform__title">{t('auth.sourceTitle')}</h2>
        <div className="authpick">
          <button
            className={`authpick__it ${authMode === 'official' ? 'is-on' : ''}`}
            onClick={() => onAuthMode('official')}
          >
            <span className="authpick__t">{t('auth.officialTitle')}</span>
            <span className="authpick__d">
              {t('auth.officialBody')}
            </span>
          </button>
          <button
            className={`authpick__it ${authMode === 'channel' ? 'is-on' : ''}`}
            onClick={() => onAuthMode('channel')}
          >
            <span className="authpick__t">{t('auth.channelTitle')}</span>
            <span className="authpick__d">{t('auth.channelBody')}</span>
          </button>
        </div>

        {authMode === 'official' && (
          <div className="field">
            <label className="field__label">{t('auth.officialModel')}</label>
            <div className="field__body">
              <input
                className="input"
                placeholder={t('auth.officialModelPlaceholder')}
                value={officialModel}
                onChange={(e) => onOfficialModel(e.target.value)}
                spellCheck={false}
              />
              <p className="field__hint">
                {t('auth.officialModelHint')}
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
