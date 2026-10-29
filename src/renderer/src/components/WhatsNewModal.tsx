import { useEffect, useRef } from 'react'
import {
  whatsNewCount,
  whatsNewText,
  type WhatsNewIcon as WnIconName,
  type WhatsNewRelease
} from '@shared/whats-new'
import { useI18n } from '../i18n'
import { IconExternal } from './Icons'

/** 和「关于」页保持一致；更新说明的入口永远指向 GitHub Releases */
const RELEASES_URL = 'https://github.com/princeyuaner/CCoder-Desktop/releases'

/**
 * 更新完成后的说明弹窗。
 *
 * 只在版本号变化时由 useWhatsNew 触发一次（见那里的判定）。
 * 视觉上复用审批弹窗的遮罩与按钮，但对话本身是信息型的：没有危险操作，
 * Esc / 回车 / 点遮罩都可以关掉。
 */
export function WhatsNewModal({
  release,
  welcome,
  onClose
}: {
  release: WhatsNewRelease
  /** 第一次运行（没有上次版本记录）时不说「更新完成」 */
  welcome: boolean
  onClose(): void
}): JSX.Element {
  const { t, tn, locale } = useI18n()
  const dlgRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    dlgRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 焦点在按钮 / 链接上时交给控件自己处理，避免回车既点按钮又关弹窗
      const onControl = (e.target as HTMLElement | null)?.closest('button, a') != null
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'Enter' && !onControl && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const count = whatsNewCount(release)
  const version = `v${release.version}`

  return (
    <div className="modal">
      <div className="modal__scrim" onClick={onClose} />
      <div
        className="wn"
        ref={dlgRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wn-title"
        aria-describedby="wn-sub"
      >
        <header className="wn__head">
          <button
            className="wn__x"
            onClick={onClose}
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            ×
          </button>
          <div className="wn__mark">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
              <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" />
            </svg>
          </div>
          <div className="wn__eyebrow">
            {t(welcome ? 'whatsNew.welcome' : 'whatsNew.eyebrow')}
          </div>
          <h1 className="wn__title" id="wn-title">
            {t('whatsNew.titleLead')} <span className="wn__ver">{version}</span>
          </h1>
          <p className="wn__sub" id="wn-sub">
            {tn('whatsNew.subtitle', count, { date: release.date, count })}
          </p>
        </header>

        <div className="wn__body">
          <section className="wn-hero">
            <div className="wn-hero__icon">
              <WnIcon name={release.highlight.icon} size={17} />
            </div>
            <div>
              <span className="wn-hero__tag">{t('whatsNew.highlight')}</span>
              <h2>{whatsNewText(release.highlight.title, locale)}</h2>
              <p>{whatsNewText(release.highlight.desc, locale)}</p>
            </div>
          </section>

          {release.sections.map((section) => (
            <section className="wn-group" key={section.kind}>
              <h3 className="wn-sec">
                {t(
                  section.kind === 'new' ? 'whatsNew.section.new' : 'whatsNew.section.improved'
                )}
                <span className="wn-sec__n">{section.items.length}</span>
              </h3>
              <ul className="wn-list">
                {section.items.map((item, i) => (
                  <li className="wn-item" key={`${section.kind}-${i}`}>
                    <span className="wn-item__icon">
                      <WnIcon name={item.icon} />
                    </span>
                    <div className="wn-item__main">
                      <div className="wn-item__title">{whatsNewText(item.title, locale)}</div>
                      <p className="wn-item__desc">{whatsNewText(item.desc, locale)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <footer className="wn__foot">
          <span className="wn__note">{t('whatsNew.note')}</span>
          <a className="btn btn--ghost wn__log" href={RELEASES_URL} target="_blank" rel="noreferrer">
            {t('whatsNew.log')}
            <IconExternal width={11} height={11} />
          </a>
          <button className="btn btn--primary" onClick={onClose}>
            {t('whatsNew.start')}
            <span className="kbd">Enter</span>
          </button>
        </footer>
      </div>
    </div>
  )
}

/**
 * 更新说明里的小图标。和 Icons.tsx 一样统一 16px 视口、currentColor 描边，
 * 但只服务于这一份数据，所以留在这里而不是进通用图标库。
 */
function WnIcon({
  name,
  size = 14
}: {
  name: WnIconName
  size?: number
}): JSX.Element {
  const base = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round'
  } as const

  switch (name) {
    case 'rich-text':
      return (
        <svg {...base}>
          <path d="M2.5 3.5h11v7.5H8L5 13.5V11H2.5z" />
          <path d="M5 6h6M5 8.5h4" />
        </svg>
      )
    case 'review':
      return (
        <svg {...base}>
          <path d="M3.5 2.5h6l3 3v8h-9z" />
          <path d="M9.5 2.5v3h3M5.75 9l1.25 1.25L9.5 7.5" />
        </svg>
      )
    case 'batch':
      return (
        <svg {...base}>
          <path d="M3 4.5h10M3 8h10M3 11.5h6" />
          <path d="M11 11.5l1.3 1.3L15 10" />
        </svg>
      )
    case 'search':
      return (
        <svg {...base}>
          <circle cx="7" cy="7" r="4" />
          <path d="M10 10l3.5 3.5" />
        </svg>
      )
    case 'bell':
      return (
        <svg {...base}>
          <path d="M12.5 6.5a4.5 4.5 0 0 0-9 0c0 3.4-1.5 4.2-1.5 4.2h12s-1.5-.8-1.5-4.2z" />
          <path d="M6.5 13a1.6 1.6 0 0 0 3 0" />
        </svg>
      )
    case 'keyboard':
      return (
        <svg {...base}>
          <rect x="1.8" y="4" width="12.4" height="8" rx="1.5" />
          <path d="M4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M4.5 9.5h7" />
        </svg>
      )
    case 'lsp':
      return (
        <svg {...base}>
          <circle cx="8" cy="8" r="2" />
          <path d="M8 2v4M8 10v4M2 8h4M10 8h4" />
        </svg>
      )
    case 'hooks':
      return (
        <svg {...base}>
          <circle cx="4.2" cy="3.4" r="1.5" />
          <path d="M4.2 4.9v3.4a3 3 0 0 0 3 3h4.6" />
          <circle cx="12.4" cy="11.3" r="1.5" />
        </svg>
      )
    case 'sparkle':
      return (
        <svg {...base}>
          <path d="M8 2l1.3 3.4L12.7 6.7l-3.4 1.3L8 11.4 6.7 8 3.3 6.7l3.4-1.3L8 2z" />
          <path d="M12.4 11l.55 1.45L14.4 13l-1.45.55L12.4 15l-.55-1.45L10.4 13l1.45-.55L12.4 11z" />
        </svg>
      )
    case 'collapse':
      return (
        <svg {...base}>
          <path d="M4.5 8.5L8 5l3.5 3.5" />
          <path d="M3.2 12.5h9.6" />
        </svg>
      )
    case 'terminal':
      return (
        <svg {...base}>
          <rect x="1.8" y="3.2" width="12.4" height="9.6" rx="1.5" />
          <path d="M4.6 6.6l2 1.8-2 1.8M9 10.2h2.6" />
        </svg>
      )
  }
}
