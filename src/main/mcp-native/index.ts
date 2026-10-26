import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CliId } from '../../shared/settings'
import type { McpScope, McpServerConfig, McpServerInput } from '../../shared/mcp'
import type {
  McpNativeContext,
  NativeMutationResult,
  NativeQuery,
  NativeReadResult
} from './types'
import { readClaude, saveClaude, removeClaude, setClaudeEnabled, claudeSourcePath } from './claude'
import { readCodex, saveCodex, removeCodex, setCodexEnabled, codexSourcePath } from './codex'
import { readDsh, saveDsh, removeDsh, setDshEnabled, dshSourcePath } from './dsh'

export type { McpNativeContext, NativeQuery, NativeReadResult, NativeMutationResult } from './types'

/**
 * 解析三家 CLI 的默认配置文件路径。
 *
 * 只有这里读 env/homedir；adapter 和 service 都接收显式 context，
 * 测试可以注入临时目录。
 */
export function createMcpNativeContext(opts: {
  backupRoot: string
  dshHomes: string[]
}): McpNativeContext {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim()
  const claudeDir = configDir || join(homedir(), '.claude')
  const claudeJson =
    configDir && existsSync(join(configDir, '.claude.json'))
      ? join(configDir, '.claude.json')
      : join(homedir(), '.claude.json')
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  return {
    claudeJson,
    claudeDir,
    codexConfig: join(codexHome, 'config.toml'),
    backupRoot: opts.backupRoot,
    dshHomes: opts.dshHomes
  }
}

export function defaultDshHome(ctx: McpNativeContext): string {
  return ctx.dshHomes[0] ?? ''
}

export function listNative(cli: CliId, q: NativeQuery, ctx: McpNativeContext): NativeReadResult {
  if (cli === 'claude') return readClaude(ctx, q)
  if (cli === 'codex') return readCodex(ctx, q)
  return readDsh(ctx, q)
}

export function saveNative(
  cli: CliId,
  input: McpServerInput,
  existing: McpServerConfig | null,
  q: NativeQuery,
  ctx: McpNativeContext
): NativeMutationResult {
  if (cli === 'claude') return saveClaude(ctx, input, existing, q)
  if (cli === 'codex') return saveCodex(ctx, input, existing, q)
  return saveDsh(ctx, input, existing, q)
}

export function removeNative(
  cli: CliId,
  existing: McpServerConfig,
  q: NativeQuery,
  ctx: McpNativeContext
): NativeMutationResult {
  if (cli === 'claude') return removeClaude(ctx, existing, q)
  if (cli === 'codex') return removeCodex(ctx, existing, q)
  return removeDsh(ctx, existing, q)
}

export function setNativeEnabled(
  cli: CliId,
  existing: McpServerConfig,
  enabled: boolean,
  q: NativeQuery,
  ctx: McpNativeContext
): NativeMutationResult {
  if (cli === 'claude') return setClaudeEnabled(ctx, existing, enabled, q)
  if (cli === 'codex') return setCodexEnabled(ctx, existing, enabled, q)
  return setDshEnabled(ctx, existing, enabled, q)
}

export function sourcePathFor(
  cli: CliId,
  scope: McpScope,
  q: NativeQuery,
  ctx: McpNativeContext
): string | null {
  if (cli === 'claude') return claudeSourcePath(scope, q, ctx)
  if (cli === 'codex') return codexSourcePath(scope, q, ctx)
  return dshSourcePath(scope, q, ctx)
}
