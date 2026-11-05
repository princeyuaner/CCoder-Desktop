import type {
  InstalledPlugin,
  PluginLocalInspectResult,
  PluginManifest,
  PluginMutationResult,
  PluginStatusBarTone
} from '@shared/plugins'
import { createPluginContext } from './context'
import { importPluginModule } from './loader'
import type {
  PluginCommandContribution,
  PluginContributionsState,
  PluginHostState,
  PluginPanelTabContribution,
  PluginSettingsContribution,
  PluginStatusComponentContribution,
  PluginStatusContribution,
  PluginStatusTextContribution
} from './types'

interface LoadedEntry {
  plugin: InstalledPlugin
  manifest: PluginManifest
  disposers: Array<() => void>
  cleanup: (() => void) | null
  styles: HTMLStyleElement[]
  blobUrl: string | null
}

const EMPTY_CONTRIBUTIONS: PluginContributionsState = {
  statusBar: [],
  commands: [],
  settings: [],
  panelTabs: []
}

let state: PluginHostState = {
  plugins: [],
  root: '',
  contributions: EMPTY_CONTRIBUTIONS,
  errors: {},
  loading: true,
  loaded: []
}

const listeners = new Set<() => void>()
const loaded = new Map<string, LoadedEntry>()
const activating = new Set<string>()
const eventBus = new Map<string, Set<(data: unknown) => void>>()
let sequence = 0
let refreshing: Promise<void> | null = null
let initialized: Promise<void> | null = null
let offChanged: (() => void) | null = null

function notify(): void {
  for (const cb of listeners) cb()
}

function patch(patchValue: Partial<PluginHostState>): void {
  state = { ...state, ...patchValue }
  notify()
}

function setLoaded(id: string, value: boolean): void {
  const next = value
    ? [...state.loaded.filter((x) => x !== id), id]
    : state.loaded.filter((x) => x !== id)
  patch({ loaded: next })
}

function clearError(id: string): void {
  if (!state.errors[id]) return
  const errors = { ...state.errors }
  delete errors[id]
  patch({ errors })
}

function addContribution<K extends keyof PluginContributionsState>(
  slot: K,
  item: PluginContributionsState[K][number]
): () => void {
  const current = state.contributions[slot] as Array<PluginContributionsState[K][number]>
  const next = [...current, item]
  state = {
    ...state,
    contributions: { ...state.contributions, [slot]: next }
  }
  notify()
  return () => removeContribution(slot, item.id)
}

function removeContribution(slot: keyof PluginContributionsState, id: string): void {
  const current = state.contributions[slot] as Array<{ id: string }>
  if (!current.some((x) => x.id === id)) return
  state = {
    ...state,
    contributions: {
      ...state.contributions,
      [slot]: current.filter((x) => x.id !== id)
    }
  }
  notify()
}

function removePluginContributions(pluginId: string): void {
  let changed = false
  const next: PluginContributionsState = {
    statusBar: state.contributions.statusBar.filter((x) => x.pluginId !== pluginId),
    commands: state.contributions.commands.filter((x) => x.pluginId !== pluginId),
    settings: state.contributions.settings.filter((x) => x.pluginId !== pluginId),
    panelTabs: state.contributions.panelTabs.filter((x) => x.pluginId !== pluginId)
  }
  for (const slot of Object.keys(next) as Array<keyof PluginContributionsState>) {
    if (next[slot].length !== state.contributions[slot].length) changed = true
  }
  if (!changed) return
  state = { ...state, contributions: next }
  notify()
}

function nextId(prefix: string): string {
  sequence += 1
  return `${prefix}:${sequence}`
}

function safeCss(css: string): void {
  if (/@import\b/i.test(css)) throw new Error('css-import-not-allowed')
  if (/url\s*\(\s*['"]?\s*(?:https?:)?\/\//i.test(css)) {
    throw new Error('css-remote-url-not-allowed')
  }
  if (/expression\s*\(/i.test(css)) throw new Error('css-expression-not-allowed')
}

function injectStyle(
  pluginId: string,
  css: string,
  kind: string
): HTMLStyleElement {
  safeCss(css)
  const el = document.createElement('style')
  el.dataset.ccoderPlugin = pluginId
  el.dataset.ccoderKind = kind
  el.textContent = css
  document.head.appendChild(el)
  return el
}

function cleanTokens(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!/^--[A-Za-z0-9-]+$/.test(key)) continue
    if (typeof value !== 'string' || value.length > 200) continue
    if (/[;{}<>]/.test(value) || /url\s*\(/i.test(value) || /expression\s*\(/i.test(value)) {
      continue
    }
    out[key] = value
  }
  return out
}

function tokensCss(tokens: {
  light?: Record<string, string>
  dark?: Record<string, string>
}): string {
  const light = cleanTokens(tokens.light)
  const dark = cleanTokens(tokens.dark)
  if (!Object.keys(light).length && !Object.keys(dark).length) throw new Error('tokens-empty')
  const block = (selector: string, values: Record<string, string>): string =>
    `${selector}{${Object.entries(values)
      .map(([k, v]) => `${k}:${v};`)
      .join('')}}`
  return [
    Object.keys(dark).length ? block(':root[data-scheme="dark"]', dark) : '',
    Object.keys(light).length ? block(':root[data-scheme="light"]', light) : ''
  ]
    .filter(Boolean)
    .join('\n')
}

function eventsOn(topic: string, cb: (data: unknown) => void): () => void {
  let set = eventBus.get(topic)
  if (!set) {
    set = new Set()
    eventBus.set(topic, set)
  }
  set.add(cb)
  return () => {
    const current = eventBus.get(topic)
    if (!current) return
    current.delete(cb)
    if (!current.size) eventBus.delete(topic)
  }
}

function eventsEmit(topic: string, data: unknown): void {
  const set = eventBus.get(topic)
  if (!set) return
  for (const cb of [...set]) {
    try {
      cb(data)
    } catch (e) {
      console.error(`[plugin] event ${topic} listener failed`, e)
    }
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function activatePlugin(plugin: InstalledPlugin): Promise<void> {
  const api = window.api?.plugins
  if (!api) throw new Error('plugin-api-unavailable')
  if (loaded.has(plugin.id) || activating.has(plugin.id)) return
  activating.add(plugin.id)

  let entry: LoadedEntry | null = null
  try {
    const runtime = await api.runtime(plugin.id)
    if (!runtime) return
    const manifest = runtime.manifest
    entry = {
      plugin,
      manifest,
      disposers: [],
      cleanup: null,
      styles: [],
      blobUrl: null
    }
    loaded.set(plugin.id, entry)

    // 免代码插件的 styles.css 是它的全部能力，不需要额外权限；
    // 需要运行代码的插件要注入 CSS，必须声明 theme。
    if (
      runtime.css &&
      (manifest.tier === 'declarative' || manifest.permissions.includes('theme'))
    ) {
      entry.styles.push(injectStyle(plugin.id, runtime.css, 'plugin-css'))
    }

    const theme = manifest.contributes?.themes?.[0]
    if (theme && manifest.permissions.includes('theme')) {
      entry.styles.push(
        injectStyle(plugin.id, tokensCss(theme.tokens), 'plugin-tokens')
      )
    }

    if (
      manifest.contributes?.statusBarItems &&
      manifest.permissions.includes('ui:status-bar')
    ) {
      for (const item of manifest.contributes.statusBarItems) {
        const contribution: PluginStatusTextContribution = {
          kind: 'text',
          id: nextId('status'),
          pluginId: manifest.id,
          pluginName: manifest.name,
          text: item.text,
          tone: (item.tone ?? 'default') as PluginStatusBarTone,
          align: item.align === 'end' ? 'end' : 'start'
        }
        addContribution('statusBar', contribution)
      }
    }

    if (
      manifest.contributes?.commands &&
      manifest.permissions.includes('ui:command')
    ) {
      for (const item of manifest.contributes.commands) {
        const contribution: PluginCommandContribution = {
          id: nextId('command'),
          pluginId: manifest.id,
          pluginName: manifest.name,
          key: item.key,
          title: item.title,
          description: item.description ?? '',
          keywords: item.keywords ?? [],
          run: () => eventsEmit(`command:${item.key}`, { pluginId: manifest.id, key: item.key })
        }
        addContribution('commands', contribution)
      }
    }

    if (manifest.tier === 'js') {
      if (!runtime.main) throw new Error('main-missing')
      const imported = await importPluginModule(runtime.main)
      entry.blobUrl = imported.url
      const ctx = createPluginContext({
        plugin,
        manifest,
        appVersion: runtime.appVersion,
        onDispose: (fn) => entry!.disposers.push(fn),
        addStatusBar: (item: PluginStatusComponentContribution) => addContribution('statusBar', item),
        addCommand: (item: PluginCommandContribution) => addContribution('commands', item),
        addSettings: (item: PluginSettingsContribution) => addContribution('settings', item),
        addPanelTab: (item: PluginPanelTabContribution) => addContribution('panelTabs', item),
        injectCss: (css) => {
          const el = injectStyle(manifest.id, css, 'plugin-runtime-css')
          entry!.styles.push(el)
          return () => {
            el.remove()
            if (entry) entry.styles = entry.styles.filter((x) => x !== el)
          }
        },
        injectTokens: (tokens) => {
          const el = injectStyle(manifest.id, tokensCss(tokens), 'plugin-runtime-tokens')
          entry!.styles.push(el)
          return () => {
            el.remove()
            if (entry) entry.styles = entry.styles.filter((x) => x !== el)
          }
        },
        eventsOn,
        eventsEmit
      })
      const cleanup = imported.activate(ctx)
      if (typeof cleanup === 'function') entry.cleanup = cleanup
    }

    clearError(plugin.id)
    setLoaded(plugin.id, true)
  } catch (e) {
    if (entry) {
      await deactivatePlugin(plugin.id)
    }
    patch({ errors: { ...state.errors, [plugin.id]: messageOf(e) } })
    console.error(`[plugin:${plugin.id}] activate failed`, e)
  } finally {
    activating.delete(plugin.id)
  }
}

async function deactivatePlugin(id: string): Promise<void> {
  const entry = loaded.get(id)
  if (!entry) {
    removePluginContributions(id)
    setLoaded(id, false)
    return
  }
  loaded.delete(id)

  if (entry.cleanup) {
    try {
      entry.cleanup()
    } catch (e) {
      console.error(`[plugin:${id}] cleanup failed`, e)
    }
  }
  for (let i = entry.disposers.length - 1; i >= 0; i--) {
    try {
      entry.disposers[i]()
    } catch (e) {
      console.error(`[plugin:${id}] disposer failed`, e)
    }
  }
  for (const style of entry.styles) style.remove()
  if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl)
  removePluginContributions(id)
  setLoaded(id, false)
}

async function doRefresh(): Promise<void> {
  const api = window.api?.plugins
  if (!api) {
    patch({
      loading: false,
      errors: { ...state.errors, __host: 'plugin-api-unavailable' }
    })
    return
  }
  let list
  try {
    list = await api.list()
  } catch (e) {
    patch({
      loading: false,
      errors: { ...state.errors, __host: messageOf(e) }
    })
    return
  }

  patch({ plugins: list.plugins, root: list.root, loading: false })

  for (const id of [...loaded.keys()]) {
    const plugin = list.plugins.find((x) => x.id === id)
    if (!plugin || !plugin.enabled || plugin.error) await deactivatePlugin(id)
  }

  for (const plugin of list.plugins) {
    if (!plugin.enabled || plugin.error) continue
    if (loaded.has(plugin.id) || activating.has(plugin.id)) continue
    await activatePlugin(plugin)
  }
}

export function refreshPlugins(): Promise<void> {
  if (refreshing) return refreshing
  refreshing = doRefresh().finally(() => {
    refreshing = null
  })
  return refreshing
}

/** App 启动时调用一次；StrictMode 下重复调用也只会真正跑一遍。 */
export function initPluginHost(): Promise<void> {
  if (initialized) return initialized
  initialized = (async () => {
    if (!offChanged && window.api?.plugins) {
      offChanged = window.api.plugins.onChanged(() => {
        void refreshPlugins()
      })
    }
    await refreshPlugins()
  })()
  return initialized
}

export function getPluginHostState(): PluginHostState {
  return state
}

export function subscribePluginHost(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/* ── 对页面暴露的安装 / 启停封装 ─────────────────────────── */

function unavailable(): PluginMutationResult {
  return {
    ok: false,
    error: 'plugin-api-unavailable',
    list: { plugins: state.plugins, root: state.root }
  }
}

/** 第一步：弹目录选择器并解析 manifest，不安装。 */
export async function inspectLocalPlugin(): Promise<PluginLocalInspectResult> {
  const api = window.api?.plugins
  if (!api) return { ok: false, error: 'plugin-api-unavailable' }
  return api.inspectLocal()
}

/** 第二步：凭主进程发放的 token 确认安装。 */
export async function installPluginFromLocal(token: string): Promise<PluginMutationResult> {
  const api = window.api?.plugins
  if (!api) return unavailable()
  const result = await api.installLocal(token)
  if (result.ok) await refreshPlugins()
  return result
}

export async function setPluginEnabled(
  id: string,
  enabled: boolean
): Promise<PluginMutationResult> {
  const api = window.api?.plugins
  if (!api) return unavailable()
  const result = await api.setEnabled(id, enabled)
  await refreshPlugins()
  return result
}

export async function uninstallPlugin(id: string): Promise<PluginMutationResult> {
  const api = window.api?.plugins
  if (!api) return unavailable()
  const result = await api.uninstall(id)
  await refreshPlugins()
  return result
}

export async function revealPlugin(id: string): Promise<{ ok: boolean; error?: string }> {
  const api = window.api?.plugins
  if (!api) return { ok: false, error: 'plugin-api-unavailable' }
  return api.reveal(id)
}

export async function installPluginFromMarket(
  id: string,
  version?: string
): Promise<PluginMutationResult> {
  const api = window.api?.plugins
  if (!api) return unavailable()
  const result = await api.market.install(id, version)
  if (result.ok) await refreshPlugins()
  return result
}

/** 热重载：先卸载当前实例，再按磁盘上的最新代码重新 activate。 */
export async function reloadPlugin(id: string): Promise<void> {
  await deactivatePlugin(id)
  await refreshPlugins()
}

/** 供 Tier-0 命令 / 其他模块发事件用；权限由 ctx 负责。 */
export function emitPluginEvent(topic: string, data: unknown): void {
  eventsEmit(topic, data)
}

export type {
  PluginCommandContribution,
  PluginPanelTabContribution,
  PluginSettingsContribution,
  PluginStatusContribution
}
