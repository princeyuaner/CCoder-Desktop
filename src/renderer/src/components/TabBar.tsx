import type { ComponentType } from 'react'
import type { MessageKey } from '@shared/i18n'
import { useI18n } from '../i18n'

export type TabKey = string

const TABS: { key: TabKey; labelKey: MessageKey }[] = [
  { key: 'chat', labelKey: 'tabbar.chat' },
  { key: 'trace', labelKey: 'tabbar.trace' }
]

export interface PluginTabView {
  /** 贡献 id 已经做过全局唯一，直接作为 tab key */
  id: string
  label: string
  icon?: ComponentType<{ className?: string }>
}

export function TabBar({
  active,
  onChange,
  pluginTabs = []
}: {
  active: TabKey
  onChange: (k: TabKey) => void
  pluginTabs?: PluginTabView[]
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
      {pluginTabs.map((tab) => {
        const Icon = tab.icon
        const key = `plugin:${tab.id}`
        return (
          <button
            key={key}
            role="tab"
            aria-selected={active === key}
            className={`tab tab--plugin ${active === key ? 'is-active' : ''}`}
            title={tab.label}
            onClick={() => onChange(key)}
          >
            {Icon ? <Icon className="tab__icon" /> : null}
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
