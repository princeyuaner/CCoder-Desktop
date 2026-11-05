import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react'
import type {
  InstalledPlugin,
  PluginLocalPreview,
  PluginMarketEntry,
  PluginMarketListResult,
  PluginMarketVersion,
  PluginTier
} from '@shared/plugins'
import { permissionRisk } from '@shared/plugins'
import { useI18n } from '../i18n'
import {
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconCode,
  IconCopy,
  IconDownload,
  IconExternal,
  IconFolder,
  IconGear,
  IconMore,
  IconPanel,
  IconPlugin,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconShield,
  IconSlash,
  IconSpark,
  IconTrash,
  IconX
} from './Icons'
import {
  initPluginHost,
  inspectLocalPlugin,
  installPluginFromLocal,
  installPluginFromMarket,
  reloadPlugin,
  revealPlugin,
  setPluginEnabled,
  uninstallPlugin
} from '../plugins/host'
import { usePluginHost } from '../plugins/hooks'
import {
  categoryLabel,
  formatBytes,
  formatInstalledAt,
  permissionHelp,
  permissionRiskLabel,
  pluginErrorText
} from '../plugins/permission-help'
type PageTab = 'installed' | 'market'
type DetailTab = 'overview' | 'contributions' | 'permissions' | 'changelog'

type PendingInstall =
  | { kind: 'market'; entry: PluginMarketEntry; version: PluginMarketVersion }
  | { kind: 'local'; preview: PluginLocalPreview }

interface InstallView {
  kind: 'market' | 'local'
  name: string
  version: string
  tier: PluginTier
  permissions: string[]
  source: string
  description: string
  author: string
}

interface ContributionRow {
  key: string
  label: string
  detail: string
  kind: 'theme' | 'status' | 'command' | 'settings' | 'panel'
}

function ModeBadge({ tier }: { tier: PluginTier }): JSX.Element {
  return tier === 'declarative' ? (
    <span className="pl-badge pl-badge--ok">免代码</span>
  ) : (
    <span className="pl-badge pl-badge--plugin">需要运行代码</span>
  )
}

function PluginGlyph({ tier, size = 17 }: { tier: PluginTier; size?: number }): JSX.Element {
  return tier === 'js' ? (
    <IconCode width={size} height={size} />
  ) : (
    <IconPlugin width={size} height={size} />
  )
}

function PermissionRows({ permissions }: { permissions: string[] }): JSX.Element {
  if (!permissions.length) {
    return <div className="pl-muted">没有声明额外权限。</div>
  }
  return (
    <div className="pl-perms">
      {permissions.map((key) => {
        const help = permissionHelp(key)
        const risk = permissionRisk(key)
        return (
          <details className="pl-perm" key={key}>
            <summary className="pl-perm__summary">
              <span className={`pl-risk pl-risk--${risk}`}>{permissionRiskLabel(key)}</span>
              <span className="pl-perm__main">
                <code className="pl-perm__key">{key}</code>
                <span className="pl-perm__desc">{help.access[0]}</span>
              </span>
              <span className="pl-perm__chev">
                <IconChevronDown width={12} height={12} />
              </span>
            </summary>
            <div className="pl-perm__expanded">
              <div>
                <div className="pl-perm__title">可以访问</div>
                <ul className="pl-perm__list is-yes">
                  {help.access.map((text) => (
                    <li key={text}>
                      <IconCheck width={11} height={11} />
                      <span>{text}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="pl-perm__title">不会访问</div>
                <ul className="pl-perm__list is-no">
                  {help.deny.map((text) => (
                    <li key={text}>
                      <IconX width={11} height={11} />
                      <span>{text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </details>
        )
      })}
    </div>
  )
}

function contributionIcon(kind: ContributionRow['kind']): ReactNode {
  const size = 13
  if (kind === 'theme') return <IconSpark width={size} height={size} />
  if (kind === 'status') return <IconPanel width={size} height={size} />
  if (kind === 'command') return <IconSlash width={size} height={size} />
  if (kind === 'settings') return <IconGear width={size} height={size} />
  return <IconPanel width={size} height={size} />
}

function contributionRows(
  plugin: InstalledPlugin,
  state: ReturnType<typeof usePluginHost>
): ContributionRow[] {
  const rows: ContributionRow[] = []
  const loaded = state.loaded.includes(plugin.id)
  const staticOnly = !plugin.enabled || !loaded

  if (staticOnly) {
    for (const theme of plugin.contributes?.themes ?? []) {
      rows.push({
        key: `theme:${theme.name ?? 'main'}`,
        label: '主题',
        detail: theme.name ?? '自定义主题',
        kind: 'theme'
      })
    }
    for (const item of plugin.contributes?.statusBarItems ?? []) {
      rows.push({
        key: `status:${item.key ?? item.text}`,
        label: '状态栏',
        detail: item.text,
        kind: 'status'
      })
    }
    for (const item of plugin.contributes?.commands ?? []) {
      rows.push({
        key: `command:${item.key}`,
        label: '命令',
        detail: item.key.startsWith('/') ? item.key : `/${item.key}`,
        kind: 'command'
      })
    }
    return rows
  }

  for (const item of state.contributions.statusBar.filter((x) => x.pluginId === plugin.id)) {
    rows.push({
      key: item.id,
      label: '状态栏',
      detail: item.kind === 'text' ? item.text : '运行时组件',
      kind: 'status'
    })
  }
  for (const item of state.contributions.commands.filter((x) => x.pluginId === plugin.id)) {
    rows.push({
      key: item.id,
      label: '命令',
      detail: item.title,
      kind: 'command'
    })
  }
  for (const item of state.contributions.settings.filter((x) => x.pluginId === plugin.id)) {
    rows.push({
      key: item.id,
      label: '设置页',
      detail: item.label,
      kind: 'settings'
    })
  }
  for (const item of state.contributions.panelTabs.filter((x) => x.pluginId === plugin.id)) {
    rows.push({
      key: item.id,
      label: '主区页签',
      detail: item.label,
      kind: 'panel'
    })
  }
  for (const theme of plugin.contributes?.themes ?? []) {
    rows.push({
      key: `theme:${theme.name ?? 'main'}`,
      label: '主题',
      detail: theme.name ?? '自定义主题',
      kind: 'theme'
    })
  }
  return rows
}

export function PluginsManagerPage({ onBack }: { onBack: () => void }): JSX.Element {
  const { t } = useI18n()
  const host = usePluginHost()
  const [pageTab, setPageTab] = useState<PageTab>('installed')
  const [activeId, setActiveId] = useState('')
  const [detailTab, setDetailTab] = useState<DetailTab>('overview')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmUninstall, setConfirmUninstall] = useState<InstalledPlugin | null>(null)
  const [installing, setInstalling] = useState<PendingInstall | null>(null)
  const [market, setMarket] = useState<PluginMarketListResult | null>(null)
  const [marketLoading, setMarketLoading] = useState(false)
  const [marketQuery, setMarketQuery] = useState('')
  const [marketCategory, setMarketCategory] = useState('all')
  const toastTimer = useRef<number | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void initPluginHost()
  }, [])

  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    }
  }, [])

  useEffect(() => {
    if (!activeId && host.plugins[0]) setActiveId(host.plugins[0].id)
  }, [activeId, host.plugins])

  useEffect(() => {
    if (activeId && !host.plugins.some((p) => p.id === activeId)) {
      setActiveId(host.plugins[0]?.id ?? '')
    }
  }, [activeId, host.plugins])

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: PointerEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [menuOpen])

  const showToast = (text: string): void => {
    setToast(text)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 2600)
  }

  const active = host.plugins.find((p) => p.id === activeId) ?? host.plugins[0] ?? null
  const activeError = active ? host.errors[active.id] || active.error || '' : ''

  const enabled = useMemo(
    () => host.plugins.filter((p) => !p.error && p.enabled && matchesQuery(p, query)),
    [host.plugins, query]
  )
  const disabled = useMemo(
    () => host.plugins.filter((p) => !p.error && !p.enabled && matchesQuery(p, query)),
    [host.plugins, query]
  )
  const broken = useMemo(
    () => host.plugins.filter((p) => !!p.error && matchesQuery(p, query)),
    [host.plugins, query]
  )

  const marketIndex = market?.ok ? market.index : undefined
  const marketCategories = useMemo(() => {
    const seen = new Set<string>()
    for (const entry of marketIndex?.plugins ?? []) {
      if (entry.category) seen.add(entry.category)
    }
    return ['all', ...seen]
  }, [marketIndex])
  const marketEntries = useMemo(() => {
    const q = marketQuery.trim().toLowerCase()
    return (marketIndex?.plugins ?? []).filter((entry) => {
      const catOk = marketCategory === 'all' || entry.category === marketCategory
      const text = [entry.name, entry.author, entry.description, ...(entry.tags ?? [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return catOk && (!q || text.includes(q))
    })
  }, [marketIndex, marketCategory, marketQuery])

  const loadMarket = async (force = false): Promise<void> => {
    setMarketLoading(true)
    try {
      const api = window.api?.plugins
      const result = api
        ? await api.market.list(force)
        : {
            ok: false,
            error: 'plugin-api-unavailable',
            source: '',
            fetchedAt: Date.now()
          }
      setMarket(result)
    } catch (e) {
      setMarket({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        source: '',
        fetchedAt: Date.now()
      })
    } finally {
      setMarketLoading(false)
    }
  }

  useEffect(() => {
    if (pageTab === 'market' && !market && !marketLoading) void loadMarket()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageTab, market, marketLoading])

  const handleInstallLocal = async (): Promise<void> => {
    setBusy('inspect-local')
    try {
      const result = await inspectLocalPlugin()
      if (!result.ok) {
        if (result.error !== 'canceled') showToast(pluginErrorText(result.error))
        return
      }
      if (result.preview) setInstalling({ kind: 'local', preview: result.preview })
    } finally {
      setBusy('')
    }
  }

  const handleToggle = async (plugin: InstalledPlugin, next: boolean): Promise<void> => {
    setBusy(plugin.id)
    try {
      const result = await setPluginEnabled(plugin.id, next)
      if (!result.ok) showToast(pluginErrorText(result.error))
      else showToast(next ? `已启用 ${plugin.name}` : `已禁用 ${plugin.name}`)
    } finally {
      setBusy('')
    }
  }

  const handleReload = async (plugin: InstalledPlugin): Promise<void> => {
    setBusy(plugin.id)
    try {
      await reloadPlugin(plugin.id)
      showToast(`已重新加载 ${plugin.name}`)
    } finally {
      setBusy('')
    }
  }

  const handleUninstall = async (): Promise<void> => {
    if (!confirmUninstall) return
    const plugin = confirmUninstall
    setConfirmUninstall(null)
    setBusy(plugin.id)
    try {
      const result = await uninstallPlugin(plugin.id)
      if (!result.ok) showToast(pluginErrorText(result.error))
      else showToast(`已卸载 ${plugin.name}`)
    } finally {
      setBusy('')
    }
  }

  const handleReveal = async (plugin: InstalledPlugin): Promise<void> => {
    const result = await revealPlugin(plugin.id)
    if (!result.ok) showToast(pluginErrorText(result.error))
  }

  const handleCopyId = async (plugin: InstalledPlugin): Promise<void> => {
    try {
      await navigator.clipboard.writeText(plugin.id)
      showToast(`已复制插件 ID：${plugin.id}`)
    } catch {
      showToast('复制失败')
    }
  }

  const startInstall = (entry: PluginMarketEntry): void => {
    const version = entry.versions.find((x) => x.version === entry.latest) ?? entry.versions[0]
    if (!version) {
      showToast('这个插件没有可安装的版本')
      return
    }
    setInstalling({ kind: 'market', entry, version })
  }

  const confirmInstall = async (): Promise<void> => {
    if (!installing) return
    const pending = installing
    const id =
      pending.kind === 'market'
        ? pending.entry.id
        : pending.preview.manifest.id
    const name =
      pending.kind === 'market'
        ? pending.entry.name
        : pending.preview.manifest.name
    const version =
      pending.kind === 'market'
        ? pending.version.version
        : pending.preview.manifest.version
    const busyKey = `install:${id}`
    setBusy(busyKey)
    try {
      const result =
        pending.kind === 'market'
          ? await installPluginFromMarket(pending.entry.id, pending.version.version)
          : await installPluginFromLocal(pending.preview.token)
      if (!result.ok) {
        showToast(pluginErrorText(result.error))
        // 本地 token 是一次性的，失败后重试同一个弹窗没有意义
        if (pending.kind === 'local') setInstalling(null)
        return
      }
      setInstalling(null)
      setActiveId(id)
      setDetailTab('overview')
      setPageTab('installed')
      showToast(`已安装 ${name} · v${version}`)
    } finally {
      setBusy('')
    }
  }

  const featured = marketIndex?.plugins[0]
  const featuredInstalled = featured ? host.plugins.some((p) => p.id === featured.id) : false

  return (
    <section className="plugins-page" aria-label={t('nav.plugins')}>
      <header className="pl-head">
        <button className="pl-iconbtn pl-back" onClick={onBack} title="返回对话">
          <IconChevronLeft width={16} height={16} />
        </button>
        <div className="pl-heading">
          <div className="pl-titleline">
            <h1 className="pl-title">{t('nav.plugins')}</h1>
            <span className="pl-badge pl-badge--mono">PLUGINS</span>
          </div>
          <p className="pl-sub">扩展 CCoder 的外观、面板和工作流；免代码插件不会运行 JavaScript。</p>
        </div>
        <div className="pl-head-actions">
          <div className="pl-segmented">
            <button
              className={pageTab === 'installed' ? 'is-active' : ''}
              onClick={() => setPageTab('installed')}
            >
              已安装 <span>{host.plugins.length}</span>
            </button>
            <button
              className={pageTab === 'market' ? 'is-active' : ''}
              onClick={() => setPageTab('market')}
            >
              市场 <span>{marketIndex?.plugins.length ?? '…'}</span>
            </button>
          </div>
          <button
            className="pl-iconbtn"
            title="刷新"
            onClick={() => {
              void initPluginHost()
              if (pageTab === 'market') void loadMarket(true)
            }}
          >
            <IconRefresh width={15} height={15} />
          </button>
          <button
            className="pl-btn pl-btn--primary"
            disabled={busy === 'inspect-local'}
            onClick={() => void handleInstallLocal()}
          >
            <IconPlus width={14} height={14} />
            {busy === 'inspect-local' ? '选择目录…' : '从本地目录安装'}
          </button>
        </div>
      </header>

      <div className="pl-body">
        {pageTab === 'installed' ? (
          <div className="pl-split">
            <aside className="pl-list">
              <div className="pl-list-tools">
                <label className="pl-search">
                  <IconSearch width={14} height={14} />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜索已安装插件"
                    autoComplete="off"
                  />
                </label>
                <button className="pl-iconbtn" title="重新扫描" onClick={() => void initPluginHost()}>
                  <IconRefresh width={14} height={14} />
                </button>
              </div>
              <div className="pl-list-scroll">
                {host.loading && !host.plugins.length ? (
                  <div className="pl-list-empty">正在扫描插件目录…</div>
                ) : null}
                {!host.loading && !host.plugins.length ? (
                  <div className="pl-list-empty">
                    <IconPlugin width={26} height={26} />
                    <strong>还没有安装插件</strong>
                    <span>从本地目录安装，或去市场看看。</span>
                  </div>
                ) : null}
                <PluginGroup label="已启用" count={enabled.length} />
                {enabled.map((plugin) => (
                  <PluginRow
                    key={plugin.id}
                    plugin={plugin}
                    active={active?.id === plugin.id}
                    onSelect={() => {
                      setActiveId(plugin.id)
                      setDetailTab('overview')
                      setMenuOpen(false)
                    }}
                  />
                ))}
                <PluginGroup label="已禁用" count={disabled.length} />
                {disabled.map((plugin) => (
                  <PluginRow
                    key={plugin.id}
                    plugin={plugin}
                    active={active?.id === plugin.id}
                    onSelect={() => {
                      setActiveId(plugin.id)
                      setDetailTab('overview')
                      setMenuOpen(false)
                    }}
                  />
                ))}
                <PluginGroup label="需要处理" count={broken.length} error />
                {broken.map((plugin) => (
                  <PluginRow
                    key={plugin.id}
                    plugin={plugin}
                    active={active?.id === plugin.id}
                    onSelect={() => {
                      setActiveId(plugin.id)
                      setDetailTab('overview')
                      setMenuOpen(false)
                    }}
                  />
                ))}
                {!!query && !enabled.length && !disabled.length && !broken.length ? (
                  <div className="pl-list-empty">
                    <IconSearch width={24} height={24} />
                    <strong>没有匹配的插件</strong>
                  </div>
                ) : null}
              </div>
              <div className="pl-list-foot">
                <IconFolder width={13} height={13} />
                <code>{host.root || '~/.ccoder/plugins'}</code>
              </div>
            </aside>

            <section className="pl-detail">
              {active ? (
                <PluginDetail
                  plugin={active}
                  host={host}
                  error={activeError}
                  busy={busy === active.id}
                  detailTab={detailTab}
                  menuOpen={menuOpen}
                  menuRef={menuRef}
                  onTab={setDetailTab}
                  onToggle={handleToggle}
                  onReload={handleReload}
                  onReveal={handleReveal}
                  onCopyId={handleCopyId}
                  onUninstall={(plugin) => {
                    setMenuOpen(false)
                    setConfirmUninstall(plugin)
                  }}
                  onMore={() => setMenuOpen((v) => !v)}
                />
              ) : (
                <div className="pl-detail-empty">选择左侧插件查看详情</div>
              )}
            </section>
          </div>
        ) : (
          <div className="pl-market">
            {marketLoading && !market ? (
              <div className="pl-market-state">正在加载市场索引…</div>
            ) : market && !market.ok ? (
              <div className="pl-market-state pl-market-state--error">
                <IconAlert width={26} height={26} />
                <strong>市场暂时不可用</strong>
                <span>{pluginErrorText(market.error)}</span>
                <div className="pl-market-state__actions">
                  <button className="pl-btn pl-btn--ghost" onClick={() => void loadMarket(true)}>
                    <IconRefresh width={13} height={13} />
                    重试
                  </button>
                  <button className="pl-btn pl-btn--ghost" onClick={() => void handleInstallLocal()}>
                    <IconFolder width={13} height={13} />
                    从本地目录安装
                  </button>
                </div>
              </div>
            ) : (
              <>
                {featured ? (
                  <section className="pl-hero">
                    <div className="pl-hero__body">
                      <span className="pl-hero__eyebrow">
                        <IconSpark width={12} height={12} /> 精选插件
                      </span>
                      <h2 className="pl-hero__title">{featured.name}</h2>
                      <p className="pl-hero__desc">{featured.description ?? '来自社区的新插件。'}</p>
                      <div className="pl-hero__meta">
                        {featured.verified ? (
                          <span className="pl-badge pl-badge--plugin">
                            <IconShield width={11} height={11} /> 已验证发布者
                          </span>
                        ) : null}
                        {featured.installs ? <span>{featured.installs} 次安装</span> : null}
                        <span>v{featured.latest}</span>
                        <ModeBadge tier={featured.versions[0]?.tier ?? 'js'} />
                      </div>
                      <div className="pl-hero__actions">
                        <button
                          className="pl-btn pl-btn--plugin"
                          disabled={featuredInstalled || busy === `install:${featured.id}`}
                          onClick={() => startInstall(featured)}
                        >
                          <IconDownload width={14} height={14} />
                          {featuredInstalled ? '已安装' : '安装插件'}
                        </button>
                      </div>
                    </div>
                    <div className="pl-hero__art" aria-hidden="true">
                      <div className="pl-mini">
                        <span>Claude</span>
                        <i />
                        <i />
                        <i />
                      </div>
                      <div className="pl-mini">
                        <span>Codex</span>
                        <i />
                        <i />
                        <i />
                      </div>
                      <div className="pl-mini">
                        <span>DSH</span>
                        <i />
                        <i />
                        <i />
                      </div>
                    </div>
                  </section>
                ) : null}

                <div className="pl-market-toolbar">
                  <div className="pl-filters">
                    {marketCategories.map((category) => (
                      <button
                        key={category}
                        className={`pl-filter ${marketCategory === category ? 'is-active' : ''}`}
                        onClick={() => setMarketCategory(category)}
                      >
                        {category === 'all' ? '全部' : categoryLabel(category)}
                      </button>
                    ))}
                  </div>
                  <label className="pl-search">
                    <IconSearch width={14} height={14} />
                    <input
                      value={marketQuery}
                      onChange={(e) => setMarketQuery(e.target.value)}
                      placeholder="搜索市场"
                      autoComplete="off"
                    />
                  </label>
                </div>

                {marketEntries.length ? (
                  <div className="pl-market-grid">
                    {marketEntries.map((entry) => (
                      <MarketCard
                        key={entry.id}
                        entry={entry}
                        installed={host.plugins.some((p) => p.id === entry.id)}
                        busy={busy === `install:${entry.id}`}
                        onInstall={() => startInstall(entry)}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="pl-market-state">没有找到匹配的插件</div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {confirmUninstall ? (
        <div className="pl-modal-backdrop" onClick={() => setConfirmUninstall(null)}>
          <div className="pl-dialog pl-dialog--confirm" onClick={(e) => e.stopPropagation()}>
            <div className="pl-dialog__head">
              <div className="pl-dialog__mark is-danger">
                <IconTrash width={19} height={19} />
              </div>
              <div>
                <h2 className="pl-dialog__title">卸载 {confirmUninstall.name}？</h2>
                <p className="pl-dialog__sub">插件目录会被删除，插件数据保留 30 天。</p>
              </div>
            </div>
            <div className="pl-dialog__foot">
              <button className="pl-btn pl-btn--ghost" onClick={() => setConfirmUninstall(null)}>
                取消
              </button>
              <button className="pl-btn pl-btn--danger" onClick={() => void handleUninstall()}>
                卸载
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {installing ? (
        <InstallDialog
          view={
            installing.kind === 'market'
              ? {
                  kind: 'market',
                  name: installing.entry.name,
                  version: installing.version.version,
                  tier: installing.version.tier ?? 'js',
                  permissions: installing.version.permissions ?? [],
                  source: installing.version.url,
                  description: installing.entry.description ?? '',
                  author: installing.entry.author ?? ''
                }
              : {
                  kind: 'local',
                  name: installing.preview.manifest.name,
                  version: installing.preview.manifest.version,
                  tier: installing.preview.manifest.tier,
                  permissions: installing.preview.manifest.permissions,
                  source: installing.preview.source,
                  description: installing.preview.manifest.description ?? '',
                  author: installing.preview.manifest.author ?? ''
                }
          }
          busy={
            busy ===
            `install:${
              installing.kind === 'market'
                ? installing.entry.id
                : installing.preview.manifest.id
            }`
          }
          onCancel={() => setInstalling(null)}
          onConfirm={() => void confirmInstall()}
        />
      ) : null}

      {toast ? (
        <div className="pl-toast">
          <IconCheck width={14} height={14} />
          <span>{toast}</span>
        </div>
      ) : null}
    </section>
  )
}

function matchesQuery(plugin: InstalledPlugin, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return `${plugin.name} ${plugin.description} ${plugin.id}`.toLowerCase().includes(q)
}

function PluginGroup({
  label,
  count,
  error
}: {
  label: string
  count: number
  error?: boolean
}): JSX.Element | null {
  if (!count) return null
  return (
    <div className={`pl-group ${error ? 'is-error' : ''}`}>
      <span>{label}</span>
      <span>{count}</span>
    </div>
  )
}

function PluginRow({
  plugin,
  active,
  onSelect
}: {
  plugin: InstalledPlugin
  active: boolean
  onSelect: () => void
}): JSX.Element {
  const state = plugin.error ? '加载失败' : plugin.enabled ? '已启用' : '已禁用'
  return (
    <button
      className={`pl-row ${active ? 'is-active' : ''} ${plugin.error ? 'is-error' : ''} ${
        !plugin.enabled && !plugin.error ? 'is-off' : ''
      }`}
      onClick={onSelect}
    >
      <span className={`pl-row__icon ${plugin.tier === 'js' ? 'is-code' : ''}`}>
        <PluginGlyph tier={plugin.tier} />
      </span>
      <span className="pl-row__main">
        <span className="pl-row__line">
          <span className="pl-row__name">{plugin.name}</span>
          <span className="pl-row__ver">{plugin.version}</span>
        </span>
        <span className="pl-row__desc">{plugin.error || plugin.description || '没有描述'}</span>
      </span>
      <span className={`pl-row__state ${plugin.error ? 'is-error' : plugin.enabled ? 'is-on' : ''}`}>
        {state}
      </span>
    </button>
  )
}

function MarketCard({
  entry,
  installed,
  busy,
  onInstall
}: {
  entry: PluginMarketEntry
  installed: boolean
  busy: boolean
  onInstall: () => void
}): JSX.Element {
  const version = entry.versions.find((x) => x.version === entry.latest) ?? entry.versions[0]
  const tier = version?.tier ?? 'js'
  return (
    <article className="pl-card">
      <div className="pl-card__head">
        <span className={`pl-card__icon ${tier === 'js' ? 'is-code' : ''}`}>
          <PluginGlyph tier={tier} />
        </span>
        <div className="pl-card__titlebox">
          <div className="pl-card__name">
            {entry.name}
            {entry.verified ? (
              <span className="pl-verified" title="已验证发布者">
                <IconShield width={12} height={12} />
              </span>
            ) : null}
          </div>
          <div className="pl-card__author">by {entry.author || 'unknown'}</div>
        </div>
      </div>
      <p className="pl-card__desc">{entry.description || '没有描述'}</p>
      <div className="pl-card__tags">
        <ModeBadge tier={tier} />
        {entry.category ? <span className="pl-tag">{categoryLabel(entry.category)}</span> : null}
        {(entry.tags ?? []).slice(0, 2).map((tag) => (
          <span className="pl-tag" key={tag}>
            {tag}
          </span>
        ))}
      </div>
      <div className="pl-card__foot">
        {entry.rating ? (
          <span className="pl-card__stat">
            <IconSpark width={11} height={11} />
            {entry.rating}
          </span>
        ) : null}
        {entry.installs ? (
          <span className="pl-card__stat">
            <IconDownload width={11} height={11} />
            {entry.installs}
          </span>
        ) : null}
        <button
          className="pl-btn pl-btn--ghost pl-btn--xs"
          disabled={installed || busy}
          onClick={onInstall}
        >
          {installed ? '已安装' : busy ? '安装中…' : '安装'}
        </button>
      </div>
    </article>
  )
}

function PluginDetail({
  plugin,
  host,
  error,
  busy,
  detailTab,
  menuOpen,
  menuRef,
  onTab,
  onToggle,
  onReload,
  onReveal,
  onCopyId,
  onUninstall,
  onMore
}: {
  plugin: InstalledPlugin
  host: ReturnType<typeof usePluginHost>
  error: string
  busy: boolean
  detailTab: DetailTab
  menuOpen: boolean
  menuRef: RefObject<HTMLDivElement>
  onTab: (tab: DetailTab) => void
  onToggle: (plugin: InstalledPlugin, enabled: boolean) => void
  onReload: (plugin: InstalledPlugin) => void
  onReveal: (plugin: InstalledPlugin) => void
  onCopyId: (plugin: InstalledPlugin) => void
  onUninstall: (plugin: InstalledPlugin) => void
  onMore: () => void
}): JSX.Element {
  const contributions = contributionRows(plugin, host)
  const loaded = host.loaded.includes(plugin.id)
  const errorText = pluginErrorText(error)
  const status = error
    ? '加载失败'
    : plugin.enabled
      ? loaded
        ? '已加载'
        : '加载中'
      : '已禁用'

  return (
    <>
      <div className="pl-detail-head">
        <div className={`pl-detail-mark ${plugin.tier === 'js' ? 'is-code' : ''} ${error ? 'is-danger' : ''}`}>
          <PluginGlyph tier={plugin.tier} size={25} />
        </div>
        <div className="pl-detail-titlebox">
          <div className="pl-detail-titleline">
            <h2 className="pl-detail-title">{plugin.name}</h2>
            {plugin.verified ? (
              <span className="pl-verified" title="已验证发布者">
                <IconShield width={15} height={15} />
              </span>
            ) : null}
            <span className="pl-badge pl-badge--mono">v{plugin.version}</span>
            {error ? <span className="pl-badge pl-badge--bad">加载失败</span> : null}
          </div>
          <div className="pl-detail-sub">
            <span>{plugin.author || '本地插件'}</span>
            <span className="pl-dotsep">·</span>
            <code>{plugin.id}</code>
            <span className="pl-dotsep">·</span>
            <span>安装于 {formatInstalledAt(plugin.installedAt)}</span>
          </div>
        </div>
        <div className="pl-detail-actions">
          {!error ? (
            <div className="pl-toggle-wrap">
              <span>{plugin.enabled ? '已启用' : '已禁用'}</span>
              <label className="pl-switch">
                <input
                  type="checkbox"
                  checked={plugin.enabled && !busy}
                  disabled={busy}
                  onChange={(e) => onToggle(plugin, e.target.checked)}
                />
                <span className="pl-switch__track" />
              </label>
            </div>
          ) : null}
          <button
            className="pl-iconbtn"
            title="重新加载"
            disabled={busy}
            onClick={() => onReload(plugin)}
          >
            <IconRefresh width={15} height={15} />
          </button>
          <div className="pl-menu-wrap" ref={menuRef}>
            <button className="pl-iconbtn" title="更多操作" onClick={onMore}>
              <IconMore width={15} height={15} />
            </button>
            {menuOpen ? (
              <div className="pl-menu">
                <button onClick={() => onReveal(plugin)}>
                  <IconFolder width={13} height={13} />打开插件目录
                </button>
                <button onClick={() => onCopyId(plugin)}>
                  <IconCopy width={13} height={13} />复制插件 ID
                </button>
                <div className="pl-menu__sep" />
                <button className="is-danger" onClick={() => onUninstall(plugin)}>
                  <IconTrash width={13} height={13} />卸载插件
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="pl-detail-meta">
        <ModeBadge tier={plugin.tier} />
        <span className="pl-badge">{formatBytes(plugin.size)}</span>
        <span className={`pl-badge ${error ? 'pl-badge--bad' : plugin.enabled ? 'pl-badge--ok' : ''}`}>
          <i className="pl-dot" />
          {status}
        </span>
        {plugin.fromMarket ? (
          <span className="pl-badge">
            <IconDownload width={11} height={11} />
            市场安装
          </span>
        ) : (
          <span className="pl-badge">
            <IconFolder width={11} height={11} />
            本地安装
          </span>
        )}
      </div>

      <div className="pl-detail-tabs">
        <DetailTabButton label="概览" value="overview" current={detailTab} onClick={onTab} />
        <DetailTabButton
          label="贡献"
          value="contributions"
          current={detailTab}
          onClick={onTab}
          count={contributions.length}
        />
        <DetailTabButton
          label="权限"
          value="permissions"
          current={detailTab}
          onClick={onTab}
          count={plugin.permissions.length}
        />
        <DetailTabButton label="更新日志" value="changelog" current={detailTab} onClick={onTab} />
      </div>

      <div className="pl-detail-body">
        {detailTab === 'overview' ? (
          <>
            {error ? (
              <div className="pl-card pl-card--error">
                <div className="pl-card__headline">
                  <span>
                    <IconAlert width={14} height={14} /> 加载失败
                  </span>
                  <span>已自动禁用</span>
                </div>
                <p>{errorText || '插件在 activate() 时抛出异常。'}</p>
                <pre className="pl-error-code">{error}</pre>
                <div className="pl-card__actions">
                  <button className="pl-btn pl-btn--ghost pl-btn--xs" onClick={() => onReload(plugin)}>
                    <IconRefresh width={12} height={12} />
                    重新加载
                  </button>
                </div>
              </div>
            ) : null}
            <div className="pl-detail-grid">
              <div className="pl-card">
                <div className="pl-card__heading">关于</div>
                <p className="pl-card__body">{plugin.description || '这个插件没有填写描述。'}</p>
                <div className="pl-source">
                  <IconFolder width={12} height={12} />
                  <code>{plugin.dir}</code>
                </div>
              </div>
              <div className="pl-card">
                <div className="pl-card__heading">运行状态</div>
                <div className="pl-statusline">
                  <i className={`pl-dot ${error ? 'is-error' : plugin.enabled ? 'is-on' : ''}`} />
                  {status}
                  <small>{error ? '· 查看下方错误' : `· ${host.contributions.statusBar.filter((x) => x.pluginId === plugin.id).length} 个贡献点`}</small>
                </div>
                <div className="pl-stats">
                  <div>
                    <b>{contributions.length}</b>
                    <span>贡献点</span>
                  </div>
                  <div>
                    <b>{plugin.permissions.length}</b>
                    <span>权限</span>
                  </div>
                  <div>
                    <b>{formatBytes(plugin.size)}</b>
                    <span>体积</span>
                  </div>
                </div>
              </div>
            </div>
            <div className="pl-card">
              <div className="pl-card__heading">
                贡献 <span>{contributions.length}</span>
              </div>
              {contributions.length ? (
                <div className="pl-contribs">
                  {contributions.map((row) => (
                    <div className="pl-contrib" key={row.key}>
                      <span className="pl-contrib__icon">{contributionIcon(row.kind)}</span>
                      <span className="pl-contrib__main">
                        <span>{row.label}</span>
                        <small>{row.detail}</small>
                      </span>
                      <span className="pl-contrib__kind">{row.kind}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="pl-muted">这个插件还没有注册界面贡献。</div>
              )}
            </div>
            <div className="pl-card">
              <div className="pl-card__heading">
                权限 <span>{plugin.permissions.length}</span>
              </div>
              <p className="pl-card__hint">更新导致权限增加时，CCoder 会再次向你确认。</p>
              <PermissionRows permissions={plugin.permissions} />
            </div>
          </>
        ) : null}

        {detailTab === 'contributions' ? (
          <div className="pl-card">
            <div className="pl-card__heading">
              界面贡献 <span>{contributions.length}</span>
            </div>
            <p className="pl-card__hint">这些入口由插件注册，禁用或卸载时宿主会自动回收。</p>
            {contributions.length ? (
              <div className="pl-contribs">
                {contributions.map((row) => (
                  <div className="pl-contrib" key={row.key}>
                    <span className="pl-contrib__icon">{contributionIcon(row.kind)}</span>
                    <span className="pl-contrib__main">
                      <span>{row.label}</span>
                      <small>{row.detail}</small>
                    </span>
                    <span className="pl-contrib__kind">{row.kind}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="pl-muted">没有注册贡献。</div>
            )}
          </div>
        ) : null}

        {detailTab === 'permissions' ? (
          <>
            <div className="pl-card">
              <div className="pl-card__heading">
                权限清单 <span>{plugin.permissions.length}</span>
              </div>
              <p className="pl-card__hint">
                点击任意权限，查看它具体能访问哪些数据、不会访问哪些数据。
              </p>
              <PermissionRows permissions={plugin.permissions} />
            </div>
            <div className="pl-card">
              <div className="pl-card__heading">风险说明</div>
              <p className="pl-card__body">
                <b>低风险</b>：只能读写插件自己的数据或界面。
                <br />
                <b>中风险</b>：可以读取会话事件或访问指定的网络主机。
                <br />
                <b>高风险</b>：可以执行外部命令或启动 agent 轮次，只应安装可信来源。
              </p>
            </div>
          </>
        ) : null}

        {detailTab === 'changelog' ? (
          <div className="pl-card">
            <div className="pl-card__heading">更新日志</div>
            <div className="pl-changelog">
              <div className="pl-cl-item">
                <span className="pl-cl-dot" />
                <div>
                  <div className="pl-cl-head">
                    <code>v{plugin.version}</code>
                    <span>{formatInstalledAt(plugin.updatedAt)}</span>
                  </div>
                  <p>
                    {plugin.fromMarket ? '从市场安装 / 更新。' : '从本地目录安装 / 更新。'}
                    本地插件没有独立的更新日志文件，版本信息来自 manifest.json。
                  </p>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </>
  )
}

function DetailTabButton({
  label,
  value,
  current,
  onClick,
  count
}: {
  label: string
  value: DetailTab
  current: DetailTab
  onClick: (tab: DetailTab) => void
  count?: number
}): JSX.Element {
  return (
    <button
      className={`pl-detail-tab ${current === value ? 'is-active' : ''}`}
      onClick={() => onClick(value)}
    >
      {label}
      {typeof count === 'number' ? <span>{count}</span> : null}
    </button>
  )
}

function InstallDialog({
  view,
  busy,
  onCancel,
  onConfirm
}: {
  view: InstallView
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  const permissions = view.permissions
  const tier = view.tier
  return (
    <div className="pl-modal-backdrop" onClick={onCancel}>
      <div className="pl-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="pl-dialog__head">
          <div className={`pl-dialog__mark ${tier === 'js' ? 'is-code' : ''}`}>
            <PluginGlyph tier={tier} size={20} />
          </div>
          <div className="pl-dialog__titlebox">
            <h2 className="pl-dialog__title">安装 {view.name}</h2>
            <p className="pl-dialog__sub">
              {view.kind === 'local'
                ? '从本地目录安装 · 安装前请确认权限'
                : '来自插件市场 · 安装前请确认权限'}
            </p>
          </div>
          <button className="pl-iconbtn" onClick={onCancel} title="关闭">
            <IconX width={15} height={15} />
          </button>
        </div>
        <div className="pl-dialog__body">
          <div className="pl-source">
            {view.kind === 'local' ? (
              <IconFolder width={13} height={13} />
            ) : (
              <IconExternal width={13} height={13} />
            )}
            <code>{view.source}</code>
          </div>
          <div className="pl-dialog__preview">
            <span className={`pl-dialog__previewmark ${tier === 'js' ? 'is-code' : ''}`}>
              <PluginGlyph tier={tier} size={18} />
            </span>
            <div>
              <div className="pl-dialog__previewname">{view.name}</div>
              <div className="pl-dialog__previewsub">
                v{view.version} · {tier === 'js' ? '需要运行代码' : '免代码'}
                {view.author ? ` · ${view.author}` : ''}
              </div>
            </div>
            <ModeBadge tier={tier} />
          </div>
          {view.description ? (
            <p className="pl-dialog__desc">{view.description}</p>
          ) : null}
          <div className="pl-dialog__section">
            <IconShield width={13} height={13} />
            将请求以下权限
            <span>点击权限查看具体数据</span>
          </div>
          <PermissionRows permissions={permissions} />
          <div className="pl-warning">
            <IconAlert width={14} height={14} />
            <span>
              {tier === 'js'
                ? '插件代码会在应用内运行，并可能访问你声明的数据。只安装你信任的来源；权限增加时会再次向你确认。'
                : '这个插件不运行 JavaScript，只会应用样式与静态配置。安装前仍请确认来源。'}
            </span>
          </div>
        </div>
        <div className="pl-dialog__foot">
          <span className="pl-muted">安装后可随时禁用或卸载</span>
          <button className="pl-btn pl-btn--ghost" onClick={onCancel}>
            取消
          </button>
          <button className="pl-btn pl-btn--primary" disabled={busy} onClick={onConfirm}>
            <IconDownload width={14} height={14} />
            {busy ? '安装中…' : '安装并启用'}
          </button>
        </div>
      </div>
    </div>
  )
}
