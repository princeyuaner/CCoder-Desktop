import {
  MCP_TRANSPORTS,
  toProbeInput,
  toRuntimeMcpServer,
  validateMcpServer,
  type LegacyMcpServerConfig,
  type McpListResult,
  type McpMutationResult,
  type McpProbeInput,
  type McpProbeResult,
  type McpServerConfig,
  type McpServerInput,
  type McpServerView,
  type McpTestResult,
  type RuntimeMcpServer
} from '../shared/mcp'
import { CLI_IDS, type CliId } from '../shared/settings'
import { countLegacyServers, loadMcpServers } from './mcp-store'
import { probeMcpServer } from './mcp-probe'
import { pathKey } from './path-key'
import {
  defaultDshHome,
  listNative,
  removeNative,
  saveNative,
  setNativeEnabled,
  type McpNativeContext,
  type NativeQuery
} from './mcp-native'

/**
 * MCP 门面：原生配置读取/写入 + 探测缓存 + 旧 store 兼容注入。
 *
 * 原生条目由 mcp-native/* 处理；这里只负责：
 *  - 按 cwd / DSH home 过滤；
 *  - 挂探测结果（只在内存）；
 *  - 迁移期把旧 mcp-servers.json 的条目继续注入，迁移完成后自然为空。
 */

const probes = new Map<string, McpProbeResult>()

function probeKey(cli: CliId, id: string): string {
  return `${cli}:${id}`
}

function viewOf(cli: CliId, s: McpServerConfig): McpServerView {
  const probe = probes.get(probeKey(cli, s.id))
  const base = {
    ...s,
    error: '',
    latencyMs: 0,
    checkedAt: 0,
    tools: probe?.tools ?? [],
    resources: probe?.resources ?? [],
    prompts: probe?.prompts ?? []
  }
  if (!s.enabled) return { ...base, status: 'disabled' }
  if (!probe) return { ...base, status: 'untested' }
  return {
    ...base,
    status: probe.ok ? 'connected' : 'error',
    error: probe.error,
    latencyMs: probe.latencyMs,
    checkedAt: probe.checkedAt
  }
}

export interface McpListOptions {
  dshHome?: string
}

function queryFor(ctx: McpNativeContext, cwd: string, opts?: McpListOptions): NativeQuery {
  return {
    cwd,
    dshHome: opts?.dshHome?.trim() || defaultDshHome(ctx)
  }
}

export function listMcpServers(
  cli: CliId,
  cwd: string,
  ctx: McpNativeContext,
  opts?: McpListOptions
): McpListResult {
  const q = queryFor(ctx, cwd, opts)
  const read = listNative(cli, q, ctx)
  return {
    cli,
    cwd,
    servers: read.servers.map((s) => viewOf(cli, s)),
    configFiles: read.sources,
    dshHome: cli === 'dsh' ? q.dshHome : undefined,
    legacyCount: countLegacyServers()
  }
}

function findExisting(
  cli: CliId,
  input: McpServerInput,
  cwd: string,
  ctx: McpNativeContext,
  opts?: McpListOptions
): McpServerConfig | null {
  if (!input.id) return null
  const q = queryFor(ctx, input.cwd || cwd, opts)
  return listNative(cli, q, ctx).servers.find((s) => s.id === input.id) ?? null
}

function duplicateName(
  cli: CliId,
  input: McpServerInput,
  existing: McpServerConfig | null,
  cwd: string,
  ctx: McpNativeContext,
  opts?: McpListOptions
): McpServerConfig | null {
  const location = input.cwd || cwd
  const list = listNative(cli, queryFor(ctx, location, opts), ctx).servers
  const name = input.name.trim().toLowerCase()
  for (const s of list) {
    if (existing && s.id === existing.id) continue
    if (s.name.trim().toLowerCase() !== name) continue
    if (s.scope !== input.scope) continue
    const scopeHasCwd = s.scope === 'local' || s.scope === 'project'
    if (scopeHasCwd && pathKey(s.cwd) !== pathKey(location)) continue
    return s
  }
  return null
}

export function saveMcpServer(
  cli: CliId,
  input: McpServerInput,
  cwd: string,
  ctx: McpNativeContext,
  opts?: McpListOptions
): McpMutationResult {
  const existing = findExisting(cli, input, cwd, ctx, opts)
  if (input.id && !existing) {
    return { ok: false, errorKey: 'mcp.error.notFound', list: listMcpServers(cli, cwd, ctx, opts) }
  }
  if (existing && existing.scope !== input.scope) {
    return { ok: false, errorKey: 'mcp.error.invalidScope', list: listMcpServers(cli, cwd, ctx, opts) }
  }

  const bad = validateMcpServer(cli, input, existing?.name)
  if (bad) return { ok: false, errorKey: bad, list: listMcpServers(cli, cwd, ctx, opts) }

  const dup = duplicateName(cli, input, existing, cwd, ctx, opts)
  if (dup) {
    return { ok: false, errorKey: 'mcp.error.duplicateName', list: listMcpServers(cli, cwd, ctx, opts) }
  }

  const q = queryFor(ctx, input.cwd || cwd, opts)
  const result = saveNative(cli, input, existing, q, ctx)
  if (!result.ok) {
    return {
      ok: false,
      errorKey: result.errorKey,
      detail: result.detail,
      list: listMcpServers(cli, cwd, ctx, opts)
    }
  }

  for (const id of [existing?.id, result.serverId]) {
    if (id) probes.delete(probeKey(cli, id))
  }
  return {
    ok: true,
    serverId: result.serverId,
    sourceFile: result.sourceFile,
    backupPath: result.backupPath,
    list: listMcpServers(cli, cwd, ctx, opts)
  }
}

export function removeMcpServer(
  cli: CliId,
  id: string,
  cwd: string,
  ctx: McpNativeContext,
  opts?: McpListOptions
): McpMutationResult {
  const all = listNative(cli, queryFor(ctx, cwd, opts), ctx).servers
  const existing = all.find((s) => s.id === id) ?? null
  if (!existing) {
    return { ok: false, errorKey: 'mcp.error.notFound', list: listMcpServers(cli, cwd, ctx, opts) }
  }
  if (existing.readOnly) {
    return { ok: false, errorKey: 'mcp.error.readOnly', list: listMcpServers(cli, cwd, ctx, opts) }
  }

  const q = queryFor(ctx, existing.cwd || cwd, opts)
  const result = removeNative(cli, existing, q, ctx)
  if (!result.ok) {
    return {
      ok: false,
      errorKey: result.errorKey,
      detail: result.detail,
      list: listMcpServers(cli, cwd, ctx, opts)
    }
  }
  probes.delete(probeKey(cli, id))
  return {
    ok: true,
    sourceFile: result.sourceFile,
    backupPath: result.backupPath,
    list: listMcpServers(cli, cwd, ctx, opts)
  }
}

export function setMcpEnabled(
  cli: CliId,
  id: string,
  enabled: boolean,
  cwd: string,
  ctx: McpNativeContext,
  opts?: McpListOptions
): McpMutationResult {
  const all = listNative(cli, queryFor(ctx, cwd, opts), ctx).servers
  const existing = all.find((s) => s.id === id) ?? null
  if (!existing) {
    return { ok: false, errorKey: 'mcp.error.notFound', list: listMcpServers(cli, cwd, ctx, opts) }
  }
  if (existing.readOnly) {
    return { ok: false, errorKey: 'mcp.error.readOnly', list: listMcpServers(cli, cwd, ctx, opts) }
  }

  const q = queryFor(ctx, existing.cwd || cwd, opts)
  const result = setNativeEnabled(cli, existing, enabled, q, ctx)
  if (!result.ok) {
    return {
      ok: false,
      errorKey: result.errorKey,
      detail: result.detail,
      list: listMcpServers(cli, cwd, ctx, opts)
    }
  }
  return {
    ok: true,
    sourceFile: result.sourceFile,
    backupPath: result.backupPath,
    list: listMcpServers(cli, cwd, ctx, opts)
  }
}

export async function testMcpServer(
  cli: CliId,
  input: McpServerInput
): Promise<McpTestResult> {
  const probe: McpProbeInput = {
    name: input.name,
    transport: input.transport,
    command: input.command,
    args: input.args,
    env: input.env,
    url: input.url,
    headers: input.headers,
    workingDir: input.workingDir
  }
  const result = await probeMcpServer(probe)
  if (input.id) probes.set(probeKey(cli, input.id), result)
  return result
}

export async function testAllMcpServers(
  cli: CliId,
  cwd: string,
  ctx: McpNativeContext,
  opts?: McpListOptions
): Promise<McpListResult> {
  const current = listMcpServers(cli, cwd, ctx, opts)
  // SSE 的握手当前探测层没实现；不把“无法探测”误报成“服务器坏了”。
  const queue = current.servers.filter(
    (s) => s.enabled && s.supported && s.transport !== 'sse'
  )
  const worker = async (): Promise<void> => {
    for (;;) {
      const s = queue.shift()
      if (!s) return
      const result = await probeMcpServer(toProbeInput(s))
      probes.set(probeKey(cli, s.id), result)
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, () => worker()))
  return listMcpServers(cli, cwd, ctx, opts)
}

/* ── 迁移期：旧 store 兼容注入 ────────────────────────────── */

function legacyScopeMatches(s: LegacyMcpServerConfig, cwd: string): boolean {
  if (s.scope === 'global') return true
  return !!cwd && pathKey(s.cwd) === pathKey(cwd)
}

/**
 * @deprecated 旧 `mcp-servers.json` 的兼容注入。
 *
 * 迁移完成前只把旧条目继续注入，保证升级瞬间不丢 MCP；原生条目由 CLI
 * 自己从配置读取。旧文件改名为 `*.migrated-*` 后这里自然返回空。
 */
export function getLegacyRuntimeMcpServers(cli: CliId, cwd: string): RuntimeMcpServer[] {
  return loadMcpServers(cli)
    .filter((s) => s.enabled && legacyScopeMatches(s, cwd))
    .filter((s) => MCP_TRANSPORTS[cli].includes(s.transport))
    .map(toRuntimeMcpServer)
}

export function clearMcpProbeCache(): void {
  probes.clear()
}

/** 校验来自渲染进程的 cli 字段；调用方拿到 null 就不要继续 */
export function asCliId(v: unknown): CliId | null {
  return typeof v === 'string' && (CLI_IDS as string[]).includes(v) ? (v as CliId) : null
}
