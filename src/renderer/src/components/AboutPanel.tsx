import type { ReactNode } from 'react'
import { formatRelativeTime } from '@shared/i18n'
import type { UpdateState } from '@shared/update'
import { useI18n } from '../i18n'
import type { UpdaterUi } from '../useUpdater'
import appIcon from '../assets/app-icon.png'
import { IconCheck, IconDownload, IconExternal, IconGithub } from './Icons'

const REPO_URL = 'https://github.com/princeyuaner/CCoder-Desktop'
const RELEASES_URL = `${REPO_URL}/releases`
const ISSUES_URL = `${REPO_URL}/issues`

/**
 * 「关于」页：版本信息、自动更新状态和项目链接。
 *
 * 更新状态完全由主进程持有（和右下角的 UpdateToast 是同一份），这里只负责
 * 把 phase 翻译成一张状态卡，并在用户手动检查时把「检查中」显示出来。
 */
export function AboutPanel({ updater }: { updater: UpdaterUi }): JSX.Element {
  const { t, locale } = useI18n()
  const state = updater.state
  const phase = state?.phase ?? 'idle'
  const currentVersion = state?.currentVersion || '—'
  const checkedAt = state?.checkedAt
    ? formatRelativeTime(state.checkedAt, locale)
    : ''
  const version = state?.version ? `v${state.version}` : ''

  /** 主操作按钮。检查中 / 下载中 / 不支持自动更新时不放可点的按钮，避免重复触发 */
  const checkButton = (primary = false): ReactNode => (
    <button
      className={`btn ${primary ? 'btn--primary' : 'btn--ghost'} btn--xs`}
      onClick={updater.check}
      disabled={
        phase === 'checking' || phase === 'downloading' || phase === 'unsupported'
      }
    >
      {phase === 'checking'
        ? t('about.update.checkingAction')
        : phase === 'downloading'
          ? t('about.update.downloadingAction')
          : t('about.update.check')}
    </button>
  )

  const card = (): { tone: string; icon: ReactNode; title: ReactNode; meta: ReactNode; action: ReactNode } => {
    if (phase === 'checking') {
      return {
        tone: 'statuscard--muted',
        icon: <span className="spinner" />,
        title: t('about.update.checking'),
        meta: t('about.update.checkingMeta'),
        action: checkButton()
      }
    }

    if (phase === 'available') {
      return {
        tone: '',
        icon: <IconDownload width={18} height={18} />,
        title: (
          <>
            {t('about.update.available', { version })}
            <span className="badge badge--ok">{t('about.update.availableBadge')}</span>
          </>
        ),
        meta: state?.releaseName || t('about.update.availableHint'),
        action: (
          <button className="btn btn--primary btn--xs" onClick={updater.download}>
            {t('about.update.download')}
          </button>
        )
      }
    }

    if (phase === 'downloading') {
      const percent = Math.round(state?.percent ?? 0)
      return {
        tone: 'statuscard--muted',
        icon: <span className="spinner" />,
        title: t('about.update.downloading', { version }),
        meta: (
          <>
            <span className="aboutprogress" aria-hidden="true">
              <span style={{ width: `${percent}%` }} />
            </span>
            {t('about.update.downloadingPercent', { percent })}
          </>
        ),
        action: checkButton()
      }
    }

    if (phase === 'downloaded') {
      return {
        tone: '',
        icon: <IconCheck width={18} height={18} />,
        title: (
          <>
            {t('about.update.downloaded', { version })}
            <span className="badge badge--ok">{t('about.update.readyBadge')}</span>
          </>
        ),
        meta: t('about.update.readyHint'),
        action: (
          <button
            className="btn btn--primary btn--xs"
            onClick={() => void updater.install()}
          >
            {t('about.update.install')}
          </button>
        )
      }
    }

    if (phase === 'error') {
      const downloadFailed = state?.errorScope === 'download'
      return {
        tone: 'statuscard--bad',
        icon: '!',
        title: downloadFailed ? t('about.update.downloadFailed') : t('about.update.checkFailed'),
        meta: state?.error || t('about.update.errorFallback'),
        action: (
          <button
            className="btn btn--ghost btn--xs"
            onClick={downloadFailed ? updater.download : updater.check}
          >
            {t('common.retry')}
          </button>
        )
      }
    }

    if (phase === 'unsupported') {
      return {
        tone: 'statuscard--muted',
        icon: '!',
        title:
          state?.reason === 'portable'
            ? t('about.update.unsupportedPortable')
            : t('about.update.unsupportedDev'),
        meta: t('about.update.unsupportedHint'),
        action: checkButton()
      }
    }

    if (phase === 'up-to-date') {
      return {
        tone: '',
        icon: <IconCheck width={18} height={18} />,
        title: (
          <>
            {t('about.update.upToDate')}
            {version && <span className="badge badge--ok">{version}</span>}
          </>
        ),
        meta: checkedAt
          ? t('about.update.checkedAt', { time: checkedAt, hint: t('about.update.autoHint') })
          : t('about.update.autoHint'),
        action: checkButton()
      }
    }

    return {
      tone: 'statuscard--muted',
      icon: <IconCheck width={18} height={18} />,
      title: t('about.update.idle'),
      meta: t('about.update.autoHint'),
      action: checkButton()
    }
  }

  const status = card()

  return (
    <>
      <section className="abouthero">
        <div className="abouthero__mark">
          <img src={appIcon} alt="" />
        </div>
        <div className="abouthero__main">
          <h2 className="abouthero__name">
            CCoder <span className="abouthero__ver">v{currentVersion}</span>
          </h2>
          <p className="abouthero__tagline">{t('about.tagline')}</p>
          <p className="abouthero__meta">{t('about.builtWith')}</p>
        </div>
      </section>

      <section className="chform chform--sep">
        <div className="chform__head">
          <h2 className="chform__title">{t('about.update.section')}</h2>
        </div>
        <div className={`statuscard ${status.tone}`}>
          <div
            className={`statuscard__icon ${
              status.tone === 'statuscard--bad'
                ? 'statuscard__icon--bad'
                : phase === 'up-to-date' || phase === 'downloaded' || phase === 'available'
                  ? 'statuscard__icon--ok'
                  : ''
            }`}
          >
            {status.icon}
          </div>
          <div className="statuscard__main">
            <div className="statuscard__title">{status.title}</div>
            <div className="statuscard__meta">{status.meta}</div>
          </div>
          <div className="statuscard__actions">{status.action}</div>
        </div>
        <p className="aboutnote">{t('about.update.note')}</p>
      </section>

      <section className="chform chform--sep">
        <div className="chform__head">
          <h2 className="chform__title">{t('about.links')}</h2>
        </div>
        <div className="aboutlinks">
          <a className="aboutlink" href={REPO_URL} target="_blank" rel="noreferrer">
            <span className="aboutlink__icon">
              <IconGithub width={15} height={15} />
            </span>
            <span className="aboutlink__label">{t('about.links.repo')}</span>
            <span className="aboutlink__meta">princeyuaner/CCoder-Desktop</span>
            <IconExternal width={13} height={13} className="aboutlink__ext" />
          </a>
          <a className="aboutlink" href={RELEASES_URL} target="_blank" rel="noreferrer">
            <span className="aboutlink__icon">
              <IconDownload width={15} height={15} />
            </span>
            <span className="aboutlink__label">{t('about.links.releases')}</span>
            <span className="aboutlink__meta">{t('about.links.releasesMeta')}</span>
            <IconExternal width={13} height={13} className="aboutlink__ext" />
          </a>
          <a className="aboutlink" href={ISSUES_URL} target="_blank" rel="noreferrer">
            <span className="aboutlink__icon">
              <IconExternal width={15} height={15} />
            </span>
            <span className="aboutlink__label">{t('about.links.issues')}</span>
            <span className="aboutlink__meta">{t('about.links.issuesMeta')}</span>
            <IconExternal width={13} height={13} className="aboutlink__ext" />
          </a>
        </div>
      </section>

      <footer className="aboutfoot">
        <span>{t('about.footer')}</span>
        <span>{t('about.footerHint')}</span>
      </footer>
    </>
  )
}
