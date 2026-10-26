import type { McpScope, McpServerConfig, McpServerInput, McpSourceFile } from '../../shared/mcp'

/**
 * 原生 MCP 适配器的显式路径上下文。
 *
 * 适配器不直接读 homedir/env/electron —— 由 index.ts 解析好路径传进来，
 * 测试用临时目录构造即可，不会碰真实用户配置。
 */
export interface McpNativeContext {
  /** ~/.claude.json（尊重 CLAUDE_CONFIG_DIR） */
  claudeJson: string
  /** ~/.claude（settings / 项目审批文件） */
  claudeDir: string
  /** $CODEX_HOME/config.toml */
  codexConfig: string
  /** userData/mcp-backups */
  backupRoot: string
  /** 允许写入的 DSH_HOME 列表 */
  dshHomes: string[]
}

export interface NativeQuery {
  cwd: string
  /** DSH 选中的 home；为空时用 context 的第一个（默认 home） */
  dshHome?: string
}

export interface NativeReadResult {
  servers: McpServerConfig[]
  sources: McpSourceFile[]
}

export interface NativeMutationOk {
  ok: true
  serverId?: string
  sourceFile?: string
  backupPath?: string
}

export interface NativeMutationErr {
  ok: false
  errorKey: string
  detail?: string
  sourceFile?: string
  backupPath?: string
}

export type NativeMutationResult = NativeMutationOk | NativeMutationErr

export interface Adapter {
  read(ctx: McpNativeContext, q: NativeQuery): NativeReadResult
  save(
    ctx: McpNativeContext,
    input: McpServerInput,
    existing: McpServerConfig | null,
    q: NativeQuery
  ): NativeMutationResult
  remove(ctx: McpNativeContext, existing: McpServerConfig, q: NativeQuery): NativeMutationResult
  setEnabled(
    ctx: McpNativeContext,
    existing: McpServerConfig,
    enabled: boolean,
    q: NativeQuery
  ): NativeMutationResult
  sourcePath(scope: McpScope, q: NativeQuery, ctx: McpNativeContext): string | null
}
