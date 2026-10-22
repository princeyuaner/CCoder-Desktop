export type TabKey = 'chat' | 'trace'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'chat', label: '对话' },
  { key: 'trace', label: '轨迹' }
]

export function TabBar({
  active,
  onChange
}: {
  active: TabKey
  onChange: (k: TabKey) => void
}): JSX.Element {
  return (
    <div className="tabbar" role="tablist">
      {TABS.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={active === t.key}
          className={`tab ${active === t.key ? 'is-active' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
