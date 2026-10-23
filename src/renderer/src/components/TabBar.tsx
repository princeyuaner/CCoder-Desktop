import type { MessageKey } from '@shared/i18n'
import { useI18n } from '../i18n'

export type TabKey = 'chat' | 'trace'

const TABS: { key: TabKey; labelKey: MessageKey }[] = [
  { key: 'chat', labelKey: 'tabbar.chat' },
  { key: 'trace', labelKey: 'tabbar.trace' }
]

export function TabBar({
  active,
  onChange
}: {
  active: TabKey
  onChange: (k: TabKey) => void
}): JSX.Element {
  const { t } = useI18n()
  return (
    <div className="tabbar" role="tablist">
      {TABS.map((tab) => (
        <button
          key={tab.key}
          role="tab"
          aria-selected={active === tab.key}
          className={`tab ${active === tab.key ? 'is-active' : ''}`}
          onClick={() => onChange(tab.key)}
        >
          {t(tab.labelKey)}
        </button>
      ))}
    </div>
  )
}
