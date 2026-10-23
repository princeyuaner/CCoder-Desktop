import { useState } from 'react'
import type { CliAuthMode } from '@shared/settings'
import type { ClaudeAuthApi } from '../useClaudeAuth'

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
          <div className="statuscard__title">正在检测 Claude Code…</div>
          <div className="statuscard__meta">检查可执行文件与官方登录状态</div>
        </div>
      </div>
    )
  } else if (!status && auth.error) {
    card = (
      <div className="statuscard statuscard--bad">
        <div className="statuscard__icon">!</div>
        <div className="statuscard__main">
          <div className="statuscard__title">检测失败</div>
          <div className="statuscard__meta">{auth.error}</div>
        </div>
        <div className="statuscard__actions">
          <button className="btn btn--ghost btn--xs" onClick={() => void auth.refresh()}>
            重新检测
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
            Claude Code <span className="badge badge--bad">未安装</span>
          </div>
          <div className="statuscard__meta">
            没有找到 <code>claude</code>。安装后即可使用官方登录：
            <code className="authcmd">{INSTALL_COMMAND}</code>
            {status?.path && (
              <>
                {' '}
                尝试过：<span className="statuscard__path">{status.path}</span>
              </>
            )}
          </div>
        </div>
        <div className="statuscard__actions">
          <button
            className="btn btn--ghost btn--xs"
            onClick={() => void copy(INSTALL_COMMAND, 'install')}
          >
            {copied === 'install' ? '已复制' : '复制安装命令'}
          </button>
          <button className="btn btn--ghost btn--xs" onClick={() => void auth.refresh()}>
            重新检测
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
            Claude Code <span className="badge badge--ok">已安装</span>
          </div>
          <div className="statuscard__meta">
            <code>{status.version || '版本未知'}</code>
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
            {auth.loading ? '检测中…' : '重新检测'}
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
              官方账号{' '}
              {loggedIn ? (
                <span className="badge badge--ok">已登录</span>
              ) : (
                <span className="badge">未登录</span>
              )}
            </div>
            <div className="statuscard__meta">
              {loggedIn
                ? identity || '已通过 Claude Code CLI 登录'
                : '使用官方账号需要先在 Claude Code 里登录；也可以继续使用 API 渠道。'}
              {loggedIn && method && (
                <>
                  {' · '}
                  <span className="authmeta">{method}</span>
                </>
              )}
            </div>
            {authMode === 'official' && !loggedIn && (
              <p className="authwarn">
                当前是「官方登录」模式，但还没登录 —— 新建会话的请求可能会失败。
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
                    确认退出
                  </button>
                  <button
                    className="btn btn--ghost btn--xs"
                    onClick={() => setConfirmLogout(false)}
                  >
                    取消
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
                  退出登录
                </button>
              )
            ) : (
              <button
                className="btn btn--ghost btn--xs"
                onClick={() => void auth.startLogin()}
                disabled={auth.busy}
              >
                {auth.busy ? '登录中…' : '登录官方账号'}
              </button>
            )}
          </div>
        </div>
      )}

      {confirmLogout && runningSessions > 0 && (
        <p className="authwarn authwarn--block">
          当前有 {runningSessions} 条会话在运行。退出登录不会停止它们，但它们的下一轮
          请求可能因为凭据失效而失败。
        </p>
      )}

      {/* ── 登录流程 ─────────────────────────────────── */}
      {auth.phase !== 'idle' && auth.phase !== 'success' && (
        <section className="authflow">
          <div className="authflow__head">
            <span className={`authflow__state is-${auth.phase}`}>
              {auth.phase === 'starting' && '正在启动登录…'}
              {auth.phase === 'waiting' && '等待授权码'}
              {auth.phase === 'verifying' && '正在验证授权码…'}
              {auth.phase === 'failed' && '登录失败'}
              {auth.phase === 'cancelled' && '已取消'}
            </span>
            {auth.busy && (
              <button className="btn btn--ghost btn--xs" onClick={() => void auth.cancelLogin()}>
                取消登录
              </button>
            )}
          </div>

          {auth.message && <p className="authwarn">{auth.message}</p>}

          {auth.url && (
            <div className="authurlrow">
              <span className="authurlrow__label">授权链接</span>
              <code className="authurl" title={auth.url}>
                {auth.url}
              </code>
              <div className="authurlrow__acts">
                <button
                  className="btn btn--ghost btn--xs"
                  onClick={() => void copy(auth.url ?? '', 'url')}
                >
                  {copied === 'url' ? '已复制' : '复制链接'}
                </button>
                <button
                  className="btn btn--ghost btn--xs"
                  onClick={() => window.open(auth.url ?? '', '_blank')}
                >
                  打开浏览器
                </button>
              </div>
            </div>
          )}

          {auth.busy && (
            <div className="authcoderow">
              <input
                className="input"
                placeholder="把浏览器里显示的授权码粘贴到这里"
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
                提交授权码
              </button>
            </div>
          )}

          <p className="authnote">
            授权码只用于本次登录，不会写入设置文件；登录由 Claude Code CLI 自己完成。
          </p>

          {auth.output && (
            <div className="authlogwrap">
              <button className="authlogtoggle" onClick={() => setShowLog((v) => !v)}>
                {showLog ? '收起 CLI 输出' : '查看 CLI 输出'}
              </button>
              {showLog && <pre className="authlog">{auth.output}</pre>}
            </div>
          )}
        </section>
      )}

      {/* ── 凭据来源 ─────────────────────────────────── */}
      <section className="chform chform--sep">
        <h2 className="chform__title">凭据来源</h2>
        <div className="authpick">
          <button
            className={`authpick__it ${authMode === 'official' ? 'is-on' : ''}`}
            onClick={() => onAuthMode('official')}
          >
            <span className="authpick__t">官方登录</span>
            <span className="authpick__d">
              用 CLI 保存的 OAuth 凭据；不注入渠道变量，也不加载
              ~/.claude/settings.json 里的用户级配置（避免全局中转 env 覆盖登录）。
            </span>
          </button>
          <button
            className={`authpick__it ${authMode === 'channel' ? 'is-on' : ''}`}
            onClick={() => onAuthMode('channel')}
          >
            <span className="authpick__t">API 渠道</span>
            <span className="authpick__d">用下方渠道的 Base URL 与密钥（中转端点也走这里）。</span>
          </button>
        </div>

        {authMode === 'official' && (
          <div className="field">
            <label className="field__label">默认模型</label>
            <div className="field__body">
              <input
                className="input"
                placeholder="留空 = 由 CLI 决定"
                value={officialModel}
                onChange={(e) => onOfficialModel(e.target.value)}
                spellCheck={false}
              />
              <p className="field__hint">
                官方登录模式下新会话使用的模型，如 <code>sonnet</code> / <code>opus</code> /{' '}
                <code>haiku</code>；留空则用 CLI 的默认模型。渠道配置会保留，切回 API
                渠道即可继续使用。
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
