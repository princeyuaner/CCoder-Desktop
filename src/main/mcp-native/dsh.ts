import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as YAML from 'yaml'
import {
  secretKeysOf,
  type McpKeyValue,
  type McpScope,
  type McpServerConfig,
  type McpServerInput,
  type McpSourceFile,
  type McpTransport
} from '../../shared/mcp'
import { pathKey } from '../path-key'
import { NativeParseError, isWritable, readTextFile, withTextFile } from './fs'
import type {
  McpNativeContext,
  NativeMutationResult,
  NativeQuery,
  NativeReadResult
} from './types'

/**
 * DSH 的原生 MCP 配置。
 *
 * DSH 没有传统 MCP 文件；原生方式是在某个 DSH_HOME 的
 * `profiles/acp/cordis.patch.yml` 里插入一行 `@deepseek-ai/dsh-mcp-client`：
 *
 * ```yaml
 * - insert:
 *     - id: ccoder-mcp-demo
 *       name: '@deepseek-ai/dsh-mcp-client'
 *       config:
 *         transport: stdio
 *         serverName: demo
 *         command: npx
 *         args: [-y, demo]
 * ```
 *
 * 我们只管理 id 以 `ccoder-mcp-` 开头的行；用户自己的行、注释和 `!!js`
 * 表达式原样保留。
 */

const PLUGIN = '@deepseek-ai/dsh-mcp-client'
const PREFIX = 'ccoder-mcp-'
const MANAGED_KEYS = new Set([
  'transport',
  'serverName',
  'command',
  'args',
  'env',
  'cwd',
  'url',
  'headers'
])
const FORMAT = 'yaml' as const

const jsTag = {
  tag: 'tag:yaml.org,2002:js',
  resolve: (value: unknown) => value,
  stringify: (value: unknown) => String(value ?? ''),
  identify: (value: unknown) => typeof value === 'string'
}

const PARSE_OPTIONS = {
  keepSourceTokens: true,
  customTags: [jsTag],
  logLevel: 'silent' as const
}

type YamlMap = YAML.YAMLMap<unknown, unknown>
type YamlSeq = YAML.YAMLSeq<unknown>

interface RowRef {
  row: YamlMap
  parent: YamlSeq
  patch: YamlMap
  index: number
}

function resolveHome(ctx: McpNativeContext, q: NativeQuery): { home: string } | { errorKey: string } {
  const home = (q.dshHome?.trim() || ctx.dshHomes[0] || '').trim()
  if (!home) return { errorKey: 'mcp.error.homeNotAllowed' }
  const key = pathKey(home)
  if (!ctx.dshHomes.some((h) => pathKey(h) === key)) return { errorKey: 'mcp.error.homeNotAllowed' }
  return { home }
}

function patchPath(home: string): string {
  return join(home, 'profiles', 'acp', 'cordis.patch.yml')
}

function parseDoc(text: string, file: string): YAML.Document.Parsed {
  const doc = YAML.parseDocument(text, PARSE_OPTIONS)
  if (doc.errors.length) {
    throw new NativeParseError('mcp.error.parseFailed', `${file}: ${doc.errors[0].message}`)
  }
  return doc
}

function rootSeq(doc: YAML.Document.Parsed): YamlSeq | null {
  const c = doc.contents
  return YAML.isSeq(c) ? (c as YamlSeq) : null
}

function isMcpRow(row: YamlMap): boolean {
  return row.get('name') === PLUGIN
}

function rowId(row: YamlMap): string {
  const id = row.get('id')
  return typeof id === 'string' ? id : ''
}

function collectRows(doc: YAML.Document.Parsed): RowRef[] {
  const root = rootSeq(doc)
  if (!root) return []
  const out: RowRef[] = []
  for (const patch of root.items) {
    if (!YAML.isMap(patch)) continue
    const insert = (patch as YamlMap).get('insert')
    if (!YAML.isSeq(insert)) continue
    const seq = insert as YamlSeq
    seq.items.forEach((item, index) => {
      if (YAML.isMap(item) && isMcpRow(item as YamlMap)) {
        out.push({ row: item as YamlMap, parent: seq, patch: patch as YamlMap, index })
      }
    })
  }
  return out
}

function configOf(row: YamlMap): Record<string, unknown> {
  const c = row.get('config')
  return YAML.isMap(c) ? ((c.toJSON() as Record<string, unknown>) ?? {}) : {}
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function asStringRecord(v: unknown): McpKeyValue[] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return []
  const out: McpKeyValue[] = []
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (typeof value === 'string') out.push({ key, value })
    else if (typeof value === 'number' || typeof value === 'boolean') {
      out.push({ key, value: String(value) })
    }
  }
  return out
}

function inferTransport(cfg: Record<string, unknown>): { transport: McpTransport; supported: boolean } {
  if (cfg.transport === 'stdio') return { transport: 'stdio', supported: true }
  if (cfg.transport === 'streamable-http') return { transport: 'http', supported: true }
  if (cfg.transport === 'http') return { transport: 'http', supported: true }
  return { transport: 'stdio', supported: false }
}

export function dshId(home: string, rowIdValue: string): string {
  return `dsh:home:${encodeURIComponent(pathKey(home))}:${encodeURIComponent(rowIdValue)}`
}

function rowToServer(home: string, file: string, ref: RowRef, fileReadOnly: boolean): McpServerConfig {
  const id = rowId(ref.row)
  const cfg = configOf(ref.row)
  const { transport, supported } = inferTransport(cfg)
  const name = typeof cfg.serverName === 'string' ? cfg.serverName : id.replace(PREFIX, '')
  const command = typeof cfg.command === 'string' ? cfg.command : ''
  const args = asStringArray(cfg.args)
  const env = asStringRecord(cfg.env)
  const url = typeof cfg.url === 'string' ? cfg.url : ''
  const headers = asStringRecord(cfg.headers)
  const workingDir = typeof cfg.cwd === 'string' ? cfg.cwd : ''
  const enabled = ref.row.get('disabled') !== true
  const secretKeys = secretKeysOf(env, headers)
  const managed = id.startsWith(PREFIX)
  const external = !managed

  return {
    id: dshId(home, id),
    cli: 'dsh',
    name,
    transport,
    command,
    args,
    env,
    url,
    headers,
    workingDir,
    enabled,
    enabledControl: 'native',
    enabledBy: enabled ? undefined : 'row-disabled',
    scope: 'home',
    cwd: '',
    source: { file, scope: 'home', format: FORMAT, home },
    supported,
    readOnly: fileReadOnly || external || !supported,
    readOnlyReason: fileReadOnly ? 'external' : external ? 'external' : !supported ? 'unsupported' : undefined,
    hasSecrets: secretKeys.length > 0,
    secretKeys,
    nativeExtras: Object.keys(cfg).filter((k) => !MANAGED_KEYS.has(k))
  }
}

export function readDsh(ctx: McpNativeContext, q: NativeQuery): NativeReadResult {
  const resolved = resolveHome(ctx, q)
  if ('errorKey' in resolved) {
    return {
      servers: [],
      sources: [
        {
          path: '',
          scopes: ['home'],
          format: FORMAT,
          exists: false,
          readOnly: true,
          errorKey: resolved.errorKey,
          noteKey: 'mcp.dshHome.label'
        }
      ]
    }
  }
  const { home } = resolved
  const file = patchPath(home)
  const writable = isWritable(file)
  const source: McpSourceFile = {
    path: file,
    scopes: ['home'],
    format: FORMAT,
    exists: false,
    readOnly: !writable
  }

  if (!existsSync(dirname(file))) {
    source.readOnly = true
    source.errorKey = 'mcp.error.dshProfileNotInitialized'
    return { servers: [], sources: [source] }
  }

  const r = readTextFile(file)
  if (!r.ok) {
    source.error = r.detail
    source.readOnly = true
    return { servers: [], sources: [source] }
  }
  source.exists = r.file.exists
  if (!r.file.exists) {
    source.noteKey = 'mcp.dshHome.notInitialized'
    return { servers: [], sources: [source] }
  }

  let doc: YAML.Document.Parsed
  try {
    doc = parseDoc(r.file.text, file)
  } catch (e) {
    source.error = e instanceof NativeParseError ? e.detail : String(e)
    source.readOnly = true
    return { servers: [], sources: [source] }
  }
  if (doc.contents !== null && !YAML.isSeq(doc.contents)) {
    source.error = 'mcp.error.parseFailed'
    source.readOnly = true
    return { servers: [], sources: [source] }
  }

  const servers = collectRows(doc).map((ref) => rowToServer(home, file, ref, !writable))
  return { servers, sources: [source] }
}

/* ── 写入 ─────────────────────────────────────────────────── */

function sanitizeId(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'server'
  return (PREFIX + cleaned.slice(0, 40)).toLowerCase()
}

function uniqueRowId(doc: YAML.Document.Parsed, wanted: string, editingId: string | null): string {
  const ids = new Set(collectRows(doc).map((r) => rowId(r.row)))
  if (editingId) ids.delete(editingId)
  if (!ids.has(wanted)) return wanted
  for (let i = 2; i < 1000; i++) {
    const candidate = `${wanted}-${i}`
    if (!ids.has(candidate)) return candidate
  }
  return `${wanted}-${Date.now().toString(36)}`
}

function nextConfig(
  current: Record<string, unknown>,
  input: McpServerInput
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current }
  if (input.transport === 'stdio') {
    delete next.url
    delete next.headers
    next.transport = 'stdio'
    next.serverName = input.name
    next.command = input.command.trim()
    const args = input.args.map((a) => a.trim()).filter(Boolean)
    if (args.length) next.args = args
    else delete next.args
    const env = input.env.filter((kv) => kv.key.trim())
    if (env.length) next.env = Object.fromEntries(env.map((kv) => [kv.key.trim(), kv.value]))
    else delete next.env
    if (input.workingDir.trim()) next.cwd = input.workingDir.trim()
    else delete next.cwd
  } else {
    delete next.command
    delete next.args
    delete next.env
    delete next.cwd
    next.transport = 'streamable-http'
    next.serverName = input.name
    next.url = input.url.trim()
    const headers = input.headers.filter((kv) => kv.key.trim())
    if (headers.length) next.headers = Object.fromEntries(headers.map((kv) => [kv.key.trim(), kv.value]))
    else delete next.headers
  }
  return next
}

function applyConfig(doc: YAML.Document.Parsed, row: YamlMap, cfg: Record<string, unknown>): void {
  const current = row.get('config')
  if (!YAML.isMap(current)) {
    row.set('config', doc.createNode(cfg))
    return
  }
  const map = current as YamlMap
  for (const pair of [...map.items]) {
    const key = (pair as YAML.Pair).key
    const name = YAML.isScalar(key) ? String(key.value) : String(key)
    if (!(name in cfg)) map.delete(name)
  }
  for (const [key, value] of Object.entries(cfg)) {
    map.set(key, doc.createNode(value))
  }
}

function ensureInsertSeq(doc: YAML.Document.Parsed): YamlSeq {
  let root = rootSeq(doc)
  if (!root) {
    const seq = doc.createNode([]) as YamlSeq
    seq.flow = false
    doc.contents = seq as unknown as typeof doc.contents
    root = seq
  }
  root.flow = false
  for (const patch of root.items) {
    if (!YAML.isMap(patch)) continue
    const insert = (patch as YamlMap).get('insert')
    if (YAML.isSeq(insert)) return insert as YamlSeq
  }
  const seq = doc.createNode([]) as YamlSeq
  seq.flow = false
  const patch = doc.createNode({ insert: seq }) as YamlMap
  root.add(patch)
  return seq
}

function validateDoc(doc: YAML.Document.Parsed, file: string): void {
  const errors = doc.errors
  if (errors.length) {
    throw new NativeParseError('mcp.error.writeFailed', `${file}: ${errors[0].message}`)
  }
  const names = new Map<string, number>()
  for (const ref of collectRows(doc)) {
    const cfg = configOf(ref.row)
    const name = typeof cfg.serverName === 'string' ? cfg.serverName : ''
    if (!name) continue
    names.set(name, (names.get(name) ?? 0) + 1)
  }
  for (const [name, count] of names) {
    if (count > 1) {
      throw new NativeParseError('mcp.error.nativeConflict', `duplicate serverName: ${name}`)
    }
  }
}

function findRow(
  doc: YAML.Document.Parsed,
  id: string
): RowRef | null {
  return collectRows(doc).find((r) => rowId(r.row) === id) ?? null
}

function idFromServerId(serverId: string): string {
  const parts = serverId.split(':')
  const last = parts[parts.length - 1] ?? ''
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

export function saveDsh(
  ctx: McpNativeContext,
  input: McpServerInput,
  existing: McpServerConfig | null,
  q: NativeQuery
): NativeMutationResult {
  const resolved = resolveHome(ctx, q)
  if ('errorKey' in resolved) return { ok: false, errorKey: resolved.errorKey }
  const { home } = resolved
  const file = patchPath(home)
  if (!existsSync(dirname(file))) {
    return { ok: false, errorKey: 'mcp.error.dshProfileNotInitialized', sourceFile: file }
  }

  const result = withTextFile(file, 'dsh', ctx.backupRoot, (text, exists) => {
    const seed = exists ? text : '[]\n'
    const doc = parseDoc(seed, file)
    if (doc.contents !== null && !YAML.isSeq(doc.contents)) {
      throw new NativeParseError('mcp.error.parseFailed', file)
    }
    const editingId = existing ? idFromServerId(existing.id) : null
    const ref = editingId ? findRow(doc, editingId) : null
    if (editingId && !ref) {
      throw new NativeParseError('mcp.error.notFound', editingId)
    }

    // 同名检查（排除自己）
    for (const other of collectRows(doc)) {
      if (editingId && rowId(other.row) === editingId) continue
      const cfg = configOf(other.row)
      if (cfg.serverName === input.name) {
        throw new NativeParseError('mcp.error.nativeConflict', `serverName ${input.name} already exists`)
      }
    }

    if (ref) {
      const cfg = nextConfig(configOf(ref.row), input)
      applyConfig(doc, ref.row, cfg)
      if (input.enabled) ref.row.delete('disabled')
      else ref.row.set('disabled', true)
    } else {
      const seq = ensureInsertSeq(doc)
      const id = uniqueRowId(doc, sanitizeId(input.name), null)
      const cfg = nextConfig({}, input)
      const row = doc.createNode({ id, name: PLUGIN, config: cfg }) as YamlMap
      if (!input.enabled) row.set('disabled', true)
      seq.add(row)
    }

    validateDoc(doc, file)
    return String(doc)
  })

  if (!result.ok) {
    return { ok: false, errorKey: result.errorKey ?? 'mcp.error.writeFailed', detail: result.detail, sourceFile: result.sourceFile }
  }

  const saved = readDsh(ctx, { ...q, dshHome: home }).servers.find((s) => s.name === input.name)
  return {
    ok: true,
    serverId: saved?.id,
    sourceFile: result.sourceFile,
    backupPath: result.backupPath
  }
}

export function removeDsh(
  ctx: McpNativeContext,
  existing: McpServerConfig,
  q: NativeQuery
): NativeMutationResult {
  const resolved = resolveHome(ctx, q)
  if ('errorKey' in resolved) return { ok: false, errorKey: resolved.errorKey }
  const { home } = resolved
  const file = patchPath(home)
  const id = idFromServerId(existing.id)

  const result = withTextFile(file, 'dsh', ctx.backupRoot, (text, exists) => {
    if (!exists) throw new NativeParseError('mcp.error.sourceMissing', file)
    const doc = parseDoc(text, file)
    const ref = findRow(doc, id)
    if (!ref) throw new NativeParseError('mcp.error.notFound', id)
    ref.parent.items.splice(ref.index, 1)
    // 空的 insert patch 一起去掉
    if (ref.parent.items.length === 0 && ref.patch.items.length === 1) {
      const root = rootSeq(doc)
      if (root) {
        const idx = root.items.indexOf(ref.patch)
        if (idx >= 0) root.items.splice(idx, 1)
      }
    }
    validateDoc(doc, file)
    return String(doc)
  })
  return {
    ok: result.ok,
    errorKey: result.errorKey ?? 'mcp.error.writeFailed',
    detail: result.detail,
    sourceFile: result.sourceFile,
    backupPath: result.backupPath
  }
}

export function setDshEnabled(
  ctx: McpNativeContext,
  existing: McpServerConfig,
  enabled: boolean,
  q: NativeQuery
): NativeMutationResult {
  const resolved = resolveHome(ctx, q)
  if ('errorKey' in resolved) return { ok: false, errorKey: resolved.errorKey }
  const { home } = resolved
  const file = patchPath(home)
  const id = idFromServerId(existing.id)

  const result = withTextFile(file, 'dsh', ctx.backupRoot, (text, exists) => {
    if (!exists) throw new NativeParseError('mcp.error.sourceMissing', file)
    const doc = parseDoc(text, file)
    const ref = findRow(doc, id)
    if (!ref) throw new NativeParseError('mcp.error.notFound', id)
    if (enabled) ref.row.delete('disabled')
    else ref.row.set('disabled', true)
    validateDoc(doc, file)
    return String(doc)
  })
  return {
    ok: result.ok,
    errorKey: result.errorKey ?? 'mcp.error.writeFailed',
    detail: result.detail,
    sourceFile: result.sourceFile,
    backupPath: result.backupPath
  }
}

export function dshSourcePath(scope: McpScope, q: NativeQuery, ctx: McpNativeContext): string | null {
  if (scope !== 'home') return null
  const resolved = resolveHome(ctx, q)
  return 'errorKey' in resolved ? null : patchPath(resolved.home)
}
