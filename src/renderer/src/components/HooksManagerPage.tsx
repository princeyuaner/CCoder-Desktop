import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MessageKey } from '@shared/i18n'
import { baseName } from '@shared/path'
import {
  HOOK_EVENTS,
  HOOK_EVENT_GROUP_LABEL,
  HOOK_TYPES,
  HOOK_TYPE_MAP,
  emptyHookEntry,
  emptyHookInput,
  eventDef,
  eventSupportsMatcher,
  hookSummary,
  isHookType,
  validateHookInput,
  type AgentHook,
  type CommandHook,
  type HookCommon,
  type HookEntry,
  type HookEvent,
  type HookEventGroup,
  type HookInput,
  type HookListResult,
  type HookScope,
  type HookTestInput,
  type HookTestResult,
  type HookType,
  type HookView,
  type HookWritableScope,
  type HttpHook,
  type McpToolHook,
  type PromptHook
} from '@shared/hooks'
import { useI18n } from '../i18n'
import { ConfirmModal } from './ConfirmModal'
import {
  IconAlert,
  IconBrain,
  IconCheck,
  IconChevronDown,
  IconCode,
  IconExternal,
  IconFolder,
  IconGlobe,
  IconInfo,
  IconMessage,
  IconPencil,
  IconPlay,
  IconPlugin,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconServer,
  IconShield,
  IconTrash,
  IconWrench,
  IconX
} from './Icons'

/**
 * Claude Code Hooks 管理页。
 *
 * 只有 Claude Code 有这套配置：用户 / 项目 / 本地可写，插件只读。
 * 停用是应用侧注册表（真从 settings.json 移除），不是往文件里写 enabled。
 */

interface DrawerState {
  mode: 'new' | 'edit'
  input: HookInput
  original: HookView | null
}

const EMPTY_HOOKS: HookView[] = []

const SCOPE_LABEL: Record<HookScope, MessageKey> = {
  user: 'hook.scope.user',
  project: 'hook.scope.project',
  local: 'hook.scope.local',
  plugin: 'hook.scope.plugin'
}

const SCOPE_TEXT: Record<'zh' | 'en', Record<HookScope, string>> = {
  zh: { user: '用户', project: '项目', local: '本地', plugin: '插件' },
  en: { user: 'User', project: 'Project', local: 'Local', plugin: 'Plugin' }
}

const SCOPE_HINT: Record<HookWritableScope, MessageKey> = {
  user: 'hook.scope.userHint',
  project: 'hook.scope.projectHint',
  local: 'hook.scope.localHint'
}

function scopePathLabel(scope: HookScope): string {
  if (scope === 'user') return '~/.claude/settings.json'
  if (scope === 'project') return '.claude/settings.json'
  if (scope === 'local') return '.claude/settings.local.json'
  return ''
}

function shortSource(path: string): string {
  const s = path.replace(/\\/g, '/')
  return s.replace(/^[A-Za-z]:\/Users\/[^/]+/, '~')
}

function typeLabel(type: string, locale: 'zh' | 'en'): string {
  return isHookType(type) ? HOOK_TYPE_MAP[type].label[locale] : type
}

function typeText(type: string, locale: 'zh' | 'en'): string {
  return isHookType(type) ? HOOK_TYPE_MAP[type].desc[locale] : ''
}

function typeIcon(type: string): JSX.Element {
  if (type === 'command') return <IconCode />
  if (type === 'prompt') return <IconMessage />
  if (type === 'agent') return <IconBrain />
  if (type === 'http') return <IconGlobe />
  if (type === 'mcp_tool') return <IconServer />
  return <IconInfo />
}

function groupIcon(group: HookEventGroup): JSX.Element {
  if (group === 'tool') return <IconWrench />
  if (group === 'session') return <IconMessage />
  if (group === 'task') return <IconCheck />
  if (group === 'workspace') return <IconFolder />
  return <IconInfo />
}

function timeoutOf(hook: HookEntry): number | null {
  const n = (hook as { timeout?: unknown }).timeout
  return typeof n === 'number' && n > 0 ? n : null
}

function messageKey(key: string | undefined, fallback: MessageKey): MessageKey {
  return (key as MessageKey) || fallback
}

function viewInput(view: HookView, cwd: string): HookInput | null {
  if (view.readOnly || (view.scope !== 'user' && view.scope !== 'project' && view.scope !== 'local')) {
    return null
  }
  return {
    id: view.id,
    scope: view.scope,
    cwd: view.scope === 'user' ? '' : cwd,
    event: view.event as HookEvent,
    matcher: view.matcher,
    hook: JSON.parse(JSON.stringify(view.hook)) as HookEntry,
    enabled: view.enabled
  }
}

function testInputOf(view: HookView, cwd: string): HookTestInput | null {
  if (view.scope !== 'user' && view.scope !== 'project' && view.scope !== 'local') return null
  return {
    scope: view.scope,
    cwd,
    event: view.event as HookEvent,
    matcher: view.matcher,
    hook: view.hook
  }
}

function previewJson(input: HookInput): string {
  const matcher = eventSupportsMatcher(input.event) ? input.matcher.trim() : ''
  const entry = matcher
    ? { matcher, hooks: [input.hook] }
    : { hooks: [input.hook] }
  return JSON.stringify({ hooks: { [input.event]: [entry] } }, null, 2)
}

function headersToText(headers?: Record<string, string>): string {
  return Object.entries(headers ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
}

function parseHeaders(text: string): { ok: boolean; value?: Record<string, string> } {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    const i = s.indexOf(':')
    if (i <= 0) return { ok: false }
    const key = s.slice(0, i).trim()
    if (!key) return { ok: false }
    out[key] = s.slice(i + 1).trim()
  }
  return { ok: true, value: Object.keys(out).length ? out : undefined }
}

export function HooksManagerPage({
  cwd,
  openedCwds = []
}: {
  cwd: string
  openedCwds?: string[]
}): JSX.Element {
  const { t, locale } = useI18n()
  const available = typeof window !== 'undefined' && !!window.api?.hooks

  const workspaces = useMemo(() => {
    const out: string[] = []
    for (const p of [cwd, ...openedCwds]) {
      const v = p.trim()
      if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v)
    }
    return out
  }, [cwd, openedCwds])

  const [selectedCwd, setSelectedCwd] = useState(cwd || workspaces[0] || '')
  useEffect(() => {
    if (!selectedCwd && workspaces[0]) setSelectedCwd(workspaces[0])
  }, [selectedCwd, workspaces])

  const [list, setList] = useState<HookListResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [scopeFilter, setScopeFilter] = useState<'all' | HookScope>('all')
  const [onlyEnabled, setOnlyEnabled] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [drawer, setDrawer] = useState<DrawerState | null>(null)
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<HookView | null>(null)
  const [testResult, setTestResult] = useState<HookTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [headersDraft, setHeadersDraft] = useState('')
  const [mcpInputDraft, setMcpInputDraft] = useState('')
  const [toast, setToast] = useState('')
  const toastTimer = useRef<number | null>(null)

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

  const refresh = useCallback(async (): Promise<void> => {
    if (!available) {
      setLoading(false)
      setError(t('hook.error.unsupportedType'))
      return
    }
    setLoading(true)
    setError('')
    try {
      const next = await window.api!.hooks.list(selectedCwd)
      setList(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [available, selectedCwd, t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const allHooks = list?.hooks ?? EMPTY_HOOKS

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return allHooks.filter((h) => {
      if (scopeFilter !== 'all' && h.scope !== scopeFilter) return false
      if (onlyEnabled && !h.enabled) return false
      if (!q) return true
      const hay = [
        h.event,
        h.matcher,
        hookSummary(h.hook),
        h.pluginName ?? '',
        h.hook.type,
        typeLabel(h.hook.type, locale),
        typeText(h.hook.type, locale),
        SCOPE_TEXT[locale][h.scope]
      ]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [allHooks, onlyEnabled, query, scopeFilter, locale])

  const groups = useMemo(() => {
    const map = new Map<string, HookView[]>()
    for (const h of filtered) {
      const arr = map.get(h.event)
      if (arr) arr.push(h)
      else map.set(h.event, [h])
    }
    const order = new Map(HOOK_EVENTS.map((e, i) => [e.id as string, i]))
    return [...map.entries()]
      .sort((a, b) => (order.get(a[0]) ?? 999) - (order.get(b[0]) ?? 999))
      .map(([event, hooks]) => ({ event, def: eventDef(event), hooks }))
  }, [filtered])

  const stats = useMemo(() => {
    const enabled = allHooks.filter((h) => h.enabled).length
    const readonly = allHooks.filter((h) => h.readOnly).length
    const events = new Set(allHooks.map((h) => h.event)).size
    return { total: allHooks.length, enabled, readonly, events }
  }, [allHooks])

  const scopeCounts = useMemo(() => {
    const out: Record<'all' | HookScope, number> = {
      all: allHooks.length,
      user: 0,
      project: 0,
      local: 0,
      plugin: 0
    }
    for (const h of allHooks) out[h.scope]++
    return out
  }, [allHooks])

  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed.has(g.event))

  const toggleGroup = useCallback((event: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(event)) next.delete(event)
      else next.add(event)
      return next
    })
  }, [])

  const toggleAll = useCallback((): void => {
    if (allCollapsed) setCollapsed(new Set())
    else setCollapsed(new Set(groups.map((g) => g.event)))
  }, [allCollapsed, groups])

  const openNew = useCallback(
    (event?: HookEvent): void => {
      const input = emptyHookInput(selectedCwd)
      input.cwd = ''
      if (event) input.event = event
      input.matcher = eventSupportsMatcher(input.event) ? 'Bash' : ''
      setDrawer({ mode: 'new', input, original: null })
      setFormError('')
      setTestResult(null)
      setHeadersDraft('')
      setMcpInputDraft('')
    },
    [selectedCwd]
  )

  const openEdit = useCallback(
    (view: HookView, autoTest = false): void => {
      const input = viewInput(view, selectedCwd)
      if (!input) return
      setDrawer({ mode: 'edit', input, original: view })
      setFormError('')
      setTestResult(null)
      setHeadersDraft(
        input.hook.type === 'http' ? headersToText((input.hook as HttpHook).headers) : ''
      )
      setMcpInputDraft(
        input.hook.type === 'mcp_tool' && input.hook.input
          ? JSON.stringify(input.hook.input, null, 2)
          : ''
      )
      if (autoTest) {
        const ti = testInputOf(view, selectedCwd)
        if (ti) void runTestFor(ti)
      }
    },
    // runTestFor is defined below; the closure is stable enough for this page
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedCwd]
  )

  const closeDrawer = useCallback((): void => {
    setDrawer(null)
    setFormError('')
    setTestResult(null)
    setHeadersDraft('')
    setMcpInputDraft('')
  }, [])

  const patchInput = useCallback((patch: Partial<HookInput>): void => {
    setDrawer((d) => (d ? { ...d, input: { ...d.input, ...patch } } : d))
  }, [])

  const patchHook = useCallback((patch: Record<string, unknown>): void => {
    setDrawer((d) =>
      d
        ? {
            ...d,
            input: {
              ...d.input,
              hook: { ...(d.input.hook as unknown as Record<string, unknown>), ...patch } as unknown as HookEntry
            }
          }
        : d
    )
  }, [])

  const changeType = useCallback(
    (type: HookType): void => {
      setDrawer((d) => {
        if (!d) return d
        const old = d.input.hook as unknown as Record<string, unknown>
        const next = emptyHookEntry(type) as unknown as Record<string, unknown>
        for (const key of ['if', 'statusMessage', 'once', 'timeout']) {
          if (old[key] !== undefined) next[key] = old[key]
        }
        return { ...d, input: { ...d.input, hook: next as unknown as HookEntry } }
      })
      setFormError('')
      setTestResult(null)
      setHeadersDraft('')
      setMcpInputDraft('')
    },
    []
  )

  const changeEvent = useCallback((event: HookEvent): void => {
    setDrawer((d) =>
      d
        ? {
            ...d,
            input: {
              ...d.input,
              event,
              matcher: eventSupportsMatcher(event) ? d.input.matcher : ''
            }
          }
        : d
    )
    setTestResult(null)
  }, [])

  const changeScope = useCallback(
    (scope: HookWritableScope): void => {
      setDrawer((d) =>
        d
          ? {
              ...d,
              input: {
                ...d.input,
                scope,
                cwd: scope === 'user' ? '' : selectedCwd
              }
            }
          : d
      )
    },
    [selectedCwd]
  )

  const runTestFor = useCallback(async (input: HookTestInput): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await window.api!.hooks.test(input)
      setTestResult(r)
    } catch (e) {
      setTestResult({
        ok: false,
        supported: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: 0,
        timedOut: false,
        errorKey: 'hook.test.spawnFailed',
        detail: e instanceof Error ? e.message : String(e)
      })
    } finally {
      setTesting(false)
    }
  }, [])

  const runTest = useCallback((): void => {
    if (!drawer) return
    const input = drawer.input
    void runTestFor({
      scope: input.scope,
      cwd: selectedCwd,
      event: input.event,
      matcher: input.matcher,
      hook: input.hook
    })
  }, [drawer, runTestFor, selectedCwd])

  const save = useCallback(async (): Promise<void> => {
    if (!drawer) return
    const input: HookInput = {
      ...drawer.input,
      cwd: drawer.input.scope === 'user' ? '' : selectedCwd
    }

    let hook = input.hook
    if (hook.type === 'http') {
      const parsed = parseHeaders(headersDraft)
      if (!parsed.ok) {
        setFormError('hook.error.headersInvalid')
        return
      }
      hook = { ...hook, headers: parsed.value } as unknown as HookEntry
    }
    if (hook.type === 'mcp_tool') {
      const text = mcpInputDraft.trim()
      if (!text) {
        hook = { ...hook, input: undefined } as unknown as HookEntry
      } else {
        try {
          const parsed = JSON.parse(text) as unknown
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('not an object')
          }
          hook = { ...hook, input: parsed as Record<string, unknown> } as unknown as HookEntry
        } catch {
          setFormError('hook.error.inputJsonInvalid')
          return
        }
      }
    }

    const finalInput: HookInput = { ...input, hook }
    const bad = validateHookInput(finalInput)
    if (bad) {
      setFormError(bad)
      return
    }
    setSaving(true)
    setFormError('')
    try {
      const r = await window.api!.hooks.save(finalInput, selectedCwd)
      if (!r.ok) {
        setFormError(r.errorKey ?? 'hook.error.writeFailed')
        return
      }
      setList(r.list)
      closeDrawer()
      showToast(t('hook.save.saved'))
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [closeDrawer, drawer, headersDraft, mcpInputDraft, selectedCwd, showToast, t])

  const toggleHook = useCallback(
    async (view: HookView, enabled: boolean): Promise<void> => {
      try {
        const r = await window.api!.hooks.setEnabled(view.id, enabled, selectedCwd)
        if (!r.ok) {
          showToast(t(messageKey(r.errorKey, 'hook.error.writeFailed')))
          return
        }
        setList(r.list)
        showToast(t(enabled ? 'hook.enable.done' : 'hook.disable.done'))
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e))
      }
    },
    [selectedCwd, showToast, t]
  )

  const removeTarget = useCallback(async (): Promise<void> => {
    const target = deleteTarget
    if (!target) return
    try {
      const r = await window.api!.hooks.remove(target.id, selectedCwd)
      if (!r.ok) {
        showToast(t(messageKey(r.errorKey, 'hook.error.writeFailed')))
        return
      }
      setList(r.list)
      setDeleteTarget(null)
      closeDrawer()
      showToast(t('hook.delete.done'))
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }, [closeDrawer, deleteTarget, selectedCwd, showToast, t])

  const openConfig = useCallback(
    async (scope: HookWritableScope): Promise<void> => {
      try {
        const r = await window.api!.hooks.openConfig(scope, selectedCwd)
        if (!r.ok) showToast(r.error ?? t('hook.error.openFailed'))
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e))
      }
    },
    [selectedCwd, showToast, t]
  )

  const openBackups = useCallback(async (): Promise<void> => {
    try {
      const r = await window.api!.hooks.openBackups()
      if (!r.ok) showToast(r.error ?? t('hook.error.openFailed'))
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }, [showToast, t])

  useEffect(() => {
    if (!drawer) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !deleteTarget) closeDrawer()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeDrawer, deleteTarget, drawer])

  const renderRow = (h: HookView): JSX.Element => {
    const def = eventDef(h.event)
    const matcher = def?.matcher
      ? h.matcher || t('hook.form.matcherAll')
      : t('hook.form.matcherAll')
    const summary = hookSummary(h.hook)
    const timeout = timeoutOf(h.hook)
    const canTest = h.hook.type === 'command' || h.hook.type === 'http'
    const readonlyText =
      h.readOnlyReason === 'plugin' ? t('hook.readonly') : t('hook.unsupported')

    return (
      <article
        className={`hooks-row${h.enabled ? '' : ' is-off'}${h.readOnly ? ' is-readonly' : ''}`}
        key={h.id}
      >
        <span className="hooks-row__matcher">
          <code>{matcher}</code>
        </span>
        <div className="hooks-row__main">
          <div className="hooks-row__title">
            <span className={`hooks-row__type hooks-row__type--${h.hook.type}`}>
              {typeIcon(h.hook.type)}
              {typeLabel(h.hook.type, locale)}
            </span>
            <code className="hooks-row__summary" title={summary}>
              {summary || t('common.none')}
            </code>
          </div>
          <div className="hooks-row__meta">
            <span className={`hooks-scope hooks-scope--${h.scope}`}>
              {t(SCOPE_LABEL[h.scope])}
            </span>
            {h.scope === 'plugin' && h.pluginName ? (
              <span className="hooks-row__plugin">
                <IconPlugin />
                {h.pluginName}
              </span>
            ) : null}
            {timeout !== null ? <span>{t('hook.timeout', { n: timeout })}</span> : null}
            <span className={`hooks-state${h.enabled ? ' is-ok' : ''}`}>
              {h.enabled ? t('hook.enabled') : t('hook.disabled')}
            </span>
            {h.readOnly ? (
              <span className="hooks-readonly">
                <IconShield />
                {readonlyText}
              </span>
            ) : null}
          </div>
        </div>
        <div className="hooks-row__actions">
          {!h.readOnly ? (
            <>
              {canTest ? (
                <button
                  className="hooks-iconbtn"
                  title={t('hook.test.run')}
                  onClick={() => openEdit(h, true)}
                >
                  <IconPlay />
                </button>
              ) : null}
              <label className="switch switch--sm">
                <input
                  type="checkbox"
                  checked={h.enabled}
                  aria-label={t('hook.enabled')}
                  onChange={(e) => void toggleHook(h, e.target.checked)}
                />
              </label>
              <button
                className="hooks-iconbtn"
                title={t('hook.edit')}
                onClick={() => openEdit(h)}
              >
                <IconPencil />
              </button>
              <button
                className="hooks-iconbtn hooks-iconbtn--danger"
                title={t('common.delete')}
                onClick={() => setDeleteTarget(h)}
              >
                <IconTrash />
              </button>
            </>
          ) : (
            <>
              <span className="hooks-readonly">
                <IconShield />
                {readonlyText}
              </span>
              {h.readOnlyReason === 'unsupported' ? (
                <button
                  className="hooks-iconbtn hooks-iconbtn--danger"
                  title={t('common.delete')}
                  onClick={() => setDeleteTarget(h)}
                >
                  <IconTrash />
                </button>
              ) : null}
            </>
          )}
        </div>
      </article>
    )
  }

  const renderDrawer = (): JSX.Element | null => {
    if (!drawer) return null
    const input = drawer.input
    const hook = input.hook
    const common = hook as HookCommon
    const def = eventDef(input.event)
    const isEdit = !!drawer.original
    const source = isEdit
      ? shortSource(drawer.original!.sourceFile)
      : scopePathLabel(input.scope)
    const canTest = hook.type === 'command' || hook.type === 'http'
    const preview = previewJson(input)

    return (
      <div className="hooks-drawer-layer">
        <div className="hooks-drawer-scrim" onClick={closeDrawer} />
        <aside className="hooks-drawer" role="dialog" aria-modal="true">
          <header className="hooks-drawer__head">
            <div>
              <p className="hooks-drawer__kicker">{t('hook.drawer.kicker')}</p>
              <h2 className="hooks-drawer__title">
                {isEdit ? t('hook.drawer.edit') : t('hook.drawer.new')}
              </h2>
            </div>
            <button className="hooks-drawer__close" title={t('common.close')} onClick={closeDrawer}>
              <IconX />
            </button>
          </header>

          <div className="hooks-drawer__body">
            <div className="hooks-context">
              <span className="hooks-context__mark">{typeIcon(hook.type)}</span>
              <span className="hooks-context__main">
                <strong>
                  {input.event}
                  {def ? ` · ${def.label[locale]}` : ''}
                </strong>
                <code>{source}</code>
              </span>
              <span className={`hooks-scope hooks-scope--${input.scope}`}>
                {t(SCOPE_LABEL[input.scope])}
              </span>
            </div>

            {formError ? (
              <div className="hooks-form-error">
                {t(messageKey(formError, 'hook.error.invalidInput'))}
              </div>
            ) : null}

            <section className="hooks-field">
              <span className="hooks-label">{t('hook.form.scope')}</span>
              <div className="hooks-seg">
                {(['user', 'project', 'local'] as const).map((scope) => (
                  <button
                    key={scope}
                    className={input.scope === scope ? 'is-active' : ''}
                    disabled={isEdit}
                    onClick={() => changeScope(scope)}
                  >
                    {t(SCOPE_LABEL[scope])}
                  </button>
                ))}
              </div>
              <p className="hooks-hint">{t(SCOPE_HINT[input.scope])}</p>
              {isEdit ? <p className="hooks-hint">{t('hook.scopeLocked')}</p> : null}
            </section>

            <section className="hooks-field">
              <label className="hooks-label" htmlFor="hooks-event">
                {t('hook.form.event')}
              </label>
              <select
                id="hooks-event"
                className="hooks-input hooks-select"
                value={input.event}
                onChange={(e) => changeEvent(e.target.value as HookEvent)}
              >
                {(
                  Object.keys(HOOK_EVENT_GROUP_LABEL) as HookEventGroup[]
                ).map((group) => (
                  <optgroup key={group} label={HOOK_EVENT_GROUP_LABEL[group][locale]}>
                    {HOOK_EVENTS.filter((e) => e.group === group).map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.id} · {e.label[locale]}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <p className="hooks-hint">{def ? def.desc[locale] : ''}</p>
            </section>

            {eventSupportsMatcher(input.event) ? (
              <section className="hooks-field">
                <label className="hooks-label" htmlFor="hooks-matcher">
                  {t('hook.form.matcher')}{' '}
                  <span className="hooks-label__opt">{t('hook.form.matcherAll')}</span>
                </label>
                <input
                  id="hooks-matcher"
                  className="hooks-input"
                  value={input.matcher}
                  placeholder="Bash"
                  spellCheck={false}
                  onChange={(e) => patchInput({ matcher: e.target.value })}
                />
                <div className="hooks-chips">
                  {['Bash', 'Edit|Write', 'Read', 'WebFetch', 'mcp__.*', '*'].map(
                    (chip) => (
                      <button
                        key={chip}
                        className={`hooks-chip${input.matcher === chip ? ' is-active' : ''}`}
                        onClick={() =>
                          patchInput({
                            matcher: chip === '*' ? '' : chip
                          })
                        }
                      >
                        {chip}
                      </button>
                    )
                  )}
                </div>
                <p className="hooks-hint">{t('hook.form.matcherHint')}</p>
              </section>
            ) : null}

            <section className="hooks-field">
              <label className="hooks-label" htmlFor="hooks-type">
                {t('hook.form.type')}
              </label>
              <select
                id="hooks-type"
                className="hooks-input hooks-select"
                value={hook.type}
                onChange={(e) => changeType(e.target.value as HookType)}
              >
                {HOOK_TYPES.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.label[locale]} · {type.desc[locale]}
                  </option>
                ))}
              </select>
            </section>

            {hook.type === 'command' ? (
              <section className="hooks-field">
                <label className="hooks-label" htmlFor="hooks-command">
                  {t('hook.form.command')} <span className="hooks-label__req">*</span>
                </label>
                <textarea
                  id="hooks-command"
                  className="hooks-textarea hooks-textarea--code"
                  value={(hook as CommandHook).command}
                  spellCheck={false}
                  placeholder='node "$CLAUDE_PROJECT_DIR/.claude/hooks/my-hook.mjs"'
                  onChange={(e) => patchHook({ command: e.target.value })}
                />
                <p className="hooks-hint">{t('hook.form.commandHint')}</p>
              </section>
            ) : null}

            {hook.type === 'prompt' ? (
              <section className="hooks-field">
                <label className="hooks-label" htmlFor="hooks-prompt">
                  {t('hook.form.prompt')} <span className="hooks-label__req">*</span>
                </label>
                <textarea
                  id="hooks-prompt"
                  className="hooks-textarea"
                  value={(hook as PromptHook).prompt}
                  placeholder="Verify that unit tests ran and passed. $ARGUMENTS"
                  onChange={(e) => patchHook({ prompt: e.target.value })}
                />
                <p className="hooks-hint">{t('hook.form.promptHint')}</p>
              </section>
            ) : null}

            {hook.type === 'agent' ? (
              <section className="hooks-field">
                <label className="hooks-label" htmlFor="hooks-agent">
                  {t('hook.form.agentPrompt')} <span className="hooks-label__req">*</span>
                </label>
                <textarea
                  id="hooks-agent"
                  className="hooks-textarea"
                  value={(hook as AgentHook).prompt}
                  placeholder="Verify that unit tests ran and passed. $ARGUMENTS"
                  onChange={(e) => patchHook({ prompt: e.target.value })}
                />
                <p className="hooks-hint">{t('hook.form.agentPromptHint')}</p>
              </section>
            ) : null}

            {hook.type === 'http' ? (
              <section className="hooks-field">
                <label className="hooks-label" htmlFor="hooks-url">
                  {t('hook.form.url')} <span className="hooks-label__req">*</span>
                </label>
                <input
                  id="hooks-url"
                  className="hooks-input"
                  value={(hook as HttpHook).url}
                  placeholder="https://example.com/hooks/claude"
                  spellCheck={false}
                  onChange={(e) => patchHook({ url: e.target.value })}
                />
                <p className="hooks-hint">{t('hook.form.urlHint')}</p>
              </section>
            ) : null}

            {hook.type === 'mcp_tool' ? (
              <section className="hooks-field">
                <span className="hooks-label">
                  {t('hook.form.server')} / {t('hook.form.tool')}
                </span>
                <div className="hooks-inline-fields">
                  <input
                    className="hooks-input"
                    value={(hook as McpToolHook).server}
                    placeholder={t('hook.form.server')}
                    spellCheck={false}
                    onChange={(e) => patchHook({ server: e.target.value })}
                  />
                  <input
                    className="hooks-input"
                    value={(hook as McpToolHook).tool}
                    placeholder={t('hook.form.tool')}
                    spellCheck={false}
                    onChange={(e) => patchHook({ tool: e.target.value })}
                  />
                </div>
              </section>
            ) : null}

            <section className="hooks-field hooks-inline-row">
              <label className="hooks-label" htmlFor="hooks-timeout">
                {t('hook.form.timeout')}
              </label>
              <input
                id="hooks-timeout"
                className="hooks-input hooks-input--num"
                type="number"
                min={1}
                max={3600}
                value={timeoutOf(hook) ?? 10}
                onChange={(e) => patchHook({ timeout: Number(e.target.value) || undefined })}
              />
              <span className="hooks-unit">{t('hook.form.seconds')}</span>
              <label className="hooks-check hooks-check--right">
                <input
                  type="checkbox"
                  checked={input.enabled}
                  onChange={(e) => patchInput({ enabled: e.target.checked })}
                />
                {t('hook.form.enabled')}
              </label>
            </section>

            <details className="hooks-advanced">
              <summary>{t('hook.form.advanced')}</summary>
              <div className="hooks-advanced__body">
                <section className="hooks-field">
                  <label className="hooks-label" htmlFor="hooks-if">
                    {t('hook.form.if')}
                  </label>
                  <input
                    id="hooks-if"
                    className="hooks-input"
                    value={common.if ?? ''}
                    placeholder="Bash(git *)"
                    spellCheck={false}
                    onChange={(e) => patchHook({ if: e.target.value || undefined })}
                  />
                  <p className="hooks-hint">{t('hook.form.ifHint')}</p>
                </section>

                <section className="hooks-field">
                  <label className="hooks-label" htmlFor="hooks-status">
                    {t('hook.form.statusMessage')}
                  </label>
                  <input
                    id="hooks-status"
                    className="hooks-input"
                    value={common.statusMessage ?? ''}
                    onChange={(e) =>
                      patchHook({ statusMessage: e.target.value || undefined })
                    }
                  />
                </section>

                <label className="hooks-check">
                  <input
                    type="checkbox"
                    checked={common.once === true}
                    onChange={(e) => patchHook({ once: e.target.checked || undefined })}
                  />
                  {t('hook.form.once')}
                </label>

                {hook.type === 'command' ? (
                  <>
                    <section className="hooks-field">
                      <label className="hooks-label" htmlFor="hooks-args">
                        {t('hook.form.args')}
                      </label>
                      <textarea
                        id="hooks-args"
                        className="hooks-textarea hooks-textarea--code"
                        value={((hook as CommandHook).args ?? []).join('\n')}
                        spellCheck={false}
                        onChange={(e) => {
                          const args = e.target.value
                            .split('\n')
                            .map((s) => s.trim())
                            .filter(Boolean)
                          patchHook({ args: args.length ? args : undefined })
                        }}
                      />
                      <p className="hooks-hint">{t('hook.form.argsHint')}</p>
                    </section>

                    <div className="hooks-inline-fields">
                      <label className="hooks-mini-field">
                        <span>{t('hook.form.shell')}</span>
                        <select
                          className="hooks-input hooks-select"
                          value={(hook as CommandHook).shell ?? ''}
                          onChange={(e) =>
                            patchHook({
                              shell: (e.target.value || undefined) as
                                | 'bash'
                                | 'powershell'
                                | undefined
                            })
                          }
                        >
                          <option value="">{t('hook.form.shellDefault')}</option>
                          <option value="bash">bash</option>
                          <option value="powershell">powershell</option>
                        </select>
                      </label>
                      <label className="hooks-mini-field">
                        <span>{t('hook.form.onFailure')}</span>
                        <select
                          className="hooks-input hooks-select"
                          value={(hook as CommandHook).onFailure ?? 'continue'}
                          onChange={(e) =>
                            patchHook({
                              onFailure:
                                e.target.value === 'block' ? 'block' : 'continue'
                            })
                          }
                        >
                          <option value="continue">
                            {t('hook.form.onFailureContinue')}
                          </option>
                          <option value="block">{t('hook.form.onFailureBlock')}</option>
                        </select>
                      </label>
                    </div>

                    <div className="hooks-checks">
                      <label className="hooks-check">
                        <input
                          type="checkbox"
                          checked={(hook as CommandHook).async === true}
                          onChange={(e) =>
                            patchHook({ async: e.target.checked || undefined })
                          }
                        />
                        {t('hook.form.async')}
                      </label>
                      <label className="hooks-check">
                        <input
                          type="checkbox"
                          checked={(hook as CommandHook).asyncRewake === true}
                          onChange={(e) =>
                            patchHook({ asyncRewake: e.target.checked || undefined })
                          }
                        />
                        {t('hook.form.asyncRewake')}
                      </label>
                    </div>

                    <section className="hooks-field">
                      <label className="hooks-label" htmlFor="hooks-rewake-msg">
                        {t('hook.form.rewakeMessage')}
                      </label>
                      <input
                        id="hooks-rewake-msg"
                        className="hooks-input"
                        value={(hook as CommandHook).rewakeMessage ?? ''}
                        onChange={(e) =>
                          patchHook({ rewakeMessage: e.target.value || undefined })
                        }
                      />
                    </section>

                    <section className="hooks-field">
                      <label className="hooks-label" htmlFor="hooks-rewake-sum">
                        {t('hook.form.rewakeSummary')}
                      </label>
                      <input
                        id="hooks-rewake-sum"
                        className="hooks-input"
                        value={(hook as CommandHook).rewakeSummary ?? ''}
                        onChange={(e) =>
                          patchHook({ rewakeSummary: e.target.value || undefined })
                        }
                      />
                    </section>
                  </>
                ) : null}

                {hook.type === 'prompt' || hook.type === 'agent' ? (
                  <>
                    <section className="hooks-field">
                      <label className="hooks-label" htmlFor="hooks-model">
                        {t('hook.form.model')}
                      </label>
                      <input
                        id="hooks-model"
                        className="hooks-input"
                        value={(hook as PromptHook | AgentHook).model ?? ''}
                        placeholder={t('hook.form.modelPlaceholder')}
                        spellCheck={false}
                        onChange={(e) =>
                          patchHook({ model: e.target.value || undefined })
                        }
                      />
                      <p className="hooks-hint">{t('hook.form.modelHint')}</p>
                    </section>
                    {hook.type === 'prompt' ? (
                      <label className="hooks-check">
                        <input
                          type="checkbox"
                          checked={(hook as PromptHook).continueOnBlock === true}
                          onChange={(e) =>
                            patchHook({
                              continueOnBlock: e.target.checked || undefined
                            })
                          }
                        />
                        {t('hook.form.continueOnBlock')}
                      </label>
                    ) : null}
                  </>
                ) : null}

                {hook.type === 'http' ? (
                  <>
                    <section className="hooks-field">
                      <label className="hooks-label" htmlFor="hooks-headers">
                        {t('hook.form.headers')}
                      </label>
                      <textarea
                        id="hooks-headers"
                        className="hooks-textarea hooks-textarea--code"
                        value={headersDraft}
                        placeholder={'Authorization: Bearer $TOKEN'}
                        spellCheck={false}
                        onChange={(e) => {
                          setHeadersDraft(e.target.value)
                          const parsed = parseHeaders(e.target.value)
                          if (parsed.ok) patchHook({ headers: parsed.value })
                        }}
                      />
                      <p className="hooks-hint">{t('hook.form.headersHint')}</p>
                    </section>
                    <section className="hooks-field">
                      <label className="hooks-label" htmlFor="hooks-env">
                        {t('hook.form.allowedEnvVars')}
                      </label>
                      <input
                        id="hooks-env"
                        className="hooks-input"
                        value={((hook as HttpHook).allowedEnvVars ?? []).join(', ')}
                        placeholder="TOKEN, API_KEY"
                        spellCheck={false}
                        onChange={(e) => {
                          const vars = e.target.value
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean)
                          patchHook({
                            allowedEnvVars: vars.length ? vars : undefined
                          })
                        }}
                      />
                      <p className="hooks-hint">{t('hook.form.allowedEnvVarsHint')}</p>
                    </section>
                  </>
                ) : null}

                {hook.type === 'mcp_tool' ? (
                  <section className="hooks-field">
                    <label className="hooks-label" htmlFor="hooks-input-json">
                      {t('hook.form.toolInput')}
                    </label>
                    <textarea
                      id="hooks-input-json"
                      className="hooks-textarea hooks-textarea--code"
                      value={mcpInputDraft}
                      placeholder={'{\n  "path": "${tool_input.file_path}"\n}'}
                      spellCheck={false}
                      onChange={(e) => {
                        setMcpInputDraft(e.target.value)
                        const text = e.target.value.trim()
                        if (!text) {
                          patchHook({ input: undefined })
                          return
                        }
                        try {
                          const parsed = JSON.parse(text) as unknown
                          if (
                            parsed &&
                            typeof parsed === 'object' &&
                            !Array.isArray(parsed)
                          ) {
                            patchHook({ input: parsed })
                          }
                        } catch {
                          // 保存时再报错，输入过程中不打断
                        }
                      }}
                    />
                    <p className="hooks-hint">{t('hook.form.toolInputHint')}</p>
                  </section>
                ) : null}
              </div>
            </details>

            <section className="hooks-test">
              <div className="hooks-test__head">
                <span className="hooks-test__title">
                  <IconPlay />
                  {t('hook.test.title')}
                </span>
                <span className="hooks-test__meta">
                  {testing
                    ? t('hook.test.running')
                    : testResult
                      ? t('hook.test.last', { ms: testResult.durationMs })
                      : t('hook.test.never')}
                </span>
                <button
                  className="btn btn--ghost btn--xs"
                  disabled={testing || !canTest}
                  onClick={runTest}
                >
                  {testResult ? t('hook.test.rerun') : t('hook.test.run')}
                </button>
              </div>
              <p className="hooks-test__hint">
                {canTest
                  ? t('hook.test.hint', { event: input.event })
                  : t('hook.test.unsupported', {
                      type: typeLabel(hook.type, locale)
                    })}
              </p>
              {testResult ? (
                <div className="hooks-test__out">
                  {testResult.errorKey ? (
                    <div className="hooks-test__error">
                      {t(messageKey(testResult.errorKey, 'hook.test.spawnFailed'))}
                      {testResult.detail ? ` · ${testResult.detail}` : ''}
                    </div>
                  ) : null}
                  <div className="hooks-test__line">
                    <span className="hooks-test__key">{t('hook.test.exit')}</span>
                    <code
                      className={
                        testResult.timedOut || !testResult.ok ? 'is-err' : 'is-ok'
                      }
                    >
                      {testResult.timedOut
                        ? t('hook.test.timedOut')
                        : (testResult.exitCode ?? '—')}
                    </code>
                    <span className="hooks-test__time">
                      {t('hook.test.duration', { ms: testResult.durationMs })}
                    </span>
                  </div>
                  <div className="hooks-test__line hooks-test__line--block">
                    <span className="hooks-test__key">{t('hook.test.stdout')}</span>
                    <pre>{testResult.stdout || t('hook.test.noOutput')}</pre>
                  </div>
                  {testResult.stderr ? (
                    <div className="hooks-test__line hooks-test__line--block">
                      <span className="hooks-test__key">{t('hook.test.stderr')}</span>
                      <pre>{testResult.stderr}</pre>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>

            <details className="hooks-preview">
              <summary>{t('hook.preview.title')}</summary>
              <pre>{preview}</pre>
            </details>
          </div>

          <footer className="hooks-drawer__foot">
            {isEdit ? (
              <button
                className="btn btn--danger"
                onClick={() => setDeleteTarget(drawer.original)}
              >
                {t('common.delete')}
              </button>
            ) : null}
            <span className="hooks-drawer__spacer" />
            <button className="btn btn--ghost" onClick={closeDrawer}>
              {t('common.cancel')}
            </button>
            <button className="btn btn--primary" disabled={saving} onClick={() => void save()}>
              {saving
                ? t('settings.save.saving')
                : isEdit
                  ? t('hook.save.update')
                  : t('hook.save.create')}
            </button>
          </footer>
        </aside>
      </div>
    )
  }

  const renderGroup = (g: {
    event: string
    def: ReturnType<typeof eventDef>
    hooks: HookView[]
  }): JSX.Element => {
    const isCollapsed = collapsed.has(g.event)
    return (
      <section className="hooks-group" key={g.event}>
        <div
          className="hooks-group__head"
          role="button"
          tabIndex={0}
          aria-expanded={!isCollapsed}
          onClick={() => toggleGroup(g.event)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              toggleGroup(g.event)
            }
          }}
        >
          <span
            className={`hooks-group__chev${isCollapsed ? ' is-collapsed' : ''}`}
          >
            <IconChevronDown />
          </span>
          <span className="hooks-group__icon">
            {g.def ? groupIcon(g.def.group) : <IconInfo />}
          </span>
          <code className="hooks-group__event">{g.event}</code>
          <span className="hooks-group__desc">
            {g.def ? g.def.desc[locale] : ''}
          </span>
          <span className="hooks-group__count">{g.hooks.length}</span>
          <button
            className="hooks-group__add"
            onClick={(e) => {
              e.stopPropagation()
              openNew(g.event as HookEvent)
            }}
          >
            <IconPlus />
            {t('hook.add')}
          </button>
        </div>
        {!isCollapsed ? (
          <div className="hooks-group__body">{g.hooks.map(renderRow)}</div>
        ) : null}
      </section>
    )
  }

  return (
    <div className="hooks-page">
      <header className="hooks-intro">
        <div className="hooks-intro__main">
          <h2 className="hooks-intro__title">
            {t('hook.title')}
            <span className="badge badge--mono">HOOKS</span>
          </h2>
          <p className="hooks-intro__lead">
            {t('hook.lead')}{' '}
            <a
              href="https://docs.anthropic.com/en/docs/claude-code/hooks"
              target="_blank"
              rel="noreferrer"
            >
              {t('hook.leadLink')}
            </a>
          </p>
          <div className="hooks-intro__meta">
            <span>
              <i className="hooks-dot" />
              {t('hook.meta.total', { n: stats.total })}
            </span>
            <span className="hooks-sep">·</span>
            <span>{t('hook.meta.enabled', { n: stats.enabled })}</span>
            <span className="hooks-sep">·</span>
            <span>{t('hook.meta.events', { n: stats.events })}</span>
            <span className="hooks-sep">·</span>
            <span>{t('hook.meta.readonly', { n: stats.readonly })}</span>
          </div>
        </div>
        <div className="hooks-intro__actions">
          <button className="btn btn--ghost" onClick={() => void refresh()} disabled={loading}>
            <IconRefresh className={loading ? 'spin' : undefined} />
            {t('hook.rescan')}
          </button>
          <button className="btn btn--primary" onClick={() => openNew()}>
            <IconPlus />
            {t('hook.new')}
          </button>
        </div>
      </header>

      <div className="hooks-security">
        <IconAlert className="hooks-security__icon" />
        <div className="hooks-security__body">
          <strong>{t('hook.security.title')}</strong> {t('hook.security.body')}
        </div>
        <a
          className="hooks-security__link"
          href="https://docs.anthropic.com/en/docs/claude-code/hooks"
          target="_blank"
          rel="noreferrer"
        >
          {t('hook.security.link')}
        </a>
      </div>

      <section className="hooks-panel">
        <div className="hooks-panel__head">
          <div className="hooks-panel__row">
            <h3 className="hooks-panel__title">
              {t('hook.list.title')}
              <span className="hooks-count">{allHooks.length}</span>
            </h3>
            <span className="hooks-panel__sub">{t('hook.list.sub')}</span>
            <button className="hooks-linkbtn" onClick={toggleAll}>
              {allCollapsed ? t('hook.expandAll') : t('hook.collapseAll')}
            </button>
          </div>

          <div className="hooks-panel__row2">
            <div className={`hooks-search${query ? ' has-value' : ''}`}>
              <IconSearch />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('hook.search')}
                type="search"
                spellCheck={false}
              />
              {query ? (
                <button
                  className="hooks-search__clear"
                  title={t('common.close')}
                  onClick={() => setQuery('')}
                >
                  <IconX />
                </button>
              ) : null}
            </div>

            <div className="hooks-scope-tabs">
              <button
                className={scopeFilter === 'all' ? 'is-active' : ''}
                onClick={() => setScopeFilter('all')}
              >
                {t('hook.filter.all')} <b>{scopeCounts.all}</b>
              </button>
              {(['user', 'project', 'local', 'plugin'] as const).map((scope) => (
                <button
                  key={scope}
                  className={scopeFilter === scope ? 'is-active' : ''}
                  onClick={() => setScopeFilter(scope)}
                >
                  {t(SCOPE_LABEL[scope])} <b>{scopeCounts[scope]}</b>
                </button>
              ))}
            </div>

            <label className="hooks-only-enabled">
              <span>{t('hook.onlyEnabled')}</span>
              <span className="switch switch--sm">
                <input
                  type="checkbox"
                  checked={onlyEnabled}
                  onChange={(e) => setOnlyEnabled(e.target.checked)}
                />
              </span>
            </label>
          </div>

          <div className="hooks-workspace">
            <IconFolder />
            <span>{t('hook.workspace')}</span>
            <select
              value={selectedCwd}
              onChange={(e) => setSelectedCwd(e.target.value)}
            >
              {workspaces.length === 0 ? (
                <option value="">{t('common.none')}</option>
              ) : (
                workspaces.map((p) => (
                  <option key={p} value={p} title={p}>
                    {baseName(p)}
                  </option>
                ))
              )}
            </select>
            {selectedCwd ? (
              <span className="hooks-workspace__path" title={selectedCwd}>
                {selectedCwd}
              </span>
            ) : null}
          </div>
        </div>

        <div className="hooks-scroll">
          {loading && !list ? (
            <div className="hooks-loading">{t('common.loading')}</div>
          ) : error ? (
            <div className="hooks-error">{error}</div>
          ) : groups.length === 0 ? (
            <div className="hooks-empty">
              <IconSearch />
              <strong>{t('hook.empty.title')}</strong>
              <span>{t('hook.empty.body')}</span>
            </div>
          ) : (
            groups.map(renderGroup)
          )}
          {list?.sources
            .filter((s) => s.error)
            .map((s) => (
              <div className="hooks-source-error" key={s.path}>
                {t('hook.source.error', { detail: s.error ?? '' })}
              </div>
            ))}
        </div>

        <footer className="hooks-pathbar">
          <IconFolder />
          <span>{t('hook.path.title')}</span>
          <code>~/.claude/settings.json</code>
          <span className="hooks-sep">·</span>
          <code>.claude/settings.json</code>
          <span className="hooks-sep">·</span>
          <code>.claude/settings.local.json</code>
          <button className="hooks-pathbar__btn" onClick={() => void openConfig('user')}>
            <IconExternal />
            {t('hook.path.open')}
          </button>
          <button className="hooks-pathbar__btn" onClick={() => void openBackups()}>
            {t('hook.path.backups')}
          </button>
        </footer>
      </section>

      {drawer ? renderDrawer() : null}

      {deleteTarget ? (
        <ConfirmModal
          title={t('hook.delete.title')}
          badge={t('common.delete')}
          confirmLabel={t('hook.delete.confirm')}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void removeTarget()}
        >
          <p>
            {t('hook.delete.body', {
              path: deleteTarget.sourceFile
                ? shortSource(deleteTarget.sourceFile)
                : scopePathLabel(deleteTarget.scope)
            })}
          </p>
          <p className="hooks-confirm-hint">{t('hook.delete.hint')}</p>
        </ConfirmModal>
      ) : null}

      <div className={`hooks-toast${toast ? ' is-open' : ''}`}>
        <IconCheck />
        {toast}
      </div>
    </div>
  )
}

