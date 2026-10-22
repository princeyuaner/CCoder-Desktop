import type { PermissionMode } from './events'

/**
 * 渠道（channel）= 一个 API 端点 + 凭据 + 模型。
 *
 * 存在的理由：Claude Code CLI 不必"登录"—— 只要给它
 * `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`，它就把请求打到那个端点。
 * 实测确认：不设这两个变量时报 `Not logged in`，设了就直接打到端点
 * （假 key 会拿到端点真实的 401）。所以"渠道配置"的本质就是环境变量注入。
 */

/**
 * 渠道说的协议。**由所属 CLI 决定**，不是用户在表单里挑的 ——
 * Claude Code 只会说 Anthropic 协议，Codex 只会说 OpenAI 协议。
 * 'openai' 目前还没有适配器去消费，先把位置占住，免得以后改数据格式。
 */
export type ChannelKind = 'anthropic' | 'openai'

export const PROTOCOL_LABEL: Record<ChannelKind, string> = {
  anthropic: 'Anthropic 兼容',
  openai: 'OpenAI 兼容'
}

/**
 * 凭据怎么发。这个区分很要命，选错会一直 401：
 * - 'token' → `Authorization: Bearer <key>`（多数中转网关）
 * - 'key'   → `x-api-key: <key>`（Anthropic 官方与部分网关）
 */
export type AuthMode = 'token' | 'key'

export interface EnvVar {
  key: string
  value: string
}

export interface Channel {
  id: string
  name: string
  kind: ChannelKind
  /** 例：https://api.deepseek.com/anthropic （末尾不带 /） */
  baseUrl: string
  model: string
  /**
   * 这个端点还能用哪些模型。会话里的模型选择器就列这些。
   * `model` 是默认的那个（选择器里标「默认」并置顶），这里放其余候选。
   * 可以为空 —— 那就只有默认模型 + 手动输入。
   */
  models: string[]
  /** 后台小任务用的快模型，留空则不注入 */
  smallFastModel: string
  authMode: AuthMode
  authToken: string
  /** 该渠道独有的额外环境变量，原样注入 CLI */
  extraEnv: EnvVar[]
}

/* ── 思考深度 ──────────────────────────────────────────────── */

/**
 * CLI 的 `--effort` 档位 —— 也就是"思考深度"。
 *
 * 实测本机 `claude --help`：`--effort <level>  Effort level for the current session
 * (low, medium, high, xhigh, max)`，二进制里另有 `MAX_THINKING_TOKENS` 与
 * `CLAUDE_CODE_EFFORT_LEVEL` 两个环境变量。所以这是个**真实存在**的启动参数，
 * 不是我们自己编的档位。
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高'
}

export const EFFORT_HINT: Record<EffortLevel, string> = {
  low: '直接答，几乎不推演。最快、最省。',
  medium: 'CLI 默认档。日常改动的平衡点。',
  high: '动代码之前先推演一遍。',
  xhigh: '多步推理，慢但稳，留给重构和排查。',
  max: '吃满预算。最慢最贵，留给硬骨头。'
}

/**
 * `medium` 就是 CLI 的默认档 —— 选中它时**不传 `--effort`**（见 buildClaudeArgs）。
 * 这样"没动过这个设置"的用户发出的命令行跟以前一字不差，
 * 也不会给不认这个字段的中转端点添麻烦。
 */
export const DEFAULT_EFFORT: EffortLevel = 'medium'

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as string[]).includes(v)
}

/* ── 外观与交互 ────────────────────────────────────────────── */

/** 主题。system = 跟随操作系统的深色/浅色偏好 */
export type ThemeMode = 'dark' | 'light' | 'system'

export const THEME_LABEL: Record<ThemeMode, string> = {
  dark: '深色',
  light: '浅色',
  system: '跟随系统'
}

/** 新消息的发送快捷键。enter = Enter 发送；ctrlEnter = Ctrl/Cmd+Enter 发送 */
export type SendKey = 'enter' | 'ctrlEnter'

export const SEND_KEY_LABEL: Record<SendKey, string> = {
  enter: 'Enter 发送，Shift+Enter 换行',
  ctrlEnter: 'Ctrl/Cmd+Enter 发送，Enter 换行'
}

/** 工具调用在对话里的显示方式 */
export type ToolDetail = 'full' | 'compact' | 'hidden'

export const TOOL_DETAIL_LABEL: Record<ToolDetail, string> = {
  full: '完整 —— 一行摘要，可展开命令与输出',
  compact: '精简 —— 只保留一行摘要，不展开',
  hidden: '隐藏 —— 不在对话里显示（轨迹页仍可查看）'
}

/** 界面可选的字体栈。存的是完整 CSS font-family，自定义字体也能直接落盘 */
export interface FontPreset {
  label: string
  value: string
}

export const UI_FONT_PRESETS: FontPreset[] = [
  {
    label: '系统默认',
    value: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif"
  },
  {
    label: '微软雅黑',
    value: "'Microsoft YaHei UI', 'Microsoft YaHei', system-ui, sans-serif"
  },
  {
    label: 'Segoe UI',
    value: "'Segoe UI', system-ui, 'Microsoft YaHei', sans-serif"
  },
  {
    label: '苹方 / 思源黑体',
    value: "'PingFang SC', 'Noto Sans SC', 'Source Han Sans SC', 'Microsoft YaHei', sans-serif"
  }
]

export const MONO_FONT_PRESETS: FontPreset[] = [
  {
    label: 'JetBrains Mono',
    value: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace"
  },
  {
    label: 'Cascadia Code',
    value: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace"
  },
  {
    label: 'Consolas',
    value: "Consolas, 'Cascadia Mono', monospace"
  },
  {
    label: '系统等宽',
    value: "ui-monospace, 'SF Mono', 'Cascadia Mono', Consolas, monospace"
  }
]

export const DEFAULT_UI_FONT = UI_FONT_PRESETS[0].value
export const DEFAULT_MONO_FONT = MONO_FONT_PRESETS[0].value

/** 界面缩放档位。1 = 100% */
export const UI_ZOOM_LEVELS = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const

/** 对话正文字号（px） */
export const CHAT_FONT_SIZES = [12, 13, 14, 15, 16, 17, 18] as const

export function clampZoom(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 1
  return Math.min(1.5, Math.max(0.75, Math.round(n * 100) / 100))
}

export function clampChatFontSize(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 14
  return Math.min(20, Math.max(11, Math.round(n)))
}

/* ── CLI 维度 ──────────────────────────────────────────────── */

/**
 * 支持的编程 CLI。
 *
 * 关键设计：**渠道挂在 CLI 下面，不是一个全局列表**。
 * Claude Code 走 Anthropic 兼容端点、Codex 走 OpenAI 兼容端点，
 * 两者的 baseUrl / 密钥 / 模型没有任何理由共用 —— 早先做成全局列表，
 * 结果是换个 CLI 就得把渠道全部重填一遍。
 */
export type CliId = 'claude' | 'codex'

export interface CliDef {
  id: CliId
  name: string
  /** 这个 CLI 说的协议 —— 它下面的渠道一律是这个协议 */
  protocol: ChannelKind
  /** 适配器写好了没。没写好的只能先把渠道存着，不能真的建会话。 */
  ready: boolean
}

export const CLIS: CliDef[] = [
  { id: 'claude', name: 'Claude Code', protocol: 'anthropic', ready: true },
  { id: 'codex', name: 'Codex CLI', protocol: 'openai', ready: false }
]

export const CLI_IDS: CliId[] = CLIS.map((c) => c.id)

export function cliDef(id: CliId): CliDef {
  return CLIS.find((c) => c.id === id) ?? CLIS[0]
}

/** 一个 CLI 的独立配置 */
export interface CliConfig {
  /** 停用后这个 CLI 不参与新建会话 */
  enabled: boolean
  activeChannelId: string | null
  channels: Channel[]
  /** 新会话默认的思考深度。会话里还能单独改，只影响那一条会话。 */
  effort: EffortLevel
}

export interface Settings {
  clis: Record<CliId, CliConfig>
  /** 新会话默认权限模式 */
  permissionMode: PermissionMode
  /** 新会话默认工作目录；空 = 沿用上次打开的目录 */
  defaultCwd: string
  /**
   * 侧栏里显示哪些工作区 —— **白名单**，只有用户手动打开过的目录。
   *
   * 不用黑名单的理由：`~/.claude/projects` 里躺着几百份会话、几十个目录，
   * 全是用户这些年随手 cd 过去跑过一次留下的。默认全铺出来，侧栏就成了一份
   * 文件系统索引，"我一直用的那三个项目"反而找不着了。
   *
   * 打开方式：右上角文件夹图标选目录。
   * **关闭 ≠ 删除** —— 只是从这份名单里去掉，磁盘上一个文件都没动。
   */
  openedCwds: string[]

  /* ── 外观 ───────────────────────────────────────────────── */
  theme: ThemeMode
  /** 界面缩放，1 = 100%（Electron 页面缩放，连布局一起放大） */
  uiZoom: number
  /** 对话正文字号（px）。代码块会跟着小一档 */
  chatFontSize: number
  /** 界面字体（完整 CSS font-family） */
  uiFont: string
  /** 代码 / 等宽字体（完整 CSS font-family） */
  monoFont: string

  /* ── 对话显示 ───────────────────────────────────────────── */
  /** 在用户消息下方显示发送时间 */
  showTimestamps: boolean
  /** 思考块默认展开 */
  thinkingOpen: boolean
  /** 工具调用的显示方式 */
  toolDetail: ToolDetail

  /* ── 输入 ───────────────────────────────────────────────── */
  /** 发送快捷键 */
  sendKey: SendKey
}

export function emptyCliConfig(id: CliId): CliConfig {
  // 没接入的 CLI 默认停用 —— 别给一个用不了的东西点亮着的开关
  return {
    enabled: cliDef(id).ready,
    activeChannelId: null,
    channels: [],
    effort: DEFAULT_EFFORT
  }
}

export function defaultSettings(): Settings {
  const clis = {} as Record<CliId, CliConfig>
  for (const id of CLI_IDS) clis[id] = emptyCliConfig(id)
  return {
    clis,
    permissionMode: 'standard',
    defaultCwd: '',
    openedCwds: [],
    // 默认保持深色：这个应用此前只有深色，升级后不该因为系统是浅色就突然变样
    theme: 'dark',
    uiZoom: 1,
    chatFontSize: 14,
    uiFont: DEFAULT_UI_FONT,
    monoFont: DEFAULT_MONO_FONT,
    showTimestamps: false,
    thinkingOpen: false,
    toolDetail: 'full',
    sendKey: 'enter'
  }
}

/** 取某个 CLI 的配置；缺字段时补一份空的，调用方不必到处判空 */
export function cliConfig(s: Settings, id: CliId): CliConfig {
  return s.clis?.[id] ?? emptyCliConfig(id)
}

/** 某个 CLI 当前在用的渠道 */
export function activeChannelOf(s: Settings, id: CliId): Channel | null {
  const c = cliConfig(s, id)
  return c.channels.find((x) => x.id === c.activeChannelId) ?? null
}

/** 老版本落盘的渠道没有 models 字段，读进来补一个空数组，免得界面上到处判空 */
export function normalizeChannel(c: Channel): Channel {
  return { ...c, models: Array.isArray(c.models) ? c.models : [] }
}

/** 把可能缺字段的数据补齐成完整 Settings（老版本落盘的文件就靠它兜底） */
export function normalizeSettings(raw: Partial<Settings> | null | undefined): Settings {
  const src = raw ?? {}
  const clis = {} as Record<CliId, CliConfig>
  for (const id of CLI_IDS) {
    const c = src.clis?.[id]
    clis[id] = {
      enabled: c?.enabled ?? cliDef(id).ready,
      activeChannelId: c?.activeChannelId ?? null,
      channels: Array.isArray(c?.channels) ? c.channels.map(normalizeChannel) : [],
      // 老版本落盘的配置没有 effort 字段 —— 补成默认档，别让它变成 undefined 混进命令行
      effort: isEffortLevel(c?.effort) ? c.effort : DEFAULT_EFFORT
    }
  }
  return {
    clis,
    permissionMode: src.permissionMode ?? 'standard',
    defaultCwd: src.defaultCwd ?? '',
    openedCwds: Array.isArray(src.openedCwds)
      ? src.openedCwds.filter((c) => typeof c === 'string')
      : [],
    // 老版本没有这几个字段 —— 一律回落到「保持原来的深色外观」
    theme: src.theme === 'light' || src.theme === 'system' ? src.theme : 'dark',
    uiZoom: clampZoom(src.uiZoom),
    chatFontSize: clampChatFontSize(src.chatFontSize),
    uiFont:
      typeof src.uiFont === 'string' && src.uiFont.trim() ? src.uiFont : DEFAULT_UI_FONT,
    monoFont:
      typeof src.monoFont === 'string' && src.monoFont.trim() ? src.monoFont : DEFAULT_MONO_FONT,
    showTimestamps: src.showTimestamps === true,
    thinkingOpen: src.thinkingOpen === true,
    toolDetail:
      src.toolDetail === 'compact' || src.toolDetail === 'hidden' ? src.toolDetail : 'full',
    sendKey: src.sendKey === 'ctrlEnter' ? 'ctrlEnter' : 'enter'
  }
}

export interface ChannelTestResult {
  ok: boolean
  /** 成功时是模型回话，失败时是 CLI/端点给的真实错误 */
  message: string
  latencyMs: number
}

export function newChannel(kind: ChannelKind = 'anthropic'): Channel {
  // crypto.randomUUID 只在安全上下文有；file:// 下不保证，故留兜底
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `ch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  return {
    id,
    name: '新渠道',
    kind,
    baseUrl: '',
    model: '',
    models: [],
    smallFastModel: '',
    authMode: 'token',
    authToken: '',
    extraEnv: []
  }
}


/**
 * 两个路径是不是同一个目录。
 *
 * 只统一分隔符和末尾斜杠 —— **不做大小写折叠**：Windows 上大小写不敏感，
 * 但 POSIX 上 `/Foo` 和 `/foo` 是两个目录，折叠了会误合并。
 */
export function sameCwd(a: string, b: string): boolean {
  const n = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  return n(a) === n(b)
}
