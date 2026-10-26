import * as TOML from 'smol-toml'
import {
  secretKeysOf,
  type McpKeyValue,
  type McpScope,
  type McpServerConfig,
  type McpServerInput,
  type McpSourceFile,
  type McpTransport
} from '../../shared/mcp'
import { NativeParseError, isWritable, readTextFile, withTextFile } from './fs'
import type {
  McpNativeContext,
  NativeMutationResult,
  NativeQuery,
  NativeReadResult
} from './types'

/**
 * Codex CLI 的原生 MCP 配置：`$CODEX_HOME/config.toml` 的
 * `[mcp_servers.<name>]`。
 *
 * Phase 0 实测 `toml-patch` 在改数组/加 key 时会抛错，所以这里用
 * `smol-toml` 只做解析与校验，写入采用**块级文本替换**：只替换目标
 * `[mcp_servers.<name>]`（含子表）这一段，文件其余部分逐字节保留。
 */

type TomlTable = Record<string, unknown>

const MANAGED_KEYS = new Set([
  'type',
  'command',
  'args',
  'env',
  'url',
  'http_headers',
  'cwd',
  'enabled'
])

const FORMAT = 'toml' as const

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

function parseToml(text: string, file: string): Record<string, unknown> {
  try {
    return TOML.parse(text) as Record<string, unknown>
  } catch (e) {
    throw new NativeParseError('mcp.error.parseFailed', `${file}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function serversOf(parsed: Record<string, unknown>): Record<string, TomlTable> {
  const raw = parsed.mcp_servers
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, TomlTable> = {}
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) out[name] = entry as TomlTable
  }
  return out
}

function inferTransport(entry: TomlTable): { transport: McpTransport; supported: boolean } {
  const type = typeof entry.type === 'string' ? entry.type : ''
  if (type === 'sse') return { transport: 'sse', supported: false }
  if (typeof entry.url === 'string') return { transport: 'http', supported: true }
  if (typeof entry.command === 'string') return { transport: 'stdio', supported: true }
  if (type === 'stdio') return { transport: 'stdio', supported: true }
  return { transport: 'stdio', supported: false }
}

export function codexId(name: string): string {
  return `codex:global:-:${encodeURIComponent(name)}`
}

/* ── 表头解析与定位 ───────────────────────────────────────── */

interface Header {
  line: number
  segments: string[]
  array: boolean
}

function parseKeyPath(inner: string): string[] | null {
  const parts: string[] = []
  let i = 0
  while (i < inner.length) {
    while (i < inner.length && /\s/.test(inner[i])) i++
    if (i >= inner.length) return null
    let value = ''
    if (inner[i] === '"' || inner[i] === "'") {
      const quote = inner[i++]
      let closed = false
      while (i < inner.length) {
        const ch = inner[i++]
        if (ch === quote) {
          closed = true
          break
        }
        if (ch === '\\' && quote === '"') value += inner[i++] ?? ''
        else value += ch
      }
      if (!closed) return null
    } else {
      while (i < inner.length && inner[i] !== '.' && !/\s/.test(inner[i])) value += inner[i++]
      if (!value) return null
    }
    parts.push(value)
    while (i < inner.length && /\s/.test(inner[i])) i++
    if (i < inner.length) {
      if (inner[i] !== '.') return null
      i++
    }
  }
  return parts.length ? parts : null
}

function headerAt(line: string, index: number): Header | null {
  const m = /^\s*(\[\[?)\s*(.+?)\s*(\]\]?)\s*(?:#.*)?$/.exec(line)
  if (!m) return null
  const array = m[1] === '[['
  if ((m[1] === '[[') !== (m[3] === ']]')) return null
  const segments = parseKeyPath(m[2])
  if (!segments) return null
  return { line: index, segments, array }
}

function tableNames(text: string): Set<string> {
  const out = new Set<string>()
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const h = headerAt(lines[i], i)
    if (!h || h.array) continue
    if (h.segments.length === 2 && h.segments[0] === 'mcp_servers') out.add(h.segments[1])
  }
  return out
}

function isDescendant(segments: string[], name: string): boolean {
  return segments.length >= 2 && segments[0] === 'mcp_servers' && segments[1] === name
}

/** 返回块的行区间 [start, end)，含子表，止于下一个非子表 header 前的空行/注释 */
function findBlock(lines: string[], name: string): { start: number; end: number } | null {
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const h = headerAt(lines[i], i)
    if (h && !h.array && isDescendant(h.segments, name)) {
      start = i
      break
    }
  }
  if (start < 0) return null

  let next = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const h = headerAt(lines[i], i)
    if (h && !isDescendant(h.segments, name)) {
      next = i
      break
    }
  }

  // 把紧贴下一个表的空行/注释留给下一个表
  let end = next
  while (end > start + 1) {
    const l = lines[end - 1].trim()
    if (l === '' || l.startsWith('#')) end--
    else break
  }
  return { start, end }
}

function serializeBlock(name: string, entry: TomlTable): string {
  const text = TOML.stringify({ mcp_servers: { [name]: entry } }).trimEnd()
  if (!text) throw new NativeParseError('mcp.error.writeFailed', `empty TOML for ${name}`)
  return text
}

/* ── 读取 ─────────────────────────────────────────────────── */

function entryToServer(
  name: string,
  raw: TomlTable,
  file: string,
  fileReadOnly: boolean,
  hasTable: boolean
): McpServerConfig {
  const { transport, supported } = inferTransport(raw)
  const command = typeof raw.command === 'string' ? raw.command : ''
  const args = asStringArray(raw.args)
  const env = asStringRecord(raw.env)
  const url = typeof raw.url === 'string' ? raw.url : ''
  const headers = asStringRecord(raw.http_headers)
  const workingDir = typeof raw.cwd === 'string' ? raw.cwd : ''
  const enabled = raw.enabled !== false
  const extraSecret: string[] = []
  if (typeof raw.bearer_token === 'string' && raw.bearer_token) extraSecret.push('bearer_token')
  const secretKeys = [...secretKeysOf(env, headers), ...extraSecret]
  const nativeExtras = Object.keys(raw).filter((k) => !MANAGED_KEYS.has(k))
  const editable = !fileReadOnly && hasTable && supported

  return {
    id: codexId(name),
    cli: 'codex',
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
    scope: 'global',
    cwd: '',
    source: { file, scope: 'global', format: FORMAT },
    supported: hasTable && supported,
    readOnly: !editable,
    readOnlyReason: fileReadOnly ? 'external' : !hasTable ? 'unsupported' : !supported ? 'unsupported' : undefined,
    hasSecrets: secretKeys.length > 0,
    secretKeys,
    nativeExtras
  }
}

export function readCodex(ctx: McpNativeContext, _q: NativeQuery): NativeReadResult {
  const file = ctx.codexConfig
  const writable = isWritable(file)
  const source: McpSourceFile = {
    path: file,
    scopes: ['global'],
    format: FORMAT,
    exists: false,
    readOnly: !writable
  }
  const r = readTextFile(file)
  if (!r.ok) {
    source.error = r.detail
    source.readOnly = true
    return { servers: [], sources: [source] }
  }
  source.exists = r.file.exists
  if (!r.file.exists) return { servers: [], sources: [source] }

  let parsed: Record<string, unknown>
  try {
    parsed = parseToml(r.file.text, file)
  } catch (e) {
    source.error = e instanceof NativeParseError ? e.detail : String(e)
    source.readOnly = true
    return { servers: [], sources: [source] }
  }

  const tables = tableNames(r.file.text)
  const servers = Object.entries(serversOf(parsed)).map(([name, raw]) =>
    entryToServer(name, raw, file, !writable, tables.has(name))
  )
  return { servers, sources: [source] }
}

/* ── 写入 ─────────────────────────────────────────────────── */

function mergeEntry(existing: TomlTable | null, input: McpServerInput): TomlTable {
  const next: TomlTable = { ...(existing ?? {}) }
  const oldTransport = existing ? inferTransport(existing).transport : null

  if (input.transport === 'stdio') {
    for (const k of [
      'url',
      'http_headers',
      'env_http_headers',
      'bearer_token',
      'bearer_token_env_var',
      'http_headers_helper',
      'oauth',
      'oauth_resource',
      'scopes',
      'auth'
    ]) {
      delete next[k]
    }
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
    for (const k of ['command', 'args', 'env', 'env_vars', 'cwd']) delete next[k]
    next.url = input.url.trim()
    const headers = input.headers.filter((kv) => kv.key.trim())
    if (headers.length) {
      next.http_headers = Object.fromEntries(headers.map((kv) => [kv.key.trim(), kv.value]))
    } else {
      delete next.http_headers
    }
  }

  // type 是可选的；只有同一传输时才保留原值，切换后让 Codex 按字段推断
  if (oldTransport && oldTransport !== input.transport) delete next.type

  if (input.enabled) delete next.enabled
  else next.enabled = false

  return next
}

interface BlockWriteResult {
  text: string
  /** 写入后的条目对象，便于校验 */
  entry: TomlTable | null
}

function replaceBlock(
  text: string,
  name: string,
  entry: TomlTable | null,
  existing: McpServerConfig | null
): BlockWriteResult {
  const lines = text.split(/\r?\n/)
  const oldName = existing?.name ?? null
  const oldBlock = oldName ? findBlock(lines, oldName) : null

  if (oldName && oldName !== name) {
    // 改名：删旧块，在旧位置插新块
    if (!oldBlock) throw new NativeParseError('mcp.error.nativeConflict', `table ${oldName} not found`)
    const newLines = serializeBlock(name, entry ?? {}).split('\n')
    lines.splice(oldBlock.start, oldBlock.end - oldBlock.start, ...newLines)
  } else if (entry === null) {
    if (oldBlock) lines.splice(oldBlock.start, oldBlock.end - oldBlock.start)
  } else {
    const block = serializeBlock(name, entry)
    if (oldBlock) {
      lines.splice(oldBlock.start, oldBlock.end - oldBlock.start, ...block.split('\n'))
    } else {
      // 新表：追加到文件末尾，和已有内容空一行
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
      if (lines.length) lines.push('')
      lines.push(...block.split('\n'))
    }
  }

  return { text: lines.join('\n'), entry }
}

export function saveCodex(
  ctx: McpNativeContext,
  input: McpServerInput,
  existing: McpServerConfig | null,
  _q: NativeQuery
): NativeMutationResult {
  if (input.scope !== 'global') return { ok: false, errorKey: 'mcp.error.invalidScope' }

  const file = ctx.codexConfig
  const result = withTextFile(file, 'codex', ctx.backupRoot, (text, exists) => {
    const seed = exists ? text : ''
    const parsed = parseToml(seed, file)
    const servers = serversOf(parsed)
    if ((!existing || existing.name !== input.name) && servers[input.name]) {
      throw new NativeParseError('mcp.error.nativeConflict', `server ${input.name} already exists`)
    }
    const oldRaw = existing ? servers[existing.name] ?? null : null
    const entry = mergeEntry(oldRaw, input)
    const out = replaceBlock(seed, input.name, entry, existing)
    const check = parseToml(out.text, file)
    const saved = serversOf(check)[input.name]
    if (!saved) {
      throw new NativeParseError('mcp.error.writeFailed', `server ${input.name} missing after write`)
    }
    return out.text
  })
  return {
    ok: result.ok,
    errorKey: result.errorKey ?? 'mcp.error.writeFailed',
    detail: result.detail,
    sourceFile: result.sourceFile,
    backupPath: result.backupPath,
    serverId: result.ok ? codexId(input.name) : undefined
  }
}

export function removeCodex(
  ctx: McpNativeContext,
  existing: McpServerConfig,
  _q: NativeQuery
): NativeMutationResult {
  const file = ctx.codexConfig
  const result = withTextFile(file, 'codex', ctx.backupRoot, (text, exists) => {
    if (!exists) throw new NativeParseError('mcp.error.sourceMissing', file)
    const parsed = parseToml(text, file)
    if (!serversOf(parsed)[existing.name]) {
      throw new NativeParseError('mcp.error.notFound', existing.name)
    }
    const out = replaceBlock(text, existing.name, null, existing)
    const check = parseToml(out.text, file)
    if (serversOf(check)[existing.name]) {
      throw new NativeParseError('mcp.error.writeFailed', `server ${existing.name} still present`)
    }
    return out.text
  })
  return {
    ok: result.ok,
    errorKey: result.errorKey ?? 'mcp.error.writeFailed',
    detail: result.detail,
    sourceFile: result.sourceFile,
    backupPath: result.backupPath
  }
}

export function setCodexEnabled(
  ctx: McpNativeContext,
  existing: McpServerConfig,
  enabled: boolean,
  _q: NativeQuery
): NativeMutationResult {
  const file = ctx.codexConfig
  const result = withTextFile(file, 'codex', ctx.backupRoot, (text, exists) => {
    if (!exists) throw new NativeParseError('mcp.error.sourceMissing', file)
    const parsed = parseToml(text, file)
    const raw = serversOf(parsed)[existing.name]
    if (!raw) throw new NativeParseError('mcp.error.notFound', existing.name)
    const entry: TomlTable = { ...raw }
    if (enabled) delete entry.enabled
    else entry.enabled = false
    const out = replaceBlock(text, existing.name, entry, existing)
    parseToml(out.text, file)
    return out.text
  })
  return {
    ok: result.ok,
    errorKey: result.errorKey ?? 'mcp.error.writeFailed',
    detail: result.detail,
    sourceFile: result.sourceFile,
    backupPath: result.backupPath
  }
}

export function codexSourcePath(scope: McpScope, _q: NativeQuery, ctx: McpNativeContext): string | null {
  return scope === 'global' ? ctx.codexConfig : null
}
