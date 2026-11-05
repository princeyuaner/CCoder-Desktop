import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { net } from 'electron'
import type {
  PluginMarketEntry,
  PluginMarketIndex,
  PluginMarketInstallResult,
  PluginMarketListResult,
  PluginMarketVersion
} from '../../shared/plugins'
import {
  checkPluginManifest,
  DEFAULT_PLUGIN_MARKET_URL,
  PLUGIN_ID_RE,
  PLUGIN_VERSION_RE,
  pluginVersionAtLeast
} from '../../shared/plugins'
import type { PluginHostContext } from './context'
import { installFromDirectory, listPlugins } from './store'
import { extractZip } from './zip'

const CACHE_MS = 10 * 60 * 1000
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024

interface MarketCache {
  at: number
  result: PluginMarketListResult
}

let cache: MarketCache | null = null

const asText = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

function marketUrl(): string {
  return (process.env.CCODER_PLUGIN_MARKET_URL || DEFAULT_PLUGIN_MARKET_URL).trim()
}

function normalizeVersion(raw: unknown): PluginMarketVersion | null {
  const o = asRecord(raw)
  if (!o) return null
  const version = asText(o.version)
  const url = asText(o.url)
  if (!PLUGIN_VERSION_RE.test(version)) return null
  // 绝对 http(s) / file，或相对索引文件的路径（开发模式本地索引用）
  if (!/^(https?:\/\/|file:\/\/|\.{0,2}\/|[A-Za-z0-9._-]+\/)/i.test(url)) return null
  if (o.tier !== undefined && o.tier !== 'declarative' && o.tier !== 'js') return null
  return {
    version,
    ...(o.tier ? { tier: o.tier } : {}),
    ...(asText(o.minAppVersion) ? { minAppVersion: asText(o.minAppVersion) } : {}),
    ...(asText(o.sdkVersion) ? { sdkVersion: asText(o.sdkVersion) } : {}),
    ...(Array.isArray(o.permissions)
      ? { permissions: o.permissions.filter((x): x is string => typeof x === 'string') }
      : {}),
    url,
    ...(asText(o.sha256) ? { sha256: asText(o.sha256).toLowerCase() } : {}),
    ...(typeof o.size === 'number' && o.size > 0 ? { size: o.size } : {}),
    ...(asText(o.publishedAt) ? { publishedAt: asText(o.publishedAt) } : {})
  }
}

function normalizeEntry(raw: unknown): PluginMarketEntry | null {
  const o = asRecord(raw)
  if (!o) return null
  const id = asText(o.id)
  const name = asText(o.name)
  const latest = asText(o.latest)
  if (!PLUGIN_ID_RE.test(id) || !name) return null
  const versions = Array.isArray(o.versions)
    ? o.versions.map(normalizeVersion).filter((v): v is PluginMarketVersion => !!v)
    : []
  if (!versions.length) return null
  return {
    id,
    name,
    ...(asText(o.author) ? { author: asText(o.author) } : {}),
    ...(asText(o.description) ? { description: asText(o.description) } : {}),
    ...(asText(o.icon) ? { icon: asText(o.icon) } : {}),
    ...(o.verified === true ? { verified: true } : {}),
    latest: PLUGIN_VERSION_RE.test(latest) ? latest : versions[0].version,
    versions,
    ...(asText(o.category) ? { category: asText(o.category) } : {}),
    ...(Array.isArray(o.tags)
      ? { tags: o.tags.filter((x): x is string => typeof x === 'string').slice(0, 12) }
      : {}),
    ...(typeof o.installs === 'number' && o.installs >= 0 ? { installs: o.installs } : {}),
    ...(typeof o.rating === 'number' && o.rating > 0 ? { rating: o.rating } : {})
  }
}

export function normalizeMarketIndex(raw: unknown): PluginMarketIndex | null {
  const o = asRecord(raw)
  if (!o || !Array.isArray(o.plugins)) return null
  const plugins = o.plugins
    .map(normalizeEntry)
    .filter((p): p is PluginMarketEntry => !!p)
  const seen = new Set<string>()
  return {
    schemaVersion: typeof o.schemaVersion === 'number' ? o.schemaVersion : 1,
    ...(asText(o.generatedAt) ? { generatedAt: asText(o.generatedAt) } : {}),
    plugins: plugins.filter((p) => {
      if (seen.has(p.id)) return false
      seen.add(p.id)
      return true
    })
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  try {
    const res = await net.fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'CCoder-Plugin-Market/1' },
      signal: controller.signal
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    if (text.length > 4 * 1024 * 1024) throw new Error('market-index-too-large')
    return JSON.parse(text)
  } finally {
    clearTimeout(timer)
  }
}

async function fetchBuffer(raw: string, base: string): Promise<Buffer> {
  let url: URL
  try {
    url = new URL(raw, base)
  } catch {
    throw new Error('invalid-download-url')
  }

  if (url.protocol === 'file:') {
    try {
      const buffer = readFileSync(fileURLToPath(url))
      if (buffer.length > MAX_DOWNLOAD_BYTES) throw new Error('download-too-large')
      return buffer
    } catch (e) {
      if (e instanceof Error && e.message === 'download-too-large') throw e
      throw new Error('download-read-failed')
    }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('invalid-download-url')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    const res = await net.fetch(url.toString(), {
      headers: { 'user-agent': 'CCoder-Plugin-Market/1' },
      signal: controller.signal
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const length = Number(res.headers.get('content-length') || 0)
    if (length > MAX_DOWNLOAD_BYTES) throw new Error('download-too-large')
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length > MAX_DOWNLOAD_BYTES) throw new Error('download-too-large')
    return buffer
  } finally {
    clearTimeout(timer)
  }
}

function readDevMarket(
  path: string,
  now: number
): PluginMarketListResult | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    const index = normalizeMarketIndex(raw)
    if (!index) return null
    return {
      ok: true,
      index,
      source: `file://${path}`,
      fetchedAt: now
    }
  } catch {
    return null
  }
}

export async function listMarket(
  ctx: PluginHostContext,
  force = false
): Promise<PluginMarketListResult> {
  const now = Date.now()
  if (!force && cache && now - cache.at < CACHE_MS) return cache.result

  const source = marketUrl()
  const explicit = !!process.env.CCODER_PLUGIN_MARKET_URL

  // 开发模式默认先用仓库里的索引：不依赖外网，也不会让市场页卡在
  // 12 秒的远程超时上。显式设置了环境变量才按远程地址走。
  if (
    !explicit &&
    ctx.preferDevMarket === true &&
    ctx.devMarketIndex &&
    existsSync(ctx.devMarketIndex)
  ) {
    const local = readDevMarket(ctx.devMarketIndex, now)
    if (local) {
      cache = { at: now, result: local }
      return local
    }
  }

  try {
    const raw = await fetchJson(source)
    const index = normalizeMarketIndex(raw)
    if (!index) throw new Error('market-index-invalid')
    const result: PluginMarketListResult = {
      ok: true,
      index,
      source,
      fetchedAt: now
    }
    cache = { at: now, result }
    return result
  } catch (e) {
    // 远程失败时再退回本地索引（显式环境变量的场景）
    if (ctx.devMarketIndex && existsSync(ctx.devMarketIndex)) {
      const local = readDevMarket(ctx.devMarketIndex, now)
      if (local) {
        cache = { at: now, result: local }
        return local
      }
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      source,
      fetchedAt: now
    }
  }
}

function findVersion(entry: PluginMarketEntry, version?: string): PluginMarketVersion | null {
  if (version) return entry.versions.find((v) => v.version === version) ?? null
  return entry.versions.find((v) => v.version === entry.latest) ?? entry.versions[0] ?? null
}

export async function installMarketPlugin(
  ctx: PluginHostContext,
  id: string,
  version?: string
): Promise<PluginMarketInstallResult> {
  const fail = (error: string): PluginMarketInstallResult => ({
    ok: false,
    error,
    list: listPlugins(ctx)
  })

  const market = await listMarket(ctx, false)
  if (!market.ok || !market.index) return fail(market.error ?? 'market-unavailable')
  const entry = market.index.plugins.find((p) => p.id === id)
  if (!entry) return fail('market-plugin-not-found')
  const selected = findVersion(entry, version)
  if (!selected) return fail('market-version-not-found')
  if (selected.minAppVersion && !pluginVersionAtLeast(ctx.appVersion, selected.minAppVersion)) {
    return fail(`incompatible-app-version:${selected.minAppVersion}`)
  }

  // 远程索引不能指向本机文件；只有开发模式的本地索引允许 file://
  if (/^file:/i.test(selected.url) && !market.source.startsWith('file://')) {
    return fail('invalid-download-url')
  }

  let buffer: Buffer
  try {
    buffer = await fetchBuffer(selected.url, market.source)
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }

  if (selected.size && buffer.length !== selected.size) return fail('download-size-mismatch')
  if (selected.sha256) {
    const actual = createHash('sha256').update(buffer).digest('hex')
    if (actual.toLowerCase() !== selected.sha256.toLowerCase()) return fail('download-sha256-mismatch')
  }

  const temp = join(ctx.root, `.download-${id}-${process.pid}-${Date.now()}`)
  try {
    mkdirSync(temp, { recursive: true })
    extractZip(buffer, temp)

    const manifestPath = join(temp, 'manifest.json')
    if (!existsSync(manifestPath)) return fail('manifest-missing')
    let rawManifest: unknown
    try {
      rawManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
    } catch {
      return fail('manifest-unreadable')
    }
    const checked = checkPluginManifest(rawManifest)
    if (!checked.manifest) return fail(checked.error ?? 'manifest-invalid')
    if (checked.manifest.id !== entry.id) return fail('market-id-mismatch')
    if (checked.manifest.version !== selected.version) return fail('market-version-mismatch')

    const installed = installFromDirectory(ctx, temp, {
      fromMarket: true,
      verified: entry.verified === true
    })
    return { ok: installed.ok, ...(installed.error ? { error: installed.error } : {}), list: installed.list }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
