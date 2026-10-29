/**
 * Claude Code Hooks。
 *
 * 只有 Claude Code 有这套配置，所以这里不挂 CliId：
 *  - 用户级：`~/.claude/settings.json`
 *  - 项目级：`<cwd>/.claude/settings.json`
 *  - 本地级：`<cwd>/.claude/settings.local.json`
 *  - 插件：`~/.claude/plugins/<plugin>/hooks/hooks.json`，只读
 *
 * 事件与类型以本机 CLI 2.1.x 的 schema 为准：5 种 hook 类型，
 * `command` / `prompt` / `agent` / `http` / `mcp_tool`。
 */

/* ── 事件 ───────────────────────────────────────────────── */

export const HOOK_EVENT_IDS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'PermissionRequest',
  'PermissionDenied',
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PreModelSwitch',
  'PostModelSwitch',
  'TaskCreated',
  'TaskCompleted',
  'TeammateIdle',
  'CwdChanged',
  'FileChanged',
  'DirectoryAdded',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'ConfigChange',
  'Notification',
  'Setup',
  'Elicitation',
  'ElicitationResult',
  'MessageDisplay'
] as const

export type HookEvent = (typeof HOOK_EVENT_IDS)[number]

export type HookEventGroup = 'tool' | 'session' | 'task' | 'workspace' | 'system'

export interface HookText {
  zh: string
  en: string
}

export interface HookEventDef {
  id: HookEvent
  group: HookEventGroup
  /** 事件是否使用 matcher（工具名 / 斜杠命令 / MCP server） */
  matcher: boolean
  label: HookText
  desc: HookText
}

const ev = (
  id: HookEvent,
  group: HookEventGroup,
  matcher: boolean,
  labelZh: string,
  labelEn: string,
  descZh: string,
  descEn: string
): HookEventDef => ({
  id,
  group,
  matcher,
  label: { zh: labelZh, en: labelEn },
  desc: { zh: descZh, en: descEn }
})

export const HOOK_EVENTS: HookEventDef[] = [
  ev('PreToolUse', 'tool', true, '工具执行前', 'Before tool use', '工具调用前触发；退出码 2 可阻止本次调用。', 'Runs before a tool call; exit code 2 blocks the call.'),
  ev('PostToolUse', 'tool', true, '工具执行后', 'After tool use', '工具调用后触发；可把结果或建议回传给模型。', 'Runs after a tool call; can feed results or advice back to the model.'),
  ev('PostToolUseFailure', 'tool', true, '工具失败后', 'After tool failure', '工具执行失败后触发，适合记录错误或补救。', 'Runs after a tool fails, for logging or recovery.'),
  ev('PostToolBatch', 'tool', true, '工具批次结束后', 'After tool batch', '一批工具调用结束后触发。', 'Runs after a batch of tool calls finishes.'),
  ev('PermissionRequest', 'tool', true, '权限请求时', 'On permission request', 'CLI 请求权限时触发，可自动批准或拒绝。', 'Runs when the CLI asks for permission; can approve or deny.'),
  ev('PermissionDenied', 'tool', true, '权限被拒后', 'After permission denied', '权限被拒绝后触发。', 'Runs after a permission request is denied.'),

  ev('SessionStart', 'session', false, '会话开始', 'Session start', '会话启动或恢复时触发。', 'Runs when a session starts or resumes.'),
  ev('SessionEnd', 'session', false, '会话结束', 'Session end', '会话结束时触发。', 'Runs when a session ends.'),
  ev('UserPromptSubmit', 'session', false, '提交提示词', 'Prompt submitted', '用户提交提示词后、模型开始前触发。', 'Runs after the user submits a prompt, before the model starts.'),
  ev('UserPromptExpansion', 'session', true, '提示词展开', 'Prompt expansion', '斜杠命令展开为提示词时触发。', 'Runs when a slash command expands into a prompt.'),
  ev('Stop', 'session', false, '本轮结束', 'Turn stop', '本轮回复结束时触发。', 'Runs when a turn finishes.'),
  ev('StopFailure', 'session', false, '本轮异常结束', 'Turn stop failure', '本轮因错误结束时触发。', 'Runs when a turn ends with an error.'),
  ev('SubagentStart', 'session', false, '子代理开始', 'Subagent start', '子代理启动时触发。', 'Runs when a subagent starts.'),
  ev('SubagentStop', 'session', false, '子代理结束', 'Subagent stop', '子代理完成时触发。', 'Runs when a subagent finishes.'),
  ev('PreCompact', 'session', false, '压缩前', 'Before compaction', '上下文压缩前触发。', 'Runs before context compaction.'),
  ev('PostCompact', 'session', false, '压缩后', 'After compaction', '上下文压缩后触发。', 'Runs after context compaction.'),
  ev('PreModelSwitch', 'session', false, '切换模型前', 'Before model switch', '切换模型前触发。', 'Runs before switching models.'),
  ev('PostModelSwitch', 'session', false, '切换模型后', 'After model switch', '切换模型后触发。', 'Runs after switching models.'),

  ev('TaskCreated', 'task', false, '任务创建', 'Task created', '任务创建时触发。', 'Runs when a task is created.'),
  ev('TaskCompleted', 'task', false, '任务完成', 'Task completed', '任务完成时触发。', 'Runs when a task completes.'),
  ev('TeammateIdle', 'task', false, '队友空闲', 'Teammate idle', '多代理队友进入空闲时触发。', 'Runs when a teammate agent becomes idle.'),

  ev('CwdChanged', 'workspace', false, '工作目录变化', 'Working directory changed', '会话工作目录变化时触发。', 'Runs when the session working directory changes.'),
  ev('FileChanged', 'workspace', false, '文件变化', 'File changed', '工作区文件变化时触发。', 'Runs when a workspace file changes.'),
  ev('DirectoryAdded', 'workspace', false, '目录加入', 'Directory added', '工作区新增目录时触发。', 'Runs when a directory is added to the workspace.'),
  ev('WorktreeCreate', 'workspace', false, '工作树创建', 'Worktree created', '创建 Git worktree 时触发。', 'Runs when a Git worktree is created.'),
  ev('WorktreeRemove', 'workspace', false, '工作树移除', 'Worktree removed', '移除 Git worktree 时触发。', 'Runs when a Git worktree is removed.'),
  ev('InstructionsLoaded', 'workspace', false, '指令加载', 'Instructions loaded', '加载 CLAUDE.md 等指令文件时触发。', 'Runs when instruction files such as CLAUDE.md are loaded.'),
  ev('ConfigChange', 'workspace', false, '配置变化', 'Config changed', 'CLI 配置变化时触发。', 'Runs when CLI configuration changes.'),

  ev('Notification', 'system', false, '通知', 'Notification', 'CLI 发出通知时触发。', 'Runs when the CLI emits a notification.'),
  ev('Setup', 'system', false, '初始化', 'Setup', 'CLI 初始化或安装流程中触发。', 'Runs during CLI setup or installation.'),
  ev('Elicitation', 'system', true, '信息补充', 'Elicitation', 'MCP 服务器请求补充信息时触发。', 'Runs when an MCP server asks for more information.'),
  ev('ElicitationResult', 'system', true, '信息补充结果', 'Elicitation result', '补充信息返回后触发。', 'Runs after an elicitation result is returned.'),
  ev('MessageDisplay', 'system', false, '消息展示', 'Message display', '消息展示给用户时触发。', 'Runs when a message is displayed to the user.')
]

export const HOOK_EVENT_MAP: Record<HookEvent, HookEventDef> = Object.fromEntries(
  HOOK_EVENTS.map((e) => [e.id, e])
) as Record<HookEvent, HookEventDef>

export const HOOK_EVENT_GROUP_LABEL: Record<HookEventGroup, HookText> = {
  tool: { zh: '工具', en: 'Tools' },
  session: { zh: '会话', en: 'Session' },
  task: { zh: '任务', en: 'Tasks' },
  workspace: { zh: '工作区', en: 'Workspace' },
  system: { zh: '系统', en: 'System' }
}

export function isHookEvent(v: unknown): v is HookEvent {
  return typeof v === 'string' && (HOOK_EVENT_IDS as readonly string[]).includes(v)
}

export function eventDef(id: string): HookEventDef | undefined {
  return isHookEvent(id) ? HOOK_EVENT_MAP[id] : undefined
}

export function eventSupportsMatcher(id: string): boolean {
  return eventDef(id)?.matcher === true
}

/* ── 类型 ───────────────────────────────────────────────── */

export const HOOK_TYPE_IDS = ['command', 'prompt', 'agent', 'http', 'mcp_tool'] as const
export type HookType = (typeof HOOK_TYPE_IDS)[number]

export interface HookTypeDef {
  id: HookType
  label: HookText
  desc: HookText
}

export const HOOK_TYPES: HookTypeDef[] = [
  {
    id: 'command',
    label: { zh: '命令', en: 'Command' },
    desc: { zh: '执行 Shell 命令', en: 'Run a shell command' }
  },
  {
    id: 'prompt',
    label: { zh: '提示词', en: 'Prompt' },
    desc: { zh: '交给一个小模型判定', en: 'Evaluate with a small model' }
  },
  {
    id: 'agent',
    label: { zh: '子代理', en: 'Agent' },
    desc: { zh: '启动一个验证子代理', en: 'Run a verifier subagent' }
  },
  {
    id: 'http',
    label: { zh: 'HTTP', en: 'HTTP' },
    desc: { zh: '把事件 JSON POST 到 URL', en: 'POST the event JSON to a URL' }
  },
  {
    id: 'mcp_tool',
    label: { zh: 'MCP 工具', en: 'MCP tool' },
    desc: { zh: '调用已配置的 MCP 工具', en: 'Call a configured MCP tool' }
  }
]

export const HOOK_TYPE_MAP: Record<HookType, HookTypeDef> = Object.fromEntries(
  HOOK_TYPES.map((t) => [t.id, t])
) as Record<HookType, HookTypeDef>

export function isHookType(v: unknown): v is HookType {
  return typeof v === 'string' && (HOOK_TYPE_IDS as readonly string[]).includes(v)
}

export function typeDef(id: string): HookTypeDef | undefined {
  return isHookType(id) ? HOOK_TYPE_MAP[id] : undefined
}

/* ── 配置结构 ───────────────────────────────────────────── */

export type HookScope = 'user' | 'project' | 'local' | 'plugin'
export type HookWritableScope = Exclude<HookScope, 'plugin'>
export type HookShell = 'bash' | 'powershell'
export type HookFailureMode = 'continue' | 'block'

export interface HookCommon {
  /** 权限规则过滤，例如 `Bash(git *)` */
  if?: string
  statusMessage?: string
  once?: boolean
}

export interface CommandHook extends HookCommon {
  type: 'command'
  command: string
  args?: string[]
  shell?: HookShell
  timeout?: number
  onFailure?: HookFailureMode
  async?: boolean
  asyncRewake?: boolean
  rewakeMessage?: string
  rewakeSummary?: string
}

export interface PromptHook extends HookCommon {
  type: 'prompt'
  prompt: string
  timeout?: number
  model?: string
  continueOnBlock?: boolean
}

export interface AgentHook extends HookCommon {
  type: 'agent'
  prompt: string
  timeout?: number
  model?: string
}

export interface HttpHook extends HookCommon {
  type: 'http'
  url: string
  timeout?: number
  onFailure?: HookFailureMode
  headers?: Record<string, string>
  allowedEnvVars?: string[]
}

export interface McpToolHook extends HookCommon {
  type: 'mcp_tool'
  server: string
  tool: string
  input?: Record<string, unknown>
  timeout?: number
}

/** CLI 配置里出现了当前 UI 不认识的 type；只读展示，不丢数据 */
export interface UnknownHook extends HookCommon {
  type: string
  [key: string]: unknown
}

export type HookEntry =
  | CommandHook
  | PromptHook
  | AgentHook
  | HttpHook
  | McpToolHook
  | UnknownHook

/** 编辑时由 UI 管理的字段；其余字段原样保留 */
export const HOOK_KNOWN_KEYS = [
  'type',
  'command',
  'args',
  'if',
  'shell',
  'timeout',
  'onFailure',
  'statusMessage',
  'once',
  'async',
  'asyncRewake',
  'rewakeMessage',
  'rewakeSummary',
  'prompt',
  'model',
  'continueOnBlock',
  'url',
  'headers',
  'allowedEnvVars',
  'server',
  'tool',
  'input'
] as const

export type HookReadOnlyReason = 'plugin' | 'unsupported'

export interface HookView {
  /** 指纹，禁用 / 编辑 / 删除都用它定位 */
  id: string
  scope: HookScope
  event: HookEvent | string
  matcher: string
  hook: HookEntry
  enabled: boolean
  readOnly: boolean
  readOnlyReason: HookReadOnlyReason | null
  pluginName?: string
  sourceFile: string
  cwd: string
  /** 来自应用侧 disabled 注册表 */
  disabled?: boolean
}

export interface HookSourceFile {
  scope: HookScope
  path: string
  exists: boolean
  writable: boolean
  count: number
  /** 解析失败时给界面看的原话 */
  error?: string
}

export interface HookListResult {
  cwd: string
  hooks: HookView[]
  sources: HookSourceFile[]
  /** 应用侧禁用注册表里、当前工作区可见的条数 */
  disabledCount: number
  scannedAt: number
}

export interface HookInput {
  /** 编辑时传原 view.id；新建为空 */
  id?: string
  scope: HookWritableScope
  cwd: string
  event: HookEvent
  matcher: string
  hook: HookEntry
  enabled: boolean
}

export interface HookMutationResult {
  ok: boolean
  errorKey?: string
  detail?: string
  list: HookListResult
}

export interface HookTestInput {
  scope: HookWritableScope
  cwd: string
  event: HookEvent
  matcher: string
  hook: HookEntry
}

export interface HookTestResult {
  ok: boolean
  /** prompt / agent / mcp_tool 不能在本机离线试运行 */
  supported: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  errorKey?: string
  detail?: string
}

/* ── 表单 ───────────────────────────────────────────────── */

const MAX_TEXT = 64 * 1024
const MAX_MATCHER = 4096
const MAX_MODEL = 256
const MAX_URL = 8192
const MAX_TIMEOUT = 3600

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function text(v: unknown, max = MAX_TEXT): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

function trimmed(v: unknown, max = MAX_TEXT): string {
  return text(v, max).trim()
}

function positiveInt(v: unknown, fallback?: number): number | undefined {
  if (v === undefined || v === null || v === '') return fallback
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_TIMEOUT, Math.max(1, Math.round(n)))
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

function stringList(v: unknown, maxItems: number, maxLen: number): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.slice(0, maxLen))
    .filter(Boolean)
    .slice(0, maxItems)
  return out.length ? out : undefined
}

function stringRecord(v: unknown, maxItems: number): Record<string, string> | undefined {
  if (!isRecord(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v).slice(0, maxItems)) {
    if (typeof val !== 'string') continue
    const key = k.slice(0, 256)
    if (key) out[key] = val.slice(0, 4096)
  }
  return Object.keys(out).length ? out : undefined
}

function jsonObject(v: unknown): Record<string, unknown> | undefined {
  if (!isRecord(v)) return undefined
  try {
    if (JSON.stringify(v).length > 64 * 1024) return undefined
  } catch {
    return undefined
  }
  return v
}

function commonOf(o: Record<string, unknown>): HookCommon {
  const out: HookCommon = {}
  const filter = trimmed(o.if, MAX_MATCHER)
  if (filter) out.if = filter
  const status = text(o.statusMessage, 512)
  if (status) out.statusMessage = status
  const once = bool(o.once)
  if (once !== undefined) out.once = once
  return out
}

function validUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function isHookScope(v: unknown): v is HookScope {
  return v === 'user' || v === 'project' || v === 'local' || v === 'plugin'
}

export function isWritableHookScope(v: unknown): v is HookWritableScope {
  return v === 'user' || v === 'project' || v === 'local'
}

export function emptyHookEntry(type: HookType = 'command'): HookEntry {
  if (type === 'prompt') return { type: 'prompt', prompt: '', timeout: 30 }
  if (type === 'agent') return { type: 'agent', prompt: '', timeout: 60 }
  if (type === 'http') return { type: 'http', url: '', timeout: 10 }
  if (type === 'mcp_tool') return { type: 'mcp_tool', server: '', tool: '', timeout: 10 }
  return { type: 'command', command: '', timeout: 10 }
}

export function emptyHookInput(cwd = ''): HookInput {
  return {
    scope: 'user',
    cwd,
    event: 'PreToolUse',
    matcher: '',
    hook: emptyHookEntry('command'),
    enabled: true
  }
}

export function coerceHookEntry(raw: unknown): HookEntry | null {
  if (!isRecord(raw) || !isHookType(raw.type)) return null
  const common = commonOf(raw)

  if (raw.type === 'command') {
    const command = text(raw.command)
    const args = stringList(raw.args, 256, 8192)
    if (!command.trim()) return null
    const out: CommandHook = { type: 'command', command, ...common }
    if (args) out.args = args
    if (raw.shell === 'bash' || raw.shell === 'powershell') out.shell = raw.shell
    const timeout = positiveInt(raw.timeout)
    if (timeout !== undefined) out.timeout = timeout
    if (raw.onFailure === 'continue' || raw.onFailure === 'block') out.onFailure = raw.onFailure
    const async = bool(raw.async)
    if (async !== undefined) out.async = async
    const asyncRewake = bool(raw.asyncRewake)
    if (asyncRewake !== undefined) out.asyncRewake = asyncRewake
    const rewakeMessage = text(raw.rewakeMessage, 2048)
    if (rewakeMessage) out.rewakeMessage = rewakeMessage
    const rewakeSummary = text(raw.rewakeSummary, 2048)
    if (rewakeSummary) out.rewakeSummary = rewakeSummary
    return out
  }

  if (raw.type === 'prompt') {
    const prompt = text(raw.prompt)
    if (!prompt.trim()) return null
    const out: PromptHook = { type: 'prompt', prompt, ...common }
    const timeout = positiveInt(raw.timeout)
    if (timeout !== undefined) out.timeout = timeout
    const model = trimmed(raw.model, MAX_MODEL)
    if (model) out.model = model
    const cont = bool(raw.continueOnBlock)
    if (cont !== undefined) out.continueOnBlock = cont
    return out
  }

  if (raw.type === 'agent') {
    const prompt = text(raw.prompt)
    if (!prompt.trim()) return null
    const out: AgentHook = { type: 'agent', prompt, ...common }
    const timeout = positiveInt(raw.timeout)
    if (timeout !== undefined) out.timeout = timeout
    const model = trimmed(raw.model, MAX_MODEL)
    if (model) out.model = model
    return out
  }

  if (raw.type === 'http') {
    const url = trimmed(raw.url, MAX_URL)
    if (!validUrl(url)) return null
    const out: HttpHook = { type: 'http', url, ...common }
    const timeout = positiveInt(raw.timeout)
    if (timeout !== undefined) out.timeout = timeout
    if (raw.onFailure === 'continue' || raw.onFailure === 'block') out.onFailure = raw.onFailure
    const headers = stringRecord(raw.headers, 64)
    if (headers) out.headers = headers
    const vars = stringList(raw.allowedEnvVars, 64, 256)
    if (vars) out.allowedEnvVars = vars
    return out
  }

  const server = trimmed(raw.server, 512)
  const tool = trimmed(raw.tool, 512)
  if (!server || !tool) return null
  const out: McpToolHook = { type: 'mcp_tool', server, tool, ...common }
  const timeout = positiveInt(raw.timeout)
  if (timeout !== undefined) out.timeout = timeout
  const input = jsonObject(raw.input)
  if (input) out.input = input
  return out
}

export function validateHookEntry(hook: HookEntry): string | null {
  if (!hook || !isHookType(hook.type)) return 'hook.error.unsupportedType'
  if (hook.type === 'command') {
    if (!(hook as CommandHook).command.trim()) return 'hook.error.commandRequired'
  } else if (hook.type === 'prompt' || hook.type === 'agent') {
    if (!(hook as PromptHook | AgentHook).prompt.trim()) return 'hook.error.promptRequired'
  } else if (hook.type === 'http') {
    if (!validUrl((hook as HttpHook).url)) return 'hook.error.urlInvalid'
  } else if (hook.type === 'mcp_tool') {
    const h = hook as McpToolHook
    if (!h.server.trim() || !h.tool.trim()) return 'hook.error.mcpToolRequired'
  }
  return null
}

export function validateHookInput(input: HookInput): string | null {
  if (!isWritableHookScope(input.scope)) return 'hook.error.invalidScope'
  if (!isHookEvent(input.event)) return 'hook.error.invalidEvent'
  if (input.matcher.length > MAX_MATCHER) return 'hook.error.matcherTooLong'
  if (input.scope !== 'user' && !input.cwd.trim()) return 'hook.error.cwdRequired'
  return validateHookEntry(input.hook)
}

export function coerceHookInput(raw: unknown): HookInput | null {
  if (!isRecord(raw)) return null
  const scope = raw.scope
  if (!isWritableHookScope(scope)) return null
  const event = raw.event
  if (!isHookEvent(event)) return null
  const hook = coerceHookEntry(raw.hook)
  if (!hook) return null
  return {
    id: typeof raw.id === 'string' ? raw.id.slice(0, 128) : undefined,
    scope,
    cwd: typeof raw.cwd === 'string' ? raw.cwd.slice(0, 4096) : '',
    event,
    matcher: trimmed(raw.matcher, MAX_MATCHER),
    hook,
    enabled: raw.enabled !== false
  }
}

export function coerceHookTestInput(raw: unknown): HookTestInput | null {
  if (!isRecord(raw)) return null
  if (!isWritableHookScope(raw.scope) || !isHookEvent(raw.event)) return null
  const hook = coerceHookEntry(raw.hook)
  if (!hook) return null
  return {
    scope: raw.scope,
    cwd: typeof raw.cwd === 'string' ? raw.cwd.slice(0, 4096) : '',
    event: raw.event,
    matcher: trimmed(raw.matcher, MAX_MATCHER),
    hook
  }
}

/** 列表里的标题：命令 / 提示词 / URL / server.tool */
export function hookSummary(hook: HookEntry): string {
  if (hook.type === 'command') {
    const h = hook as CommandHook
    return h.command || (h.args ?? []).join(' ')
  }
  if (hook.type === 'prompt' || hook.type === 'agent') {
    return (hook as PromptHook | AgentHook).prompt
  }
  if (hook.type === 'http') return (hook as HttpHook).url
  if (hook.type === 'mcp_tool') {
    const h = hook as McpToolHook
    return `${h.server}.${h.tool}`
  }
  return ''
}
