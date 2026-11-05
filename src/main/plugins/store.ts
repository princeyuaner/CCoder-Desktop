import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type {
  PluginListResult,
  PluginManifest,
  PluginMutationResult,
  PluginRuntimeAssets,
  PluginSetStorageResult,
  PluginStorageValue,
  InstalledPlugin
} from '../../shared/plugins'
import {
  checkPluginManifest,
  PLUGIN_ID_RE,
  pluginVersionAtLeast
} from '../../shared/plugins'
import type { PluginHostContext } from './context'

const MAX_PLUGIN_BYTES = 16 * 1024 * 1024
const MAX_PLUGIN_FILES = 2000
const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_MAIN_BYTES = 2 * 1024 * 1024
const MAX_CSS_BYTES = 1024 * 1024
const MAX_STORAGE_BYTES = 512 * 1024
const STORAGE_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg'])
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db'])

interface PluginStateEntry {
  enabled: boolean
  installedAt: number
  updatedAt?: number
  fromMarket?: boolean
  verified?: boolean
}

type PluginStateFile = Record<string, PluginStateEntry>

interface ManifestRead {
  manifest: PluginManifest | null
  error?: string
}

function ensureRoot(ctx: PluginHostContext): void {
  mkdirSync(ctx.root, { recursive: true })
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

function readText(path: string, max: number): string | null {
  try {
    const st = statSync(path)
    if (!st.isFile() || st.size > max) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function readJson(path: string, max = 4 * 1024 * 1024): unknown {
  const text = readText(path, max)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function loadState(ctx: PluginHostContext): PluginStateFile {
  const raw = readJson(ctx.statePath)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: PluginStateFile = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!PLUGIN_ID_RE.test(id) || !value || typeof value !== 'object' || Array.isArray(value)) {
      continue
    }
    const o = value as Record<string, unknown>
    out[id] = {
      enabled: o.enabled !== false,
      installedAt:
        typeof o.installedAt === 'number' && Number.isFinite(o.installedAt)
          ? o.installedAt
          : Date.now(),
      ...(typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt)
        ? { updatedAt: o.updatedAt }
        : {}),
      ...(o.fromMarket === true ? { fromMarket: true } : {}),
      ...(o.verified === true ? { verified: true } : {})
    }
  }
  return out
}

function saveState(ctx: PluginHostContext, state: PluginStateFile): void {
  mkdirSync(dirname(ctx.statePath), { recursive: true })
  const tmp = `${ctx.statePath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  try {
    renameSync(tmp, ctx.statePath)
  } catch {
    rmSync(tmp, { force: true })
    writeFileSync(ctx.statePath, JSON.stringify(state, null, 2), 'utf8')
  }
}

function manifestRead(ctx: PluginHostContext, dir: string, checkDirName: boolean): ManifestRead {
  const path = join(dir, 'manifest.json')
  if (!isFile(path)) return { manifest: null, error: 'manifest-missing' }
  const raw = readJson(path, MAX_MANIFEST_BYTES)
  if (raw === null) return { manifest: null, error: 'manifest-unreadable' }
  const checked = checkPluginManifest(raw)
  if (!checked.manifest) return { manifest: null, error: checked.error ?? 'manifest-invalid' }

  const manifest = checked.manifest
  if (checkDirName && basename(dir) !== manifest.id) {
    return { manifest, error: 'manifest-id-mismatch' }
  }
  if (manifest.tier === 'js' && !isFile(join(dir, 'main.js'))) {
    return { manifest, error: 'main-missing' }
  }
  if (manifest.minAppVersion && !pluginVersionAtLeast(ctx.appVersion, manifest.minAppVersion)) {
    return { manifest, error: `incompatible-app-version:${manifest.minAppVersion}` }
  }
  return { manifest }
}

function measureTree(dir: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  const walk = (path: string): void => {
    let entries
    try {
      entries = readdirSync(path, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (files > MAX_PLUGIN_FILES || bytes > MAX_PLUGIN_BYTES) return
      if (SKIP_FILES.has(ent.name)) continue
      const abs = join(path, ent.name)
      if (ent.isSymbolicLink()) continue
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue
        walk(abs)
        continue
      }
      if (!ent.isFile()) continue
      try {
        files += 1
        bytes += statSync(abs).size
      } catch {
        // 文件在扫描时被删了，忽略
      }
    }
  }
  walk(dir)
  return { files, bytes }
}

function copyTree(source: string, target: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  const walk = (src: string, dest: string): void => {
    mkdirSync(dest, { recursive: true })
    let entries
    try {
      entries = readdirSync(src, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (files > MAX_PLUGIN_FILES || bytes > MAX_PLUGIN_BYTES) {
        throw new Error('plugin-too-large')
      }
      if (SKIP_FILES.has(ent.name)) continue
      const abs = join(src, ent.name)
      if (ent.isSymbolicLink()) continue
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue
        walk(abs, join(dest, ent.name))
        continue
      }
      if (!ent.isFile()) continue
      const size = statSync(abs).size
      bytes += size
      files += 1
      if (bytes > MAX_PLUGIN_BYTES || files > MAX_PLUGIN_FILES) {
        throw new Error('plugin-too-large')
      }
      copyFileSync(abs, join(dest, ent.name))
    }
  }
  walk(source, target)
  return { files, bytes }
}

export function listPlugins(ctx: PluginHostContext): PluginListResult {
  const state = loadState(ctx)
  const plugins: InstalledPlugin[] = []
  let entries: Dirent<string>[] = []
  try {
    entries = readdirSync(ctx.root, { withFileTypes: true })
  } catch {
    return { plugins, root: ctx.root }
  }

  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue
    const dir = join(ctx.root, ent.name)
    const read = manifestRead(ctx, dir, true)
    const st = state[ent.name]
    let installedAt = st?.installedAt ?? 0
    if (!installedAt) {
      try {
        installedAt = statSync(dir).mtimeMs
      } catch {
        installedAt = Date.now()
      }
    }
    const measured = measureTree(dir)
    const manifest = read.manifest
    plugins.push({
      id: ent.name,
      name: manifest?.name ?? ent.name,
      version: manifest?.version ?? '0.0.0',
      tier: manifest?.tier ?? 'declarative',
      description: manifest?.description ?? '',
      ...(manifest?.author ? { author: manifest.author } : {}),
      permissions: manifest?.permissions ?? [],
      enabled: !read.error && (st?.enabled ?? true),
      installedAt,
      updatedAt: st?.updatedAt ?? installedAt,
      dir,
      size: measured.bytes,
      ...(manifest?.contributes ? { contributes: manifest.contributes } : {}),
      ...(read.error ? { error: read.error } : {}),
      ...(st?.fromMarket ? { fromMarket: true } : {}),
      ...(st?.verified ? { verified: true } : {})
    })
  }

  plugins.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  return { plugins, root: ctx.root }
}

export interface InstallOptions {
  fromMarket?: boolean
  verified?: boolean
}

export interface PluginInspectResult {
  ok: boolean
  error?: string
  manifest?: PluginManifest
  size?: number
  source?: string
}

/** 只解析并校验目录，不复制；本地安装弹窗用它先展示权限。 */
export function inspectPluginDirectory(
  ctx: PluginHostContext,
  source: string
): PluginInspectResult {
  const src = resolve(source)
  if (!isDirectory(src)) return { ok: false, error: 'source-not-directory' }

  const read = manifestRead(ctx, src, false)
  if (!read.manifest) return { ok: false, error: read.error ?? 'manifest-invalid' }
  const manifest = read.manifest

  if (manifest.tier === 'js' && readText(join(src, 'main.js'), MAX_MAIN_BYTES) === null) {
    return { ok: false, error: 'main-missing' }
  }
  const css = join(src, 'styles.css')
  if (existsSync(css) && readText(css, MAX_CSS_BYTES) === null) {
    return { ok: false, error: 'css-too-large' }
  }
  const measured = measureTree(src)
  if (measured.bytes > MAX_PLUGIN_BYTES || measured.files > MAX_PLUGIN_FILES) {
    return { ok: false, error: 'plugin-too-large' }
  }
  return { ok: true, manifest, size: measured.bytes, source: src }
}

export function installFromDirectory(
  ctx: PluginHostContext,
  source: string,
  options: InstallOptions = {}
): PluginMutationResult {
  const fail = (error: string): PluginMutationResult => ({
    ok: false,
    error,
    list: listPlugins(ctx)
  })

  const src = resolve(source)
  if (!isDirectory(src)) return fail('source-not-directory')

  const read = manifestRead(ctx, src, false)
  if (!read.manifest) return fail(read.error ?? 'manifest-invalid')
  const manifest = read.manifest

  if (manifest.tier === 'js') {
    const main = readText(join(src, 'main.js'), MAX_MAIN_BYTES)
    if (main === null) return fail('main-missing')
  }
  const css = join(src, 'styles.css')
  if (existsSync(css) && readText(css, MAX_CSS_BYTES) === null) return fail('css-too-large')

  const measured = measureTree(src)
  if (measured.bytes > MAX_PLUGIN_BYTES || measured.files > MAX_PLUGIN_FILES) {
    return fail('plugin-too-large')
  }

  ensureRoot(ctx)
  const target = join(ctx.root, manifest.id)
  const staging = join(ctx.root, `.staging-${manifest.id}-${process.pid}-${Date.now()}`)

  try {
    copyTree(src, staging)
    const after = manifestRead(ctx, staging, false)
    if (!after.manifest) {
      rmSync(staging, { recursive: true, force: true })
      return fail(after.error ?? 'manifest-invalid')
    }
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
  } catch (e) {
    rmSync(staging, { recursive: true, force: true })
    return fail(e instanceof Error ? e.message : String(e))
  }

  const state = loadState(ctx)
  const previous = state[manifest.id]
  const now = Date.now()
  state[manifest.id] = {
    enabled: previous?.enabled ?? true,
    installedAt: previous?.installedAt ?? now,
    updatedAt: now,
    ...(options.fromMarket ? { fromMarket: true } : {}),
    ...(options.verified ? { verified: true } : {})
  }
  saveState(ctx, state)
  return { ok: true, list: listPlugins(ctx) }
}

export function setPluginEnabled(
  ctx: PluginHostContext,
  id: string,
  enabled: boolean
): PluginMutationResult {
  const fail = (error: string): PluginMutationResult => ({
    ok: false,
    error,
    list: listPlugins(ctx)
  })
  if (!PLUGIN_ID_RE.test(id)) return fail('invalid-id')
  const dir = join(ctx.root, id)
  if (!isDirectory(dir)) return fail('plugin-not-found')

  if (enabled) {
    const read = manifestRead(ctx, dir, true)
    if (!read.manifest) return fail(read.error ?? 'manifest-invalid')
  }

  const state = loadState(ctx)
  const now = Date.now()
  const previous = state[id]
  state[id] = {
    enabled,
    installedAt: previous?.installedAt ?? now,
    updatedAt: previous?.updatedAt ?? now,
    ...(previous?.fromMarket ? { fromMarket: true } : {}),
    ...(previous?.verified ? { verified: true } : {})
  }
  saveState(ctx, state)
  return { ok: true, list: listPlugins(ctx) }
}

export function uninstallPlugin(ctx: PluginHostContext, id: string): PluginMutationResult {
  const fail = (error: string): PluginMutationResult => ({
    ok: false,
    error,
    list: listPlugins(ctx)
  })
  if (!PLUGIN_ID_RE.test(id)) return fail('invalid-id')
  const dir = join(ctx.root, id)
  if (!isDirectory(dir)) return fail('plugin-not-found')

  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
  const state = loadState(ctx)
  delete state[id]
  saveState(ctx, state)
  return { ok: true, list: listPlugins(ctx) }
}

export function pluginDir(ctx: PluginHostContext, id: string): string | null {
  if (!PLUGIN_ID_RE.test(id)) return null
  const dir = join(ctx.root, id)
  if (!isDirectory(dir)) return null
  // 防一手：join 之后必须仍然是 root 的直接子目录
  if (resolve(dirname(dir)) !== resolve(ctx.root)) return null
  return dir
}

export function readPluginRuntime(
  ctx: PluginHostContext,
  id: string
): PluginRuntimeAssets | null {
  const dir = pluginDir(ctx, id)
  if (!dir) return null
  const state = loadState(ctx)
  if (state[id]?.enabled === false) return null
  const read = manifestRead(ctx, dir, true)
  if (!read.manifest) return null

  const manifest = read.manifest
  const main = manifest.tier === 'js' ? readText(join(dir, 'main.js'), MAX_MAIN_BYTES) : null
  if (manifest.tier === 'js' && main === null) return null
  const css = readText(join(dir, 'styles.css'), MAX_CSS_BYTES)
  return { manifest, main, css, dir, appVersion: ctx.appVersion }
}

function storagePath(ctx: PluginHostContext, id: string): string | null {
  if (!PLUGIN_ID_RE.test(id)) return null
  return join(ctx.dataRoot, `${id}.json`)
}

function loadStorage(ctx: PluginHostContext, id: string): Record<string, unknown> {
  const path = storagePath(ctx, id)
  if (!path) return {}
  const raw = readJson(path, MAX_STORAGE_BYTES * 4)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as Record<string, unknown>
}

function saveStorage(
  ctx: PluginHostContext,
  id: string,
  map: Record<string, unknown>
): PluginSetStorageResult {
  const path = storagePath(ctx, id)
  if (!path) return { ok: false, error: 'invalid-id' }
  try {
    mkdirSync(ctx.dataRoot, { recursive: true })
    const text = JSON.stringify(map)
    if (Buffer.byteLength(text, 'utf8') > MAX_STORAGE_BYTES) {
      return { ok: false, error: 'storage-too-large' }
    }
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, path)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function getPluginStorage(
  ctx: PluginHostContext,
  id: string,
  key: string
): PluginStorageValue {
  if (!PLUGIN_ID_RE.test(id) || !STORAGE_KEY_RE.test(key)) {
    return { ok: false, error: 'invalid-key' }
  }
  const map = loadStorage(ctx, id)
  return { ok: true, value: map[key] ?? null }
}

export function setPluginStorage(
  ctx: PluginHostContext,
  id: string,
  key: string,
  value: unknown
): PluginSetStorageResult {
  if (!PLUGIN_ID_RE.test(id) || !STORAGE_KEY_RE.test(key)) {
    return { ok: false, error: 'invalid-key' }
  }
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    return { ok: false, error: 'value-not-serializable' }
  }
  if (typeof serialized !== 'string') {
    return { ok: false, error: 'value-not-serializable' }
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_STORAGE_BYTES) {
    return { ok: false, error: 'value-too-large' }
  }
  const map = loadStorage(ctx, id)
  map[key] = value
  return saveStorage(ctx, id, map)
}

export function deletePluginStorage(
  ctx: PluginHostContext,
  id: string,
  key: string
): PluginSetStorageResult {
  if (!PLUGIN_ID_RE.test(id) || !STORAGE_KEY_RE.test(key)) {
    return { ok: false, error: 'invalid-key' }
  }
  const map = loadStorage(ctx, id)
  if (!(key in map)) return { ok: true }
  delete map[key]
  return saveStorage(ctx, id, map)
}
