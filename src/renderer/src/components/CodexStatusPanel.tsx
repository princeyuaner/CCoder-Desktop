import { useState } from 'react'
import type { CodexStatus } from '@shared/codex'

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
  if (loading && !status) {
    return (
      <div className="statuscard statuscard--muted">
        <div className="statuscard__icon">
          <span className="spinner" />
        </div>
        <div className="statuscard__main">
          <div className="statuscard__title">正在检测 Codex CLI…</div>
          <div className="statuscard__meta">检查可执行文件、app-server 与账号状态</div>
        </div>
      </div>
    )
  }

  if (error && !status) {
    return (
      <div className="statuscard statuscard--bad">
        <div className="statuscard__icon">!</div>
        <div className="statuscard__main">
          <div className="statuscard__title">检测失败</div>
          <div className="statuscard__meta">{error}</div>
        </div>
        <div className="statuscard__actions">
          <button className="btn btn--ghost btn--xs" onClick={onRefresh}>
            重新检测
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
              {installed ? '已安装' : '未安装'}
            </span>
          </div>
          <div className="statuscard__meta">
            {installed ? (
              <>
                <code>{status?.version || '版本未知'}</code>
                {' · '}
                <span className="statuscard__path">{status?.path}</span>
                {' · '}
                {appServerOk ? 'app-server 正常' : 'app-server 无法启动'}
              </>
            ) : (
              <>
                没有找到 <code>codex</code>。按下方步骤安装后即可使用。
                {status?.path && (
                  <>
                    {' '}
                    尝试过：<span className="statuscard__path">{status.path}</span>
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
            {loading ? '检测中…' : '重新检测'}
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
  if (hasChannelKey) {
    return (
      <div className="statuscard">
        <div className="statuscard__icon statuscard__icon--ok">
          <IconKey width={17} height={17} />
        </div>
        <div className="statuscard__main">
          <div className="statuscard__title">
            渠道凭据 <span className="badge badge--ok">已配置</span>
          </div>
          <div className="statuscard__meta">
            当前渠道填了 API Key，请求走这个端点，不需要 ChatGPT 登录。
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
            账号 <span className="badge badge--ok">已登录</span>
          </div>
          <div className="statuscard__meta">
            ChatGPT{acc.plan ? ` ${acc.plan}` : ''}
            {acc.email ? ` · ${acc.email}` : ''}
            {' · 与 Codex CLI / 插件共享 CODEX_HOME'}
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
            账号 <span className="badge badge--ok">API Key</span>
          </div>
          <div className="statuscard__meta">Codex 已保存 API Key；渠道里的凭据优先。</div>
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
          账号 <span className="badge">未登录</span>
        </div>
        <div className="statuscard__meta">
          在终端运行 <code>codex login</code>，然后新建一个渠道（Base URL 与 Key
          可留空，只填模型名）；也可以直接在渠道里填 API Key。
        </div>
      </div>
      <div className="statuscard__actions">
        <button
          className="btn btn--ghost btn--xs"
          onClick={() => void copyText('codex login')}
        >
          复制登录命令
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
      <h2 className="installguide__title">安装 Codex CLI</h2>
      <p className="installguide__lead">
        安装完成后点上面的「重新检测」，不需要重启 CCoder。Codex 的登录与历史都放在
        <code>CODEX_HOME</code> 里，和终端里跑的 <code>codex</code> 共享。
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
          {copied === 'install' ? '已复制' : '复制'}
        </button>
      </div>

      <div className="installguide__alt">
        <span>或者用 npm：</span>
        <div className="cmdbox cmdbox--inline">
          <code className="cmdbox__line">{NPM_COMMAND}</code>
          <button
            type="button"
            className="btn btn--ghost btn--xs"
            onClick={() => void copy(NPM_COMMAND, 'npm')}
          >
            {copied === 'npm' ? '已复制' : '复制'}
          </button>
        </div>
      </div>

      <ol className="installguide__steps">
        <li>运行上面的安装命令，确认终端里 <code>codex --version</code> 能输出版本号。</li>
        <li>点「重新检测」。检测到已安装后，这里会显示版本和 app-server 状态。</li>
        <li>
          登录：终端运行 <code>codex login</code>，然后新建渠道并填模型名（Base URL /
          Key 可留空）；也可以直接填 OpenAI 兼容的 Base URL 和 API Key。
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
