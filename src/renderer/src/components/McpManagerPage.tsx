import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  NATIVE_MCP_TRANSPORTS,
  emptyMcpInput,
  toMcpInput,
  validateMcpServer,
  type DshHomeOption,
  type McpKeyValue,
  type McpListResult,
  type McpMigrationEntry,
  type McpMigrationPreview,
  type McpScope,
  type McpServerInput,
  type McpServerView,
  type McpTestResult,
  type McpTransport
} from '@shared/mcp'
import { CLI_IDS, type CliId } from '@shared/settings'
import { formatRelativeTime, type MessageKey } from '@shared/i18n'
import { useI18n } from '../i18n'
import { ConfirmModal } from './ConfirmModal'
import {
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconClaudeCode,
  IconClock,
  IconCode,
  IconCopy,
  IconDeepSeek,
  IconFile,
  IconFolder,
  IconGlobe,
  IconInfo,
  IconLog,
  IconMessage,
  IconOpenAI,
  IconPencil,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconServer,
  IconShield,
  IconTrash,
  IconUser,
  IconWrench,
  IconX
} from './Icons'

/**
 * MCP 管理页。
 *
 * 直接读写每个 CLI 的原生配置：Claude 的 ~/.claude.json / .mcp.json、
 * Codex 的 config.toml、DSH 的 cordis.patch.yml。主进程负责备份和原子写；
 * 这里只做展示、表单和迁移提示。
 */

const CLI_META: Record<
  CliId,
  {
    short: string
    name: string
    icon: (p: { width?: number; height?: number }) => JSX.Element
    color: string
  }
> = {
  claude: { short: 'Claude', name: 'Claude Code', icon: IconClaudeCode, color: '#d97757' },
  codex: { short: 'Codex', name: 'Codex CLI', icon: IconOpenAI, color: 'var(--text)' },
  dsh: { short: 'DSH', name: 'DeepSeek Harness', icon: IconDeepSeek, color: '#6aa8ff' }
}

type Filter = 'all' | 'connected' | 'error' | 'disabled'
type DetailTab = 'tools' | 'resources' | 'prompts' | 'diagnostics'

interface DrawerState {
  mode: 'add' | 'edit'
  input: McpServerInput
  /** 编辑时的原名，用于允许保留历史特殊名称、以及改名提示 */
  originalName?: string
}

interface McpManagerPageProps {
  cwd: string
  openedCwds?: string[]
  dshAuthMode?: 'channel' | 'official'
  dshChannelId?: string | null
}

function statusClass(s: McpServerView): string {
  if (s.status === 'connected') return 'ok'
  if (s.status === 'error') return 'bad'
  if (s.status === 'disabled') return 'off'
  return 'idle'
}

const SCOPE_LABEL: Record<McpScope, string> = {
  user: 'mcp.scope.user',
  project: 'mcp.scope.project',
  local: 'mcp.scope.local',
  global: 'mcp.scope.global',
  home: 'mcp.scope.home'
}

function shortPath(p: string, home?: string): string {
  if (!p) return '—'
  const h = home || ''
  if (h && p.toLowerCase().startsWith(h.toLowerCase())) return `~${p.slice(h.length)}`
  return p
}

function emptyDrawer(cli: CliId, cwd: string): DrawerState {
  return { mode: 'add', input: { ...emptyMcpInput(cli), cwd } }
}

export function McpManagerPage({
  cwd,
  openedCwds = [],
  dshAuthMode,
  dshChannelId
}: McpManagerPageProps): JSX.Element {
  const { t, locale } = useI18n()
  const available = typeof window !== 'undefined' && !!window.api?.mcp
  const [activeCli, setActiveCli] = useState<CliId>('claude')
  const [lists, setLists] = useState<Partial<Record<CliId, McpListResult>>>({})
  const [selected, setSelected] = useState<Partial<Record<CliId, string>>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [testingAll, setTestingAll] = useState(false)
  const [testingId, setTestingId] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [tab, setTab] = useState<DetailTab>('tools')
  const [toolQuery, setToolQuery] = useState('')
  const [drawer, setDrawer] = useState<DrawerState | null>(null)
  const [drawerError, setDrawerError] = useState('')
  const [drawerTesting, setDrawerTesting] = useState(false)
  const [drawerTest, setDrawerTest] = useState<McpTestResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<McpServerView | null>(null)
  const [toast, setToast] = useState('')
  const toastTimer = useRef<number | null>(null)

  /** 当前用于 Claude local/project 与 Codex 的工作区 */
  const [selectedCwd, setSelectedCwd] = useState(cwd)
  useEffect(() => {
    if (!selectedCwd && cwd) setSelectedCwd(cwd)
  }, [cwd, selectedCwd])
  const workspaces = useMemo(() => {
    const out: string[] = []
    for (const p of [selectedCwd, cwd, ...openedCwds]) {
      const v = p.trim()
      if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v)
    }
    return out
  }, [selectedCwd, cwd, openedCwds])

  /** DSH 当前管理的 home */
  const [dshHomes, setDshHomes] = useState<DshHomeOption[]>([])
  const [dshHome, setDshHome] = useState('')

  /** 旧 store 迁移 */
  const [migration, setMigration] = useState<McpMigrationPreview | null>(null)
  const [migrationOpen, setMigrationOpen] = useState(false)
  const [migrating, setMigrating] = useState(false)
  const [migrationSelected, setMigrationSelected] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!migration) return
    const next: Record<string, boolean> = {}
    for (const e of migration.entries) {
      next[e.legacyId] = e.status === 'migrate' || e.status === 'existing'
    }
    setMigrationSelected(next)
  }, [migration])

  const loadMigration = useCallback(async (): Promise<void> => {
    if (!available) return
    try {
      setMigration(await window.api!.mcp.migration(dshHome || undefined))
    } catch {
      // 迁移提示失败不影响主流程
    }
  }, [available, dshHome])

  useEffect(() => {
    if (!available) return
    let alive = true
    void window.api!.mcp
      .dshHomes()
      .then((homes) => {
        if (!alive) return
        setDshHomes(homes)
        setDshHome((cur) => cur || homes.find((h) => h.active)?.path || homes[0]?.path || '')
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [available, dshAuthMode, dshChannelId])

  useEffect(() => {
    void loadMigration()
  }, [loadMigration])

  const showToast = useCallback((text: string): void => {
    setToast(text)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 2200)
  }, [])

  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    }
  }, [])

  const applyList = useCallback((next: McpListResult): void => {
    setLists((cur) => ({ ...cur, [next.cli]: next }))
    setSelected((cur) => {
      const old = cur[next.cli]
      if (old && next.servers.some((s) => s.id === old)) return cur
      return { ...cur, [next.cli]: next.servers[0]?.id ?? '' }
    })
  }, [])

  const refreshAll = useCallback(async (): Promise<void> => {
    if (!available) {
      setLoading(false)
      setLoadError(t('mcp.error.unavailable'))
      return
    }
    setLoadError('')
    const projectCwd = selectedCwd || cwd
    const results = await Promise.all(
      CLI_IDS.map((cli) =>
        window.api!.mcp
          .list(cli, projectCwd, cli === 'dsh' ? dshHome : undefined)
          .catch(() => null)
      )
    )
    const failed = results.filter((x) => !x).length
    for (const r of results) if (r) applyList(r)
    setLoading(false)
    if (failed) setLoadError(t('mcp.error.loadFailed'))
  }, [applyList, available, cwd, dshHome, selectedCwd, t])

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  useEffect(() => {
    setQuery('')
    setFilter('all')
    setToolQuery('')
    setTab('tools')
  }, [activeCli])

  useEffect(() => {
    if (!drawer && !deleteTarget) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (drawer) setDrawer(null)
      else setDeleteTarget(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawer, deleteTarget])

  const current = lists[activeCli]
  const allServers = current?.servers ?? []
  const stats = useMemo(() => {
    return {
      total: allServers.length,
      connected: allServers.filter((s) => s.status === 'connected').length,
      errors: allServers.filter((s) => s.status === 'error').length,
      disabled: allServers.filter((s) => s.status === 'disabled').length,
      tools: allServers
        .filter((s) => s.status === 'connected')
        .reduce((n, s) => n + s.tools.length, 0)
    }
  }, [allServers])

  const selectedId = selected[activeCli] ?? allServers[0]?.id ?? ''
  const server = allServers.find((s) => s.id === selectedId) ?? allServers[0] ?? null

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return allServers.filter((s) => {
      if (filter === 'connected' && s.status !== 'connected') return false
      if (filter === 'error' && s.status !== 'error') return false
      if (filter === 'disabled' && s.status !== 'disabled') return false
      if (!q) return true
      return [s.name, s.url, s.command, s.scope, ...s.tools.map((x) => x.name)]
        .join(' ')
        .toLowerCase()
        .includes(q)
    })
  }, [allServers, filter, query])

  const filteredTools = useMemo(() => {
    if (!server) return []
    const q = toolQuery.trim().toLowerCase()
    if (!q) return server.tools
    return server.tools.filter((x) => `${x.name} ${x.description}`.toLowerCase().includes(q))
  }, [server, toolQuery])

  const cliTabStats = (cli: CliId): { total: number; tools: number; errors: number } => {
    const list = lists[cli]?.servers ?? []
    return {
      total: list.length,
      tools: list
        .filter((s) => s.status === 'connected')
        .reduce((n, s) => n + s.tools.length, 0),
      errors: list.filter((s) => s.status === 'error').length
    }
  }

  const projectCwd = selectedCwd || cwd

  const testAll = async (): Promise<void> => {
    if (!available || testingAll) return
    setTestingAll(true)
    try {
      applyList(
        await window.api!.mcp.testAll(
          activeCli,
          projectCwd,
          activeCli === 'dsh' ? dshHome : undefined
        )
      )
    } catch {
      showToast(t('mcp.error.testFailed'))
    } finally {
      setTestingAll(false)
    }
  }

  const testOne = async (view: McpServerView): Promise<void> => {
    if (!available || testingId || testingAll) return
    if (view.transport === 'sse') {
      showToast(t('mcp.error.sseUnsupported'))
      return
    }
    setTestingId(view.id)
    try {
      const result = await window.api!.mcp.test(activeCli, toMcpInput(view))
      applyList(
        await window.api!.mcp.list(
          activeCli,
          projectCwd,
          activeCli === 'dsh' ? dshHome : undefined
        )
      )
      showToast(
        result.ok
          ? t('mcp.toast.testOk', { n: result.tools.length, ms: result.latencyMs })
          : t('mcp.toast.testBad', { error: result.error })
      )
    } catch {
      showToast(t('mcp.error.testFailed'))
    } finally {
      setTestingId('')
    }
  }

  const toggleEnabled = async (view: McpServerView): Promise<void> => {
    if (!available || view.readOnly) return
    setSaving(true)
    try {
      const result = await window.api!.mcp.setEnabled(
        activeCli,
        view.id,
        !view.enabled,
        projectCwd,
        activeCli === 'dsh' ? dshHome : undefined
      )
      if (!result.ok) {
        showToast(t((result.errorKey ?? 'mcp.error.saveFailed') as MessageKey))
      } else {
        applyList(result.list)
      }
    } catch {
      showToast(t('mcp.error.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const openAdd = (): void => {
    const box = emptyDrawer(activeCli, projectCwd)
    const scopeHasCwd = box.input.scope === 'local' || box.input.scope === 'project'
    box.input.cwd = scopeHasCwd ? projectCwd : ''
    box.input.workingDir = ''
    setDrawer(box)
    setDrawerError('')
    setDrawerTest(null)
  }

  const openEdit = (view: McpServerView): void => {
    setDrawer({ mode: 'edit', input: toMcpInput(view), originalName: view.name })
    setDrawerError('')
    setDrawerTest(null)
  }

  const patchDrawer = (patch: Partial<McpServerInput>): void => {
    setDrawer((cur) => (cur ? { ...cur, input: { ...cur.input, ...patch } } : cur))
    setDrawerTest(null)
  }

  const setTransport = (transport: McpTransport): void => {
    patchDrawer({ transport })
  }

  const setScope = (scope: McpScope): void => {
    const scopeHasCwd = scope === 'local' || scope === 'project'
    patchDrawer({ scope, cwd: scopeHasCwd ? projectCwd : '' })
  }

  const testDrawer = async (): Promise<void> => {
    if (!drawer || !available || drawerTesting) return
    const error = validateMcpServer(activeCli, drawer.input, drawer.originalName)
    if (error) {
      setDrawerError(error)
      return
    }
    if (drawer.input.transport === 'sse') {
      setDrawerError('mcp.error.sseUnsupported')
      return
    }
    setDrawerError('')
    setDrawerTesting(true)
    try {
      // 草稿不带 id：主进程不会把这次探测缓存到一个尚未保存的配置上
      setDrawerTest(await window.api!.mcp.test(activeCli, { ...drawer.input, id: undefined }))
    } catch {
      setDrawerError('mcp.error.testFailed')
    } finally {
      setDrawerTesting(false)
    }
  }

  const saveDrawer = async (): Promise<void> => {
    if (!drawer || !available || saving) return
    const error = validateMcpServer(activeCli, drawer.input, drawer.originalName)
    if (error) {
      setDrawerError(error)
      return
    }
    setSaving(true)
    setDrawerError('')
    try {
      const result = await window.api!.mcp.save(
        activeCli,
        drawer.input,
        projectCwd,
        activeCli === 'dsh' ? dshHome : undefined
      )
      if (!result.ok) {
        setDrawerError(result.errorKey ?? 'mcp.error.saveFailed')
        return
      }
      applyList(result.list)
      if (result.serverId) {
        setSelected((cur) => ({ ...cur, [activeCli]: result.serverId! }))
      }
      const name = drawer.input.name.trim()
      showToast(
        t(drawer.mode === 'add' ? 'mcp.toast.added' : 'mcp.toast.saved', {
          name,
          cli: CLI_META[activeCli].short
        })
      )
      setDrawer(null)
    } catch {
      setDrawerError('mcp.error.saveFailed')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!deleteTarget || !available) return
    const target = deleteTarget
    setDeleteTarget(null)
    try {
      const result = await window.api!.mcp.remove(
        activeCli,
        target.id,
        projectCwd,
        activeCli === 'dsh' ? dshHome : undefined
      )
      if (!result.ok) {
        showToast(t((result.errorKey ?? 'mcp.error.saveFailed') as MessageKey))
        return
      }
      applyList(result.list)
      showToast(t('mcp.toast.removed', { name: target.name }))
    } catch {
      showToast(t('mcp.error.saveFailed'))
    }
  }

  const openConfig = async (scope: McpScope): Promise<void> => {
    if (!available) return
    try {
      const r = await window.api!.mcp.openConfig(
        activeCli,
        scope,
        projectCwd,
        activeCli === 'dsh' ? dshHome : undefined
      )
      if (!r.ok) showToast(r.error || t('mcp.error.openFailed'))
    } catch {
      showToast(t('mcp.error.openFailed'))
    }
  }

  const revealConfig = async (scope: McpScope): Promise<void> => {
    if (!available) return
    try {
      const r = await window.api!.mcp.revealConfig(
        activeCli,
        scope,
        projectCwd,
        activeCli === 'dsh' ? dshHome : undefined
      )
      if (!r.ok) showToast(r.error || t('mcp.error.openFailed'))
    } catch {
      showToast(t('mcp.error.openFailed'))
    }
  }

  const reload = (): void => {
    void refreshAll()
    void loadMigration()
  }

  const applyMigration = async (): Promise<void> => {
    if (!migration || migrating) return
    const ids = migration.entries
      .filter(
        (e) =>
          migrationSelected[e.legacyId] &&
          (e.status === 'migrate' || e.status === 'existing')
      )
      .map((e) => e.legacyId)
    if (!ids.length) return
    setMigrating(true)
    try {
      const result = await window.api!.mcp.migrate(
        ids,
        activeCli === 'dsh' ? dshHome : dshHome || undefined
      )
      if (result.ok) {
        showToast(t('mcp.migrate.done', { n: result.migrated }))
      } else {
        showToast(t('mcp.migrate.partial', { n: result.migrated, failed: result.failed.length }))
      }
      setMigrationOpen(false)
      reload()
    } catch {
      showToast(t('mcp.migrate.failed'))
    } finally {
      setMigrating(false)
    }
  }

  const copyEndpoint = async (value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      showToast(t('mcp.toast.copied'))
    } catch {
      showToast(t('mcp.error.copyFailed'))
    }
  }

  const setKv = (
    field: 'env' | 'headers',
    index: number,
    patch: Partial<McpKeyValue>
  ): void => {
    if (!drawer) return
    const list = drawer.input[field].map((kv, i) => (i === index ? { ...kv, ...patch } : kv))
    patchDrawer({ [field]: list } as Partial<McpServerInput>)
  }

  const addKv = (field: 'env' | 'headers'): void => {
    if (!drawer) return
    patchDrawer({ [field]: [...drawer.input[field], { key: '', value: '' }] } as Partial<McpServerInput>)
  }

  const removeKv = (field: 'env' | 'headers', index: number): void => {
    if (!drawer) return
    patchDrawer({
      [field]: drawer.input[field].filter((_, i) => i !== index)
    } as Partial<McpServerInput>)
  }

  const tabCount = (currentTab: DetailTab): number => {
    if (!server) return 0
    if (currentTab === 'tools') return server.tools.length
    if (currentTab === 'resources') return server.resources.length
    if (currentTab === 'prompts') return server.prompts.length
    return server.status === 'error' ? 1 : 0
  }

  const statusLabel = (s: McpServerView): string => {
    if (s.status === 'connected') return t('mcp.status.connected')
    if (s.status === 'error') return t('mcp.status.error')
    if (s.status === 'disabled') return t('mcp.status.disabled')
    return t('mcp.status.untested')
  }

  const scopeLabel = (scope: McpScope): string => t(SCOPE_LABEL[scope] as MessageKey)

  const sourceFiles = current?.configFiles ?? []
  const drawerTargetPath = drawer
    ? sourceFiles.find((f) => f.scopes.includes(drawer.input.scope))?.path ?? ''
    : ''
  const enabledHint = (s: McpServerView): string => {
    if (s.readOnly) return t('mcp.detail.readOnlyHint')
    if (s.enabledBy === 'enable-all') return t('mcp.approval.allEnabled')
    if (s.enabledControl === 'approval' && s.approvalState === 'pending') {
      return t('mcp.approval.pending')
    }
    return s.enabled ? t('mcp.detail.disable') : t('mcp.detail.enable')
  }

  const checkedLabel = (s: McpServerView): string => {
    if (!s.checkedAt) return t('mcp.diag.never')
    return t('mcp.diag.checkedAgo', { time: formatRelativeTime(s.checkedAt, locale) })
  }

  const renderTools = (s: McpServerView): JSX.Element => {
    if (s.status === 'disabled') {
      return <div className="mcp-detail-empty"><IconServer width={24} height={24} /><strong>{t('mcp.tools.disabled')}</strong><p>{t('mcp.tools.disabledHint')}</p></div>
    }
    if (s.status === 'untested') {
      return (
        <div className="mcp-detail-empty">
          <IconWrench width={24} height={24} />
          <strong>{t('mcp.tools.untested')}</strong>
          <p>{t('mcp.tools.untestedHint')}</p>
          <button className="btn btn--ghost" onClick={() => void testOne(s)}>
            <IconPlay width={13} height={13} />{t('mcp.diag.test')}
          </button>
        </div>
      )
    }
    return (
      <>
        <div className="mcp-tab-toolbar">
          <span className="mcp-tab-toolbar__title">{t('mcp.tools.found')}</span>
          <span className="mcp-tab-toolbar__hint">{t('mcp.tools.count', { n: s.tools.length })}</span>
          <span className="mcp-tab-toolbar__spacer" />
          <div className="mcp-tool-search">
            <IconSearch width={11} height={11} />
            <input
              value={toolQuery}
              onChange={(e) => setToolQuery(e.target.value)}
              placeholder={t('mcp.tools.search')}
              spellCheck={false}
            />
          </div>
        </div>
        {filteredTools.length === 0 ? (
          <div className="mcp-detail-empty"><IconWrench width={22} height={22} /><strong>{t('mcp.tools.empty')}</strong></div>
        ) : (
          <div className="mcp-tool-list">
            {filteredTools.map((tool) => (
              <div className="mcp-tool-row" key={tool.name}>
                <span className="mcp-tool-row__icon"><IconWrench width={12} height={12} /></span>
                <span className="mcp-tool-row__main">
                  <span className="mcp-tool-row__name"><code>{tool.name}</code></span>
                  {tool.description && <p className="mcp-tool-row__desc">{tool.description}</p>}
                </span>
                <button className="mcp-row-action" title={t('mcp.detail.copy')} onClick={() => void copyEndpoint(tool.name)}>
                  <IconCopy width={12} height={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="mcp-tab-foot"><IconShield width={12} height={12} /><span>{t('mcp.tools.foot')}</span></div>
      </>
    )
  }

  const renderResources = (s: McpServerView): JSX.Element => {
    if (s.status === 'untested') {
      return <div className="mcp-detail-empty"><IconFile width={24} height={24} /><strong>{t('mcp.resources.untested')}</strong><p>{t('mcp.tools.untestedHint')}</p></div>
    }
    if (!s.resources.length) {
      return <div className="mcp-detail-empty"><IconFile width={24} height={24} /><strong>{t('mcp.resources.empty')}</strong><p>{t('mcp.resources.emptyHint')}</p></div>
    }
    return (
      <div className="mcp-tool-list">
        {s.resources.map((r) => (
          <div className="mcp-resource-row" key={r.uri}>
            <span className="mcp-tool-row__icon"><IconFile width={12} height={12} /></span>
            <span className="mcp-tool-row__main">
              <span className="mcp-tool-row__name">{r.name || r.uri}</span>
              <p className="mcp-tool-row__desc">{r.uri}{r.mimeType ? ` · ${r.mimeType}` : ''}</p>
            </span>
            <button className="mcp-row-action" title={t('mcp.detail.copy')} onClick={() => void copyEndpoint(r.uri)}>
              <IconCopy width={12} height={12} />
            </button>
          </div>
        ))}
      </div>
    )
  }

  const renderPrompts = (s: McpServerView): JSX.Element => {
    if (s.status === 'untested') {
      return <div className="mcp-detail-empty"><IconMessage width={24} height={24} /><strong>{t('mcp.prompts.untested')}</strong><p>{t('mcp.tools.untestedHint')}</p></div>
    }
    if (!s.prompts.length) {
      return <div className="mcp-detail-empty"><IconMessage width={24} height={24} /><strong>{t('mcp.prompts.empty')}</strong><p>{t('mcp.prompts.emptyHint')}</p></div>
    }
    return (
      <div className="mcp-tool-list">
        {s.prompts.map((p) => (
          <div className="mcp-prompt-row" key={p.name}>
            <span className="mcp-tool-row__icon"><IconMessage width={12} height={12} /></span>
            <span className="mcp-tool-row__main">
              <span className="mcp-tool-row__name"><code>{p.name}</code></span>
              {p.description && <p className="mcp-tool-row__desc">{p.description}</p>}
            </span>
            <button className="mcp-row-action" title={t('mcp.detail.copy')} onClick={() => void copyEndpoint(p.name)}>
              <IconCopy width={12} height={12} />
            </button>
          </div>
        ))}
      </div>
    )
  }

  const renderDiagnostics = (s: McpServerView): JSX.Element => (
    <div className="mcp-diagnostics">
      <div className={`mcp-diag-status mcp-diag-status--${statusClass(s)}`}>
        {s.status === 'error' ? <IconAlert width={16} height={16} /> : s.status === 'connected' ? <IconCheck width={16} height={16} /> : <IconServer width={16} height={16} />}
        <div>
          <strong>{statusLabel(s)}</strong>
          <p>{checkedLabel(s)}{s.checkedAt ? ` · ${t('mcp.diag.latency', { ms: s.latencyMs })}` : ''}</p>
        </div>
        <button
          className="btn btn--ghost btn--xs"
          onClick={() => void testOne(s)}
          disabled={testingId === s.id || s.status === 'disabled' || s.transport === 'sse'}
          title={s.transport === 'sse' ? t('mcp.error.sseUnsupported') : undefined}
        >
          {testingId === s.id ? <span className="spinner" /> : <IconRefresh width={12} height={12} />}
          {testingId === s.id ? t('mcp.status.testing') : t('mcp.diag.test')}
        </button>
      </div>
      {s.error && <pre className="mcp-diag-error">{s.error}</pre>}
      <div className="mcp-diag-grid">
        <div className="mcp-diag-wide">
          <span>{t('mcp.diag.sourceFile')}</span>
          <code>{s.source.file}</code>
        </div>
        <div><span>{t('mcp.detail.scope')}</span><strong>{scopeLabel(s.scope)}</strong></div>
        <div><span>{t('mcp.detail.transport')}</span><strong>{s.transport.toUpperCase()}</strong></div>
        {(s.scope === 'local' || s.scope === 'project') && (
          <div className="mcp-diag-wide"><span>{t('mcp.diag.cwd')}</span><code>{s.cwd || '—'}</code></div>
        )}
        {s.workingDir && (
          <div className="mcp-diag-wide"><span>{t('mcp.form.workingDir')}</span><code>{s.workingDir}</code></div>
        )}
        {s.approvalState && (
          <div><span>{t('mcp.detail.enabled')}</span><strong>{t(`mcp.approval.${s.approvalState}` as MessageKey)}</strong></div>
        )}
        {s.nativeExtras.length > 0 && (
          <div className="mcp-diag-wide">
            <span>{t('mcp.native.extras')}</span>
            <code>{s.nativeExtras.join(', ')}</code>
          </div>
        )}
        {s.hasSecrets && (
          <div className="mcp-diag-wide">
            <span>{t('mcp.warn.plaintext')}</span>
            <code>{s.secretKeys.join(', ')}</code>
          </div>
        )}
        {s.readOnly && (
          <div className="mcp-diag-wide">
            <span>{t('mcp.source.readOnly')}</span>
            <code>{s.readOnlyReason ? t(`mcp.readOnly.${s.readOnlyReason}` as MessageKey) : '—'}</code>
          </div>
        )}
      </div>
      <div className="mcp-diag-actions">
        <button className="btn btn--ghost btn--xs" onClick={() => void openConfig(s.scope)}>
          <IconFile width={11} height={11} />{t('mcp.source.open')}
        </button>
        <button className="btn btn--ghost btn--xs" onClick={() => void revealConfig(s.scope)}>
          <IconFolder width={11} height={11} />{t('mcp.source.reveal')}
        </button>
      </div>
      <p className="mcp-diag-note"><IconInfo width={12} height={12} />{t('mcp.diag.note')}</p>
    </div>
  )

  return (
    <div className="mcp-page">
      <header className="mcp-intro">
        <div className="mcp-intro__main">
          <h2 className="mcp-intro__title">
            {t('mcp.title')}
            <span className="badge badge--mono">{t('mcp.badge')}</span>
          </h2>
          <p className="mcp-intro__lead">
            {t('mcp.lead')}{' '}
            <a href="https://modelcontextprotocol.io" target="_blank" rel="noreferrer">
              {t('mcp.docs')} ↗
            </a>
          </p>
          <div className="mcp-intro__meta">
            <span><i className="state-dot state-dot--ok" />{t('mcp.meta.connected', { n: stats.connected })}</span>
            <span className="sep">·</span>
            <span>{t('mcp.meta.tools', { n: stats.tools })}</span>
            <span className="sep">·</span>
            <span style={{ color: stats.errors ? 'var(--danger)' : 'var(--text-faint)' }}>
              {stats.errors ? t('mcp.meta.errors', { n: stats.errors }) : t('mcp.meta.ok')}
            </span>
          </div>
        </div>
        <div className="mcp-intro__actions">
          <button className="btn btn--ghost" onClick={() => void testAll()} disabled={testingAll || !available}>
            <IconRefresh width={14} height={14} />
            {testingAll ? t('mcp.status.testing') : t('mcp.testAll', { cli: CLI_META[activeCli].short })}
          </button>
          <button className="btn btn--primary" onClick={openAdd} disabled={!available}>
            <IconPlus width={14} height={14} />{t('mcp.add')}
          </button>
        </div>
      </header>

      <div className="mcp-cli-tabs">
        {CLI_IDS.map((cli) => {
          const meta = CLI_META[cli]
          const Icon = meta.icon
          const s = cliTabStats(cli)
          return (
            <button
              key={cli}
              className={`mcp-cli-tab${cli === activeCli ? ' is-active' : ''}`}
              onClick={() => setActiveCli(cli)}
            >
              <span className="mcp-cli-tab__mark" style={{ color: meta.color }}><Icon width={15} height={15} /></span>
              <span className="mcp-cli-tab__body">
                <span className="mcp-cli-tab__name">
                  {meta.name}
                  {s.errors > 0 && <i className="mcp-cli-tab__warn" title={t('mcp.meta.errors', { n: s.errors })} />}
                </span>
                <span className="mcp-cli-tab__meta">{t('mcp.cli.meta', { n: s.total, tools: s.tools })}</span>
              </span>
              <span className="mcp-cli-tab__check"><IconCheck width={12} height={12} /></span>
            </button>
          )
        })}
      </div>

      {migration && migration.count > 0 && (
        <div className="mcp-notice mcp-notice--warn">
          <IconAlert width={13} height={13} />
          <span>{t('mcp.migrate.banner', { n: migration.count })}</span>
          <span className="mcp-notice__spacer" />
          <button className="btn btn--ghost btn--xs" onClick={() => setMigrationOpen(true)}>
            {t('mcp.migrate.action')}
          </button>
        </div>
      )}

      <div className="mcp-layout">
        <section className="mcp-panel mcp-server-panel">
          <div className="mcp-server-panel__head">
            <h3 className="mcp-server-panel__title">
              {t('mcp.servers.title', { cli: CLI_META[activeCli].short })}
              <span className="mcp-count">{allServers.length}</span>
            </h3>
            {activeCli === 'claude' && workspaces.length > 1 && (
              <div className="mcp-workspace">
                <IconFolder width={12} height={12} />
                <select
                  value={selectedCwd}
                  title={selectedCwd}
                  onChange={(e) => setSelectedCwd(e.target.value)}
                >
                  {workspaces.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="mcp-searchbox">
              <IconSearch width={13} height={13} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('mcp.search')}
                spellCheck={false}
              />
              {query && (
                <button onClick={() => setQuery('')} title={t('mcp.clear')}><IconX width={12} height={12} /></button>
              )}
            </div>
            <div className="mcp-filters">
              {([
                ['all', t('mcp.filter.all'), allServers.length],
                ['connected', t('mcp.filter.connected'), stats.connected],
                ['error', t('mcp.filter.error'), stats.errors],
                ['disabled', t('mcp.filter.disabled'), stats.disabled]
              ] as [Filter, string, number][]).map(([id, label, n]) => (
                <button
                  key={id}
                  className={`mcp-filter${filter === id ? ' is-active' : ''}`}
                  onClick={() => setFilter(id)}
                >
                  {label}<span>{n}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="mcp-server-list">
            {loading ? (
              <div className="mcp-list-loading"><span className="spinner" />{t('mcp.loading')}</div>
            ) : loadError ? (
              <div className="mcp-detail-empty"><IconAlert width={22} height={22} /><strong>{loadError}</strong><button className="btn btn--ghost btn--xs" onClick={() => void refreshAll()}>{t('common.retry')}</button></div>
            ) : allServers.length === 0 ? (
              <div className="mcp-detail-empty mcp-list-empty">
                <IconServer width={24} height={24} />
                <strong>{t('mcp.empty.title')}</strong>
                <p>{t('mcp.empty.body', { cli: CLI_META[activeCli].short })}</p>
                <button className="btn btn--ghost btn--xs" onClick={openAdd}><IconPlus width={12} height={12} />{t('mcp.add')}</button>
              </div>
            ) : filtered.length === 0 ? (
              <div className="mcp-detail-empty mcp-list-empty"><IconSearch width={22} height={22} /><strong>{t('mcp.list.empty')}</strong><p>{t('mcp.list.emptyHint')}</p></div>
            ) : (
              filtered.map((s) => {
                const Icon = s.transport === 'stdio' ? IconCode : s.transport === 'sse' ? IconLog : IconGlobe
                return (
                  <button
                    key={s.id}
                    className={`mcp-server-row${s.id === server?.id ? ' is-active' : ''}${s.status === 'disabled' ? ' is-off' : ''}`}
                    onClick={() => setSelected((cur) => ({ ...cur, [activeCli]: s.id }))}
                  >
                    <span className="mcp-server-mark"><Icon width={15} height={15} /></span>
                    <span className="mcp-server-row__main">
                      <span className="mcp-server-row__line">
                        <span className="mcp-server-row__name">{s.name}</span>
                        <i className={`state-dot state-dot--${statusClass(s) === 'ok' ? 'ok' : statusClass(s) === 'bad' ? 'bad' : statusClass(s) === 'off' ? 'off' : 'idle'}`} />
                      </span>
                      <span className="mcp-server-row__sub">
                        <span className="transport">{s.transport.toUpperCase()}</span>
                        <span className="dotsep">·</span>
                        <span className={s.status === 'error' ? 'is-error' : ''}>
                          {s.status === 'connected' ? t('mcp.tools.shortCount', { n: s.tools.length }) : statusLabel(s)}
                        </span>
                      </span>
                      <span className="mcp-server-row__endpoint" title={s.transport === 'stdio' ? s.command : s.url}>
                        {s.transport === 'stdio' ? s.command : s.url}
                      </span>
                    </span>
                    <IconChevronDown className="mcp-server-row__chev" width={13} height={13} />
                  </button>
                )
              })
            )}
          </div>

          <div className="mcp-config-card">
            <div className="mcp-config-card__head">
              <span className="mcp-config-card__icon"><IconFile width={12} height={12} /></span>
              <span className="mcp-config-card__title">{t('mcp.source.native')}</span>
              <span className="mcp-config-card__spacer" />
              <button
                className="btn btn--ghost btn--xs"
                onClick={reload}
                disabled={!available}
                title={t('mcp.source.reload')}
              >
                <IconRefresh width={11} height={11} />{t('mcp.source.reload')}
              </button>
            </div>

            {activeCli === 'dsh' && (
              <div className="mcp-home-select">
                <span>{t('mcp.dshHome.label')}</span>
                <select
                  value={dshHome}
                  title={dshHome}
                  onChange={(e) => setDshHome(e.target.value)}
                >
                  {dshHomes.map((h) => (
                    <option key={h.path} value={h.path}>
                      {h.kind === 'channel'
                        ? h.label || t('mcp.dshHome.channel')
                        : h.kind === 'app'
                          ? t('mcp.dshHome.app')
                          : t('mcp.dshHome.shared')}
                      {h.exists ? '' : ' *'}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="mcp-config-files">
              {sourceFiles.length === 0 ? (
                <div className="mcp-config-file mcp-config-file--empty">
                  <span>{t('mcp.source.missingFile')}</span>
                </div>
              ) : (
                sourceFiles.map((f) => {
                  const label = f.errorKey
                    ? t(f.errorKey as MessageKey)
                    : f.error
                      ? t('mcp.error.parseFailed')
                      : !f.exists
                        ? t('mcp.source.missingFile')
                        : f.readOnly
                          ? t('mcp.source.readOnly')
                          : t('mcp.source.writable')
                  return (
                    <div className={`mcp-config-file${f.error || f.errorKey ? ' is-error' : ''}`} key={`${f.path}:${f.scopes.join(',')}`}>
                      <div className="mcp-config-file__main">
                        <code title={f.path}>{f.path}</code>
                        <span>{f.scopes.map((s) => scopeLabel(s)).join(' / ')}</span>
                      </div>
                      <span className={`mcp-config-file__state${f.error || f.errorKey ? ' is-error' : ''}`}>{label}</span>
                      <button
                        className="mcp-row-action"
                        title={t('mcp.source.open')}
                        onClick={() => void openConfig(f.scopes[0])}
                      >
                        <IconFile width={12} height={12} />
                      </button>
                      <button
                        className="mcp-row-action"
                        title={t('mcp.source.reveal')}
                        onClick={() => void revealConfig(f.scopes[0])}
                      >
                        <IconFolder width={12} height={12} />
                      </button>
                    </div>
                  )
                })
              )}
            </div>

            <div className="mcp-config-card__actions">
              <button className="btn btn--ghost btn--xs" onClick={() => void testAll()} disabled={testingAll || !available}>
                <IconRefresh width={11} height={11} />{t('mcp.retest')}
              </button>
              <button
                className="btn btn--ghost btn--xs"
                onClick={() => void window.api?.mcp.openBackups()}
              >
                <IconFolder width={11} height={11} />{t('mcp.source.openBackups')}
              </button>
            </div>
          </div>
          <div className="mcp-server-panel__foot">
            <IconInfo width={12} height={12} />
            <span>{t('mcp.source.foot')}</span>
          </div>
        </section>

        <section className="mcp-panel mcp-detail-panel">
          {!server ? (
            <div className="mcp-detail-empty mcp-detail-empty--page">
              <IconServer width={28} height={28} />
              <strong>{t('mcp.noSelection')}</strong>
              <p>{t('mcp.noSelectionHint', { cli: CLI_META[activeCli].short })}</p>
              <button className="btn btn--primary btn--xs" onClick={openAdd}><IconPlus width={12} height={12} />{t('mcp.add')}</button>
            </div>
          ) : (
            <>
              <div className="mcp-detail-head">
                <div className="mcp-detail-head__row">
                  <span className="mcp-detail-mark">
                    {server.transport === 'stdio' ? <IconCode width={18} height={18} /> : server.transport === 'sse' ? <IconLog width={18} height={18} /> : <IconGlobe width={18} height={18} />}
                  </span>
                  <div className="mcp-detail-titlebox">
                    <div className="mcp-detail-titleline">
                      <h3>{server.name}</h3>
                      <span className={`badge badge--${statusClass(server) === 'ok' ? 'ok' : statusClass(server) === 'bad' ? 'bad' : statusClass(server) === 'off' ? 'mono' : 'warn'}`}>
                        <i className="badge__dot" />{statusLabel(server)}
                      </span>
                    </div>
                    <p className="mcp-detail-source">
                      <IconFile width={11} height={11} />
                      <code title={server.source.file}>{shortPath(server.source.file)}</code>
                      <span>· {scopeLabel(server.scope)}</span>
                    </p>
                  </div>
                  <div className="mcp-detail-actions">
                    <label className="switch" title={enabledHint(server)}>
                      <input
                        type="checkbox"
                        checked={server.enabled}
                        disabled={
                          saving ||
                          server.readOnly ||
                          server.enabledControl === 'none' ||
                          server.enabledBy === 'enable-all'
                        }
                        onChange={() => void toggleEnabled(server)}
                      />
                    </label>
                    <button
                      className="mcp-icon-btn"
                      title={server.readOnly ? t('mcp.detail.readOnlyHint') : t('mcp.detail.edit')}
                      onClick={() => openEdit(server)}
                      disabled={server.readOnly}
                    >
                      <IconPencil width={14} height={14} />
                    </button>
                    <button
                      className="mcp-icon-btn"
                      title={server.readOnly ? t('mcp.detail.readOnlyHint') : t('mcp.detail.more')}
                      onClick={() => setDeleteTarget(server)}
                      disabled={server.readOnly}
                    >
                      <IconTrash width={14} height={14} />
                    </button>
                  </div>
                </div>

                <div className="mcp-endpoint">
                  <span className="mcp-endpoint__label">
                    {server.transport === 'stdio' ? <IconCode width={11} height={11} /> : <IconGlobe width={11} height={11} />}
                    {server.transport === 'stdio' ? t('mcp.detail.stdio') : t('mcp.detail.http')}
                  </span>
                  <code title={server.transport === 'stdio' ? server.command : server.url}>
                    {server.transport === 'stdio' ? server.command : server.url}
                  </code>
                  <button className="mcp-row-action" title={t('mcp.detail.copy')} onClick={() => void copyEndpoint(server.transport === 'stdio' ? server.command : server.url)}>
                    <IconCopy width={12} height={12} />
                  </button>
                </div>

                <div className="mcp-meta-row">
                  <span className="mcp-meta-chip"><IconClaudeCode width={11} height={11} />{t('mcp.detail.only', { cli: CLI_META[activeCli].short })}</span>
                  <span className="mcp-meta-chip"><IconGlobe width={11} height={11} />{t('mcp.detail.transport')} <strong>{server.transport.toUpperCase()}</strong></span>
                  <span className="mcp-meta-chip"><IconUser width={11} height={11} />{t('mcp.detail.scope')} <strong>{scopeLabel(server.scope)}</strong></span>
                  {server.status === 'connected' && <span className="mcp-meta-chip mcp-meta-chip--ok"><IconClock width={11} height={11} />{t('mcp.detail.latency', { ms: server.latencyMs })}</span>}
                  {server.hasSecrets && (
                    <span className="mcp-meta-chip mcp-meta-chip--warn" title={t('mcp.warn.plaintextBody')}>
                      <IconShield width={11} height={11} />{t('mcp.detail.secrets', { n: server.secretKeys.length })}
                    </span>
                  )}
                  {server.nativeExtras.length > 0 && (
                    <span className="mcp-meta-chip" title={server.nativeExtras.join(', ')}>
                      <IconCode width={11} height={11} />{t('mcp.detail.extras', { n: server.nativeExtras.length })}
                    </span>
                  )}
                  {server.readOnly && (
                    <span className="mcp-meta-chip mcp-meta-chip--warn">
                      <IconShield width={11} height={11} />{t('mcp.source.readOnly')}
                    </span>
                  )}
                  {server.approvalState && server.scope === 'project' && (
                    <span className={`mcp-meta-chip${server.approvalState === 'pending' ? ' mcp-meta-chip--warn' : ''}`}>
                      <IconCheck width={11} height={11} />{t(`mcp.approval.${server.approvalState}` as MessageKey)}
                    </span>
                  )}
                </div>

                <div className="mcp-tabs">
                  {([
                    ['tools', t('mcp.tab.tools')],
                    ['resources', t('mcp.tab.resources')],
                    ['prompts', t('mcp.tab.prompts')],
                    ['diagnostics', t('mcp.tab.diagnostics')]
                  ] as [DetailTab, string][]).map(([id, label]) => (
                    <button key={id} className={`mcp-tab${tab === id ? ' is-active' : ''}`} onClick={() => setTab(id)}>
                      {label}<span>{tabCount(id)}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="mcp-tab-body">
                {tab === 'tools' && renderTools(server)}
                {tab === 'resources' && renderResources(server)}
                {tab === 'prompts' && renderPrompts(server)}
                {tab === 'diagnostics' && renderDiagnostics(server)}
              </div>
            </>
          )}
        </section>
      </div>

      {drawer && (
        <div className="mcp-drawer-layer">
          <div className="mcp-drawer-scrim" onClick={() => setDrawer(null)} />
          <aside className="mcp-drawer">
            <header className="mcp-drawer__head">
              <div>
                <p className="mcp-drawer__kicker">{drawer.mode === 'add' ? t('mcp.drawer.newKicker') : t('mcp.drawer.editKicker')} · {CLI_META[activeCli].short}</p>
                <h2>{t(drawer.mode === 'add' ? 'mcp.drawer.addTitle' : 'mcp.drawer.editTitle', { cli: CLI_META[activeCli].name })}</h2>
              </div>
              <button className="mcp-icon-btn" onClick={() => setDrawer(null)}><IconX width={15} height={15} /></button>
            </header>
            <div className="mcp-drawer__body">
              <div className="mcp-drawer-cli">
                <span className="mcp-drawer-cli__mark" style={{ color: CLI_META[activeCli].color }}>
                  {(() => { const Icon = CLI_META[activeCli].icon; return <Icon width={15} height={15} /> })()}
                </span>
                <span className="mcp-drawer-cli__main">
                  <strong>{CLI_META[activeCli].name}</strong>
                  <span>{t('mcp.drawer.cliHint', { cli: CLI_META[activeCli].short })}</span>
                </span>
                <span className="badge">{t('mcp.drawer.independent')}</span>
              </div>

              {drawerTargetPath && (
                <div className="mcp-scope-hint">
                  <IconFile width={12} height={12} />
                  <span>{t('mcp.form.writeTarget', { path: drawerTargetPath })}</span>
                </div>
              )}

              <div className="mcp-form-field">
                <label className="mcp-form-label" htmlFor="mcp-name">{t('mcp.form.name')} <span>*</span></label>
                <input id="mcp-name" className={`input${drawerError === 'mcp.error.nameRequired' ? ' is-error' : ''}`} value={drawer.input.name} placeholder={t('mcp.form.namePlaceholder')} onChange={(e) => patchDrawer({ name: e.target.value })} />
                <p className="mcp-form-hint">{t('mcp.form.nameHint')}</p>
              </div>
              <div className="mcp-form-field">
                <span className="mcp-form-label">{t('mcp.form.transport')}</span>
                <div className="mcp-segmented">
                  {NATIVE_MCP_TRANSPORTS[activeCli].map((tr) => (
                    <button key={tr} className={drawer.input.transport === tr ? 'is-active' : ''} onClick={() => setTransport(tr)}>
                      {tr === 'stdio' ? 'stdio' : tr.toUpperCase()}
                    </button>
                  ))}
                </div>
                <p className="mcp-form-hint">
                  {drawer.input.transport === 'stdio' ? t('mcp.form.transport.stdioHint') : drawer.input.transport === 'sse' ? t('mcp.form.transport.sseHint') : t('mcp.form.transport.httpHint')}
                </p>
              </div>

              {drawer.input.transport === 'stdio' ? (
                <>
                  <div className="mcp-form-field">
                    <label className="mcp-form-label" htmlFor="mcp-command">{t('mcp.form.command')} <span>*</span></label>
                    <input id="mcp-command" className={`input${drawerError === 'mcp.error.commandRequired' ? ' is-error' : ''}`} value={drawer.input.command} placeholder="npx" spellCheck={false} onChange={(e) => patchDrawer({ command: e.target.value })} />
                  </div>
                  <div className="mcp-form-field">
                    <label className="mcp-form-label" htmlFor="mcp-args">{t('mcp.form.args')}</label>
                    <textarea id="mcp-args" className="input mcp-textarea" value={drawer.input.args.join('\n')} placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\Projects'} spellCheck={false} onChange={(e) => patchDrawer({ args: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} />
                    <p className="mcp-form-hint">{t('mcp.form.argsHint')}</p>
                  </div>
                  <div className="mcp-form-field">
                    <span className="mcp-form-label">{t('mcp.form.env')} <span className="mcp-optional">{t('mcp.form.optional')}</span></span>
                    {drawer.input.env.map((kv, i) => (
                      <div className="mcp-kv-row" key={i}>
                        <input className="input" value={kv.key} placeholder={t('mcp.form.envKey')} onChange={(e) => setKv('env', i, { key: e.target.value })} />
                        <input className="input" value={kv.value} placeholder={t('mcp.form.envValue')} onChange={(e) => setKv('env', i, { value: e.target.value })} />
                        <button className="mcp-row-action" onClick={() => removeKv('env', i)}><IconX width={12} height={12} /></button>
                      </div>
                    ))}
                    <button className="mcp-kv-add" onClick={() => addKv('env')}><IconPlus width={11} height={11} />{t('mcp.form.addEnv')}</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="mcp-form-field">
                    <label className="mcp-form-label" htmlFor="mcp-url">{t('mcp.form.url')} <span>*</span></label>
                    <input id="mcp-url" className={`input${drawerError === 'mcp.error.urlRequired' || drawerError === 'mcp.error.urlInvalid' ? ' is-error' : ''}`} value={drawer.input.url} placeholder="https://api.example.com/mcp/" spellCheck={false} onChange={(e) => patchDrawer({ url: e.target.value })} />
                  </div>
                  <div className="mcp-form-field">
                    <span className="mcp-form-label">{t('mcp.form.headers')} <span className="mcp-optional">{t('mcp.form.optional')}</span></span>
                    {drawer.input.headers.map((kv, i) => (
                      <div className="mcp-kv-row" key={i}>
                        <input className="input" value={kv.key} placeholder={t('mcp.form.headerKey')} onChange={(e) => setKv('headers', i, { key: e.target.value })} />
                        <input className="input" value={kv.value} placeholder={t('mcp.form.headerValue')} onChange={(e) => setKv('headers', i, { value: e.target.value })} />
                        <button className="mcp-row-action" onClick={() => removeKv('headers', i)}><IconX width={12} height={12} /></button>
                      </div>
                    ))}
                    <button className="mcp-kv-add" onClick={() => addKv('headers')}><IconPlus width={11} height={11} />{t('mcp.form.addHeader')}</button>
                  </div>
                </>
              )}

              {(activeCli === 'codex' || activeCli === 'dsh') && (
                <div className="mcp-form-field">
                  <label className="mcp-form-label" htmlFor="mcp-working-dir">
                    {t('mcp.form.workingDir')} <span className="mcp-optional">{t('mcp.form.optional')}</span>
                  </label>
                  <input
                    id="mcp-working-dir"
                    className="input"
                    value={drawer.input.workingDir}
                    placeholder={projectCwd}
                    spellCheck={false}
                    onChange={(e) => patchDrawer({ workingDir: e.target.value })}
                  />
                  <p className="mcp-form-hint">{t('mcp.form.workingDirHint')}</p>
                </div>
              )}

              <div className="mcp-form-field">
                <span className="mcp-form-label">{t('mcp.form.scope')}</span>
                {activeCli === 'claude' ? (
                  <>
                    <div className="mcp-segmented">
                      {(['user', 'project', 'local'] as McpScope[]).map((sc) => (
                        <button
                          key={sc}
                          className={drawer.input.scope === sc ? 'is-active' : ''}
                          onClick={() => setScope(sc)}
                          disabled={
                            (drawer.mode === 'edit' && drawer.input.scope !== sc) ||
                            (!projectCwd && (sc === 'local' || sc === 'project'))
                          }
                        >
                          {t(SCOPE_LABEL[sc] as MessageKey)}
                        </button>
                      ))}
                    </div>
                    <div className="mcp-scope-hint">
                      <IconInfo width={12} height={12} />
                      <span>
                        {drawer.mode === 'edit'
                          ? t('mcp.form.scopeLocked')
                          : drawer.input.scope === 'user'
                            ? t('mcp.form.scope.userHint')
                            : drawer.input.scope === 'local'
                              ? t('mcp.form.scope.localHint', { cwd: drawer.input.cwd || projectCwd })
                              : t('mcp.form.scope.projectHint', {
                                  cli: CLI_META[activeCli].short,
                                  cwd: drawer.input.cwd || projectCwd
                                })}
                      </span>
                    </div>
                    {drawer.input.scope === 'project' && (
                      <div className="mcp-scope-hint mcp-scope-hint--warn">
                        <IconAlert width={12} height={12} />
                        <span>{t('mcp.warn.projectFile')}</span>
                      </div>
                    )}
                  </>
                ) : activeCli === 'codex' ? (
                  <div className="mcp-scope-hint">
                    <IconInfo width={12} height={12} />
                    <span>{t('mcp.form.scope.globalFixed', { path: 'config.toml' })}</span>
                  </div>
                ) : (
                  <div className="mcp-scope-hint">
                    <IconInfo width={12} height={12} />
                    <span>{t('mcp.form.scope.homeFixed', { path: shortPath(dshHome) })}</span>
                  </div>
                )}
              </div>

              {(drawer.input.env.some((kv) => kv.value) || drawer.input.headers.some((kv) => kv.value)) && (
                <div className="mcp-scope-hint mcp-scope-hint--warn">
                  <IconAlert width={12} height={12} />
                  <span>{t('mcp.warn.plaintextBody')}</span>
                </div>
              )}

              <div className="mcp-option-row">
                <div>
                  <strong>{t('mcp.form.enabled')}</strong>
                  <p>
                    {activeCli === 'claude' && drawer.input.scope === 'project'
                      ? t('mcp.enabled.nativeApproval')
                      : activeCli === 'codex'
                        ? t('mcp.form.enabledCodex')
                        : activeCli === 'dsh'
                          ? t('mcp.form.enabledDsh')
                          : t('mcp.form.enabledHint')}
                  </p>
                </div>
                <label className="switch"><input type="checkbox" checked={drawer.input.enabled} onChange={(e) => patchDrawer({ enabled: e.target.checked })} /></label>
              </div>

              {drawerTest && (
                <div className={`mcp-test-result ${drawerTest.ok ? 'is-ok' : 'is-bad'}`}>
                  {drawerTest.ok ? <IconCheck width={13} height={13} /> : <IconAlert width={13} height={13} />}
                  <span>{drawerTest.ok ? t('mcp.form.testOk', { n: drawerTest.tools.length, ms: drawerTest.latencyMs }) : t('mcp.form.testBad', { error: drawerTest.error })}</span>
                </div>
              )}
              {drawerError && <p className="mcp-form-error">{t(drawerError as MessageKey)}</p>}
            </div>
            <footer className="mcp-drawer__foot">
              <button className="btn btn--ghost" onClick={() => setDrawer(null)}>{t('common.cancel')}</button>
              <span className="mcp-drawer__spacer" />
              <button
                className="btn btn--ghost"
                onClick={() => void testDrawer()}
                disabled={drawerTesting || saving || drawer.input.transport === 'sse'}
                title={drawer.input.transport === 'sse' ? t('mcp.error.sseUnsupported') : undefined}
              >
                {drawerTesting ? <span className="spinner" /> : <IconPlay width={13} height={13} />}
                {drawerTesting ? t('mcp.form.testing') : t('mcp.form.test')}
              </button>
              <button className="btn btn--primary" onClick={() => void saveDrawer()} disabled={saving || drawerTesting}>
                {saving ? <span className="spinner" /> : null}
                {drawer.mode === 'add' ? t('mcp.form.nativeSave') : t('mcp.form.saveEdit')}
              </button>
            </footer>
          </aside>
        </div>
      )}

      {migrationOpen && migration && (
        <div className="mcp-drawer-layer">
          <div
            className="mcp-drawer-scrim"
            onClick={() => {
              if (!migrating) setMigrationOpen(false)
            }}
          />
          <aside className="mcp-drawer mcp-migration-drawer">
            <header className="mcp-drawer__head">
              <div>
                <p className="mcp-drawer__kicker">{t('mcp.migrate.kicker')}</p>
                <h2>{t('mcp.migrate.title')}</h2>
              </div>
              <button
                className="mcp-icon-btn"
                onClick={() => setMigrationOpen(false)}
                disabled={migrating}
              >
                <IconX width={15} height={15} />
              </button>
            </header>
            <div className="mcp-drawer__body">
              <p className="mcp-migration-lead">
                {t('mcp.migrate.body', { count: migration.count })}
              </p>
              <div className="mcp-scope-hint">
                <IconInfo width={12} height={12} />
                <span>{migration.legacyPath}</span>
              </div>
              {migration.entries.length === 0 ? (
                <div className="mcp-detail-empty">
                  <IconServer width={22} height={22} />
                  <strong>{t('mcp.migrate.noEntries')}</strong>
                </div>
              ) : (
                <div className="mcp-migration-list">
                  {migration.entries.map((e: McpMigrationEntry) => (
                    <label
                      key={e.legacyId}
                      className={`mcp-migration-row is-${e.status}`}
                    >
                      <input
                        type="checkbox"
                        checked={!!migrationSelected[e.legacyId]}
                        disabled={
                          (e.status !== 'migrate' && e.status !== 'existing') || migrating
                        }
                        onChange={(ev) =>
                          setMigrationSelected((cur) => ({
                            ...cur,
                            [e.legacyId]: ev.target.checked
                          }))
                        }
                      />
                      <span className="mcp-migration-row__main">
                        <span className="mcp-migration-row__title">
                          <strong>{e.name}</strong>
                          <span className="badge badge--mono">{e.cli}</span>
                          <span className="badge">{e.transport.toUpperCase()}</span>
                        </span>
                        <span className="mcp-migration-row__meta">
                          {t(`mcp.scope.${e.fromScope}` as MessageKey)} →{' '}
                          {t(`mcp.scope.${e.targetScope}` as MessageKey)}
                          <code title={e.targetPath}>{e.targetPath}</code>
                        </span>
                        {e.reasonKey && (
                          <span className="mcp-migration-row__reason">
                            {t(e.reasonKey as MessageKey)}
                          </span>
                        )}
                      </span>
                      <span className={`mcp-migration-row__state is-${e.status}`}>
                        {t(`mcp.migrate.status.${e.status}` as MessageKey)}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <footer className="mcp-drawer__foot">
              <button
                className="btn btn--ghost"
                onClick={() => setMigrationOpen(false)}
                disabled={migrating}
              >
                {t('mcp.migrate.later')}
              </button>
              <span className="mcp-drawer__spacer" />
              <button
                className="btn btn--primary"
                onClick={() => void applyMigration()}
                disabled={
                  migrating ||
                  !migration.entries.some(
                    (e) =>
                      migrationSelected[e.legacyId] &&
                      (e.status === 'migrate' || e.status === 'existing')
                  )
                }
              >
                {migrating ? <span className="spinner" /> : null}
                {t('mcp.migrate.confirm')}
              </button>
            </footer>
          </aside>
        </div>
      )}

      {deleteTarget && (
        <ConfirmModal
          title={t('mcp.delete.title')}
          badge={t('mcp.delete.badgeNative')}
          confirmLabel={t('mcp.delete.confirm')}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void remove()}
        >
          <p>
            {t('mcp.delete.bodyNative', {
              name: deleteTarget.name,
              file: shortPath(deleteTarget.source.file)
            })}
          </p>
          {deleteTarget.cli === 'claude' && deleteTarget.transport !== 'stdio' && (
            <p className="delinfo__warn">{t('mcp.warn.oauth')}</p>
          )}
          <p className="mcp-form-hint">{t('mcp.delete.backupHint')}</p>
        </ConfirmModal>
      )}

      {toast && <div className="mcp-toast"><IconCheck width={13} height={13} /><span>{toast}</span></div>}
    </div>
  )
}
