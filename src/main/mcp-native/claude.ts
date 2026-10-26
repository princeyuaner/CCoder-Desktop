import { join, resolve } from 'node:path'
// 直接用 ESM 入口：UMD 入口里的 require('./impl/*') 会让 esbuild/Rollup
// 打不进来，打包后的主进程会在运行时报 MODULE_NOT_FOUND。
import * as jsonc from 'jsonc-parser/lib/esm/main'
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
 * Claude Code 的原生 MCP 配置。
 *
 *  - 用户级：`~/.claude.json` 顶层 `mcpServers`
 *  - 本地级：`~/.claude.json` → `projects[<cwd>].mcpServers`
 *  - 项目级：`<cwd>/.mcp.json` 的 `mcpServers`（可能被仓库提交）
 *
 * 启停：用户/本地用 `disabledMcpServers`；项目级用项目对象里的
 * `enabledMcpjsonServers` / `disabledMcpjsonServers`，settings 文件里的
 * `enableAllProjectMcpServers` 作为只读覆盖。
 */

type Json = Record<string, unknown>

interface ClaudeProject extends Json {
  mcpServers?: Record<string, Json>
  disabledMcpServers?: string[]
  enabledMcpjsonServers?: string[]
  disabledMcpjsonServers?: string[]
}

interface ClaudeDoc extends Json {
  mcpServers?: Record<string, Json>
  disabledMcpServers?: string[]
  projects?: Record<string, ClaudeProject>
}

const MANAGED_KEYS = new Set(['type', 'command', 'args', 'env', 'url', 'headers'])
const FORMAT = 'jsonc' as const

function applyModify(text: string, path: jsonc.JSONPath, value: unknown): string {
  const edits = jsonc.modify(text, path, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2 }
  })
  return jsonc.applyEdits(text, edits)
}

function parseDoc(text: string, file: string): ClaudeDoc {
  const errors: jsonc.ParseError[] = []
  const doc = jsonc.parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length) {
    const e = errors[0]
    throw new NativeParseError(
      'mcp.error.parseFailed',
      `${file}: ${jsonc.printParseErrorCode(e.error)} @ ${e.offset}`
    )
  }
  return (doc && typeof doc === 'object' ? doc : {}) as ClaudeDoc
}

function getProjectKey(doc: ClaudeDoc, cwd: string): string | null {
  if (!cwd.trim()) return null
  const want = pathKey(cwd)
  for (const key of Object.keys(doc.projects ?? {})) {
    if (pathKey(key) === want) return key
  }
  return null
}

function newProjectKey(cwd: string): string {
  return resolve(cwd).replace(/\\/g, '/')
}

function projectOf(doc: ClaudeDoc, cwd: string): { key: string; project: ClaudeProject } | null {
  const existing = getProjectKey(doc, cwd)
  if (existing) return { key: existing, project: doc.projects?.[existing] ?? {} }
  return null
}

function readSettingsApproval(
  ctx: McpNativeContext,
  cwd: string,
  project: ClaudeProject | null
): { enableAll: boolean; enabled: Set<string>; disabled: Set<string> } {
  const enabled = new Set<string>()
  const disabled = new Set<string>()
  let enableAll = false

  const files = [
    join(ctx.claudeDir, 'settings.json'),
    cwd ? join(cwd, '.claude', 'settings.json') : '',
    cwd ? join(cwd, '.claude', 'settings.local.json') : ''
  ].filter(Boolean)

  for (const file of files) {
    const r = readTextFile(file)
    if (!r.ok || !r.file.exists) continue
    try {
      const doc = parseDoc(r.file.text, file)
      if (doc.enableAllProjectMcpServers === true) enableAll = true
      for (const name of asStringArray(doc.enabledMcpjsonServers)) enabled.add(name)
      for (const name of asStringArray(doc.disabledMcpjsonServers)) disabled.add(name)
    } catch {
      // settings 解析失败只影响审批状态展示，不影响 mcpServers 的读写
    }
  }

  if (project) {
    for (const name of asStringArray(project.enabledMcpjsonServers)) enabled.add(name)
    for (const name of asStringArray(project.disabledMcpjsonServers)) disabled.add(name)
  }

  return { enableAll, enabled, disabled }
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function asStringRecord(v: unknown): McpKeyValue[] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return []
  const out: McpKeyValue[] = []
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (typeof value === 'string') out.push({ key, value })
  }
  return out
}

function inferTransport(raw: Json): { transport: McpTransport; supported: boolean } {
  const t = typeof raw.type === 'string' ? raw.type : ''
  if (t === 'stdio' || t === 'http' || t === 'sse') return { transport: t, supported: true }
  if (t) return { transport: typeof raw.url === 'string' ? 'http' : 'stdio', supported: false }
  if (typeof raw.command === 'string') return { transport: 'stdio', supported: true }
  if (typeof raw.url === 'string') return { transport: 'http', supported: true }
  return { transport: 'stdio', supported: false }
}

export function claudeId(scope: McpScope, cwd: string, name: string): string {
  const location = scope === 'user' ? '' : pathKey(cwd)
  return `claude:${scope}:${encodeURIComponent(location)}:${encodeURIComponent(name)}`
}

interface EntryContext {
  scope: McpScope
  cwd: string
  file: string
  fileReadOnly: boolean
  disabled: Set<string>
  approval?: ReturnType<typeof readSettingsApproval>
  approvalState?: 'enabled' | 'disabled' | 'pending'
}

function entryToServer(name: string, raw: Json, c: EntryContext): McpServerConfig {
  const { transport, supported } = inferTransport(raw)
  const command = typeof raw.command === 'string' ? raw.command : ''
  const args = Array.isArray(raw.args) ? raw.args.filter((x): x is string => typeof x === 'string') : []
  const env = asStringRecord(raw.env)
  const url = typeof raw.url === 'string' ? raw.url : ''
  const headers = asStringRecord(raw.headers)
  const secretKeys = secretKeysOf(env, headers)

  let enabled: boolean
  let enabledBy: McpServerConfig['enabledBy']
  if (c.scope === 'project') {
    enabled = c.approvalState === 'enabled'
    enabledBy = c.approval?.enableAll
      ? 'enable-all'
      : c.approvalState === 'pending'
        ? 'pending'
        : c.approvalState === 'disabled'
          ? 'disabled-list'
          : 'enabled-list'
  } else {
    enabled = !c.disabled.has(name)
    enabledBy = enabled ? undefined : 'disabled-list'
  }

  return {
    id: claudeId(c.scope, c.cwd, name),
    cli: 'claude',
    name,
    transport,
    command,
    args,
    env,
    url,
    headers,
    workingDir: '',
    enabled,
    enabledControl: c.scope === 'project' ? 'approval' : 'native',
    enabledBy,
    scope: c.scope,
    cwd: c.scope === 'user' ? '' : c.cwd,
    source: { file: c.file, scope: c.scope, format: FORMAT },
    supported,
    readOnly: c.fileReadOnly || !supported,
    readOnlyReason: c.fileReadOnly ? 'external' : !supported ? 'unsupported' : undefined,
    hasSecrets: secretKeys.length > 0,
    secretKeys,
    nativeExtras: Object.keys(raw).filter((k) => !MANAGED_KEYS.has(k)),
    approvalState: c.scope === 'project' ? c.approvalState : undefined
  }
}

function readEntries(
  doc: ClaudeDoc,
  scope: 'user' | 'local',
  cwd: string,
  file: string,
  fileReadOnly: boolean
): McpServerConfig[] {
  const project = scope === 'local' ? projectOf(doc, cwd) : null
  const map = scope === 'user' ? doc.mcpServers : project?.project.mcpServers
  if (!map || typeof map !== 'object') return []
  const disabled = new Set(
    asStringArray(scope === 'user' ? doc.disabledMcpServers : project?.project.disabledMcpServers)
  )
  return Object.entries(map)
    .filter(([, raw]) => raw && typeof raw === 'object' && !Array.isArray(raw))
    .map(([name, raw]) =>
      entryToServer(name, raw as Json, {
        scope,
        cwd,
        file,
        fileReadOnly,
        disabled
      })
    )
}

function readProject(
  ctx: McpNativeContext,
  cwd: string,
  claudeDoc: ClaudeDoc | null
): { servers: McpServerConfig[]; source: McpSourceFile } {
  const file = join(cwd, '.mcp.json')
  const writable = isWritable(file)
  const source: McpSourceFile = {
    path: file,
    scopes: ['project'],
    format: FORMAT,
    exists: false,
    readOnly: !writable
  }
  const r = readTextFile(file)
  if (!r.ok) {
    source.error = r.detail
    source.readOnly = true
    return { servers: [], source }
  }
  source.exists = r.file.exists
  if (!r.file.exists) return { servers: [], source }

  let doc: ClaudeDoc
  try {
    doc = parseDoc(r.file.text, file)
  } catch (e) {
    source.error = e instanceof NativeParseError ? e.detail : String(e)
    source.readOnly = true
    return { servers: [], source }
  }

  const project = claudeDoc ? projectOf(claudeDoc, cwd) : null
  const approval = readSettingsApproval(ctx, cwd, project?.project ?? null)
  const map = doc.mcpServers
  if (!map || typeof map !== 'object') return { servers: [], source }

  const servers = Object.entries(map)
    .filter(([, raw]) => raw && typeof raw === 'object' && !Array.isArray(raw))
    .map(([name, raw]) => {
      const state = approvalStateOf(name, approval)
      return entryToServer(name, raw as Json, {
        scope: 'project',
        cwd,
        file,
        fileReadOnly: !writable,
        disabled: new Set(),
        approval,
        approvalState: state
      })
    })
  return { servers, source }
}

function approvalStateOf(
  name: string,
  a: { enableAll: boolean; enabled: Set<string>; disabled: Set<string> }
): 'enabled' | 'disabled' | 'pending' {
  if (a.enableAll) return a.disabled.has(name) ? 'disabled' : 'enabled'
  if (a.disabled.has(name)) return 'disabled'
  if (a.enabled.has(name)) return 'enabled'
  return 'pending'
}

export function readClaude(ctx: McpNativeContext, q: NativeQuery): NativeReadResult {
  const servers: McpServerConfig[] = []
  const sources: McpSourceFile[] = []

  const userFile = ctx.claudeJson
  const userWritable = isWritable(userFile)
  const userSource: McpSourceFile = {
    path: userFile,
    scopes: ['user', 'local'],
    format: FORMAT,
    exists: false,
    readOnly: !userWritable
  }
  const r = readTextFile(userFile)
  let claudeDoc: ClaudeDoc | null = null
  if (!r.ok) {
    userSource.error = r.detail
    userSource.readOnly = true
  } else {
    userSource.exists = r.file.exists
    if (r.file.exists) {
      try {
        claudeDoc = parseDoc(r.file.text, userFile)
        servers.push(...readEntries(claudeDoc, 'user', q.cwd, userFile, !userWritable))
        servers.push(...readEntries(claudeDoc, 'local', q.cwd, userFile, !userWritable))
      } catch (e) {
        userSource.error = e instanceof NativeParseError ? e.detail : String(e)
        userSource.readOnly = true
      }
    }
  }
  sources.push(userSource)

  if (q.cwd.trim()) {
    const project = readProject(ctx, q.cwd, claudeDoc)
    servers.push(...project.servers)
    sources.push(project.source)
  }

  return { servers, sources }
}

/* ── 写入 ─────────────────────────────────────────────────── */

function managedEntry(input: McpServerInput, existing: Json | null): Json {
  const next: Json = { ...(existing ?? {}) }
  if (input.transport === 'stdio') {
    delete next.url
    delete next.headers
    next.type = 'stdio'
    next.command = input.command.trim()
    const args = input.args.map((a) => a.trim()).filter(Boolean)
    if (args.length) next.args = args
    else delete next.args
    const env = input.env.filter((kv) => kv.key.trim())
    if (env.length) {
      next.env = Object.fromEntries(env.map((kv) => [kv.key.trim(), kv.value]))
    } else {
      delete next.env
    }
  } else {
    delete next.command
    delete next.args
    delete next.env
    next.type = input.transport
    next.url = input.url.trim()
    const headers = input.headers.filter((kv) => kv.key.trim())
    if (headers.length) {
      next.headers = Object.fromEntries(headers.map((kv) => [kv.key.trim(), kv.value]))
    } else {
      delete next.headers
    }
  }
  return next
}

/**
 * 改写一个名字数组：先移除 oldName（改名时），再按 add 加入/移除 name。
 * 返回 null 表示没有变化。
 */
function updateList(
  list: unknown,
  name: string,
  add: boolean,
  oldName?: string | null
): string[] | null {
  const arr = asStringArray(list)
  let next = [...arr]
  if (oldName && oldName !== name) next = next.filter((x) => x !== oldName)
  if (add) {
    if (!next.includes(name)) next.push(name)
  } else {
    next = next.filter((x) => x !== name)
  }
  const same = next.length === arr.length && next.every((x, i) => x === arr[i])
  return same ? null : next
}

interface WriteTarget {
  file: string
  /** 'user' | 'local' 写 claude.json；'project' 写 .mcp.json */
  scope: McpScope
  cwd: string
}

function targetFor(ctx: McpNativeContext, scope: McpScope, cwd: string): WriteTarget | null {
  if (scope === 'user' || scope === 'local') {
    return { file: ctx.claudeJson, scope, cwd: scope === 'local' ? cwd : '' }
  }
  if (scope === 'project') return { file: join(cwd, '.mcp.json'), scope, cwd }
  return null
}

function mutateClaudeFile(
  ctx: McpNativeContext,
  target: WriteTarget,
  mutate: (text: string, exists: boolean, doc: ClaudeDoc) => string | null
): { ok: boolean; errorKey?: string; detail?: string; sourceFile: string; backupPath?: string } {
  const result = withTextFile(
    target.file,
    'claude',
    ctx.backupRoot,
    (text, exists) => {
      if (!exists && target.file === ctx.claudeJson) {
        throw new NativeParseError('mcp.error.claudeConfigMissing', ctx.claudeJson)
      }
      const seed = exists ? text : '{\n  "mcpServers": {}\n}\n'
      const doc = parseDoc(seed, target.file)
      return mutate(seed, exists, doc)
    },
    target.scope === 'project' ? 0o644 : 0o600
  )
  return {
    ok: result.ok,
    errorKey: result.errorKey ?? 'mcp.error.writeFailed',
    detail: result.detail,
    sourceFile: result.sourceFile,
    backupPath: result.backupPath
  }
}

function writeBody(
  text: string,
  doc: ClaudeDoc,
  target: WriteTarget,
  input: McpServerInput,
  existing: McpServerConfig | null
): string {
  let out = text
  const oldName = existing?.name ?? null

  if (target.scope === 'user') {
    const oldRaw = oldName ? (doc.mcpServers?.[oldName] as Json | undefined) : undefined
    if (oldName && oldName !== input.name) {
      out = applyModify(out, ['mcpServers', oldName], undefined)
    }
    out = applyModify(out, ['mcpServers', input.name], managedEntry(input, oldRaw ?? null))
    const arr = updateList(doc.disabledMcpServers, input.name, !input.enabled, oldName)
    if (arr) out = applyModify(out, ['disabledMcpServers'], arr)
    return out
  }

  if (target.scope === 'local') {
    const key = getProjectKey(doc, target.cwd) ?? newProjectKey(target.cwd)
    const project = doc.projects?.[key] ?? {}
    const oldRaw = oldName ? (project.mcpServers?.[oldName] as Json | undefined) : undefined
    if (oldName && oldName !== input.name) {
      out = applyModify(out, ['projects', key, 'mcpServers', oldName], undefined)
    }
    out = applyModify(out, ['projects', key, 'mcpServers', input.name], managedEntry(input, oldRaw ?? null))
    const arr = updateList(project.disabledMcpServers, input.name, !input.enabled, oldName)
    if (arr) out = applyModify(out, ['projects', key, 'disabledMcpServers'], arr)
    return out
  }

  // project: 服务器写 .mcp.json；审批状态写 claude.json（在下面单独处理）
  const oldRaw = oldName ? (doc.mcpServers?.[oldName] as Json | undefined) : undefined
  if (oldName && oldName !== input.name) {
    out = applyModify(out, ['mcpServers', oldName], undefined)
  }
  out = applyModify(out, ['mcpServers', input.name], managedEntry(input, oldRaw ?? null))
  return out
}

function writeProjectApproval(
  ctx: McpNativeContext,
  cwd: string,
  input: McpServerInput,
  existing: McpServerConfig | null
): { ok: boolean; errorKey?: string; detail?: string; sourceFile: string; backupPath?: string } {
  const target: WriteTarget = { file: ctx.claudeJson, scope: 'project', cwd }
  return mutateClaudeFile(ctx, target, (text, _exists, doc) => {
    const key = getProjectKey(doc, cwd) ?? newProjectKey(cwd)
    const project = doc.projects?.[key] ?? {}
    const approval = readSettingsApproval(ctx, cwd, project)
    if (approval.enableAll) {
      throw new NativeParseError(
        'mcp.error.nativeConflict',
        'enableAllProjectMcpServers is enabled; project MCP approval is controlled globally'
      )
    }
    let out = text
    const oldName = existing?.name ?? null
    const enabled = updateList(project.enabledMcpjsonServers, input.name, input.enabled, oldName)
    const disabled = updateList(project.disabledMcpjsonServers, input.name, !input.enabled, oldName)
    if (enabled) out = applyModify(out, ['projects', key, 'enabledMcpjsonServers'], enabled)
    if (disabled) out = applyModify(out, ['projects', key, 'disabledMcpjsonServers'], disabled)
    return out
  })
}

export function saveClaude(
  ctx: McpNativeContext,
  input: McpServerInput,
  existing: McpServerConfig | null,
  q: NativeQuery
): NativeMutationResult {
  const target = targetFor(ctx, input.scope, input.cwd || q.cwd)
  if (!target) return { ok: false, errorKey: 'mcp.error.invalidScope' }
  if ((input.scope === 'local' || input.scope === 'project') && !target.cwd.trim()) {
    return { ok: false, errorKey: 'mcp.error.cwdRequired' }
  }

  const server = mutateClaudeFile(ctx, target, (text, _exists, doc) =>
    writeBody(text, doc, target, input, existing)
  )
  if (!server.ok) {
    return { ok: false, errorKey: server.errorKey ?? 'mcp.error.writeFailed', detail: server.detail, sourceFile: server.sourceFile }
  }

  let backupPath = server.backupPath
  if (input.scope === 'project') {
    const approval = writeProjectApproval(ctx, target.cwd, input, existing)
    if (!approval.ok) {
      return {
        ok: false,
        errorKey: approval.errorKey ?? 'mcp.error.writeFailed',
        detail: approval.detail,
        sourceFile: approval.sourceFile,
        backupPath
      }
    }
    backupPath = backupPath ?? approval.backupPath
  }

  return {
    ok: true,
    serverId: claudeId(input.scope, target.cwd, input.name),
    sourceFile: server.sourceFile,
    backupPath
  }
}

export function removeClaude(
  ctx: McpNativeContext,
  existing: McpServerConfig,
  q: NativeQuery
): NativeMutationResult {
  const target = targetFor(ctx, existing.scope, existing.cwd || q.cwd)
  if (!target) return { ok: false, errorKey: 'mcp.error.invalidScope' }

  const server = mutateClaudeFile(ctx, target, (text, _exists, doc) => {
    let out = text
    if (target.scope === 'user') {
      out = applyModify(out, ['mcpServers', existing.name], undefined)
      const arr = updateList(doc.disabledMcpServers, existing.name, false)
      if (arr) out = applyModify(out, ['disabledMcpServers'], arr)
    } else if (target.scope === 'local') {
      const key = getProjectKey(doc, target.cwd) ?? newProjectKey(target.cwd)
      const project = doc.projects?.[key] ?? {}
      out = applyModify(out, ['projects', key, 'mcpServers', existing.name], undefined)
      const arr = updateList(project.disabledMcpServers, existing.name, false)
      if (arr) out = applyModify(out, ['projects', key, 'disabledMcpServers'], arr)
    } else {
      out = applyModify(out, ['mcpServers', existing.name], undefined)
    }
    return out
  })
  if (!server.ok) {
    return { ok: false, errorKey: server.errorKey ?? 'mcp.error.writeFailed', detail: server.detail, sourceFile: server.sourceFile }
  }

  let backupPath = server.backupPath
  if (existing.scope === 'project') {
    const approval = mutateClaudeFile(
      ctx,
      { file: ctx.claudeJson, scope: 'project', cwd: target.cwd },
      (text, _exists, doc) => {
        const key = getProjectKey(doc, target.cwd) ?? newProjectKey(target.cwd)
        const project = doc.projects?.[key] ?? {}
        let out = text
        const e = updateList(project.enabledMcpjsonServers, existing.name, false)
        const d = updateList(project.disabledMcpjsonServers, existing.name, false)
        if (e) out = applyModify(out, ['projects', key, 'enabledMcpjsonServers'], e)
        if (d) out = applyModify(out, ['projects', key, 'disabledMcpjsonServers'], d)
        return out
      }
    )
    if (!approval.ok) {
      return {
        ok: false,
        errorKey: approval.errorKey ?? 'mcp.error.writeFailed',
        detail: approval.detail,
        sourceFile: approval.sourceFile,
        backupPath
      }
    }
    backupPath = backupPath ?? approval.backupPath
  }

  return { ok: true, sourceFile: server.sourceFile, backupPath }
}

export function setClaudeEnabled(
  ctx: McpNativeContext,
  existing: McpServerConfig,
  enabled: boolean,
  q: NativeQuery
): NativeMutationResult {
  if (existing.scope === 'user' || existing.scope === 'local') {
    const target = targetFor(ctx, existing.scope, existing.cwd || q.cwd)
    if (!target) return { ok: false, errorKey: 'mcp.error.invalidScope' }
    const result = mutateClaudeFile(ctx, target, (text, _exists, doc) => {
      if (target.scope === 'user') {
        const arr = updateList(doc.disabledMcpServers, existing.name, !enabled)
        return arr ? applyModify(text, ['disabledMcpServers'], arr) : null
      }
      const key = getProjectKey(doc, target.cwd) ?? newProjectKey(target.cwd)
      const project = doc.projects?.[key] ?? {}
      const arr = updateList(project.disabledMcpServers, existing.name, !enabled)
      return arr ? applyModify(text, ['projects', key, 'disabledMcpServers'], arr) : null
    })
    return {
      ok: result.ok,
      errorKey: result.errorKey ?? 'mcp.error.writeFailed',
      detail: result.detail,
      sourceFile: result.sourceFile,
      backupPath: result.backupPath
    }
  }

  if (existing.scope !== 'project') return { ok: false, errorKey: 'mcp.error.invalidScope' }
  const cwd = existing.cwd || q.cwd
  const result = mutateClaudeFile(ctx, { file: ctx.claudeJson, scope: 'project', cwd }, (text, _e, doc) => {
    const key = getProjectKey(doc, cwd) ?? newProjectKey(cwd)
    const project = doc.projects?.[key] ?? {}
    const approval = readSettingsApproval(ctx, cwd, project)
    if (approval.enableAll) {
      throw new NativeParseError('mcp.error.nativeConflict', 'enableAllProjectMcpServers is enabled')
    }
    let out = text
    const e = updateList(project.enabledMcpjsonServers, existing.name, enabled)
    const d = updateList(project.disabledMcpjsonServers, existing.name, !enabled)
    if (e) out = applyModify(out, ['projects', key, 'enabledMcpjsonServers'], e)
    if (d) out = applyModify(out, ['projects', key, 'disabledMcpjsonServers'], d)
    return out
  })
  return {
    ok: result.ok,
    errorKey: result.errorKey ?? 'mcp.error.writeFailed',
    detail: result.detail,
    sourceFile: result.sourceFile,
    backupPath: result.backupPath
  }
}

export function claudeSourcePath(
  scope: McpScope,
  q: NativeQuery,
  ctx: McpNativeContext
): string | null {
  if (scope === 'user' || scope === 'local') return ctx.claudeJson
  if (scope === 'project') return q.cwd.trim() ? join(q.cwd, '.mcp.json') : null
  return null
}
