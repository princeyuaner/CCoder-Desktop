/**
 * 插件系统的共享契约。
 *
 * 这里只放**两端都要认的数据形状**：manifest、已安装列表、市场索引、
 * IPC 载荷。真正的文件读写、目录扫描、下载解压在 main/plugins。
 *
 * 设计原则和 MCP / Skills / Hooks 一致：渲染层永远不传文件路径给写入接口，
 * 主进程按插件 id 自己定位目录；manifest 在进入运行时之前先过一遍校验。
 */

export type PluginTier = 'declarative' | 'js'

export type PluginPermissionRisk = 'low' | 'mid' | 'high'

export type PluginStatusBarTone = 'default' | 'accent' | 'ok' | 'warn' | 'danger'

export interface PluginThemeContribution {
  name?: string
  /** 只接受 `--*` 自定义属性；light / dark 分别落到 data-scheme。 */
  tokens: {
    light?: Record<string, string>
    dark?: Record<string, string>
  }
}

export interface PluginStatusBarContribution {
  key?: string
  text: string
  tone?: PluginStatusBarTone
  align?: 'start' | 'end'
}

export interface PluginCommandContribution {
  key: string
  title: string
  description?: string
  keywords?: string[]
}

export interface PluginI18nContribution {
  lang: string
  ns?: string
  resources: Record<string, unknown>
}

export interface PluginContributions {
  themes?: PluginThemeContribution[]
  statusBarItems?: PluginStatusBarContribution[]
  commands?: PluginCommandContribution[]
  i18n?: PluginI18nContribution[]
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  tier: PluginTier
  description?: string
  author?: string
  homepage?: string
  minAppVersion?: string
  sdkVersion?: string
  permissions: string[]
  contributes?: PluginContributions
  configSchema?: Record<string, unknown>
}

export interface InstalledPlugin {
  id: string
  name: string
  version: string
  tier: PluginTier
  description: string
  author?: string
  permissions: string[]
  enabled: boolean
  installedAt: number
  updatedAt: number
  /** 插件目录绝对路径；设置页只展示，不参与任何写入参数 */
  dir: string
  /** 目录字节数，主进程扫描时顺手算出来 */
  size: number
  /** manifest 里声明的静态贡献，详情页展示用 */
  contributes?: PluginContributions
  /** 扫描 / 校验失败时的原因；有它时其余字段尽量保留 */
  error?: string
  /** 市场安装的插件标 true，用于详情页展示来源 */
  fromMarket?: boolean
  verified?: boolean
}

export interface PluginListResult {
  plugins: InstalledPlugin[]
  /** 插件根目录，界面底部显示 */
  root: string
}

export interface PluginMutationResult {
  ok: boolean
  error?: string
  list: PluginListResult
}

export interface PluginRuntimeAssets {
  manifest: PluginManifest
  /** only tier=js */
  main: string | null
  css: string | null
  dir: string
  /** 宿主版本，注入 ctx.host.appVersion */
  appVersion: string
}

export interface PluginStorageValue {
  ok: boolean
  value?: unknown
  error?: string
}

/** 本地目录安装的两步流程：先预览，再凭 token 确认安装。 */
export interface PluginLocalPreview {
  token: string
  source: string
  manifest: PluginManifest
  size: number
}

export interface PluginLocalInspectResult {
  ok: boolean
  error?: string
  preview?: PluginLocalPreview
}

export interface PluginSetStorageResult {
  ok: boolean
  error?: string
}

/* ── 市场 ─────────────────────────────────────────────────── */

export interface PluginMarketVersion {
  version: string
  tier?: PluginTier
  minAppVersion?: string
  sdkVersion?: string
  permissions?: string[]
  /** 插件 zip 的 https 地址 */
  url: string
  /** hex sha256；有就校验，没有至少校验大小 */
  sha256?: string
  size?: number
  publishedAt?: string
}

export interface PluginMarketEntry {
  id: string
  name: string
  author?: string
  description?: string
  /** 市场展示图；v1 只支持 https / data URL，加载失败时显示首字母 */
  icon?: string
  verified?: boolean
  latest: string
  versions: PluginMarketVersion[]
  category?: string
  tags?: string[]
  installs?: number
  rating?: number
}

export interface PluginMarketIndex {
  schemaVersion: number
  generatedAt?: string
  plugins: PluginMarketEntry[]
}

export interface PluginMarketListResult {
  ok: boolean
  index?: PluginMarketIndex
  error?: string
  source: string
  fetchedAt: number
}

export interface PluginMarketInstallResult {
  ok: boolean
  error?: string
  list: PluginListResult
}

/* ── manifest 校验 ────────────────────────────────────────── */

export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
export const PLUGIN_VERSION_RE = /^\d+\.\d+\.\d+$/
export const PLUGIN_SDK_VERSION = '0.1.0'

/** v1 市场索引的默认位置；可用 CCODER_PLUGIN_MARKET_URL 覆盖。 */
export const DEFAULT_PLUGIN_MARKET_URL =
  'https://raw.githubusercontent.com/princeyuaner/CCoder-Desktop/main/docs/plugins/index.json'

/**
 * 权限目录。运行时只实现了其中一部分；没实现的权限可以声明，但调用对应
 * ctx 能力时仍然会被门禁拒绝。未知权限直接拒绝安装/加载。
 */
const BASE_PERMISSIONS = new Set([
  'storage',
  'theme',
  'i18n',
  'events',
  'composer:draft',
  'agent',
  'session.lifecycle.read',
  'runtime.events.read',
  'runtime.switch.observe',
  'workspace.metadata.read',
  'prompt.contribute.internal',
  'plugin.storage',
  'assets:bundle',
  'assets:directory',
  'ui:status-bar',
  'ui:command',
  'ui:settings-section',
  'ui:panel-tab',
  'ui:sidebar-entry',
  'ui:center-tab',
  'ui:overlay',
  'ui:add-menu',
  'ui:composer-status',
  'ui:conversation-mode',
  'ui:markdown',
  'ui:timeline-row',
  'ui:session-menu',
  'ui:workspace-menu',
  'ui:page',
  'host:session',
  'host:workspace',
  'host:workspace:remote',
  'host:worktree',
  'host:models',
  'host:window',
  'network:none'
])

const RISK_OF: Record<string, PluginPermissionRisk> = {
  storage: 'low',
  theme: 'low',
  i18n: 'low',
  events: 'low',
  'composer:draft': 'mid',
  'plugin.storage': 'low',
  'assets:bundle': 'low',
  'assets:directory': 'mid',
  'ui:status-bar': 'low',
  'ui:command': 'low',
  'ui:settings-section': 'low',
  'ui:panel-tab': 'low',
  'ui:sidebar-entry': 'low',
  'ui:center-tab': 'low',
  'ui:overlay': 'mid',
  'ui:add-menu': 'low',
  'ui:composer-status': 'low',
  'ui:conversation-mode': 'mid',
  'ui:markdown': 'mid',
  'ui:timeline-row': 'mid',
  'ui:session-menu': 'low',
  'ui:workspace-menu': 'low',
  'ui:page': 'low',
  'session.lifecycle.read': 'mid',
  'runtime.events.read': 'mid',
  'runtime.switch.observe': 'mid',
  'workspace.metadata.read': 'low',
  'prompt.contribute.internal': 'mid',
  'host:session': 'mid',
  'host:workspace': 'low',
  'host:workspace:remote': 'high',
  'host:worktree': 'mid',
  'host:models': 'low',
  'host:window': 'mid',
  agent: 'high',
  'network:none': 'low'
}

export function permissionRisk(key: string): PluginPermissionRisk {
  if (RISK_OF[key]) return RISK_OF[key]
  if (key.startsWith('network:')) return 'mid'
  if (key.startsWith('exec:')) return 'high'
  return 'low'
}

export function isPluginPermission(key: string): boolean {
  if (BASE_PERMISSIONS.has(key)) return true
  if (key.startsWith('network:')) {
    const host = key.slice('network:'.length)
    return /^[A-Za-z0-9.-]+(:\d{1,5}(-\d{1,5})?)?$/.test(host)
  }
  if (key.startsWith('exec:')) {
    return /^[A-Za-z0-9._-]+$/.test(key.slice('exec:'.length))
  }
  return false
}

export function isPluginTier(v: unknown): v is PluginTier {
  return v === 'declarative' || v === 'js'
}

/** a >= b ? 1 : -1；只支持三段数字版本。 */
export function comparePluginVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

export function pluginVersionAtLeast(current: string, min: string): boolean {
  if (!PLUGIN_VERSION_RE.test(current) || !PLUGIN_VERSION_RE.test(min)) return false
  return comparePluginVersions(current, min) >= 0
}

const asText = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(asText).filter(Boolean) : []

function normalizeThemes(raw: unknown): PluginThemeContribution[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: PluginThemeContribution[] = []
  for (const item of raw) {
    const o = asRecord(item)
    const tokens = asRecord(o?.tokens)
    if (!tokens) continue
    const clean = (v: unknown): Record<string, string> | undefined => {
      const r = asRecord(v)
      if (!r) return undefined
      const out: Record<string, string> = {}
      for (const [k, val] of Object.entries(r)) {
        if (!k.startsWith('--') || typeof val !== 'string') continue
        if (val.length > 200) continue
        out[k] = val
      }
      return Object.keys(out).length ? out : undefined
    }
    const light = clean(tokens.light)
    const dark = clean(tokens.dark)
    if (!light && !dark) continue
    out.push({ name: asText(o?.name) || undefined, tokens: { ...(light ? { light } : {}), ...(dark ? { dark } : {}) } })
  }
  return out.length ? out : undefined
}

function normalizeStatusBar(raw: unknown): PluginStatusBarContribution[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: PluginStatusBarContribution[] = []
  for (const item of raw) {
    const o = asRecord(item)
    const text = asText(o?.text)
    if (!text) continue
    const tone = asText(o?.tone)
    const align = asText(o?.align)
    out.push({
      text: text.slice(0, 200),
      ...(asText(o?.key) ? { key: asText(o?.key).slice(0, 80) } : {}),
      ...(tone === 'accent' || tone === 'ok' || tone === 'warn' || tone === 'danger'
        ? { tone }
        : {}),
      ...(align === 'end' ? { align: 'end' } : {})
    })
  }
  return out.length ? out : undefined
}

function normalizeCommands(raw: unknown): PluginCommandContribution[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: PluginCommandContribution[] = []
  for (const item of raw) {
    const o = asRecord(item)
    const key = asText(o?.key)
    const title = asText(o?.title)
    if (!key || !title) continue
    out.push({
      key: key.slice(0, 80),
      title: title.slice(0, 120),
      ...(asText(o?.description) ? { description: asText(o?.description).slice(0, 300) } : {}),
      ...(Array.isArray(o?.keywords)
        ? { keywords: asStringArray(o?.keywords).map((x) => x.slice(0, 40)).slice(0, 20) }
        : {})
    })
  }
  return out.length ? out : undefined
}

function normalizeI18n(raw: unknown): PluginI18nContribution[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: PluginI18nContribution[] = []
  for (const item of raw) {
    const o = asRecord(item)
    const lang = asText(o?.lang)
    const resources = asRecord(o?.resources)
    if (!lang || !resources) continue
    out.push({
      lang: lang.slice(0, 20),
      ...(asText(o?.ns) ? { ns: asText(o?.ns).slice(0, 80) } : {}),
      resources
    })
  }
  return out.length ? out : undefined
}

export interface PluginManifestCheck {
  manifest: PluginManifest | null
  error?: string
}

/**
 * 校验并收敛 manifest。未知字段丢弃、字符串裁剪长度；任何会让运行时
 * 陷入未定义状态的错误都返回 error，由主进程拒绝安装/加载。
 */
export function checkPluginManifest(raw: unknown): PluginManifestCheck {
  const o = asRecord(raw)
  if (!o) return { manifest: null, error: 'manifest-not-object' }

  const id = asText(o.id)
  if (!PLUGIN_ID_RE.test(id)) return { manifest: null, error: 'manifest-invalid-id' }

  const version = asText(o.version)
  if (!PLUGIN_VERSION_RE.test(version)) {
    return { manifest: null, error: 'manifest-invalid-version' }
  }

  if (!isPluginTier(o.tier)) return { manifest: null, error: 'manifest-invalid-tier' }

  const permissions = asStringArray(o.permissions)
  const seen = new Set<string>()
  for (const p of permissions) {
    if (!isPluginPermission(p)) return { manifest: null, error: `manifest-unknown-permission:${p}` }
    if (seen.has(p)) return { manifest: null, error: `manifest-duplicate-permission:${p}` }
    seen.add(p)
  }

  const minAppVersion = asText(o.minAppVersion)
  if (minAppVersion && !PLUGIN_VERSION_RE.test(minAppVersion)) {
    return { manifest: null, error: 'manifest-invalid-min-app-version' }
  }

  const c = asRecord(o.contributes)
  const contributes: PluginContributions = {
    ...(normalizeThemes(c?.themes) ? { themes: normalizeThemes(c?.themes) } : {}),
    ...(normalizeStatusBar(c?.statusBarItems)
      ? { statusBarItems: normalizeStatusBar(c?.statusBarItems) }
      : {}),
    ...(normalizeCommands(c?.commands) ? { commands: normalizeCommands(c?.commands) } : {}),
    ...(normalizeI18n(c?.i18n) ? { i18n: normalizeI18n(c?.i18n) } : {})
  }

  const manifest: PluginManifest = {
    id,
    name: asText(o.name) || id,
    version,
    tier: o.tier,
    ...(asText(o.description) ? { description: asText(o.description).slice(0, 1000) } : {}),
    ...(asText(o.author) ? { author: asText(o.author).slice(0, 120) } : {}),
    ...(asText(o.homepage) ? { homepage: asText(o.homepage).slice(0, 500) } : {}),
    ...(minAppVersion ? { minAppVersion } : {}),
    ...(asText(o.sdkVersion) ? { sdkVersion: asText(o.sdkVersion).slice(0, 40) } : {}),
    permissions,
    ...(Object.keys(contributes).length ? { contributes } : {}),
    ...(asRecord(o.configSchema) ? { configSchema: asRecord(o.configSchema) as Record<string, unknown> } : {})
  }

  return { manifest }
}
