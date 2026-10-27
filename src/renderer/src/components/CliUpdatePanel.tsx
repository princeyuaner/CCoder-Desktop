import { useEffect, useRef, useState } from 'react'
import { formatRelativeTime } from '@shared/i18n'
import type { CliUpdateState } from '@shared/cli-update'
import type { CliId } from '@shared/settings'
import { useI18n } from '../i18n'
import { IconAlert, IconCheck, IconCopy, IconExternal, IconRefresh, IconUpload } from './Icons'

interface Props {
  cli: CliId
  /** CLI 的显示名，用在确认弹窗标题里 */
  name: string
  state: CliUpdateState | null
  autoCheck: boolean
  tagInNav: boolean
  /** 当前有多少条会话在跑 —— 更新前提醒、更新后说明生效范围 */
  runningSessions: number
  onAutoCheck(v: boolean): void
  onTagInNav(v: boolean): void
  onCheck(force: boolean): void
  onRun(): Promise<{ ok: boolean; message?: string }>
  onRunElevated(): Promise<{ ok: boolean; message?: string }>
  onCancel(): void
}

/**
 * 设置页里的「CLI 更新」一块。
 *
 * 结构照现有设置页：状态卡 + 一条要执行的命令 + 两个开关。三种 CLI 共用，
 * 差别全在主进程给的状态里，这里不判断包名、不拼命令 —— 那条命令是主进程
 * 算好后带下来的，复制和展示用同一份，避免两边拼出不一样的字符串。
 */
export function CliUpdatePanel({
  cli,
  name,
  state,
  autoCheck,
  tagInNav,
  runningSessions,
  onAutoCheck,
  onTagInNav,
  onCheck,
  onRun,
  onRunElevated,
  onCancel
}: Props): JSX.Element {
  const { t, locale } = useI18n()
  const [copied, setCopied] = useState<string>('')
  const [confirming, setConfirming] = useState(false)
  const [actionError, setActionError] = useState('')

  const phase = state?.phase ?? 'checking'
  const busy = phase === 'checking' || phase === 'updating'
  const checkedAt = state?.checkedAt ? formatRelativeTime(state.checkedAt, locale) : ''

  /*
   * 进页面时查一次。主进程按 6 小时 TTL 判断要不要真去问 registry，
   * 所以来回切 CLI 页不会反复起 npm 进程。
   */
  const checkRef = useRef(onCheck)
  checkRef.current = onCheck
  useEffect(() => {
    checkRef.current(false)
  }, [cli])

  // 换 CLI / 状态翻页时，把一次性的提示收掉
  useEffect(() => {
    setActionError('')
    setConfirming(false)
  }, [cli, phase])

  const copy = async (text: string, key: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      window.setTimeout(() => setCopied(''), 1600)
    } catch {
      // 剪贴板不可用时用户还能手动选中复制
    }
  }

  const beginUpdate = async (): Promise<void> => {
    setConfirming(false)
    const r = await onRun()
    if (!r.ok) setActionError(r.message ?? t('cliUpdate.updateFailed'))
  }

  const retryElevated = async (): Promise<void> => {
    const r = await onRunElevated()
    if (!r.ok) setActionError(r.message ?? t('cliUpdate.updateFailed'))
  }

  /* ── 状态卡 ────────────────────────────────────────── */

  let card: JSX.Element

  if (phase === 'checking') {
    card = (
      <div className="statuscard statuscard--muted">
        <div className="statuscard__icon">
          <span className="spinner" />
        </div>
        <div className="statuscard__main">
          <div className="statuscard__title">{t('cliUpdate.checking')}</div>
          <div className="statuscard__meta">{t('cliUpdate.checkingMeta')}</div>
        </div>
      </div>
    )
  } else if (phase === 'updating') {
    card = (
      <div className="statuscard">
        <div className="statuscard__icon">
          <span className="spinner" />
        </div>
        <div className="statuscard__main">
          <div className="statuscard__title">
            {t('cliUpdate.updating', { version: state?.latest ?? '' })}
          </div>
          <div className="statuscard__meta">
            {state?.elevated ? t('cliUpdate.elevatedHint') : t('cliUpdate.updatingMeta')}
          </div>
          <div className="prog prog--indeterminate">
            <i />
          </div>
          {state?.line && (
            <div className="statuscard__meta updline">
              <code>{state.line}</code>
            </div>
          )}
        </div>
        <div className="statuscard__actions">
          <button className="btn btn--ghost btn--xs" onClick={onCancel}>
            {t('cliUpdate.cancel')}
          </button>
        </div>
      </div>
    )
  } else if (phase === 'available' && state?.canUpdate) {
    card = (
      <div className="statuscard">
        <div className="statuscard__icon statuscard__icon--warn">
          <IconUpload width={16} height={16} />
        </div>
        <div className="statuscard__main">
          <div className="statuscard__title">
            {t('cliUpdate.available', { version: state.latest ?? '' })}
            <span className="badge badge--warn">
              <span className="badge__dot" />
              {t('cliUpdate.badgeAvailable')}
            </span>
            {state.fromCache && <span className="badge">{t('cliUpdate.offline')}</span>}
          </div>
          <div className="statuscard__meta">
            {t('cliUpdate.currentToLatest', {
              current: state.current ?? '—',
              latest: state.latest ?? '—'
            })}
            {state.publishedAt
              ? ` · ${t('cliUpdate.published', {
                  time: formatRelativeTime(state.publishedAt, locale)
                })}`
              : ''}
            {' · '}
            {t('cliUpdate.installNpm')}
          </div>
          <div className="statuscard__meta">{t('cliUpdate.lastChecked', { time: checkedAt })}</div>
        </div>
        <div className="statuscard__actions">
          {state.notesUrl && (
            <a className="btn btn--ghost btn--xs" href={state.notesUrl} target="_blank" rel="noreferrer">
              {t('cliUpdate.notes')}
              <IconExternal width={11} height={11} />
            </a>
          )}
          <button
            className="btn btn--primary btn--xs"
            onClick={() => {
              if (runningSessions > 0) setConfirming(true)
              else void beginUpdate()
            }}
          >
            <IconUpload width={12} height={12} />
            {t('cliUpdate.updateTo', { version: state.latest ?? '' })}
          </button>
        </div>
      </div>
    )
  } else if (phase === 'available') {
    // 有新版但装法不是 npm 全局 —— 只给命令，不去动用户的安装
    card = (
      <div className="statuscard statuscard--muted">
        <div className="statuscard__icon">
          <IconAlert width={15} height={15} />
        </div>
        <div className="statuscard__main">
          <div className="statuscard__title">
            {t('cliUpdate.manualOnly')}
            <span className="badge badge--warn">{state?.latest}</span>
          </div>
          <div className="statuscard__meta">
            {state?.current && state?.latest
              ? `${t('cliUpdate.currentToLatest', {
                  current: state.current,
                  latest: state.latest
                })} · `
              : ''}
            {t('cliUpdate.manualOnlyMeta', { path: state?.path ?? '—' })}
          </div>
        </div>
        <div className="statuscard__actions">
          {state?.notesUrl && (
            <a className="btn btn--ghost btn--xs" href={state.notesUrl} target="_blank" rel="noreferrer">
              {t('cliUpdate.notes')}
            </a>
          )}
          <button
            className="btn btn--ghost btn--xs"
            onClick={() => void copy(manualCommand(state), 'cmd')}
          >
            {copied === 'cmd' ? t('cliUpdate.copied') : t('cliUpdate.copyCommand')}
          </button>
        </div>
      </div>
    )
  } else if (phase === 'done') {
    card = (
      <div className="statuscard">
        <div className="statuscard__icon statuscard__icon--ok">
          <IconCheck width={17} height={17} />
        </div>
        <div className="statuscard__main">
          <div className="statuscard__title">
            {t('cliUpdate.done', { version: state?.current ?? '' })}
            <span className="badge badge--ok">{t('cliUpdate.badgeDone')}</span>
          </div>
          <div className="statuscard__meta">
            {runningSessions > 0
              ? t('cliUpdate.doneMetaRunning', { count: String(runningSessions) })
              : t('cliUpdate.doneMeta')}
          </div>
        </div>
        <div className="statuscard__actions">
          <button
            className="btn btn--ghost btn--xs"
            onClick={() => onCheck(true)}
            disabled={busy}
          >
            {t('cliUpdate.recheck')}
          </button>
        </div>
      </div>
    )
  } else if (phase === 'error' && state?.errorScope === 'update') {
    card = (
      <div className="statuscard statuscard--bad">
        <div className="statuscard__icon statuscard__icon--bad">
          <IconAlert width={15} height={15} />
        </div>
        <div className="statuscard__main">
          <div className="statuscard__title">
            {t('cliUpdate.updateFailed')}
            {state.needAdmin && (
              <span className="badge badge--bad">{t('cliUpdate.needAdmin')}</span>
            )}
          </div>
          {state.error && <pre className="statuscard__error">{state.error}</pre>}
        </div>
        <div className="statuscard__actions">
          {state.command && (
            <button
              className="btn btn--ghost btn--xs"
              onClick={() => void copy(state.command ?? '', 'cmd')}
            >
              {copied === 'cmd' ? t('cliUpdate.copied') : t('cliUpdate.copyCommand')}
            </button>
          )}
          {state.needAdmin && typeof window !== 'undefined' && window.api?.platform === 'win32' && (
            <button className="btn btn--ghost btn--xs" onClick={() => void retryElevated()}>
              {t('cliUpdate.retryAsAdmin')}
            </button>
          )}
          <button className="btn btn--ghost btn--xs" onClick={() => onCheck(true)}>
            {t('cliUpdate.retry')}
          </button>
        </div>
      </div>
    )
  } else if (phase === 'error') {
    // 检查失败：不报红，只说明「这次没查到」，已知版本信息保留
    card = (
      <div className="statuscard statuscard--muted">
        <div className="statuscard__icon">–</div>
        <div className="statuscard__main">
          <div className="statuscard__title">{t('cliUpdate.checkFailed')}</div>
          <div className="statuscard__meta">
            {state?.error || t('cliUpdate.checkFailedMeta')}
          </div>
        </div>
        <div className="statuscard__actions">
          <button className="btn btn--ghost btn--xs" onClick={() => onCheck(true)} disabled={busy}>
            {t('cliUpdate.retry')}
          </button>
        </div>
      </div>
    )
  } else if (state && !state.installed) {
    card = (
      <div className="statuscard statuscard--muted">
        <div className="statuscard__icon">!</div>
        <div className="statuscard__main">
          <div className="statuscard__title">{t('cliUpdate.notInstalled')}</div>
          {state.path && <div className="statuscard__meta">{state.path}</div>}
        </div>
      </div>
    )
  } else {
    card = (
      <div className="statuscard">
        <div className="statuscard__icon statuscard__icon--ok">
          <IconCheck width={17} height={17} />
        </div>
        <div className="statuscard__main">
          <div className="statuscard__title">
            {t('cliUpdate.upToDate')}
            {state?.current && <span className="badge badge--ok">{state.current}</span>}
            {state?.fromCache && <span className="badge">{t('cliUpdate.offline')}</span>}
          </div>
          <div className="statuscard__meta">
            {state?.fromCache
              ? t('cliUpdate.offlineCached', { time: checkedAt })
              : checkedAt
                ? t('cliUpdate.lastChecked', { time: checkedAt })
                : t('cliUpdate.neverChecked')}
          </div>
        </div>
        <div className="statuscard__actions">
          <button className="btn btn--ghost btn--xs" onClick={() => onCheck(true)} disabled={busy}>
            {t('cliUpdate.check')}
          </button>
        </div>
      </div>
    )
  }

  /* ── 命令条 / 偏好 / 确认弹窗 ──────────────────────── */

  const command = state?.command
  /*
   * 非 npm 安装时主进程不给 command（我们不会替他装），但界面上还是要让
   * 用户看见该敲什么 —— 否则「复制命令」复制的东西是看不见的。
   */
  const manual = phase === 'available' && state?.canUpdate === false ? manualCommand(state) : ''
  const stripCommand = command ?? manual
  const stripLabel =
    phase === 'updating'
      ? t('cliUpdate.commandRunning')
      : manual
        ? t('cliUpdate.commandManual')
        : t('cliUpdate.commandWillRun')

  return (
    <>
      <div className="secthead">
        {t('cliUpdate.section')}
        <span className="secthead__sp">
          {autoCheck ? t('cliUpdate.autoOn') : t('cliUpdate.autoOff')}
        </span>
      </div>

      {card}

      {(phase === 'available' || phase === 'updating') && stripCommand && (
        <div className="updcmd">
          <span className="updcmd__label">{stripLabel}</span>
          <code>{stripCommand}</code>
          <button className="updcmd__copy" onClick={() => void copy(stripCommand, 'strip')}>
            <IconCopy width={11} height={11} />
            {copied === 'strip' ? t('cliUpdate.copied') : t('cliUpdate.copy')}
          </button>
        </div>
      )}

      {actionError && <p className="updwarn">{actionError}</p>}

      <section className="chform chform--sep updprefs">
        <div className="updprefs__row">
          <div className="updprefs__main">
            <div className="updprefs__t">{t('cliUpdate.autoCheck')}</div>
            <div className="updprefs__h">{t('cliUpdate.autoCheckHint')}</div>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={autoCheck}
              onChange={(e) => onAutoCheck(e.target.checked)}
            />
            <span>{autoCheck ? t('common.enabled') : t('common.disabled')}</span>
          </label>
        </div>
        <div className="updprefs__row">
          <div className="updprefs__main">
            <div className="updprefs__t">{t('cliUpdate.tagInNav')}</div>
            <div className="updprefs__h">{t('cliUpdate.tagInNavHint')}</div>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={tagInNav}
              onChange={(e) => onTagInNav(e.target.checked)}
            />
            <span>{tagInNav ? t('common.enabled') : t('common.disabled')}</span>
          </label>
        </div>
        <div className="updprefs__foot">
          <span>
            {checkedAt ? t('cliUpdate.lastChecked', { time: checkedAt }) : t('cliUpdate.neverChecked')}
          </span>
          <button className="btn btn--ghost btn--xs" onClick={() => onCheck(true)} disabled={busy}>
            <IconRefresh width={11} height={11} />
            {phase === 'checking' ? t('cliUpdate.checking') : t('cliUpdate.checkNow')}
          </button>
        </div>
      </section>

      {confirming && (
        <UpdateConfirmDialog
          name={name}
          command={command ?? ''}
          count={runningSessions}
          current={state?.current}
          latest={state?.latest}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void beginUpdate()}
        />
      )}
    </>
  )
}

/**
 * 有会话在跑时的确认弹窗。
 *
 * 单独拆出来是为了能单独渲染 / 截图验证 —— 它只是展示，行为由外面的
 * onConfirm 决定。更新本身不会打断运行中的会话，这里把这句话说清楚。
 */
export function UpdateConfirmDialog({
  name,
  command,
  count,
  current,
  latest,
  onCancel,
  onConfirm
}: {
  name: string
  command: string
  count: number
  current?: string
  latest?: string
  onCancel(): void
  onConfirm(): void
}): JSX.Element {
  const { t } = useI18n()
  return (
    <div className="modal">
      <div className="modal__scrim" onClick={onCancel} />
      <div
        className="modal__dlg"
        role="dialog"
        aria-modal="true"
        aria-label={t('cliUpdate.confirmTitle', { name })}
      >
        <div className="modal__h">
          <span className="modal__t">{t('cliUpdate.confirmTitle', { name })}</span>
        </div>
        <div className="modal__b">
          <div className="modal__note">{t('cliUpdate.confirmLead')}</div>
          <pre className="modal__pre is-cmd">{command}</pre>
          <div className="modal__note">
            {t('cliUpdate.confirmRunning', {
              count: String(count),
              current: current ?? '—',
              latest: latest ?? '—'
            })}
          </div>
        </div>
        <div className="modal__f">
          <span className="modal__sp" />
          <button className="btn btn--ghost" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button className="btn btn--primary" onClick={onConfirm}>
            {t('cliUpdate.confirmStart')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 非 npm 安装时给用户的命令：只用 CLI 自己的更新子命令，不猜包管理器 */
function manualCommand(state: CliUpdateState | null): string {
  if (state?.command) return state.command
  const cli = state?.cli ?? 'claude'
  if (cli === 'claude') return 'claude update'
  if (cli === 'codex') return 'npm install -g @openai/codex@latest'
  return 'npm install -g @deepseek-ai/dsh@latest'
}
