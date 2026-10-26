import type { CliId } from './settings'

/**
 * MCP 服务器配置。
 *
 * 现在以每个 CLI 自己的原生配置为准：
 *  - Claude：`~/.claude.json`（用户/本地作用域）与项目 `<cwd>/.mcp.json`；
 *  - Codex：`$CODEX_HOME/config.toml` 的 `[mcp_servers.*]`；
 *  - DSH：`<DSH_HOME>/profiles/acp/cordis.patch.yml` 里的 `@deepseek-ai/dsh-mcp-client` 行。
 *
 * CCoder 只做读写和探测，不再把条目注入启动参数。旧的私有
 * `mcp-servers.json` 只在迁移期作为兼容注入来源保留（见 Legacy* 类型）。
 */
export type McpTransport = 'stdio' | 'http' | 'sse'

/** 原生配置里的作用域。Claude 三种，Codex 只有 global，DSH 按 DSH_HOME。 */
export type McpScope = 'user' | 'project' | 'local' | 'global' | 'home'

export type McpSourceFormat = 'json' | 'jsonc' | 'toml' | 'yaml'

/** 启停开关在原生配置里的实现方式 */
export type McpEnabledControl = 'native' | 'approval' | 'none'

export interface McpKeyValue {
  key: string
  value: string
}

/** 一条原生 MCP 服务器的只读视图（探测结果另加） */
export interface McpServerConfig {
  /** 稳定 id，由 adapter 生成；只用于定位/React key，不反解路径 */
  id: string
  cli: CliId
  name: string
  transport: McpTransport
  /** stdio */
  command: string
  args: string[]
  env: McpKeyValue[]
  /** http / sse */
  url: string
  headers: McpKeyValue[]
  /** 原生 per-server cwd（Codex/DSH）；与下面 scope 的定位目录不是一回事 */
  workingDir: string
  enabled: boolean
  enabledControl: McpEnabledControl
  enabledBy?: 'enabled-list' | 'disabled-list' | 'enable-all' | 'row-disabled' | 'pending'
  scope: McpScope
  /** Claude local/project 的定位目录；其它作用域为空 */
  cwd: string
  source: {
    file: string
    scope: McpScope
    format: McpSourceFormat
    /** DSH 专用：这个条目所属的 DSH_HOME */
    home?: string
  }
  /** 原生格式是否支持编辑（例如 Codex 的 dotted-key 定义、DSH 的嵌套行） */
  supported: boolean
  readOnly: boolean
  readOnlyReason?: 'external' | 'unsupported' | 'nested-row'
  /** env/headers 里是否有非空值（原生文件是明文） */
  hasSecrets: boolean
  secretKeys: string[]
  /** 原样保留但不在表单里的原生字段名 */
  nativeExtras: string[]
  /** 仅 Claude 项目级：Claude 的审批状态 */
  approvalState?: 'enabled' | 'disabled' | 'pending'
}

/** 新建 / 编辑表单提交的数据；id 为空表示新建 */
export interface McpServerInput {
  id?: string
  name: string
  transport: McpTransport
  command: string
  args: string[]
  env: McpKeyValue[]
  url: string
  headers: McpKeyValue[]
  workingDir: string
  enabled: boolean
  scope: McpScope
  cwd: string
}

export interface McpToolInfo {
  name: string
  description: string
}

export interface McpResourceInfo {
  uri: string
  name: string
  description: string
  mimeType: string
}

export interface McpPromptInfo {
  name: string
  description: string
}

export type McpStatus = 'connected' | 'error' | 'disabled' | 'untested'

/** 探测结果，只放内存，不落盘 */
export interface McpProbeResult {
  ok: boolean
  status: 'connected' | 'error'
  error: string
  latencyMs: number
  checkedAt: number
  tools: McpToolInfo[]
  resources: McpResourceInfo[]
  prompts: McpPromptInfo[]
}

/** 探测只关心运行时需要的字段，和文件作用域无关 */
export interface McpProbeInput {
  name: string
  transport: McpTransport
  command: string
  args: string[]
  env: McpKeyValue[]
  url: string
  headers: McpKeyValue[]
  workingDir: string
}

/** 列表里每条服务器 = 原生配置 + 当前探测缓存 */
export interface McpServerView extends McpServerConfig {
  status: McpStatus
  error: string
  latencyMs: number
  checkedAt: number
  tools: McpToolInfo[]
  resources: McpResourceInfo[]
  prompts: McpPromptInfo[]
}

/** 当前 CLI 涉及的一个原生配置文件 */
export interface McpSourceFile {
  path: string
  scopes: McpScope[]
  format: McpSourceFormat
  exists: boolean
  readOnly: boolean
  /** 解析/读取失败时的原始错误（不写回） */
  error?: string
  /** 可翻译的错误/提示 key */
  errorKey?: string
  noteKey?: string
}

export interface DshHomeOption {
  path: string
  /** i18n 后的展示名由渲染层决定；这里给结构信息 */
  label: string
  kind: 'shared' | 'channel' | 'app'
  active: boolean
  exists: boolean
}

export interface McpListResult {
  cli: CliId
  cwd: string
  servers: McpServerView[]
  configFiles: McpSourceFile[]
  /** DSH 当前使用的 home */
  dshHome?: string
  /** 旧私有 store 里尚未迁移的条目数 */
  legacyCount: number
}

export interface McpTestResult extends McpProbeResult {}

export interface McpMutationResult {
  ok: boolean
  /** 失败时是 i18n key（如 mcp.error.nameRequired） */
  errorKey?: string
  /** 原始错误 / stderr（只用于诊断） */
  detail?: string
  /** 新建 / 编辑后选中的服务器 id */
  serverId?: string
  /** 本次写入的原生文件 */
  sourceFile?: string
  /** 写入前的备份 */
  backupPath?: string
  list: McpListResult
}

/* ── 迁移 ─────────────────────────────────────────────────── */

export interface McpMigrationEntry {
  legacyId: string
  cli: CliId
  name: string
  transport: McpTransport
  fromScope: 'global' | 'project'
  targetScope: McpScope
  targetPath: string
  status: 'migrate' | 'skip' | 'conflict' | 'existing'
  /** 失败/跳过原因的 i18n key */
  reasonKey?: string
  hasSecrets: boolean
  secretKeys: string[]
  enabled: boolean
}

export interface McpMigrationPreview {
  count: number
  legacyPath: string
  entries: McpMigrationEntry[]
  defaultDshHome: string
}

export interface McpMigrationResult {
  ok: boolean
  migrated: number
  skipped: number
  conflicts: number
  failed: Array<{ name: string; errorKey: string; detail?: string }>
  /** 旧文件改名后的路径（全部成功时才有） */
  legacyRenamedTo?: string
  /** 迁移前旧文件备份 */
  backupPath?: string
}

/* ── 旧私有 store（迁移期兼容） ───────────────────────────── */

/** 旧 `mcp-servers.json` 里的条目形状；只读，不再写入 */
export interface LegacyMcpServerConfig {
  id: string
  name: string
  description: string
  transport: McpTransport
  command: string
  args: string[]
  env: McpKeyValue[]
  url: string
  headers: McpKeyValue[]
  enabled: boolean
  scope: 'global' | 'project'
  cwd: string
  createdAt: number
  updatedAt: number
}

/** 运行时传给 provider 的最小结构；只用于旧条目迁移期兜底注入 */
export interface RuntimeMcpServer {
  name: string
  transport: McpTransport
  command: string
  args: string[]
  env: Record<string, string>
  url: string
  headers: Record<string, string>
}

/* ── 能力表与校验 ─────────────────────────────────────────── */

/** 原生配置能表达的传输。DSH 的 mcp-client 只支持 stdio / streamable-http。 */
export const NATIVE_MCP_TRANSPORTS: Record<CliId, McpTransport[]> = {
  claude: ['stdio', 'http', 'sse'],
  codex: ['stdio', 'http'],
  dsh: ['stdio', 'http']
}

/** 旧注入路径的传输能力（DSH 仍支持 sse，避免升级后旧条目失效） */
export const MCP_TRANSPORTS: Record<CliId, McpTransport[]> = {
  claude: ['stdio', 'http', 'sse'],
  codex: ['stdio', 'http'],
  dsh: ['stdio', 'http', 'sse']
}

export const MCP_SCOPES: Record<CliId, McpScope[]> = {
  claude: ['user', 'project', 'local'],
  codex: ['global'],
  dsh: ['home']
}

export function isMcpTransport(v: unknown): v is McpTransport {
  return v === 'stdio' || v === 'http' || v === 'sse'
}

export function isMcpScope(v: unknown): v is McpScope {
  return v === 'user' || v === 'project' || v === 'local' || v === 'global' || v === 'home'
}

export function isLegacyMcpScope(v: unknown): v is 'global' | 'project' {
  return v === 'global' || v === 'project'
}

/** 默认新建表单：Claude 用户级、Codex 全局、DSH 当前 home；stdio 是最常见的形态 */
export function emptyMcpInput(cli: CliId): McpServerInput {
  return {
    name: '',
    transport: 'stdio',
    command: '',
    args: [],
    env: [],
    url: '',
    headers: [],
    workingDir: '',
    enabled: true,
    scope: MCP_SCOPES[cli][0],
    cwd: ''
  }
}

/** 旧 store 的落盘数据恢复；坏字段一律回落到空值 */
export function normalizeLegacyMcpServer(
  raw: Partial<LegacyMcpServerConfig> | null | undefined
): LegacyMcpServerConfig {
  const now = Date.now()
  const transport = isMcpTransport(raw?.transport) ? raw.transport : 'stdio'
  return {
    id: typeof raw?.id === 'string' && raw.id ? raw.id : `mcp-${now}-${Math.random().toString(36).slice(2, 8)}`,
    name: typeof raw?.name === 'string' ? raw.name : '',
    description: typeof raw?.description === 'string' ? raw.description : '',
    transport,
    command: typeof raw?.command === 'string' ? raw.command : '',
    args: Array.isArray(raw?.args) ? raw.args.filter((x): x is string => typeof x === 'string') : [],
    env: Array.isArray(raw?.env)
      ? raw.env.filter(
          (x): x is McpKeyValue =>
            !!x && typeof x === 'object' && typeof x.key === 'string' && typeof x.value === 'string'
        )
      : [],
    url: typeof raw?.url === 'string' ? raw.url : '',
    headers: Array.isArray(raw?.headers)
      ? raw.headers.filter(
          (x): x is McpKeyValue =>
            !!x && typeof x === 'object' && typeof x.key === 'string' && typeof x.value === 'string'
        )
      : [],
    enabled: raw?.enabled !== false,
    scope: isLegacyMcpScope(raw?.scope) ? raw.scope : 'global',
    cwd: typeof raw?.cwd === 'string' ? raw.cwd : '',
    createdAt: typeof raw?.createdAt === 'number' ? raw.createdAt : now,
    updatedAt: typeof raw?.updatedAt === 'number' ? raw.updatedAt : now
  }
}

/** 兼容旧名字：旧 store 仍在用 */
export const normalizeMcpServer = normalizeLegacyMcpServer

/** 渲染进程传来的对象一律按不可信处理；只认已知字段 */
export function coerceMcpInput(raw: unknown): McpServerInput {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const text = (v: unknown): string => (typeof v === 'string' ? v : '')
  const kvList = (v: unknown): McpKeyValue[] =>
    Array.isArray(v)
      ? v
          .map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {}))
          .map((x) => ({ key: text(x.key), value: text(x.value) }))
      : []
  return {
    id: typeof o.id === 'string' && o.id ? o.id : undefined,
    name: text(o.name),
    transport: isMcpTransport(o.transport) ? o.transport : 'stdio',
    command: text(o.command),
    args: Array.isArray(o.args) ? o.args.filter((x): x is string => typeof x === 'string') : [],
    env: kvList(o.env),
    url: text(o.url),
    headers: kvList(o.headers),
    workingDir: text(o.workingDir),
    enabled: o.enabled !== false,
    scope: isMcpScope(o.scope) ? o.scope : 'global',
    cwd: text(o.cwd)
  }
}

/**
 * 校验用户输入；返回第一个错误 i18n key，null = 通过。
 *
 * `existingName` 用于编辑：原生配置里可能已有带空格/点号的历史名字，
 * 只要不改名就允许保存；新建/改名校验仍走保守字符集。
 */
export function validateMcpServer(
  cli: CliId,
  s: McpServerInput,
  existingName?: string
): string | null {
  const name = s.name.trim()
  if (!name) return 'mcp.error.nameRequired'
  const maxLen = cli === 'dsh' ? 32 : 64
  if (name.length > maxLen) return cli === 'dsh' ? 'mcp.error.nameTooLongDsh' : 'mcp.error.nameTooLong'
  const renamed = existingName === undefined || existingName !== name
  if (cli === 'dsh') {
    // DSH 的 mcp-client 对 serverName 有硬性字符集/长度要求，历史名字也不能放宽
    if (!/^[A-Za-z0-9_-]+$/.test(name)) return 'mcp.error.nameInvalid'
  } else if (renamed && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    return 'mcp.error.nameInvalid'
  }
  if (!MCP_SCOPES[cli].includes(s.scope)) return 'mcp.error.invalidScope'
  if (!NATIVE_MCP_TRANSPORTS[cli].includes(s.transport)) {
    if (cli === 'dsh' && s.transport === 'sse') return 'mcp.error.sseDshUnsupported'
    if (cli === 'codex' && s.transport === 'sse') return 'mcp.error.sseCodexUnsupported'
    return 'mcp.error.transportUnsupported'
  }
  if ((s.scope === 'project' || s.scope === 'local') && !s.cwd.trim()) {
    return 'mcp.error.cwdRequired'
  }
  if (s.transport === 'stdio') {
    if (!s.command.trim()) return 'mcp.error.commandRequired'
  } else if (!s.url.trim()) {
    return 'mcp.error.urlRequired'
  } else {
    try {
      const u = new URL(s.url)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'mcp.error.urlInvalid'
    } catch {
      return 'mcp.error.urlInvalid'
    }
  }
  const validKey = (kv: McpKeyValue): boolean => !!kv.key.trim()
  if (s.env.some((kv) => !validKey(kv))) return 'mcp.error.envKeyRequired'
  if (s.headers.some((kv) => !validKey(kv))) return 'mcp.error.headerKeyRequired'
  return null
}

/** 旧条目注入用 */
export function toRuntimeMcpServer(
  s: Pick<LegacyMcpServerConfig, 'name' | 'transport' | 'command' | 'args' | 'env' | 'url' | 'headers'>
): RuntimeMcpServer {
  return {
    name: s.name.trim(),
    transport: s.transport,
    command: s.command.trim(),
    args: s.args,
    env: Object.fromEntries(s.env.filter((kv) => kv.key.trim()).map((kv) => [kv.key.trim(), kv.value])),
    url: s.url.trim(),
    headers: Object.fromEntries(
      s.headers.filter((kv) => kv.key.trim()).map((kv) => [kv.key.trim(), kv.value])
    )
  }
}

/** 原生视图 → 探测输入 */
export function toProbeInput(s: McpServerConfig): McpProbeInput {
  return {
    name: s.name,
    transport: s.transport,
    command: s.command,
    args: s.args,
    env: s.env,
    url: s.url,
    headers: s.headers,
    workingDir: s.workingDir
  }
}

/** 原生视图 → 表单输入 */
export function toMcpInput(s: McpServerConfig): McpServerInput {
  return {
    id: s.id,
    name: s.name,
    transport: s.transport,
    command: s.command,
    args: [...s.args],
    env: s.env.map((kv) => ({ ...kv })),
    url: s.url,
    headers: s.headers.map((kv) => ({ ...kv })),
    workingDir: s.workingDir,
    enabled: s.enabled,
    scope: s.scope,
    cwd: s.cwd
  }
}

/** 原生条目里的密钥标记：有非空值就算 */
export function secretKeysOf(env: McpKeyValue[], headers: McpKeyValue[]): string[] {
  const keys: string[] = []
  for (const kv of env) if (kv.key.trim() && kv.value) keys.push(`env:${kv.key.trim()}`)
  for (const kv of headers) if (kv.key.trim() && kv.value) keys.push(`header:${kv.key.trim()}`)
  return keys
}
