import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  SKILL_SCOPES,
  emptySkillInput,
  skillCommand,
  toSkillInput,
  validateSkillInput,
  type SkillInput,
  type SkillListResult,
  type SkillResource,
  type SkillScope,
  type SkillView
} from '@shared/skills'
import { CLI_IDS, type CliId } from '@shared/settings'
import type { DshHomeOption } from '@shared/mcp'
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
  IconExternal,
  IconFile,
  IconFolder,
  IconInfo,
  IconOpenAI,
  IconPencil,
  IconPlugin,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconShield,
  IconSlash,
  IconTrash,
  IconUpload,
  IconX
} from './Icons'

/**
 * Skills 管理页。
 *
 * Claude / DSH 是 `SKILL.md` 目录，Codex 是 `prompts/*.md`；所有写操作
 * 都由主进程按 scope 计算路径并备份。这个组件只负责展示、表单和筛选。
 */

const CLI_META: Record<
  CliId,
  {
    short: string
    name: string
    icon: (p: { width?: number; height?: number }) => JSX.Element
    color: string
    fileLabel: 'SKILL.md' | 'prompt.md'
    hasTools: boolean
  }
> = {
  claude: {
    short: 'Claude',
    name: 'Claude Code',
    icon: IconClaudeCode,
    color: '#d97757',
    fileLabel: 'SKILL.md',
    hasTools: true
  },
  codex: {
    short: 'Codex',
    name: 'Codex CLI',
    icon: IconOpenAI,
    color: 'var(--text)',
    fileLabel: 'prompt.md',
    hasTools: false
  },
  dsh: {
    short: 'DSH',
    name: 'DeepSeek Harness',
    icon: IconDeepSeek,
    color: 'var(--brand-dsh)',
    fileLabel: 'SKILL.md',
    hasTools: true
  }
}

const SOURCE_LABEL: Record<SkillScope, MessageKey> = {
  global: 'skill.scope.global',
  project: 'skill.scope.project',
  plugin: 'skill.scope.plugin',
  home: 'skill.scope.home',
  shared: 'skill.scope.shared'
}

const SOURCE_TITLE: Record<SkillScope | 'all', MessageKey> = {
  all: 'skill.list.title.all',
  global: 'skill.list.title.global',
  project: 'skill.list.title.project',
  plugin: 'skill.list.title.plugin',
  home: 'skill.list.title.home',
  shared: 'skill.list.title.shared'
}

const SOURCE_OPTIONS: Record<CliId, (SkillScope | 'all')[]> = {
  claude: ['all', 'global', 'project', 'plugin'],
  codex: ['all', 'global'],
  dsh: ['all', 'home', 'shared']
}

const SOURCE_ICON: Record<SkillScope, typeof IconFile> = {
  global: IconFolder,
  project: IconCode,
  plugin: IconPlugin,
  home: IconFolder,
  shared: IconFolder
}

type Filter = 'all' | 'enabled' | 'disabled' | 'warn'
type DetailTab = 'overview' | 'code' | 'resources' | 'diagnostics'

interface DrawerState {
  mode: 'add' | 'edit'
  input: SkillInput
  /** 编辑时的原名，用于锁定改名 */
  originalName?: string
}

interface SkillsManagerPageProps {
  cwd: string
  openedCwds?: string[]
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 把绝对路径压成 `~/.claude/...`，DSH 当前 home 用 DSH_HOME 代替 */
function prettyPath(p: string, skill?: SkillView): string {
  let s = p.replace(/\\/g, '/')
  if (skill?.scope === 'home' && skill.home) {
    s = s.replace(skill.home.replace(/\\/g, '/'), 'DSH_HOME')
  } else {
    s = s.replace(/^[A-Za-z]:\/Users\/[^/]+/, '~')
    s = s.replace(/^\/home\/[^/]+/, '~')
  }
  return s
}

/** 详情页副标题只保留最后几段，避免撑破一行 */
function shortPath(p: string, skill?: SkillView): string {
  const s = prettyPath(p, skill)
  if (s.length <= 62) return s
  const parts = s.split('/')
  return `…/${parts.slice(-3).join('/')}`
}

function formatSize(bytes: number): string {
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function highlightLine(line: string): string {
  if (!line) return ''
  if (/^---\s*$/.test(line)) return `<span class="tok-dim">${escapeHtml(line)}</span>`
  if (/^#{1,4}\s/.test(line)) return `<span class="tok-head">${escapeHtml(line)}</span>`

  const fm = line.match(/^(\s*)([A-Za-z0-9_-]+):(.*)$/)
  if (fm) {
    const value = fm[3].trim()
      ? `<span class="tok-str">${escapeHtml(fm[3])}</span>`
      : escapeHtml(fm[3])
    return `${escapeHtml(fm[1])}<span class="tok-key">${escapeHtml(fm[2])}</span>:${value}`
  }

  const bullet = line.match(/^(\s*-\s)(.*)$/)
  const withCode = (text: string): string =>
    text.replace(/`([^`]+)`/g, '<span class="tok-code">`$1`</span>')
  if (bullet) {
    return `<span class="tok-bullet">${escapeHtml(bullet[1])}</span>${withCode(
      escapeHtml(bullet[2])
    )}`
  }
  return withCode(escapeHtml(line))
}

function warningLabel(key: string): MessageKey {
  return key as MessageKey
}

function defaultBody(cli: CliId, name: string, description: string): string {
  const title = name || (cli === 'codex' ? 'my-prompt' : 'my-skill')
  if (cli === 'codex') {
    return `# ${title}\n\n${description || '写清楚这个提示词做什么。'}\n\n## 要求\n\n1. 读取相关文件与上下文。\n2. 按目标完成工作。\n3. 输出结果并说明关键决定。\n`
  }
  return `# ${title}\n\n${description || '写清楚什么时候该用它。'}\n\n## 步骤\n\n1. 读取任务相关的文件和上下文。\n2. 按技能约定完成工作。\n3. 在结束时汇报改动与结果。\n`
}

export function SkillsManagerPage({
  cwd,
  openedCwds = []
}: SkillsManagerPageProps): JSX.Element {
  const { t, locale } = useI18n()
  const available = typeof window !== 'undefined' && !!window.api?.skills

  const [activeCli, setActiveCli] = useState<CliId>('claude')
  const [lists, setLists] = useState<Partial<Record<CliId, SkillListResult>>>({})
  const [selected, setSelected] = useState<Partial<Record<CliId, string>>>({})
  const [source, setSource] = useState<Record<CliId, SkillScope | 'all'>>({
    claude: 'all',
    codex: 'all',
    dsh: 'all'
  })
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [tab, setTab] = useState<DetailTab>('overview')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [drawer, setDrawer] = useState<DrawerState | null>(null)
  const [drawerError, setDrawerError] = useState('')
  const [toolDraft, setToolDraft] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<SkillView | null>(null)
  const [toast, setToast] = useState('')
  const toastTimer = useRef<number | null>(null)

  /** Claude 项目级技能用哪个工作区 */
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

  /** DSH 当前 home */
  const [dshHomes, setDshHomes] = useState<DshHomeOption[]>([])
  const [dshHome, setDshHome] = useState('')

  useEffect(() => {
    if (!available) return
    let alive = true
    void window.api!.skills
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
  }, [available])

  const showToast = useCallback((text: string): void => {
    setToast(text)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 2400)
  }, [])

  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    }
  }, [])

  const applyList = useCallback((next: SkillListResult): void => {
    setLists((cur) => ({ ...cur, [next.cli]: next }))
    setSelected((cur) => {
      const old = cur[next.cli]
      if (old && next.skills.some((s) => s.id === old)) return cur
      return { ...cur, [next.cli]: next.skills[0]?.id ?? '' }
    })
  }, [])

  const refreshAll = useCallback(async (): Promise<void> => {
    if (!available) {
      setLoading(false)
      setLoadError(t('skill.error.unavailable'))
      return
    }
    setLoadError('')
    const projectCwd = selectedCwd || cwd
    const results = await Promise.all(
      CLI_IDS.map((cli) =>
        window.api!.skills
          .list(cli, projectCwd, cli === 'dsh' ? dshHome : undefined)
          .catch(() => null)
      )
    )
    const failed = results.filter((x) => !x).length
    for (const r of results) if (r) applyList(r)
    setLoading(false)
    if (failed) setLoadError(t('skill.error.loadFailed'))
  }, [applyList, available, cwd, dshHome, selectedCwd, t])

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  useEffect(() => {
    setQuery('')
    setFilter('all')
    setTab('overview')
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
  /** 主进程已按路径去重；这里再按 id 兜一道，重复 key 会让 React 留下陈旧行 */
  const allSkills = useMemo(() => {
    const seen = new Set<string>()
    return (current?.skills ?? []).filter((s) => {
      if (seen.has(s.id)) return false
      seen.add(s.id)
      return true
    })
  }, [current])
  const currentSource = source[activeCli] ?? 'all'

  const counts = useMemo(() => {
    const enabled = allSkills.filter((s) => s.enabled).length
    const warnings = allSkills.filter((s) => s.warnings.length > 0).length
    return {
      all: allSkills.length,
      enabled,
      disabled: allSkills.length - enabled,
      warn: warnings
    }
  }, [allSkills])

  const scopedSkills = useMemo(
    () =>
      currentSource === 'all'
        ? allSkills
        : allSkills.filter((s) => s.scope === currentSource),
    [allSkills, currentSource]
  )

  const scopedCounts = useMemo(() => {
    const enabled = scopedSkills.filter((s) => s.enabled).length
    return {
      all: scopedSkills.length,
      enabled,
      disabled: scopedSkills.length - enabled,
      warn: scopedSkills.filter((s) => s.warnings.length > 0).length
    }
  }, [scopedSkills])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return scopedSkills.filter((s) => {
      if (filter === 'enabled' && !s.enabled) return false
      if (filter === 'disabled' && s.enabled) return false
      if (filter === 'warn' && s.warnings.length === 0) return false
      if (!q) return true
      return [
        s.name,
        s.displayName,
        s.description,
        s.argumentHint,
        s.allowedTools.join(' '),
        s.pluginName ?? ''
      ]
        .join(' ')
        .toLowerCase()
        .includes(q)
    })
  }, [filter, query, scopedSkills])

  const selectedId = selected[activeCli] ?? ''
  const skill = allSkills.find((s) => s.id === selectedId) ?? null

  const projectCwd = selectedCwd || cwd

  const cliTabStats = (cli: CliId): { total: number; enabled: number; warn: number } => {
    const list = lists[cli]?.skills ?? []
    return {
      total: list.length,
      enabled: list.filter((s) => s.enabled).length,
      warn: list.filter((s) => s.warnings.length > 0).length
    }
  }

  const setCli = (cli: CliId): void => {
    setActiveCli(cli)
    setSource((cur) => ({ ...cur, [cli]: 'all' }))
  }

  const setSourceForCli = (value: SkillScope | 'all'): void => {
    setSource((cur) => ({ ...cur, [activeCli]: value }))
    const pool = value === 'all' ? allSkills : allSkills.filter((s) => s.scope === value)
    const first = pool.find((s) => s.id === selectedId) ?? pool[0]
    setSelected((cur) => ({ ...cur, [activeCli]: first?.id ?? '' }))
  }

  const toggleEnabled = async (target: SkillView): Promise<void> => {
    if (!available || target.readOnly || saving) return
    setSaving(true)
    try {
      const result = await window.api!.skills.setEnabled(
        activeCli,
        target.id,
        !target.enabled,
        projectCwd,
        activeCli === 'dsh' ? dshHome : undefined
      )
      if (!result.ok) {
        showToast(t((result.errorKey ?? 'skill.error.saveFailed') as MessageKey))
      } else {
        applyList(result.list)
        showToast(
          t(target.enabled ? 'skill.toast.disabledOne' : 'skill.toast.enabledOne', {
            name: target.displayName || target.name
          })
        )
      }
    } catch {
      showToast(t('skill.error.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const openAdd = (): void => {
    const cli = activeCli
    const base = emptySkillInput(cli, projectCwd)
    if (currentSource !== 'all') base.scope = currentSource
    if (cli === 'claude' && base.scope === 'plugin') base.scope = 'global'
    if (cli === 'claude' && base.scope === 'project' && !projectCwd) base.scope = 'global'
    if (cli === 'dsh' && base.scope !== 'shared') base.scope = 'home'
    setDrawer({ mode: 'add', input: base })
    setDrawerError('')
    setToolDraft('')
  }

  const openEdit = (target: SkillView): void => {
    if (target.readOnly) return
    setDrawer({ mode: 'edit', input: toSkillInput(target), originalName: target.name })
    setDrawerError('')
    setToolDraft('')
  }

  const patchDrawer = (patch: Partial<SkillInput>): void => {
    setDrawer((cur) => (cur ? { ...cur, input: { ...cur.input, ...patch } } : cur))
  }

  const setDrawerScope = (scope: SkillScope): void => {
    patchDrawer({ scope, cwd: scope === 'project' ? projectCwd : '' })
  }

  const addTool = (value: string): void => {
    if (!drawer) return
    const tool = value.trim()
    if (!tool) return
    if (drawer.input.allowedTools.some((x) => x.toLowerCase() === tool.toLowerCase())) {
      patchDrawer({ allowedTools: drawer.input.allowedTools })
      return
    }
    patchDrawer({ allowedTools: [...drawer.input.allowedTools, tool] })
  }

  const removeTool = (index: number): void => {
    if (!drawer) return
    patchDrawer({ allowedTools: drawer.input.allowedTools.filter((_, i) => i !== index) })
  }

  const saveDrawer = async (): Promise<void> => {
    if (!drawer || !available || saving) return
    const input: SkillInput = {
      ...drawer.input,
      name: drawer.input.name.trim().toLowerCase(),
      description: drawer.input.description.trim(),
      body:
        drawer.input.body ||
        (drawer.mode === 'add'
          ? defaultBody(activeCli, drawer.input.name, drawer.input.description)
          : '')
    }
    const error = validateSkillInput(activeCli, input, drawer.originalName)
    if (error) {
      setDrawerError(error)
      return
    }
    setSaving(true)
    setDrawerError('')
    try {
      const result = await window.api!.skills.save(
        activeCli,
        input,
        projectCwd,
        activeCli === 'dsh' ? dshHome : undefined
      )
      if (!result.ok) {
        setDrawerError(result.errorKey ?? 'skill.error.saveFailed')
        return
      }
      applyList(result.list)
      if (result.skillId) {
        setSelected((cur) => ({ ...cur, [activeCli]: result.skillId! }))
      }
      setSource((cur) => ({ ...cur, [activeCli]: 'all' }))
      setFilter('all')
      setQuery('')
      setTab('overview')
      showToast(
        t(drawer.mode === 'add' ? 'skill.toast.added' : 'skill.toast.saved', {
          name: input.name
        })
      )
      setDrawer(null)
      void refreshAll()
    } catch {
      setDrawerError('skill.error.saveFailed')
    } finally {
      setSaving(false)
    }
  }

  const importSkill = async (): Promise<void> => {
    if (!available || saving) return
    const fallbackScope =
      currentSource !== 'all' && currentSource !== 'plugin'
        ? currentSource
        : SKILL_SCOPES[activeCli][0]
    const scope = drawer?.input.scope ?? fallbackScope
    setSaving(true)
    try {
      const result = await window.api!.skills.import(
        activeCli,
        scope,
        projectCwd,
        activeCli === 'dsh' ? dshHome : undefined
      )
      if (result.cancelled) return
      if (!result.ok) {
        const key = result.errorKey ?? 'skill.error.importFailed'
        if (drawer) setDrawerError(key)
        else showToast(t(key as MessageKey))
        return
      }
      applyList(result.list)
      if (result.skillId) setSelected((cur) => ({ ...cur, [activeCli]: result.skillId! }))
      setSource((cur) => ({ ...cur, [activeCli]: 'all' }))
      showToast(t('skill.toast.imported'))
      setDrawer(null)
    } catch {
      showToast(t('skill.error.importFailed'))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!deleteTarget || !available) return
    const target = deleteTarget
    setDeleteTarget(null)
    try {
      const result = await window.api!.skills.remove(
        activeCli,
        target.id,
        projectCwd,
        activeCli === 'dsh' ? dshHome : undefined
      )
      if (!result.ok) {
        showToast(t((result.errorKey ?? 'skill.error.deleteFailed') as MessageKey))
        return
      }
      applyList(result.list)
      showToast(t('skill.toast.removed', { name: target.displayName || target.name }))
    } catch {
      showToast(t('skill.error.deleteFailed'))
    }
  }

  const openDir = async (scope: SkillScope): Promise<void> => {
    if (!available) return
    try {
      const r = await window.api!.skills.openDir(
        activeCli,
        scope,
        projectCwd,
        activeCli === 'dsh' ? dshHome : undefined
      )
      if (!r.ok) showToast(r.error || t('skill.error.openFailed'))
    } catch {
      showToast(t('skill.error.openFailed'))
    }
  }

  const openFile = async (target: SkillView): Promise<void> => {
    if (!available) return
    try {
      const r = await window.api!.skills.openFile(
        activeCli,
        target.id,
        projectCwd,
        activeCli === 'dsh' ? dshHome : undefined
      )
      if (!r.ok) showToast(r.error || t('skill.error.openFailed'))
    } catch {
      showToast(t('skill.error.openFailed'))
    }
  }

  const openResource = async (target: SkillView, resource: SkillResource): Promise<void> => {
    if (!available) return
    try {
      const r = await window.api!.skills.openResource(
        activeCli,
        target.id,
        resource.path,
        projectCwd,
        activeCli === 'dsh' ? dshHome : undefined
      )
      if (!r.ok) showToast(r.error || t('skill.error.openFailed'))
    } catch {
      showToast(t('skill.error.openFailed'))
    }
  }

  const openBackups = async (): Promise<void> => {
    if (!available) return
    try {
      const r = await window.api!.skills.openBackups()
      if (!r.ok) showToast(r.error || t('skill.error.openFailed'))
    } catch {
      showToast(t('skill.error.openFailed'))
    }
  }

  const copyTrigger = async (value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      showToast(t('skill.toast.copied'))
    } catch {
      showToast(t('skill.error.copyFailed'))
    }
  }

  const dshHomeLabel = (): string => {
    const hit = dshHomes.find((h) => h.path === dshHome)
    if (!hit) return t('skill.scope.home')
    if (hit.kind === 'channel') return hit.label || t('skill.scope.home')
    if (hit.kind === 'app') return t('skill.scope.home')
    return t('skill.scope.shared')
  }

  const sourceShort = (s: SkillView): string => {
    if (s.scope === 'home') return dshHomeLabel()
    return t(SOURCE_LABEL[s.scope])
  }

  /** 详情里的来源：插件补上插件名，其它和列表一致 */
  const sourceBadge = (s: SkillView): string => {
    if (s.scope === 'plugin' && s.pluginName) return s.pluginName
    return sourceShort(s)
  }

  const warningText = (s: SkillView): string =>
    s.warnings
      .map((w) => t(warningLabel(w.key)))
      .join(' · ')

  const drawerPrefix = (): string => {
    const cli = activeCli
    const scope = drawer?.input.scope ?? 'global'
    if (cli === 'claude') {
      return scope === 'project' ? '.claude/skills/' : '~/.claude/skills/'
    }
    if (cli === 'codex') return '~/.codex/prompts/'
    return scope === 'shared' ? '~/.dsh/skills/' : 'DSH_HOME/skills/'
  }

  const drawerFullPrefix = (): string => {
    if (activeCli === 'dsh' && drawer?.input.scope !== 'shared') {
      return `${dshHome}/skills/`
    }
    return drawerPrefix()
  }

  const drawerBadge = (): string => {
    if (activeCli === 'claude') {
      return drawer?.input.scope === 'project' ? t('skill.scope.project') : t('skill.scope.global')
    }
    if (activeCli === 'codex') return t('skill.scope.global')
    return drawer?.input.scope === 'shared' ? t('skill.scope.shared') : dshHomeLabel()
  }

  const renderFileRow = (target: SkillView, resource: SkillResource): JSX.Element => (
    <div className="file-row" key={resource.path}>
      <span className={`file-icon${/\.(sh|mjs|js|ts)$/.test(resource.path) ? ' file-icon--script' : ''}`}>
        <IconFile width={12} height={12} />
      </span>
      <span className="file-main">
        <code title={resource.path}>{resource.path}</code>
        <span className="file-size">{resource.dir ? t('skill.res.dir') : formatSize(resource.size)}</span>
      </span>
      <button
        className="file-open"
        title={t('skill.detail.openResource')}
        onClick={() => void openResource(target, resource)}
        disabled={resource.dir}
      >
        <IconExternal width={12} height={12} />
      </button>
    </div>
  )

  const renderOverview = (s: SkillView): JSX.Element => {
    const codex = s.cli === 'codex'
    const fields = codex
      ? 4
      : 5 + (s.version ? 1 : 0) + Object.keys(s.frontmatter.extras).length
    return (
      <div className="overview">
        {s.warnings.length > 0 && (
          <div className="notice">
            <IconAlert width={13} height={13} />
            <span className="notice__main">
              <strong>{t('skill.detail.needAttention')}</strong>
              {warningText(s)}
            </span>
            {!s.readOnly && (
              <button onClick={() => openEdit(s)}>{t('skill.detail.fix')}</button>
            )}
          </div>
        )}

        <section className="ov-section">
          <div className="ov-head">
            <span className="ov-head__title">{t('skill.overview.when')}</span>
          </div>
          <p className="skill-summary">{s.description || t('skill.detail.noDescription')}</p>
          <div className="trigger-note">
            {codex ? <IconSlash width={12} height={12} /> : <IconPlugin width={12} height={12} />}
            <span>
              {codex
                ? t('skill.overview.manualNote', { cmd: skillCommand(s.name) })
                : t('skill.overview.autoNote')}
            </span>
          </div>
        </section>

        <section className="ov-section">
          <div className="ov-head">
            <span className="ov-head__title">{t('skill.overview.how')}</span>
          </div>
          <div className="usage-card">
            <div className="usage-row">
              <span className="usage-key">{t('skill.overview.slash')}</span>
              <span className="usage-val">
                <code>{skillCommand(s.name)}</code>
              </span>
            </div>
            <div className="usage-row">
              <span className="usage-key">{t('skill.overview.args')}</span>
              <span className="usage-val">
                {s.argumentHint ? (
                  <code className="plain">{s.argumentHint}</code>
                ) : codex ? (
                  <code className="plain">$ARGUMENTS</code>
                ) : (
                  <span className="is-faint">—</span>
                )}
              </span>
            </div>
            <div className="usage-row">
              <span className="usage-key">{t('skill.overview.model')}</span>
              <span className="usage-val">
                <code className="plain">{s.model || 'inherit'}</code>
              </span>
            </div>
          </div>
        </section>

        <section className="ov-section">
          <div className="ov-head">
            <span className="ov-head__title">
              {codex ? t('skill.overview.promptInfo') : t('skill.overview.frontmatter')}
            </span>
            <span className="ov-head__spacer" />
            <span className="ov-head__n">{t('skill.overview.fields', { n: fields })}</span>
          </div>
          <div className="fm-card">
            {codex ? (
              <>
                <div className="fm-row">
                  <span className="fm-key">file</span>
                  <span className="fm-val"><code>{s.name}.md</code></span>
                </div>
                <div className="fm-row">
                  <span className="fm-key">arguments</span>
                  <span className="fm-val"><code>$ARGUMENTS</code></span>
                </div>
                <div className="fm-row">
                  <span className="fm-key">argument-hint</span>
                  <span className="fm-val">
                    {s.argumentHint ? <code>{s.argumentHint}</code> : <span className="is-faint">—</span>}
                  </span>
                </div>
                <div className="fm-row">
                  <span className="fm-key">model</span>
                  <span className="fm-val"><code>{s.model || 'inherit'}</code></span>
                </div>
              </>
            ) : (
              <>
                <div className="fm-row">
                  <span className="fm-key">name</span>
                  <span className="fm-val"><code>{s.name}</code></span>
                </div>
                <div className="fm-row">
                  <span className="fm-key">description</span>
                  <span className="fm-val">{s.description}</span>
                </div>
                <div className="fm-row">
                  <span className="fm-key">allowed-tools</span>
                  <span className="fm-val">
                    <span className="tool-chips">
                      {s.allowedTools.length ? (
                        s.allowedTools.map((tool) => (
                          <span className="tool-chip" key={tool}>{tool}</span>
                        ))
                      ) : (
                        <span className="tool-chip tool-chip--none">{t('skill.drawer.toolsNone')}</span>
                      )}
                    </span>
                  </span>
                </div>
                <div className="fm-row">
                  <span className="fm-key">argument-hint</span>
                  <span className="fm-val">
                    {s.argumentHint ? <code>{s.argumentHint}</code> : <span className="is-faint">—</span>}
                  </span>
                </div>
                <div className="fm-row">
                  <span className="fm-key">model</span>
                  <span className="fm-val"><code>{s.model || 'inherit'}</code></span>
                </div>
                {s.version && (
                  <div className="fm-row">
                    <span className="fm-key">version</span>
                    <span className="fm-val"><code>{s.version}</code></span>
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        <section className="ov-section">
          <div className="ov-head">
            <span className="ov-head__title">
              {codex ? t('skill.overview.promptFiles') : t('skill.overview.files')}
            </span>
            <span className="ov-head__n">{s.resources.length}</span>
          </div>
          <div className="file-list">
            {s.resources.map((r) => renderFileRow(s, r))}
          </div>
        </section>

        <div className="ov-foot">
          <IconShield width={12} height={12} />
          <span>{codex ? t('skill.overview.footCodex') : t('skill.overview.foot')}</span>
        </div>
      </div>
    )
  }

  const renderCode = (s: SkillView): JSX.Element => {
    const lines = s.rawContent.replace(/\r\n/g, '\n').split('\n')
    return (
      <>
        <div className="code-toolbar">
          <IconFile width={12} height={12} />
          <code>{CLI_META[s.cli].fileLabel}</code>
          <span className="badge badge--mono">{t('skill.code.readonly')}</span>
          <span className="code-toolbar__spacer" />
          <span className="code-toolbar__lines">
            {t('skill.code.lines', { n: lines.length, size: formatSize(s.size) })}
          </span>
        </div>
        <div className="code-view">
          {lines.map((line, index) => (
            <div className="code-line" key={index}>
              <span className="code-ln">{index + 1}</span>
              <span
                className="code-lc"
                dangerouslySetInnerHTML={{ __html: highlightLine(line) || ' ' }}
              />
            </div>
          ))}
        </div>
      </>
    )
  }

  const renderResources = (s: SkillView): JSX.Element => {
    const codex = s.cli === 'codex'
    const root = s.resources.filter((r) => !r.path.includes('/'))
    const groups: Record<string, SkillResource[]> = {}
    for (const r of s.resources) {
      if (!r.path.includes('/')) continue
      const dir = r.path.split('/')[0]
      ;(groups[dir] ??= []).push(r)
    }
    const total = s.resources.reduce((n, r) => n + r.size, 0)
    return (
      <>
        <div className="res-toolbar">
          <span className="res-toolbar__title">{t('skill.res.title')}</span>
          <span>{t('skill.res.count', { n: s.resources.length, size: formatSize(total) })}</span>
          <span className="res-toolbar__spacer" />
          <button className="btn btn--ghost btn--xs" onClick={() => void openDir(s.scope)}>
            <IconFolder width={11} height={11} />
            {t('skill.res.openDir')}
          </button>
        </div>
        {root.length > 0 && (
          <div className="file-list">{root.map((r) => renderFileRow(s, r))}</div>
        )}
        {Object.keys(groups).map((dir) => (
          <div className="res-group" key={dir}>
            <div className="res-group__name">
              <IconFolder width={11} height={11} />
              {dir}/
            </div>
            <div className="file-list">{groups[dir].map((r) => renderFileRow(s, r))}</div>
          </div>
        ))}
        <div className="ov-foot">
          <IconShield width={12} height={12} />
          <span>{codex ? t('skill.res.footCodex') : t('skill.res.foot')}</span>
        </div>
      </>
    )
  }

  const renderDiagnostics = (s: SkillView): JSX.Element => {
    const codex = s.cli === 'codex'
    const lines = s.rawContent.replace(/\r\n/g, '\n').split('\n').length
    const writable = !s.readOnly
    const warn = s.warnings.length > 0
    const fmFields =
      5 + (s.version ? 1 : 0) + Object.keys(s.frontmatter.extras).length
    return (
      <>
        <div className={`diag-status${warn ? ' diag-status--warn' : ''}`}>
          <span className="diag-status__icon">
            {warn ? <IconAlert width={14} height={14} /> : <IconCheck width={14} height={14} />}
          </span>
          <span className="diag-status__main">
            <span className="diag-status__title">
              {warn ? t('skill.diag.warn') : t('skill.diag.ok')}
            </span>
            <span className="diag-status__sub">
              {warn ? warningText(s) : t('skill.diag.scanned')}
            </span>
          </span>
          <button className="btn btn--ghost" onClick={() => void refreshAll()}>
            <IconRefresh width={11} height={11} />
            {t('skill.rescan')}
          </button>
        </div>

        <div className="diag-grid">
          <div className="diag-cell diag-cell--wide">
            <span>{t('skill.diag.source')}</span>
            <code title={s.path}>{prettyPath(s.path, s)}</code>
          </div>
          {codex ? (
            <>
              <div className="diag-cell"><span>{t('skill.diag.format')}</span><strong>Markdown</strong></div>
              <div className="diag-cell"><span>{t('skill.diag.encoding')}</span><strong>UTF-8</strong></div>
              <div className="diag-cell"><span>{t('skill.diag.bodyLines')}</span><strong>{t('skill.diag.lines', { n: lines })}</strong></div>
              <div className="diag-cell"><span>{t('skill.diag.permission')}</span><strong>{writable ? t('skill.diag.writable') : t('skill.diag.readonly')}</strong></div>
              <div className="diag-cell"><span>{t('skill.diag.args')}</span><strong>$ARGUMENTS</strong></div>
              <div className="diag-cell"><span>{t('skill.diag.updated')}</span><strong>{formatRelativeTime(s.updatedAt, locale)}</strong></div>
            </>
          ) : (
            <>
              <div className="diag-cell"><span>Frontmatter</span><strong>{t('skill.diag.fmCount', { n: fmFields })}</strong></div>
              <div className="diag-cell"><span>{t('skill.diag.encoding')}</span><strong>UTF-8</strong></div>
              <div className="diag-cell"><span>{t('skill.diag.bodyLines')}</span><strong>{t('skill.diag.lines', { n: lines })}</strong></div>
              <div className="diag-cell"><span>{t('skill.diag.permission')}</span><strong>{writable ? t('skill.diag.writable') : t('skill.diag.readonlyPlugin')}</strong></div>
              <div className="diag-cell"><span>{t('skill.diag.allowedTools')}</span><strong>{s.allowedTools.length ? t('skill.diag.toolsCount', { n: s.allowedTools.length }) : t('skill.diag.unrestricted')}</strong></div>
              <div className="diag-cell"><span>{t('skill.diag.updated')}</span><strong>{formatRelativeTime(s.updatedAt, locale)}</strong></div>
            </>
          )}
        </div>

        <div className="diag-actions">
          <button className="btn btn--ghost" onClick={() => void openFile(s)}>
            <IconFile width={11} height={11} />
            {t('skill.diag.openFile', { file: CLI_META[s.cli].fileLabel })}
          </button>
          <button className="btn btn--ghost" onClick={() => void openDir(s.scope)}>
            <IconFolder width={11} height={11} />
            {t('skill.diag.reveal')}
          </button>
        </div>
        <p className="diag-note">
          <IconInfo width={12} height={12} />
          <span>
            {codex
              ? t('skill.diag.noteCodex')
              : s.cli === 'dsh'
                ? t('skill.diag.noteDsh')
                : t('skill.diag.note')}
          </span>
        </p>
      </>
    )
  }

  const currentSourceLabel = t(SOURCE_TITLE[currentSource], {
    noun: t(`skill.noun.${activeCli}` as MessageKey)
  })
  const dialogName = drawer?.input.name.trim().toLowerCase() || ''
  const dialogShown =
    drawer?.mode === 'edit'
      ? drawer.originalName ?? dialogName
      : dialogName || (activeCli === 'codex' ? 'my-prompt' : 'my-skill')
  const dialogFile = drawer
    ? activeCli === 'codex'
      ? `${dialogShown || 'my-prompt'}.md`
      : `${dialogShown || 'my-skill'}/SKILL.md`
    : ''

  return (
    <div className="skills-page">
      <header className="intro">
        <div className="intro__main">
          <h2 className="intro__title">
            {t('skill.title')}
            <span className="badge badge--mono">{t('skill.badge')}</span>
          </h2>
          <p className="intro__lead">
            {t('skill.lead')}{' '}
            <a href="https://docs.claude.com/en/docs/claude-code/skills" target="_blank" rel="noreferrer">
              {t('skill.docs')} ↗
            </a>
          </p>
          <div className="intro__meta">
            <span>
              <i className="state-dot state-dot--ok" />
              {t('skill.meta.total', { n: counts.all, noun: t(`skill.noun.${activeCli}` as MessageKey) })}
            </span>
            <span className="sep">·</span>
            <span>{t('skill.meta.enabled', { n: counts.enabled })}</span>
            <span className="sep">·</span>
            <span style={{ color: counts.warn ? 'var(--warn)' : 'var(--ok)' }}>
              {counts.warn ? t('skill.meta.warn', { n: counts.warn }) : t('skill.meta.ok')}
            </span>
            <span className="sep">·</span>
            <span>
              {t('skill.meta.scanned', {
                time: current ? formatRelativeTime(current.scannedAt, locale) : '—'
              })}
            </span>
          </div>
        </div>
        <div className="intro__actions">
          <button className="btn btn--ghost" onClick={() => void refreshAll()} disabled={loading || !available}>
            <IconRefresh width={14} height={14} />
            {t('skill.rescan')}
          </button>
          <button className="btn btn--primary" onClick={openAdd} disabled={!available}>
            <IconPlus width={14} height={14} />
            {t('skill.new', { noun: t(`skill.noun.${activeCli}` as MessageKey) })}
          </button>
        </div>
      </header>

      <div className="cli-tabs">
        {CLI_IDS.map((cli) => {
          const meta = CLI_META[cli]
          const Icon = meta.icon
          const s = cliTabStats(cli)
          return (
            <button
              key={cli}
              className={`cli-tab${cli === activeCli ? ' is-active' : ''}`}
              onClick={() => setCli(cli)}
            >
              <span className="cli-tab__mark" style={{ color: meta.color }}>
                <Icon width={15} height={15} />
              </span>
              <span className="cli-tab__body">
                <span className="cli-tab__name">
                  {meta.name}
                  {s.warn > 0 && <i className="cli-tab__warn" title={t('skill.meta.warn', { n: s.warn })} />}
                </span>
                <span className="cli-tab__meta">
                  {t('skill.cli.meta', {
                    n: s.total,
                    enabled: s.enabled,
                    noun: t(`skill.noun.${cli}` as MessageKey)
                  })}
                </span>
              </span>
              <span className="cli-tab__check"><IconCheck width={12} height={12} /></span>
            </button>
          )
        })}
      </div>

      <div className="skills-layout">
        <section className="panel list-panel" aria-label={t('skill.list.aria')}>
          <div className="list-panel__head">
            <div className="list-head-row">
              <h3 className="list-panel__title">
                <span>{currentSourceLabel}</span>
                <span className="count">{scopedSkills.length}</span>
              </h3>
              <select
                className="source-select"
                value={currentSource}
                title={t('skill.source.filter')}
                onChange={(e) => setSourceForCli(e.target.value as SkillScope | 'all')}
              >
                {SOURCE_OPTIONS[activeCli].map((id) => (
                  <option key={id} value={id}>
                    {id === 'all' ? t('skill.source.all') : t(SOURCE_LABEL[id])}
                  </option>
                ))}
              </select>
            </div>

            <div className={`searchbox${query ? ' has-value' : ''}`}>
              <IconSearch width={13} height={13} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('skill.search')}
                spellCheck={false}
                autoComplete="off"
              />
              {query && (
                <button className="searchbox__clear" title={t('skill.clear')} onClick={() => setQuery('')}>
                  <IconX width={12} height={12} />
                </button>
              )}
            </div>

            <div className="filter-row">
              {([
                ['all', t('skill.filter.all'), scopedCounts.all],
                ['enabled', t('skill.filter.enabled'), scopedCounts.enabled],
                ['disabled', t('skill.filter.disabled'), scopedCounts.disabled],
                ['warn', t('skill.filter.warn'), scopedCounts.warn]
              ] as [Filter, string, number][]).map(([id, label, n]) => (
                <button
                  key={id}
                  className={`filter${filter === id ? ' is-active' : ''}`}
                  onClick={() => setFilter(id)}
                >
                  {label} <span className="filter__n">{n}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="skill-list">
            {loading ? (
              <div className="detail-empty">
                <span className="spinner" />
                <strong>{t('skill.loading')}</strong>
              </div>
            ) : loadError ? (
              <div className="detail-empty">
                <IconAlert width={22} height={22} />
                <strong>{loadError}</strong>
                <button className="btn btn--ghost btn--xs" onClick={() => void refreshAll()}>
                  {t('common.retry')}
                </button>
              </div>
            ) : visible.length === 0 ? null : (
              visible.map((s) => {
                const dot = s.warnings.length
                  ? 'warn'
                  : s.enabled
                    ? 'ok'
                    : 'off'
                return (
                  <button
                    key={s.id}
                    className={`skill-row${s.id === skill?.id ? ' is-active' : ''}${s.enabled ? '' : ' is-off'}`}
                    onClick={() => setSelected((cur) => ({ ...cur, [activeCli]: s.id }))}
                  >
                    <span className={`skill-mark${s.enabled ? '' : ' skill-mark--off'}`}>
                      <IconPlugin width={15} height={15} />
                    </span>
                    <span className="skill-row__main">
                      <span className="skill-row__line">
                        <span className="skill-row__name">{s.displayName || s.name}</span>
                        <i className={`state-dot state-dot--${dot}`} />
                      </span>
                      <span className="skill-row__sub">
                        <span className={`source-tag source-tag--${s.scope}`}>{sourceShort(s)}</span>
                        <span className="dotsep">·</span>
                        <span className={`skill-row__trigger${s.cli === 'codex' ? '' : ' skill-row__trigger--auto'}`}>
                          {s.cli === 'codex' ? skillCommand(s.name) : t('skill.row.auto')}
                        </span>
                      </span>
                      <span className="skill-row__desc">
                        {s.description || t('skill.detail.noDescription')}
                      </span>
                    </span>
                    <IconChevronDown className="skill-row__chev" width={13} height={13} />
                  </button>
                )
              })
            )}
          </div>

          <div className={`list-empty${!loading && !loadError && visible.length === 0 ? ' is-visible' : ''}`}>
            <IconSearch width={22} height={22} />
            <strong>{t('skill.list.empty', { noun: t(`skill.noun.${activeCli}` as MessageKey) })}</strong>
            <span>{t('skill.list.emptyHint', { noun: t(`skill.noun.${activeCli}` as MessageKey) })}</span>
          </div>

          <div className="dir-card">
            <div className="dir-card__head">
              <IconFolder width={12} height={12} />
              <span className="dir-card__title">
                {activeCli === 'codex' ? t('skill.dir.prompts') : t('skill.dir.skills')}
              </span>
              <span className="dir-card__spacer" />
              <button className="dir-card__rescan" onClick={() => void openBackups()} title={t('skill.dir.backups')}>
                <IconFolder width={10} height={10} />
                {t('skill.dir.backups')}
              </button>
              <button className="dir-card__rescan" onClick={() => void refreshAll()}>
                <IconRefresh width={10} height={10} />
                {t('skill.rescan')}
              </button>
            </div>

            {activeCli === 'claude' && workspaces.length > 1 && (
              <div className="dsh-home-row">
                <span>{t('skill.workspace.label')}</span>
                <select
                  value={selectedCwd}
                  title={selectedCwd}
                  onChange={(e) => setSelectedCwd(e.target.value)}
                >
                  {workspaces.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>
            )}

            {activeCli === 'dsh' && (
              <div className="dsh-home-row">
                <span>{t('skill.dshHome.label')}</span>
                <select value={dshHome} title={dshHome} onChange={(e) => setDshHome(e.target.value)}>
                  {dshHomes.map((h) => (
                    <option key={h.path} value={h.path}>
                      {h.kind === 'channel'
                        ? h.label || t('skill.scope.home')
                        : h.kind === 'app'
                          ? t('skill.scope.home')
                          : t('skill.scope.shared')}
                      {h.exists ? '' : ' *'}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              {(current?.sources ?? [])
                .filter((f) => currentSource === 'all' || f.scope === currentSource)
                .map((f) => {
                  const shown =
                    activeCli === 'dsh' && f.scope === 'home'
                      ? 'DSH_HOME/skills'
                      : prettyPath(f.path)
                  return (
                    <div className="dir-line" key={`${f.scope}:${f.path}`}>
                      <span className="dir-line__main">
                        <code className="dir-line__path" title={f.path}>{shown}</code>
                        <span className="dir-line__meta">
                          {t('skill.dir.meta', {
                            scope: t(SOURCE_LABEL[f.scope]),
                            n: f.count,
                            noun: t(`skill.noun.${activeCli}` as MessageKey)
                          })}
                        </span>
                      </span>
                      <span className="dir-line__state">
                        {f.writable ? t('skill.dir.writable') : t('skill.dir.readonly')}
                      </span>
                      <button className="dir-open" title={t('skill.detail.openDir')} onClick={() => void openDir(f.scope)}>
                        <IconExternal width={11} height={11} />
                      </button>
                    </div>
                  )
                })}
            </div>

            <div className="dir-foot">
              <IconInfo width={11} height={11} />
              <span>
                {activeCli === 'codex'
                  ? t('skill.dir.footCodex')
                  : activeCli === 'dsh'
                    ? t('skill.dir.footDsh')
                    : t('skill.dir.foot')}
              </span>
            </div>
          </div>
        </section>

        <section className="panel detail-panel" aria-label={t('skill.detail.aria')}>
          {!skill ? (
            <div className="detail-empty">
              <IconPlugin width={28} height={28} />
              <strong>{t('skill.detail.noSelection', { noun: t(`skill.noun.${activeCli}` as MessageKey) })}</strong>
              <p>{t('skill.detail.noSelectionHint', { noun: t(`skill.noun.${activeCli}` as MessageKey) })}</p>
              <button className="btn btn--primary btn--xs" onClick={openAdd}>
                <IconPlus width={12} height={12} />
                {t('skill.new', { noun: t(`skill.noun.${activeCli}` as MessageKey) })}
              </button>
            </div>
          ) : (
            <>
              <div className="detail-head">
                <div className="detail-head__row">
                  <span className="detail-mark"><IconPlugin width={18} height={18} /></span>
                  <div className="detail-titlebox">
                    <div className="detail-titleline">
                      <h3 className="detail-title">{skill.displayName || skill.name}</h3>
                      {skill.warnings.length > 0 ? (
                        <span className="badge badge--warn"><i className="badge__dot" />{t('skill.detail.needAttention')}</span>
                      ) : skill.enabled ? (
                        <span className="badge badge--ok"><i className="badge__dot" />{t('skill.detail.enabled')}</span>
                      ) : (
                        <span className="badge"><i className="badge__dot" />{t('skill.detail.disabled')}</span>
                      )}
                    </div>
                    <p className="detail-sub">
                      <IconFile width={11} height={11} />
                      <code title={skill.path}>{shortPath(skill.path, skill)}</code>
                      <span className="dotsep">·</span>
                      <span>{sourceBadge(skill)}</span>
                    </p>
                  </div>
                  <div className="detail-actions">
                    <label className="switch" title={skill.readOnly ? t('skill.detail.readonlyHint') : skill.enabled ? t('skill.detail.disable') : t('skill.detail.enable')}>
                      <input
                        type="checkbox"
                        checked={skill.enabled}
                        disabled={saving || skill.readOnly}
                        onChange={() => void toggleEnabled(skill)}
                      />
                    </label>
                    <button
                      className="detail-action"
                      title={skill.readOnly ? t('skill.detail.readonlyHint') : t('skill.detail.edit')}
                      onClick={() => openEdit(skill)}
                      disabled={skill.readOnly}
                    >
                      <IconPencil width={14} height={14} />
                    </button>
                    <button
                      className="detail-action"
                      title={skill.readOnly ? t('skill.detail.readonlyHint') : t('skill.detail.delete')}
                      onClick={() => setDeleteTarget(skill)}
                      disabled={skill.readOnly}
                    >
                      <IconTrash width={14} height={14} />
                    </button>
                  </div>
                </div>

                <div className="trigger-bar">
                  <span className="trigger-bar__label">
                    <IconSlash width={11} height={11} />
                    {t('skill.detail.trigger')}
                  </span>
                  <code className="trigger-cmd">{skillCommand(skill.name)}</code>
                  <button className="trigger-copy" title={t('skill.detail.copy')} onClick={() => void copyTrigger(skillCommand(skill.name))}>
                    <IconCopy width={11} height={11} />
                  </button>
                  <span className="trigger-bar__spacer" />
                  <span className="trigger-bar__auto">
                    {skill.cli === 'codex' ? <IconSlash width={10} height={10} /> : <IconPlugin width={10} height={10} />}
                    {skill.cli === 'codex' ? t('skill.detail.manual') : t('skill.detail.auto')}
                  </span>
                </div>

                <div className="meta-row">
                  <span className="meta-chip">
                    {(() => { const Icon = SOURCE_ICON[skill.scope]; return <Icon width={11} height={11} /> })()}
                    {t(SOURCE_LABEL[skill.scope])} <strong>{sourceBadge(skill)}</strong>
                  </span>
                  <span className="meta-chip">
                    <IconFile width={11} height={11} />
                    {t('skill.detail.files', { n: skill.resources.length })}
                  </span>
                  {CLI_META[skill.cli].hasTools ? (
                    <span className="meta-chip">
                      <IconCode width={11} height={11} />
                      {skill.allowedTools.length
                        ? t('skill.detail.tools', { n: skill.allowedTools.length })
                        : t('skill.detail.noTools')}
                    </span>
                  ) : (
                    <span className="meta-chip">
                      <IconSlash width={11} height={11} />
                      {t('skill.detail.manual')}
                    </span>
                  )}
                  <span className="meta-chip">
                    <IconClock width={11} height={11} />
                    {t('skill.detail.updated', { time: formatRelativeTime(skill.updatedAt, locale) })}
                  </span>
                  {skill.version && (
                    <span className="meta-chip">v{skill.version}</span>
                  )}
                  {skill.readOnly && (
                    <span className="meta-chip meta-chip--warn">
                      <IconShield width={11} height={11} />
                      {t('skill.detail.readonly')}
                    </span>
                  )}
                  {skill.warnings.length > 0 && (
                    <span className="meta-chip meta-chip--warn">
                      <IconAlert width={11} height={11} />
                      {t('skill.detail.needAttention')}
                    </span>
                  )}
                </div>

                <div className="tabs">
                  {([
                    ['overview', t('skill.tab.overview'), null, false],
                    ['code', CLI_META[skill.cli].fileLabel, null, false],
                    ['resources', t('skill.tab.resources'), skill.resources.length, false],
                    ['diagnostics', t('skill.tab.diagnostics'), null, skill.warnings.length > 0]
                  ] as [DetailTab, string, number | null, boolean][]).map(([id, label, n, warn]) => (
                    <button
                      key={id}
                      className={`tab${tab === id ? ' is-active' : ''}`}
                      onClick={() => setTab(id)}
                    >
                      {label}
                      {n != null && <span className="tab__n">{n}</span>}
                      {warn && <i className="tab__warn" />}
                    </button>
                  ))}
                </div>
              </div>

              <div className={`tab-body${tab === 'code' ? '' : ' tab-body--pad'}`}>
                {tab === 'overview' && renderOverview(skill)}
                {tab === 'code' && renderCode(skill)}
                {tab === 'resources' && renderResources(skill)}
                {tab === 'diagnostics' && renderDiagnostics(skill)}
              </div>
            </>
          )}
        </section>
      </div>

      {drawer && (
        <div className="drawer-layer is-open" aria-hidden="false">
          <div className="drawer-scrim" onClick={() => setDrawer(null)} />
          <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="skill-drawer-title">
            <header className="drawer__head">
              <div>
                <p className="drawer__kicker">
                  {drawer.mode === 'add' ? t('skill.drawer.addKicker') : t('skill.drawer.editKicker')} ·{' '}
                  {CLI_META[activeCli].short}
                </p>
                <h2 className="drawer__title" id="skill-drawer-title">
                  {t(drawer.mode === 'add' ? 'skill.drawer.addTitle' : 'skill.drawer.editTitle', {
                    noun: t(`skill.noun.${activeCli}` as MessageKey)
                  })}
                </h2>
              </div>
              <button className="drawer__close" title={t('common.close')} onClick={() => setDrawer(null)}>
                <IconX width={15} height={15} />
              </button>
            </header>

            <div className="drawer__body">
              <div className="drawer-context">
                <span className="drawer-context__mark"><IconPlugin width={14} height={14} /></span>
                <span className="drawer-context__main">
                  <strong>
                    {activeCli === 'claude'
                      ? drawer.input.scope === 'project'
                        ? t('skill.drawer.contextProject')
                        : t('skill.drawer.contextGlobal')
                      : activeCli === 'codex'
                        ? t('skill.drawer.contextCodex')
                        : drawer.input.scope === 'shared'
                          ? t('skill.drawer.contextShared')
                          : t('skill.drawer.contextHome')}
                  </strong>
                  <code
                    title={`${drawerFullPrefix()}${dialogShown}${activeCli === 'codex' ? '.md' : ''}`}
                  >
                    {drawerPrefix()}{dialogShown}{activeCli === 'codex' ? '.md' : ''}
                  </code>
                </span>
                <span className="badge">{drawerBadge()}</span>
              </div>

              <div className="form-field">
                <label className="form-label" htmlFor="skill-name">
                  {activeCli === 'codex' ? t('skill.drawer.fileName') : t('skill.drawer.dirName')}{' '}
                  <span className="required">*</span>
                </label>
                <div
                  className={`slug-input${drawer.mode === 'edit' ? ' is-locked' : ''}${
                    drawerError.startsWith('skill.error.name') || drawerError === 'skill.error.dirRequired'
                      ? ' is-error'
                      : ''
                  }`}
                >
                  <span>{drawerPrefix()}</span>
                  <input
                    id="skill-name"
                    value={drawer.input.name}
                    disabled={drawer.mode === 'edit'}
                    placeholder={activeCli === 'codex' ? 'my-prompt' : 'my-skill'}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => patchDrawer({ name: e.target.value.toLowerCase() })}
                  />
                  <span className="slug-input__suffix">{activeCli === 'codex' ? '.md' : ''}</span>
                </div>
                <p className="form-hint">
                  {drawer.mode === 'edit'
                    ? t('skill.drawer.nameLocked')
                    : t('skill.drawer.nameHint', { file: dialogFile })}
                </p>
              </div>

              <div className="form-field">
                <label className="form-label" htmlFor="skill-desc">
                  {t('skill.drawer.desc')} <span className="required">*</span>
                </label>
                <textarea
                  id="skill-desc"
                  className={`form-textarea${
                    drawerError === 'skill.error.descRequired' ? ' is-error' : ''
                  }`}
                  value={drawer.input.description}
                  placeholder={
                    activeCli === 'codex'
                      ? t('skill.drawer.descPlaceholderCodex')
                      : activeCli === 'dsh'
                        ? t('skill.drawer.descPlaceholderDsh')
                        : t('skill.drawer.descPlaceholder')
                  }
                  onChange={(e) => patchDrawer({ description: e.target.value })}
                />
                <div className="desc-meta">
                  <span>{activeCli === 'codex' ? t('skill.drawer.descHintCodex') : t('skill.drawer.descHint')}</span>
                  <span>{t('skill.drawer.descCount', { n: drawer.input.description.trim().length })}</span>
                </div>
              </div>

              <div className="form-field">
                <span className="form-label">{t('skill.drawer.scope')}</span>
                {activeCli === 'codex' ? (
                  <div className="scope-hint">
                    <IconInfo width={12} height={12} />
                    <span>{t('skill.drawer.scopeCodex')}</span>
                  </div>
                ) : (
                  <>
                    <div className="segmented">
                      {SKILL_SCOPES[activeCli].map((scope) => (
                        <button
                          key={scope}
                          type="button"
                          className={drawer.input.scope === scope ? 'is-active' : ''}
                          disabled={
                            drawer.mode === 'edit' ||
                            (scope === 'project' && !projectCwd)
                          }
                          onClick={() => setDrawerScope(scope)}
                        >
                          {scope === 'project'
                            ? t('skill.scope.project')
                            : scope === 'shared'
                              ? t('skill.scope.shared')
                              : activeCli === 'claude'
                                ? t('skill.scope.global')
                                : t('skill.scope.home')}
                        </button>
                      ))}
                    </div>
                    <div className="scope-hint">
                      <IconInfo width={12} height={12} />
                      <span>
                        {activeCli === 'claude'
                          ? drawer.input.scope === 'project'
                            ? t('skill.drawer.scopeProjectHint')
                            : t('skill.drawer.scopeGlobalHint')
                          : drawer.input.scope === 'shared'
                            ? t('skill.drawer.scopeSharedHint')
                            : t('skill.drawer.scopeHomeHint')}
                      </span>
                    </div>
                  </>
                )}
              </div>

              {CLI_META[activeCli].hasTools && (
                <div className="form-field">
                  <span className="form-label">
                    {t('skill.drawer.tools')} <span className="optional">{t('skill.drawer.optional')}</span>
                  </span>
                  <div className="chip-field">
                    {drawer.input.allowedTools.map((tool, index) => (
                      <span className="chip" key={`${tool}:${index}`}>
                        {tool}
                        <button type="button" title={t('skill.drawer.removeTool')} onClick={() => removeTool(index)}>
                          <IconX width={10} height={10} />
                        </button>
                      </span>
                    ))}
                    <input
                      className="chip-field__input"
                      value={toolDraft}
                      placeholder={t('skill.drawer.toolPlaceholder')}
                      spellCheck={false}
                      onChange={(e) => setToolDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ',') {
                          e.preventDefault()
                          addTool(toolDraft)
                          setToolDraft('')
                        } else if (e.key === 'Backspace' && !toolDraft && drawer.input.allowedTools.length) {
                          removeTool(drawer.input.allowedTools.length - 1)
                        }
                      }}
                      onBlur={() => {
                        addTool(toolDraft)
                        setToolDraft('')
                      }}
                    />
                  </div>
                  <p className="form-hint">{t('skill.drawer.toolsHint')}</p>
                </div>
              )}

              <div className="form-field">
                <span className="form-label">{t('skill.drawer.trigger')}</span>
                <div className="trigger-preview">
                  <span className="trigger-preview__label">
                    <IconSlash width={11} height={11} />
                    {t('skill.detail.trigger')}
                  </span>
                  <code>/{dialogShown || (activeCli === 'codex' ? 'my-prompt' : 'my-skill')}</code>
                  <span className="trigger-preview__spacer" />
                  <span className="trigger-preview__auto">
                    {activeCli === 'codex' ? t('skill.drawer.triggerCodex') : t('skill.drawer.triggerAuto')}
                  </span>
                </div>
                <p className="form-hint">
                  {activeCli === 'codex'
                    ? t('skill.drawer.triggerHintCodex')
                    : activeCli === 'dsh'
                      ? t('skill.drawer.triggerHintDsh')
                      : t('skill.drawer.triggerHint')}
                </p>
              </div>

              <div className="form-row2">
                <div className="form-field">
                  <label className="form-label" htmlFor="skill-arg-hint">
                    {t('skill.drawer.argHint')} <span className="optional">{t('skill.drawer.optional')}</span>
                  </label>
                  <input
                    id="skill-arg-hint"
                    className="form-input"
                    value={drawer.input.argumentHint}
                    placeholder="[issue-number]"
                    spellCheck={false}
                    onChange={(e) => patchDrawer({ argumentHint: e.target.value })}
                  />
                </div>
                <div className="form-field">
                  <label className="form-label" htmlFor="skill-model">
                    {t('skill.drawer.model')}
                  </label>
                  <input
                    id="skill-model"
                    className="form-input"
                    value={drawer.input.model}
                    placeholder="inherit"
                    spellCheck={false}
                    onChange={(e) => patchDrawer({ model: e.target.value })}
                  />
                </div>
              </div>

              <div className="form-field">
                <label className="form-label" htmlFor="skill-body">
                  {t('skill.drawer.body')} <span className="optional">{t('skill.drawer.bodyOptional')}</span>
                </label>
                <textarea
                  id="skill-body"
                  className="form-textarea form-textarea--code"
                  value={drawer.input.body}
                  placeholder={activeCli === 'codex' ? t('skill.drawer.bodyPlaceholderCodex') : t('skill.drawer.bodyPlaceholder')}
                  spellCheck={false}
                  onChange={(e) => patchDrawer({ body: e.target.value })}
                />
                <p className="form-hint">
                  {activeCli === 'codex' ? t('skill.drawer.bodyHintCodex') : t('skill.drawer.bodyHint')}
                </p>
              </div>

              <div className="option-row">
                <div className="option-row__main">
                  <div className="option-row__title">
                    {drawer.mode === 'edit' ? t('skill.drawer.enabledEdit') : t('skill.drawer.enabled')}
                  </div>
                  <p className="option-row__hint">
                    {activeCli === 'codex' ? t('skill.drawer.enabledHintCodex') : t('skill.drawer.enabledHint')}
                  </p>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={drawer.input.enabled}
                    onChange={(e) => patchDrawer({ enabled: e.target.checked })}
                  />
                </label>
              </div>

              {drawerError && <p className="form-error is-visible">{t(drawerError as MessageKey)}</p>}
            </div>

            <footer className="drawer__foot">
              <button className="btn btn--ghost" onClick={() => setDrawer(null)} disabled={saving}>
                {t('common.cancel')}
              </button>
              <button className="btn btn--ghost" onClick={() => void importSkill()} disabled={saving || drawer.mode === 'edit'}>
                <IconUpload width={13} height={13} />
                {activeCli === 'codex' ? t('skill.drawer.importFile') : t('skill.drawer.importDir')}
              </button>
              <span className="drawer__spacer" />
              <button className="btn btn--primary drawer__save" onClick={() => void saveDrawer()} disabled={saving}>
                {saving ? <span className="spinner" /> : null}
                {saving
                  ? t('skill.drawer.saving')
                  : drawer.mode === 'add'
                    ? t('skill.drawer.create', { noun: t(`skill.noun.${activeCli}` as MessageKey) })
                    : t('skill.drawer.save')}
              </button>
            </footer>
          </aside>
        </div>
      )}

      {deleteTarget && (
        <ConfirmModal
          title={t('skill.delete.title', { name: deleteTarget.displayName || deleteTarget.name })}
          badge={t('skill.delete.badge', { noun: t(`skill.noun.${activeCli}` as MessageKey) })}
          confirmLabel={t('skill.delete.confirm', { noun: t(`skill.noun.${activeCli}` as MessageKey) })}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void remove()}
        >
          <p>
            {deleteTarget.cli === 'codex'
              ? t('skill.delete.bodyCodex', { file: prettyPath(deleteTarget.path, deleteTarget) })
              : t('skill.delete.body', {
                  dir: prettyPath(deleteTarget.dirPath, deleteTarget),
                  n: deleteTarget.resources.length
                })}
          </p>
          <p className="form-hint">{t('skill.delete.hint')}</p>
        </ConfirmModal>
      )}

      {toast && (
        <div className="toast is-visible">
          <IconCheck width={13} height={13} />
          <span>{toast}</span>
        </div>
      )}
    </div>
  )
}
