import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  NATIVE_MCP_TRANSPORTS,
  validateMcpServer,
  type LegacyMcpServerConfig,
  type McpMigrationEntry,
  type McpMigrationPreview,
  type McpMigrationResult,
  type McpScope,
  type McpServerConfig,
  type McpServerInput
} from '../shared/mcp'
import { CLI_IDS, type CliId } from '../shared/settings'
import {
  backupLegacyStore,
  countLegacyServers,
  deleteMcpServer,
  legacyStorePath,
  loadAllMcpServers,
  renameLegacyStore
} from './mcp-store'
import { defaultDshHome, listNative, saveNative, type McpNativeContext } from './mcp-native'
import { pathKey } from './path-key'

/**
 * 旧私有 `mcp-servers.json` → 各 CLI 原生配置的迁移。
 *
 * 预览只做分类，不写盘；执行时重新读一遍旧 store 和原生配置，逐条写入。
 * 每成功一条就从旧 store 删除，避免「原生 + 旧注入」双份；全部清空后
 * 才把旧文件改名为 `.migrated-*`。任何一步失败都保留旧文件可重试。
 */

function kvKey(kvs: { key: string; value: string }[]): string {
  return kvs
    .filter((kv) => kv.key.trim())
    .map((kv) => `${kv.key.trim()}\u0000${kv.value}`)
    .sort()
    .join('\u0001')
}

function argsKey(args: string[]): string {
  return args.join('\u0000')
}

function sameConfig(s: McpServerConfig, input: McpServerInput): boolean {
  return (
    s.transport === input.transport &&
    s.command.trim() === input.command.trim() &&
    argsKey(s.args) === argsKey(input.args) &&
    kvKey(s.env) === kvKey(input.env) &&
    s.url.trim() === input.url.trim() &&
    kvKey(s.headers) === kvKey(input.headers) &&
    s.enabled === input.enabled
  )
}

function targetFor(
  cli: CliId,
  legacy: LegacyMcpServerConfig
): { scope: McpScope; cwd: string; reasonKey?: string } {
  if (cli === 'claude') {
    if (legacy.scope === 'global') return { scope: 'user', cwd: '' }
    const cwd = legacy.cwd.trim()
    if (!cwd) return { scope: 'local', cwd: '', reasonKey: 'mcp.migrate.reason.cwdRequired' }
    return { scope: 'local', cwd }
  }
  if (cli === 'codex') return { scope: 'global', cwd: '' }
  return { scope: 'home', cwd: '' }
}

function inputOf(
  legacy: LegacyMcpServerConfig,
  scope: McpScope,
  cwd: string
): McpServerInput {
  return {
    name: legacy.name.trim(),
    transport: legacy.transport,
    command: legacy.command,
    args: legacy.args,
    env: legacy.env,
    url: legacy.url,
    headers: legacy.headers,
    workingDir: '',
    enabled: legacy.enabled,
    scope,
    cwd
  }
}

function targetPathOf(
  cli: CliId,
  scope: McpScope,
  cwd: string,
  ctx: McpNativeContext,
  dshHome: string
): string {
  if (cli === 'claude') {
    if (scope === 'project') return cwd ? join(cwd, '.mcp.json') : ''
    return ctx.claudeJson
  }
  if (cli === 'codex') return ctx.codexConfig
  return join(dshHome || defaultDshHome(ctx), 'profiles', 'acp', 'cordis.patch.yml')
}

function findNative(
  list: McpServerConfig[],
  scope: McpScope,
  cwd: string,
  name: string
): McpServerConfig | null {
  for (const s of list) {
    if (s.scope !== scope) continue
    if (s.name !== name) continue
    if ((scope === 'local' || scope === 'project') && pathKey(s.cwd) !== pathKey(cwd)) continue
    return s
  }
  return null
}

export function previewMigration(
  ctx: McpNativeContext,
  dshHome?: string
): McpMigrationPreview {
  const home = dshHome?.trim() || defaultDshHome(ctx)
  const all = loadAllMcpServers()
  const readCache = new Map<string, ReturnType<typeof listNative>>()
  const readFor = (cli: CliId, cwd: string): ReturnType<typeof listNative> => {
    const key = `${cli}:${pathKey(cwd || '')}:${pathKey(home)}`
    let r = readCache.get(key)
    if (!r) {
      r = listNative(cli, { cwd, dshHome: home }, ctx)
      readCache.set(key, r)
    }
    return r
  }

  const dshProfileMissing =
    existsSync(join(home, 'profiles', 'acp')) === false

  const entries: McpMigrationEntry[] = []
  for (const cli of CLI_IDS) {
    for (const legacy of all[cli]) {
      const target = targetFor(cli, legacy)
      const targetPath = targetPathOf(cli, target.scope, target.cwd, ctx, home)
      const base: McpMigrationEntry = {
        legacyId: legacy.id,
        cli,
        name: legacy.name,
        transport: legacy.transport,
        fromScope: legacy.scope,
        targetScope: target.scope,
        targetPath,
        status: 'migrate',
        hasSecrets:
          legacy.env.some((kv) => !!kv.value) || legacy.headers.some((kv) => !!kv.value),
        secretKeys: [
          ...legacy.env.filter((kv) => !!kv.value).map((kv) => `env:${kv.key}`),
          ...legacy.headers.filter((kv) => !!kv.value).map((kv) => `header:${kv.key}`)
        ],
        enabled: legacy.enabled
      }

      const skip = (reasonKey: string): void => {
        base.status = 'skip'
        base.reasonKey = reasonKey
      }

      if (target.reasonKey) {
        skip(target.reasonKey)
        entries.push(base)
        continue
      }
      if (!NATIVE_MCP_TRANSPORTS[cli].includes(legacy.transport)) {
        skip('mcp.migrate.reason.sseUnsupported')
        entries.push(base)
        continue
      }
      if (cli === 'dsh' && dshProfileMissing) {
        skip('mcp.migrate.reason.dshProfileNotInitialized')
        entries.push(base)
        continue
      }

      const input = inputOf(legacy, target.scope, target.cwd)
      const bad = validateMcpServer(cli, input, input.name)
      if (bad) {
        base.status = 'skip'
        base.reasonKey = bad
        entries.push(base)
        continue
      }

      const nativeRead = readFor(
        cli,
        target.scope === 'local' || target.scope === 'project' ? target.cwd : ''
      )
      const sourceError = nativeRead.sources.find((s) => s.errorKey || s.error)
      if (sourceError) {
        base.status = 'skip'
        base.reasonKey = sourceError.errorKey ?? 'mcp.error.parseFailed'
        entries.push(base)
        continue
      }

      const existing = findNative(nativeRead.servers, target.scope, target.cwd, input.name)
      if (existing) {
        if (sameConfig(existing, input)) {
          base.status = 'existing'
        } else {
          base.status = 'conflict'
          base.reasonKey = 'mcp.migrate.reason.conflict'
        }
      }
      entries.push(base)
    }
  }

  return {
    count: entries.length,
    legacyPath: legacyStorePath(),
    entries,
    defaultDshHome: home
  }
}

export function applyMigration(
  ids: string[],
  ctx: McpNativeContext,
  dshHome?: string
): McpMigrationResult {
  const home = dshHome?.trim() || defaultDshHome(ctx)
  const wanted = new Set(ids)
  const failed: McpMigrationResult['failed'] = []
  let migrated = 0
  let skipped = 0
  let conflicts = 0

  // 迁移前先整份备份旧文件（保留加密格式）
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(ctx.backupRoot, 'migration', `mcp-servers.${ts}.bak`)
  try {
    backupLegacyStore(backupPath)
  } catch {
    // 备份失败不阻塞逐条迁移；原生文件本身也会逐次备份
  }

  // 逐条重新规划，避免使用渲染层传来的旧计划
  const preview = previewMigration(ctx, home)
  for (const planned of preview.entries) {
    if (!wanted.has(planned.legacyId)) {
      skipped++
      continue
    }
    if (planned.status === 'conflict') {
      conflicts++
      continue
    }
    if (planned.status === 'skip') {
      skipped++
      continue
    }

    const all = loadAllMcpServers()
    const legacy = all[planned.cli].find((s) => s.id === planned.legacyId)
    if (!legacy) {
      skipped++
      continue
    }

    if (planned.status === 'existing') {
      // 目标已经是同一条配置：只需从旧 store 删除，避免重复注入
      deleteMcpServer(planned.cli, legacy.id)
      skipped++
      continue
    }

    const target = targetFor(planned.cli, legacy)
    const input = inputOf(legacy, target.scope, target.cwd)
    const q = { cwd: target.cwd, dshHome: home }
    const result = saveNative(planned.cli, input, null, q, ctx)
    if (!result.ok) {
      failed.push({
        name: legacy.name,
        errorKey: result.errorKey,
        detail: result.detail
      })
      continue
    }
    deleteMcpServer(planned.cli, legacy.id)
    migrated++
  }

  let legacyRenamedTo: string | undefined
  if (countLegacyServers() === 0) {
    try {
      legacyRenamedTo = renameLegacyStore() ?? undefined
    } catch {
      // 改名失败不影响已经写好的原生配置
    }
  }

  return {
    ok: failed.length === 0,
    migrated,
    skipped,
    conflicts,
    failed,
    legacyRenamedTo,
    backupPath: existsSync(backupPath) ? backupPath : undefined
  }
}
