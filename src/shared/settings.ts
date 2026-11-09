import type { PermissionMode } from './events'
import {
  DEFAULT_LANGUAGE,
  isLanguageSetting,
  type LanguageSetting
} from './i18n/locale'
import type { MessageKey } from './i18n/catalog'
import { normalizeKeybindings, type KeybindingOverrides } from './keybindings'
import {
  DEFAULT_VOICE_SETTINGS,
  normalizeVoiceSettings,
  type VoiceSettings
} from './voice'

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
 * Claude Code 只会说 Anthropic 协议，Codex 只会说 OpenAI 协议，
 * DeepSeek Harness 则由它自己的适配器读 DEEPSEEK_BASE_URL / KEY。
 */
export type ChannelKind = 'anthropic' | 'openai' | 'deepseek'

export const PROTOCOL_LABEL_KEY: Record<ChannelKind, MessageKey> = {
  anthropic: 'protocol.anthropic',
  openai: 'protocol.openai',
  deepseek: 'protocol.deepseek'
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
   * 可以为空 —— 那就只有默认模型。
   */
  models: string[]
  /** 后台小任务用的快模型，留空则不注入（仅 Anthropic 渠道使用） */
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
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Codex 多一档 Ultra（会主动委派子任务），Claude Code 没有这一档 */
export const CODEX_EFFORT_LEVELS: EffortLevel[] = [...EFFORT_LEVELS, 'ultra']

export function effortLevelsFor(cli: CliId): EffortLevel[] {
  return cli === 'codex' ? CODEX_EFFORT_LEVELS : EFFORT_LEVELS
}

export const EFFORT_LABEL_KEY: Record<EffortLevel, MessageKey> = {
  low: 'effort.low',
  medium: 'effort.medium',
  high: 'effort.high',
  xhigh: 'effort.xhigh',
  max: 'effort.max',
  ultra: 'effort.ultra'
}

export const EFFORT_HINT_KEY: Record<EffortLevel, MessageKey> = {
  low: 'effortHint.low',
  medium: 'effortHint.medium',
  high: 'effortHint.high',
  xhigh: 'effortHint.xhigh',
  max: 'effortHint.max',
  ultra: 'effortHint.ultra'
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

/**
 * 主题。system = 跟随操作系统的深色/浅色偏好。
 *
 * 除了最初的两套（dark / light），其余都是在这两套的骨架上换调色板：
 * data-theme 决定 tokens.css 里用哪一组变量，data-scheme 决定组件级覆盖
 * （theme-light.css / ide.css 末尾）是否生效。浅色主题必须同时有
 * THEME_SCHEME = 'light'，否则会拿到为深色写的组件样式。
 */
export type ThemeMode =
  | 'dark'
  | 'midnight'
  | 'forest'
  | 'mist'
  | 'coffee'
  | 'moss'
  | 'starfield'
  | 'aurora'
  | 'ember'
  | 'abyss'
  | 'sakura'
  | 'prism'
  | 'contrast'
  | 'light'
  | 'paper'
  | 'frost'
  | 'mint'
  | 'lavender'
  | 'rose'
  | 'sandstone'
  | 'sepia'
  | 'glacier'
  | 'system'

/**
 * 带氛围背景层的主题。
 *
 * 这类主题除了换调色板，还会在窗口底层挂一张全屏背景（极光 / 火星 / 深海 /
 * 落樱 / 虹彩 / 冰川）。渲染层把当前主题写进 `<html data-ambient>`，
 * AmbientBackground 据此绘制；其余主题不挂这个属性，和原来完全一样。
 */
export const AMBIENT_THEMES = [
  'aurora',
  'ember',
  'abyss',
  'sakura',
  'prism',
  'glacier'
] as const

export type AmbientTheme = (typeof AMBIENT_THEMES)[number]

export function isAmbientTheme(v: unknown): v is AmbientTheme {
  return typeof v === 'string' && (AMBIENT_THEMES as readonly string[]).includes(v)
}

/** 主题的明暗底色。纯视觉主题都归入 dark / light 两个 scheme */
export type ThemeScheme = 'dark' | 'light'

export const THEME_SCHEME: Record<Exclude<ThemeMode, 'system'>, ThemeScheme> = {
  dark: 'dark',
  midnight: 'dark',
  forest: 'dark',
  mist: 'dark',
  coffee: 'dark',
  moss: 'dark',
  starfield: 'dark',
  aurora: 'dark',
  ember: 'dark',
  abyss: 'dark',
  sakura: 'dark',
  prism: 'dark',
  contrast: 'dark',
  light: 'light',
  paper: 'light',
  frost: 'light',
  mint: 'light',
  lavender: 'light',
  rose: 'light',
  sandstone: 'light',
  sepia: 'light',
  glacier: 'light'
}

export const THEME_LABEL_KEY: Record<ThemeMode, MessageKey> = {
  dark: 'theme.dark',
  midnight: 'theme.midnight',
  forest: 'theme.forest',
  mist: 'theme.mist',
  coffee: 'theme.coffee',
  moss: 'theme.moss',
  starfield: 'theme.starfield',
  aurora: 'theme.aurora',
  ember: 'theme.ember',
  abyss: 'theme.abyss',
  sakura: 'theme.sakura',
  prism: 'theme.prism',
  contrast: 'theme.contrast',
  light: 'theme.light',
  paper: 'theme.paper',
  frost: 'theme.frost',
  mint: 'theme.mint',
  lavender: 'theme.lavender',
  rose: 'theme.rose',
  sandstone: 'theme.sandstone',
  sepia: 'theme.sepia',
  glacier: 'theme.glacier',
  system: 'theme.system'
}

export const THEME_GROUPS: { labelKey: MessageKey; themes: ThemeMode[] }[] = [
  {
    labelKey: 'theme.group.dark',
    themes: [
      'dark',
      'midnight',
      'forest',
      'mist',
      'coffee',
      'moss',
      'starfield',
      'aurora',
      'ember',
      'abyss',
      'sakura',
      'prism',
      'contrast'
    ]
  },
  {
    labelKey: 'theme.group.light',
    themes: ['light', 'paper', 'frost', 'mint', 'lavender', 'rose', 'sandstone', 'sepia', 'glacier']
  },
  { labelKey: 'theme.group.other', themes: ['system'] }
]

/** 合法的主题值。**不要用 label map 的 key 做校验**：label 本地化后它会变 */
export const THEME_MODES: ThemeMode[] = [
  'dark',
  'midnight',
  'forest',
  'mist',
  'coffee',
  'moss',
  'starfield',
  'aurora',
  'ember',
  'abyss',
  'sakura',
  'prism',
  'contrast',
  'light',
  'paper',
  'frost',
  'mint',
  'lavender',
  'rose',
  'sandstone',
  'sepia',
  'glacier',
  'system'
]

export function isThemeMode(v: unknown): v is ThemeMode {
  return typeof v === 'string' && (THEME_MODES as string[]).includes(v)
}

/* ── 界面语言 ──────────────────────────────────────────────── */

export const LANGUAGE_LABEL_KEY: Record<LanguageSetting, MessageKey> = {
  zh: 'language.zh',
  en: 'language.en',
  system: 'language.system'
}

/** 跟随系统时用系统偏好解析；显式主题原样返回 */
export function resolveThemeMode(
  mode: ThemeMode,
  systemPrefersDark: boolean
): Exclude<ThemeMode, 'system'> {
  return mode === 'system' ? (systemPrefersDark ? 'dark' : 'light') : mode
}

/** 窗口底色。主进程用它给 BrowserWindow 上色，避免页面渲染前闪一下 */
export const THEME_BG: Record<Exclude<ThemeMode, 'system'>, string> = {
  dark: '#191919',
  midnight: '#0c141f',
  forest: '#0f1612',
  mist: '#232833',
  coffee: '#1b1713',
  moss: '#171a19',
  starfield: '#04070f',
  aurora: '#04100f',
  ember: '#0c0806',
  abyss: '#020b14',
  sakura: '#0d0712',
  prism: '#09090f',
  contrast: '#000000',
  light: '#f6f6f7',
  paper: '#ffffff',
  frost: '#f3f6fa',
  mint: '#f2f7f4',
  lavender: '#f7f5fb',
  rose: '#faf5f6',
  sandstone: '#f6f3ee',
  sepia: '#f3eee3',
  glacier: '#e0ebf7'
}

/** 新消息的发送快捷键。enter = Enter 发送；ctrlEnter = Ctrl/Cmd+Enter 发送 */
export type SendKey = 'enter' | 'ctrlEnter'

export const SEND_KEY_LABEL_KEY: Record<SendKey, MessageKey> = {
  enter: 'sendKey.enter',
  ctrlEnter: 'sendKey.ctrlEnter'
}

/** 工具调用在对话里的显示方式 */
export type ToolDetail = 'full' | 'compact' | 'hidden'

export const TOOL_DETAIL_LABEL_KEY: Record<ToolDetail, MessageKey> = {
  full: 'toolDetail.full',
  compact: 'toolDetail.compact',
  hidden: 'toolDetail.hidden'
}

/* ── 内置 IDE 编辑器 ─────────────────────────────────────── */

/** 自动换行的三种状态：关 / 按窗口宽度 / 按固定列宽 */
export type EditorWordWrap = 'off' | 'on' | 'bounded'

export const EDITOR_WORD_WRAP_LABEL_KEY: Record<EditorWordWrap, MessageKey> = {
  off: 'editor.wordWrap.off',
  on: 'editor.wordWrap.on',
  bounded: 'editor.wordWrap.bounded'
}

/**
 * 自动保存。`afterDelay` 是停止输入后延迟保存；`onFocusChange` 是窗口
 * 失焦时保存（切到终端 / 浏览器回来时通常更符合直觉）。
 */
export type EditorAutoSave = 'off' | 'afterDelay' | 'onFocusChange'

export const EDITOR_AUTO_SAVE_LABEL_KEY: Record<EditorAutoSave, MessageKey> = {
  off: 'editor.autoSave.off',
  afterDelay: 'editor.autoSave.afterDelay',
  onFocusChange: 'editor.autoSave.onFocusChange'
}

/** 光标形状 */
export type EditorCursorStyle =
  | 'line'
  | 'line-thin'
  | 'block'
  | 'block-outline'
  | 'underline'
  | 'underline-thin'

export const EDITOR_CURSOR_STYLE_LABEL_KEY: Record<EditorCursorStyle, MessageKey> = {
  line: 'editor.cursorStyle.line',
  'line-thin': 'editor.cursorStyle.lineThin',
  block: 'editor.cursorStyle.block',
  'block-outline': 'editor.cursorStyle.blockOutline',
  underline: 'editor.cursorStyle.underline',
  'underline-thin': 'editor.cursorStyle.underlineThin'
}

/** 光标闪烁方式 */
export type EditorCursorBlinking = 'blink' | 'smooth' | 'phase' | 'expand' | 'solid'

export const EDITOR_CURSOR_BLINKING_LABEL_KEY: Record<EditorCursorBlinking, MessageKey> = {
  blink: 'editor.cursorBlinking.blink',
  smooth: 'editor.cursorBlinking.smooth',
  phase: 'editor.cursorBlinking.phase',
  expand: 'editor.cursorBlinking.expand',
  solid: 'editor.cursorBlinking.solid'
}

/** 光标移动动画。explicit 只对方向键等显式移动生效 */
export type EditorCursorSmooth = 'off' | 'on' | 'explicit'

export const EDITOR_CURSOR_SMOOTH_LABEL_KEY: Record<EditorCursorSmooth, MessageKey> = {
  off: 'editor.cursorSmooth.off',
  on: 'editor.cursorSmooth.on',
  explicit: 'editor.cursorSmooth.explicit'
}

/** 当前行怎么高亮 */
export type EditorLineHighlight = 'none' | 'gutter' | 'line' | 'all'

export const EDITOR_LINE_HIGHLIGHT_LABEL_KEY: Record<EditorLineHighlight, MessageKey> = {
  none: 'editor.lineHighlight.none',
  gutter: 'editor.lineHighlight.gutter',
  line: 'editor.lineHighlight.line',
  all: 'editor.lineHighlight.all'
}

/** 空白字符渲染范围 */
export type EditorWhitespace = 'none' | 'selection' | 'trailing' | 'all'

export const EDITOR_WHITESPACE_LABEL_KEY: Record<EditorWhitespace, MessageKey> = {
  none: 'editor.whitespace.none',
  selection: 'editor.whitespace.selection',
  trailing: 'editor.whitespace.trailing',
  all: 'editor.whitespace.all'
}

/** 行号显示方式 */
export type EditorLineNumbers = 'on' | 'off' | 'relative'

export const EDITOR_LINE_NUMBERS_LABEL_KEY: Record<EditorLineNumbers, MessageKey> = {
  on: 'editor.lineNumbers.on',
  off: 'editor.lineNumbers.off',
  relative: 'editor.lineNumbers.relative'
}

/**
 * IDE 编辑器的可配置项。
 *
 * 之前这些全部写死在 MonacoEditor 里，用户换不了字号 / 制表符 / 换行方式。
 * 这里集中成一份可落盘的配置，主窗口和每个 IDE 窗口都读同一份。
 */
export interface LanguageEditorSettings {
  /** 该语言下按空格插入时的一级缩进列宽 */
  tabSize: number
  insertSpaces: boolean
}

export interface EditorSettings {
  /** 字号（px） */
  fontSize: number
  /** 字体栈；空字符串表示跟随主设置里的「代码字体」 */
  fontFamily: string
  /** 连字（JetBrains Mono / Fira Code 一类字体） */
  fontLigatures: boolean
  /** 行高倍数（相对字号） */
  lineHeight: number
  /** 字距（px） */
  letterSpacing: number
  /** 一个 tab 的列宽 */
  tabSize: number
  /** true = 插入空格，false = 插入制表符 */
  insertSpaces: boolean
  /** 自动换行 */
  wordWrap: EditorWordWrap
  /** 按固定列宽换行时的列数 */
  wordWrapColumn: number
  /** 光标形状 */
  cursorStyle: EditorCursorStyle
  /** 光标闪烁方式 */
  cursorBlinking: EditorCursorBlinking
  /** 光标移动动画 */
  cursorSmoothCaretAnimation: EditorCursorSmooth
  /** 当前行高亮 */
  renderLineHighlight: EditorLineHighlight
  /** 空白字符渲染范围 */
  renderWhitespace: EditorWhitespace
  /** 是否显示控制字符 */
  renderControlCharacters: boolean
  /** 行号显示方式 */
  lineNumbers: EditorLineNumbers
  /** 缩进参考线 */
  indentationGuides: boolean
  /** 括号对参考线 */
  bracketPairGuides: boolean
  /** 列标尺；0 = 关闭 */
  rulers: number
  /** 平滑滚动 */
  smoothScrolling: boolean
  /** Ctrl + 滚轮缩放字号 */
  mouseWheelZoom: boolean
  /** 代码缩略图 */
  minimap: boolean
  /** 滚动时把外层符号钉在顶部 */
  stickyScroll: boolean
  /** 终端字号（px） */
  terminalFontSize: number
  /** 终端行高倍数 */
  terminalLineHeight: number
  /** 保存前先跑一次格式化（有语言服务 / 内置格式化器时） */
  formatOnSave: boolean
  /** 自动保存策略 */
  autoSave: EditorAutoSave
  /** afterDelay 策略下的防抖时间（ms） */
  autoSaveDelayMs: number
  /** 保存时去掉行尾空白 */
  trimTrailingWhitespace: boolean
  /** 打开 / 切换文件时在资源管理器里自动展开并定位 */
  autoRevealInExplorer: boolean
  /**
   * 按语言覆盖缩进（key 是 Monaco 语言 id）。
   * 优先级低于文件所在目录的 `.editorconfig`，高于全局设置。
   */
  languages: Record<string, LanguageEditorSettings>
}

export const EDITOR_FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24] as const
export const EDITOR_TAB_SIZES = [2, 3, 4, 8] as const
export const EDITOR_AUTO_SAVE_DELAYS = [500, 1000, 2000, 5000] as const
export const EDITOR_LINE_HEIGHTS = [1.2, 1.35, 1.5, 1.55, 1.7, 1.85, 2] as const
export const EDITOR_LETTER_SPACINGS = [-1, -0.5, 0, 0.5, 1, 1.5, 2] as const
export const EDITOR_TERMINAL_LINE_HEIGHTS = [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6] as const
/** 列标尺的合法范围；0 表示关闭 */
export const EDITOR_RULERS_MAX = 400

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  fontSize: 12,
  fontFamily: '',
  fontLigatures: false,
  lineHeight: 1.55,
  letterSpacing: 0,
  tabSize: 2,
  insertSpaces: true,
  wordWrap: 'off',
  wordWrapColumn: 100,
  cursorStyle: 'line',
  cursorBlinking: 'smooth',
  cursorSmoothCaretAnimation: 'off',
  renderLineHighlight: 'all',
  renderWhitespace: 'selection',
  renderControlCharacters: false,
  lineNumbers: 'on',
  indentationGuides: true,
  bracketPairGuides: false,
  rulers: 0,
  smoothScrolling: false,
  mouseWheelZoom: false,
  minimap: true,
  stickyScroll: true,
  terminalFontSize: 12,
  terminalLineHeight: 1.2,
  formatOnSave: false,
  autoSave: 'off',
  autoSaveDelayMs: 1000,
  trimTrailingWhitespace: false,
  autoRevealInExplorer: true,
  languages: {}
}

export function clampEditorFontSize(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 12
  const clamped = Math.min(24, Math.max(10, n))
  return EDITOR_FONT_SIZES.reduce(
    (best, option) => (Math.abs(option - clamped) < Math.abs(best - clamped) ? option : best),
    EDITOR_FONT_SIZES[0] as number
  )
}

export function clampEditorTabSize(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 2
  const clamped = Math.min(8, Math.max(2, n))
  return EDITOR_TAB_SIZES.reduce(
    (best, option) => (Math.abs(option - clamped) < Math.abs(best - clamped) ? option : best),
    EDITOR_TAB_SIZES[0] as number
  )
}

export function clampAutoSaveDelay(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 1000
  const clamped = Math.min(30_000, Math.max(300, n))
  // 设置页只列固定几档；落到档位中间的值会让 select 显示空白
  return EDITOR_AUTO_SAVE_DELAYS.reduce(
    (best, option) => (Math.abs(option - clamped) < Math.abs(best - clamped) ? option : best),
    EDITOR_AUTO_SAVE_DELAYS[0] as number
  )
}

function nearestOption(value: number, options: readonly number[]): number {
  return options.reduce(
    (best, option) => (Math.abs(option - value) < Math.abs(best - value) ? option : best),
    options[0] as number
  )
}

export function clampEditorLineHeight(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_EDITOR_SETTINGS.lineHeight
  return nearestOption(Math.min(2, Math.max(1, n)), EDITOR_LINE_HEIGHTS)
}

export function clampEditorLetterSpacing(v: unknown): number {
  const n =
    typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_EDITOR_SETTINGS.letterSpacing
  return nearestOption(Math.min(2, Math.max(-1, n)), EDITOR_LETTER_SPACINGS)
}

export function clampEditorWrapColumn(v: unknown): number {
  const n =
    typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : DEFAULT_EDITOR_SETTINGS.wordWrapColumn
  return Math.min(300, Math.max(20, n))
}

export function clampEditorRulers(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  const n = Math.round(v)
  if (n <= 0) return 0
  return Math.min(EDITOR_RULERS_MAX, Math.max(20, n))
}

export function clampTerminalLineHeight(v: unknown): number {
  const n =
    typeof v === 'number' && Number.isFinite(v)
      ? v
      : DEFAULT_EDITOR_SETTINGS.terminalLineHeight
  return nearestOption(Math.min(2, Math.max(1, n)), EDITOR_TERMINAL_LINE_HEIGHTS)
}

/**
 * 字体栈直接进 CSS，过滤控制字符和会截断声明块的符号。
 * 空字符串保留「跟随全局」的语义。
 */
export function normalizeEditorFontFamily(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[\u0000-\u001f\u007f<>{};]/g, '')
    .trim()
    .slice(0, 200)
}

function isChoice<T extends string>(value: unknown, labels: Record<T, MessageKey>): value is T {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(labels, value)
}

export function isEditorCursorStyle(v: unknown): v is EditorCursorStyle {
  return isChoice(v, EDITOR_CURSOR_STYLE_LABEL_KEY)
}

export function isEditorCursorBlinking(v: unknown): v is EditorCursorBlinking {
  return isChoice(v, EDITOR_CURSOR_BLINKING_LABEL_KEY)
}

export function isEditorCursorSmooth(v: unknown): v is EditorCursorSmooth {
  return isChoice(v, EDITOR_CURSOR_SMOOTH_LABEL_KEY)
}

export function isEditorLineHighlight(v: unknown): v is EditorLineHighlight {
  return isChoice(v, EDITOR_LINE_HIGHLIGHT_LABEL_KEY)
}

export function isEditorWhitespace(v: unknown): v is EditorWhitespace {
  return isChoice(v, EDITOR_WHITESPACE_LABEL_KEY)
}

export function isEditorLineNumbers(v: unknown): v is EditorLineNumbers {
  return isChoice(v, EDITOR_LINE_NUMBERS_LABEL_KEY)
}

export function isEditorWordWrap(v: unknown): v is EditorWordWrap {
  return v === 'off' || v === 'on' || v === 'bounded'
}

export function isEditorAutoSave(v: unknown): v is EditorAutoSave {
  return v === 'off' || v === 'afterDelay' || v === 'onFocusChange'
}

function normalizeLanguageSettings(
  raw: unknown
): Record<string, LanguageEditorSettings> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, LanguageEditorSettings> = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    // 语言 id 由 Monaco 提供，只接受短字符串；上限防止一份坏设置撑爆界面
    if (typeof id !== 'string' || !id || id.length > 64) continue
    if (!value || typeof value !== 'object') continue
    const item = value as Partial<LanguageEditorSettings>
    out[id] = {
      tabSize: clampEditorTabSize(item.tabSize),
      insertSpaces: item.insertSpaces !== false
    }
    if (Object.keys(out).length >= 64) break
  }
  return out
}

export function normalizeEditorSettings(raw: Partial<EditorSettings> | null | undefined): EditorSettings {
  const src = raw ?? {}
  const fontSize = clampEditorFontSize(src.fontSize)
  return {
    fontSize,
    fontFamily: normalizeEditorFontFamily(src.fontFamily),
    fontLigatures: src.fontLigatures === true,
    lineHeight: clampEditorLineHeight(src.lineHeight),
    letterSpacing: clampEditorLetterSpacing(src.letterSpacing),
    tabSize: clampEditorTabSize(src.tabSize),
    insertSpaces: src.insertSpaces !== false,
    wordWrap: isEditorWordWrap(src.wordWrap) ? src.wordWrap : DEFAULT_EDITOR_SETTINGS.wordWrap,
    wordWrapColumn: clampEditorWrapColumn(src.wordWrapColumn),
    cursorStyle: isEditorCursorStyle(src.cursorStyle)
      ? src.cursorStyle
      : DEFAULT_EDITOR_SETTINGS.cursorStyle,
    cursorBlinking: isEditorCursorBlinking(src.cursorBlinking)
      ? src.cursorBlinking
      : DEFAULT_EDITOR_SETTINGS.cursorBlinking,
    cursorSmoothCaretAnimation: isEditorCursorSmooth(src.cursorSmoothCaretAnimation)
      ? src.cursorSmoothCaretAnimation
      : DEFAULT_EDITOR_SETTINGS.cursorSmoothCaretAnimation,
    renderLineHighlight: isEditorLineHighlight(src.renderLineHighlight)
      ? src.renderLineHighlight
      : DEFAULT_EDITOR_SETTINGS.renderLineHighlight,
    renderWhitespace: isEditorWhitespace(src.renderWhitespace)
      ? src.renderWhitespace
      : DEFAULT_EDITOR_SETTINGS.renderWhitespace,
    renderControlCharacters: src.renderControlCharacters === true,
    lineNumbers: isEditorLineNumbers(src.lineNumbers)
      ? src.lineNumbers
      : DEFAULT_EDITOR_SETTINGS.lineNumbers,
    indentationGuides: src.indentationGuides !== false,
    bracketPairGuides: src.bracketPairGuides === true,
    rulers: clampEditorRulers(src.rulers),
    smoothScrolling: src.smoothScrolling === true,
    mouseWheelZoom: src.mouseWheelZoom === true,
    minimap: src.minimap !== false,
    stickyScroll: src.stickyScroll !== false,
    // 老版本终端字号跟随编辑器字号；没有这个字段时保持原来的表现
    terminalFontSize:
      src.terminalFontSize === undefined ? fontSize : clampEditorFontSize(src.terminalFontSize),
    terminalLineHeight: clampTerminalLineHeight(src.terminalLineHeight),
    formatOnSave: src.formatOnSave === true,
    autoSave: isEditorAutoSave(src.autoSave) ? src.autoSave : DEFAULT_EDITOR_SETTINGS.autoSave,
    autoSaveDelayMs: clampAutoSaveDelay(src.autoSaveDelayMs),
    trimTrailingWhitespace: src.trimTrailingWhitespace === true,
    autoRevealInExplorer: src.autoRevealInExplorer !== false,
    languages: normalizeLanguageSettings(src.languages)
  }
}

/* ── 语言服务器 ─────────────────────────────────────────── */

/**
 * 语言服务器（LSP）设置。
 *
 * 目前只有总开关：服务器从**项目 node_modules / node_modules/.bin /
 * PATH** 自动探测，不内置二进制，也不让用户填任意命令 —— 那个入口
 * 等于把工作区里的配置文件变成执行命令，等有 workspace trust 再说。
 */
export interface LspSettings {
  enabled: boolean
}

export const DEFAULT_LSP_SETTINGS: LspSettings = {
  enabled: true
}

export function normalizeLspSettings(
  raw: Partial<LspSettings> | null | undefined
): LspSettings {
  return { enabled: raw?.enabled !== false }
}

export const DEFAULT_CLI_UPDATE_PREFS: CliUpdatePrefs = {
  autoCheck: true,
  tagInNav: true
}

/** 老版本落盘的设置没有这个字段 —— 补成「开着」，这是更有用的默认值 */
export function normalizeCliUpdatePrefs(
  raw: Partial<CliUpdatePrefs> | null | undefined
): CliUpdatePrefs {
  return {
    autoCheck: raw?.autoCheck !== false,
    tagInNav: raw?.tagInNav !== false
  }
}

/** 界面可选的字体栈。存的是完整 CSS font-family，自定义字体也能直接落盘 */
export interface FontPreset {
  labelKey: MessageKey
  value: string
}

export const UI_FONT_PRESETS: FontPreset[] = [
  {
    labelKey: 'font.system',
    value: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif"
  },
  {
    labelKey: 'font.yahei',
    value: "'Microsoft YaHei UI', 'Microsoft YaHei', system-ui, sans-serif"
  },
  {
    labelKey: 'font.segoe',
    value: "'Segoe UI', system-ui, 'Microsoft YaHei', sans-serif"
  },
  {
    labelKey: 'font.pingfang',
    value: "'PingFang SC', 'Noto Sans SC', 'Source Han Sans SC', 'Microsoft YaHei', sans-serif"
  }
]

export const MONO_FONT_PRESETS: FontPreset[] = [
  {
    labelKey: 'font.mono.jetbrains',
    value: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace"
  },
  {
    labelKey: 'font.mono.cascadia',
    value: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace"
  },
  {
    labelKey: 'font.mono.consolas',
    value: "Consolas, 'Cascadia Mono', monospace"
  },
  {
    labelKey: 'font.mono.system',
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
export type CliId = 'claude' | 'codex' | 'dsh'

/**
 * DeepSeek Harness 新会话使用的默认模型。
 *
 * 0.2.1 的内置目录把 V4.1 Flash 的 id 写成 `deepseek-flash`，但网关已经把这个
 * id 下线，只认 `deepseek-v4.1-flash`（请求会回 `Model ... has been deprecated`）。
 * 应用启动 dsh 时会用 patch 覆盖模型目录（见 providers/dsh/runner.ts），这里
 * 必须和 patch 里的 id 保持一致。
 */
export const DSH_DEFAULT_MODEL = 'deepseek-v4.1-flash'

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
  { id: 'codex', name: 'Codex CLI', protocol: 'openai', ready: true },
  { id: 'dsh', name: 'DeepSeek Harness', protocol: 'deepseek', ready: true }
]

export const CLI_IDS: CliId[] = CLIS.map((c) => c.id)

export function cliDef(id: CliId): CliDef {
  return CLIS.find((c) => c.id === id) ?? CLIS[0]
}

/**
 * 凭据来源。
 *
 * - `channel`：API Key / 中转端点，走「渠道」那套配置（原来的唯一方式）。
 * - `official`：用 CLI 自己保存的官方登录（OAuth），不注入任何渠道环境变量。
 *
 * 只有 Claude Code 在界面上暴露这个切换；Codex 仍然用"Base URL 留空"
 * 表示它自己的登录。
 */
export type CliAuthMode = 'channel' | 'official'

export const AUTH_MODE_LABEL_KEY: Record<CliAuthMode, MessageKey> = {
  channel: 'authMode.channel',
  official: 'authMode.official'
}

export function isCliAuthMode(v: unknown): v is CliAuthMode {
  return v === 'channel' || v === 'official'
}

/** 一个 CLI 的独立配置 */
export interface CliConfig {
  /** 停用后这个 CLI 不参与新建会话 */
  enabled: boolean
  activeChannelId: string | null
  channels: Channel[]
  /** 新会话默认的思考深度。会话里还能单独改，只影响那一条会话。 */
  effort: EffortLevel
  /** 凭据来源。旧版本落盘的配置没有这个字段，读进来一律按 channel 处理。 */
  authMode: CliAuthMode
  /** 官方登录模式下的默认模型；空 = 由 CLI 自己决定 */
  officialModel: string
}

/**
 * CLI 更新检查的偏好。
 *
 * 只影响「什么时候去问 npm registry」和「要不要在导航上打标记」，
 * 不涉及是否自动安装 —— 安装永远由用户点按钮触发。
 */
export interface CliUpdatePrefs {
  /** 打开设置页 / 每 6 小时自动检查一次 */
  autoCheck: boolean
  /** 有新版本时在设置导航的 CLI 名称旁显示「可更新」 */
  tagInNav: boolean
}

export interface Settings {
  clis: Record<CliId, CliConfig>
  /**
   * 界面语言。system = 跟随操作系统语言（启动 / 保存时解析）。
   * 默认 system；老版本落盘没有这个字段时也回落到 system。
   */
  language: LanguageSetting
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
  /** 语音输入：服务商、凭据、插入方式 */
  voice: VoiceSettings

  /* ── 提醒 ───────────────────────────────────────────────── */
  /**
   * 一轮跑完时弹系统通知。
   *
   * 只在这一轮不是用户当前正看着的会话、或者窗口没在前台时才真的会弹 ——
   * 否则用户就在屏幕前看着它出字，通知是噪音。判断在主进程做（它才知道
   * 哪个窗口在前台），这里只是总开关。
   */
  notifyOnDone: boolean

  /* ── 内置 IDE ───────────────────────────────────────────── */
  /** 编辑器偏好；独立 IDE 窗口与主窗口共享同一份 */
  editor: EditorSettings
  /**
   * IDE 快捷键覆盖项（commandId → 组合键 / null=解绑）。
   * 只存和默认值不同的项，默认值见 shared/keybindings.ts。
   */
  keybindings: KeybindingOverrides
  /** 语言服务器总开关；关闭后只用 Monaco 自带的 worker */
  lsp: LspSettings
  /** CLI 更新检查 */
  cliUpdate: CliUpdatePrefs
}

export function emptyCliConfig(id: CliId): CliConfig {
  // 没接入的 CLI 默认停用 —— 别给一个用不了的东西点亮着的开关
  return {
    enabled: cliDef(id).ready,
    activeChannelId: null,
    channels: [],
    effort: DEFAULT_EFFORT,
    // dsh 的 official = 用它自己 DSH_HOME 里的凭据；用户已经在终端里配过，
    // 默认走这条，不要逼他再抄一份 key 到渠道里
    authMode: id === 'dsh' ? 'official' : 'channel',
    officialModel: id === 'dsh' ? DSH_DEFAULT_MODEL : ''
  }
}

export function defaultSettings(): Settings {
  const clis = {} as Record<CliId, CliConfig>
  for (const id of CLI_IDS) clis[id] = emptyCliConfig(id)
  return {
    clis,
    language: DEFAULT_LANGUAGE,
    permissionMode: 'standard',
    defaultCwd: '',
    openedCwds: [],
    // 默认高对比：深色底 + 更亮的文字/边框，长时间读代码更稳
    theme: 'contrast',
    uiZoom: 1,
    chatFontSize: 14,
    uiFont: DEFAULT_UI_FONT,
    monoFont: DEFAULT_MONO_FONT,
    showTimestamps: false,
    thinkingOpen: false,
    toolDetail: 'full',
    sendKey: 'enter',
    // 默认开：输入框里能看到麦克风，点一次才知道要先去设置里填免费 Key。
    // 真的没配 Key 时录音前会给出可操作的错误，不会静默失败。
    voice: { ...DEFAULT_VOICE_SETTINGS },
    notifyOnDone: true,
    editor: { ...DEFAULT_EDITOR_SETTINGS },
    keybindings: {},
    lsp: { ...DEFAULT_LSP_SETTINGS },
    cliUpdate: { ...DEFAULT_CLI_UPDATE_PREFS }
  }
}

/**
 * 取某个 CLI 的配置；缺字段时合并默认值，调用方不必到处判空。
 *
 * 不能只在整条缺失时回落：旧版本 / 截图桩 / 手写的测试数据可能只给了
 * `channels`，没有 `effort`。那样 `EFFORT_HINT_KEY[cfg.effort]` 会拿到
 * undefined，翻译层直接崩掉。这里逐字段兜底。
 */
export function cliConfig(s: Settings, id: CliId): CliConfig {
  const empty = emptyCliConfig(id)
  const cur = s.clis?.[id]
  if (!cur) return empty
  return {
    ...empty,
    ...cur,
    channels: Array.isArray(cur.channels) ? cur.channels : empty.channels
  }
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
      effort: isEffortLevel(c?.effort) ? c.effort : DEFAULT_EFFORT,
      // 老版本没有凭据来源，保持原来的渠道行为
      authMode: isCliAuthMode(c?.authMode) ? c.authMode : 'channel',
      officialModel: typeof c?.officialModel === 'string' ? c.officialModel : ''
    }
  }
  return {
    clis,
    language: isLanguageSetting(src.language) ? src.language : DEFAULT_LANGUAGE,
    permissionMode: src.permissionMode ?? 'standard',
    defaultCwd: src.defaultCwd ?? '',
    openedCwds: Array.isArray(src.openedCwds)
      ? src.openedCwds.filter((c) => typeof c === 'string')
      : [],
    // 老版本没有这几个字段 —— 一律回落到「保持原来的深色外观」
    theme: isThemeMode(src.theme) ? src.theme : 'contrast',
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
    sendKey: src.sendKey === 'ctrlEnter' ? 'ctrlEnter' : 'enter',
    voice: normalizeVoiceSettings(src.voice),
    // 老版本没有这个字段 —— 补成「开着」，这是更有用的默认值
    notifyOnDone: src.notifyOnDone !== false,
    editor: normalizeEditorSettings(src.editor),
    keybindings: normalizeKeybindings(src.keybindings),
    lsp: normalizeLspSettings(src.lsp),
    cliUpdate: normalizeCliUpdatePrefs(src.cliUpdate)
  }
}

export interface ChannelTestResult {
  ok: boolean
  /** 成功时是模型回话，失败时是 CLI/端点给的真实错误 */
  message: string
  latencyMs: number
}

export function newChannel(kind: ChannelKind = 'anthropic', name = ''): Channel {
  // crypto.randomUUID 只在安全上下文有；file:// 下不保证，故留兜底
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `ch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  return {
    id,
    name,
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
