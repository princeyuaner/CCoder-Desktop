import type { MessageKey } from './i18n/catalog'

/**
 * IDE 快捷键命令表与按键匹配工具。
 *
 * 设置里只落盘「和默认值不同」的覆盖项，默认值集中在这里；IDE 窗口和
 * 设置页共用同一份定义，避免两边各写一套 commandId。
 */

export type KeybindingCommandGroup = 'file' | 'edit' | 'view' | 'nav'

export interface KeybindingCommand {
  id: string
  labelKey: MessageKey
  group: KeybindingCommandGroup
  /** null = 默认没有快捷键 */
  defaultBinding: string | null
}

export const KEYBINDING_GROUP_ORDER: KeybindingCommandGroup[] = [
  'file',
  'edit',
  'view',
  'nav'
]

export const KEYBINDING_GROUP_LABEL_KEY: Record<KeybindingCommandGroup, MessageKey> = {
  file: 'ide.command.group.file',
  edit: 'ide.command.group.edit',
  view: 'ide.command.group.view',
  nav: 'ide.command.group.nav'
}

/**
 * 顺序也是按键冲突时的优先级：同一组合键绑了两条命令，排在前面的先响应
 * （设置页会同时给出冲突提示）。
 */
export const KEYBINDING_COMMANDS: KeybindingCommand[] = [
  // 文件
  { id: 'file.save', labelKey: 'ide.command.save', group: 'file', defaultBinding: 'Ctrl+S' },
  {
    id: 'file.saveAll',
    labelKey: 'ide.command.saveAll',
    group: 'file',
    defaultBinding: 'Ctrl+Shift+S'
  },
  {
    id: 'file.quickOpen',
    labelKey: 'ide.command.quickOpen',
    group: 'file',
    defaultBinding: 'Ctrl+P'
  },
  {
    id: 'file.closeTab',
    labelKey: 'ide.command.closeTab',
    group: 'file',
    defaultBinding: 'Ctrl+W'
  },
  {
    id: 'file.reopenTab',
    labelKey: 'ide.command.reopenTab',
    group: 'file',
    defaultBinding: 'Ctrl+Shift+T'
  },
  { id: 'file.newFile', labelKey: 'ide.command.newFile', group: 'file', defaultBinding: null },
  {
    id: 'file.newFolder',
    labelKey: 'ide.command.newFolder',
    group: 'file',
    defaultBinding: null
  },
  {
    id: 'file.revealInExplorer',
    labelKey: 'ide.command.revealInExplorer',
    group: 'file',
    defaultBinding: 'Ctrl+Shift+E'
  },
  {
    id: 'file.openContainingFolder',
    labelKey: 'ide.command.openContainingFolder',
    group: 'file',
    defaultBinding: 'Shift+Alt+R'
  },
  { id: 'explorer.rename', labelKey: 'ide.command.rename', group: 'file', defaultBinding: 'F2' },
  {
    id: 'explorer.delete',
    labelKey: 'ide.command.delete',
    group: 'file',
    defaultBinding: 'Delete'
  },

  // 编辑
  {
    id: 'search.workspace',
    labelKey: 'ide.command.search',
    group: 'edit',
    defaultBinding: 'Ctrl+Shift+F'
  },
  { id: 'edit.format', labelKey: 'ide.command.format', group: 'edit', defaultBinding: 'Shift+Alt+F' },

  // 导航
  {
    id: 'nav.goToLine',
    labelKey: 'ide.command.goToLine',
    group: 'nav',
    defaultBinding: 'Ctrl+G'
  },
  {
    id: 'nav.goToSymbol',
    labelKey: 'ide.command.goToSymbol',
    group: 'nav',
    defaultBinding: 'Ctrl+Shift+O'
  },
  {
    id: 'nav.goToWorkspaceSymbol',
    labelKey: 'ide.command.goToWorkspaceSymbol',
    group: 'nav',
    defaultBinding: 'Ctrl+T'
  },
  {
    id: 'nav.quickFix',
    labelKey: 'ide.command.quickFix',
    group: 'nav',
    defaultBinding: 'Ctrl+.'
  },
  {
    id: 'nav.goToDeclaration',
    labelKey: 'ide.command.goToDeclaration',
    group: 'nav',
    defaultBinding: null
  },
  {
    id: 'nav.goToImplementation',
    labelKey: 'ide.command.goToImplementation',
    group: 'nav',
    defaultBinding: 'Ctrl+F12'
  },
  {
    id: 'nav.goToTypeDefinition',
    labelKey: 'ide.command.goToTypeDefinition',
    group: 'nav',
    defaultBinding: null
  },
  {
    id: 'nav.signatureHelp',
    labelKey: 'ide.command.signatureHelp',
    group: 'nav',
    defaultBinding: null
  },
  {
    id: 'nav.back',
    labelKey: 'ide.command.navBack',
    group: 'nav',
    defaultBinding: 'Alt+ArrowLeft'
  },
  {
    id: 'nav.forward',
    labelKey: 'ide.command.navForward',
    group: 'nav',
    defaultBinding: 'Alt+ArrowRight'
  },

  // 视图
  {
    id: 'view.settings',
    labelKey: 'ide.command.settings',
    group: 'view',
    // Ctrl+, 是通用的「设置」入口，打开快捷键 / 编辑器设置弹窗
    defaultBinding: 'Ctrl+,'
  },
  {
    id: 'view.commandPalette',
    labelKey: 'ide.command.title',
    group: 'view',
    defaultBinding: 'Ctrl+Shift+P'
  },
  {
    id: 'view.toggleSidebar',
    labelKey: 'ide.command.toggleSidebar',
    group: 'view',
    defaultBinding: 'Ctrl+B'
  },
  {
    id: 'view.toggleProblems',
    labelKey: 'ide.command.toggleProblems',
    group: 'view',
    defaultBinding: 'Ctrl+Shift+M'
  },
  {
    id: 'view.toggleTerminal',
    labelKey: 'ide.command.toggleTerminal',
    group: 'view',
    defaultBinding: 'Ctrl+`'
  },
  {
    id: 'view.closePanel',
    labelKey: 'ide.command.closePanel',
    group: 'view',
    defaultBinding: null
  },
  { id: 'view.refresh', labelKey: 'ide.command.refresh', group: 'view', defaultBinding: null },
  { id: 'tab.next', labelKey: 'ide.command.tabNext', group: 'view', defaultBinding: 'Ctrl+Tab' },
  {
    id: 'tab.prev',
    labelKey: 'ide.command.tabPrev',
    group: 'view',
    defaultBinding: 'Ctrl+Shift+Tab'
  }
]

export type KeybindingOverrides = Record<string, string | null>

const DEFAULT_BY_ID: Record<string, string | null> = Object.fromEntries(
  KEYBINDING_COMMANDS.map((c) => [c.id, c.defaultBinding])
)

const COMMAND_IDS = new Set(KEYBINDING_COMMANDS.map((c) => c.id))

export function defaultBindingOf(id: string): string | null {
  return DEFAULT_BY_ID[id] ?? null
}

/** 修饰键的几种写法都认；Ctrl 统一表示「平台主修饰键」（mac 上按 Cmd 也能触发） */
const MODIFIER_ALIASES: Record<string, 'ctrl' | 'shift' | 'alt' | 'meta'> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  cmd: 'ctrl',
  command: 'ctrl',
  mod: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  meta: 'meta',
  win: 'meta',
  super: 'meta'
}

const KEY_ALIASES: Record<string, string> = {
  left: 'ArrowLeft',
  arrowleft: 'ArrowLeft',
  right: 'ArrowRight',
  arrowright: 'ArrowRight',
  up: 'ArrowUp',
  arrowup: 'ArrowUp',
  down: 'ArrowDown',
  arrowdown: 'ArrowDown',
  esc: 'Escape',
  escape: 'Escape',
  return: 'Enter',
  enter: 'Enter',
  space: 'Space',
  spacebar: 'Space',
  plus: 'Plus',
  '+': 'Plus',
  del: 'Delete',
  delete: 'Delete',
  backspace: 'Backspace',
  ins: 'Insert',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  tab: 'Tab'
}

const NAMED_KEYS: Record<string, string> = {
  tab: 'Tab',
  enter: 'Enter',
  escape: 'Escape',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight'
}

/** 面板里按键的显示形式（内部仍然用 ArrowLeft 这种规范名） */
const KEY_DISPLAY: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Plus: '+',
  Escape: 'Esc'
}

export interface ParsedBinding {
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  key: string
}

function canonicalKey(raw: string): string | null {
  if (!raw) return null
  const lower = raw.toLowerCase()
  const alias = KEY_ALIASES[lower]
  if (alias) return alias
  if (raw.length === 1) {
    // 字母统一成大写，Shift 按下时 e.key 给的是大写、没按时是小写
    return /[a-z]/i.test(raw) ? raw.toUpperCase() : raw
  }
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase()
  return NAMED_KEYS[lower] ?? null
}

/** 单个可打印字符（含空格 / 回车）不适合单独当全局快捷键，会吞掉正常输入 */
function isBarePrintable(key: string): boolean {
  return key.length === 1 || key === 'Plus' || key === 'Space' || key === 'Enter'
}

export function parseBinding(binding: string): ParsedBinding | null {
  const parts = binding
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return null

  const parsed: ParsedBinding = { ctrl: false, shift: false, alt: false, meta: false, key: '' }
  for (const part of parts) {
    const mod = MODIFIER_ALIASES[part.toLowerCase()]
    if (mod) {
      parsed[mod] = true
      continue
    }
    if (parsed.key) return null
    const key = canonicalKey(part)
    if (!key) return null
    parsed.key = key
  }
  return parsed.key ? parsed : null
}

function serialize(parsed: ParsedBinding, display: boolean): string {
  const parts: string[] = []
  if (parsed.ctrl) parts.push('Ctrl')
  if (parsed.shift) parts.push('Shift')
  if (parsed.alt) parts.push('Alt')
  if (parsed.meta) parts.push('Meta')
  parts.push(display ? (KEY_DISPLAY[parsed.key] ?? parsed.key) : parsed.key)
  return parts.join('+')
}

/** 规范化为落盘格式；非法组合（例如单独一个字母）返回 null */
export function normalizeBinding(binding: string): string | null {
  const parsed = parseBinding(binding)
  if (!parsed) return null
  if (!parsed.ctrl && !parsed.alt && !parsed.meta && isBarePrintable(parsed.key)) return null
  return serialize(parsed, false)
}

/** 界面显示形式：Alt+ArrowLeft → Alt+← */
export function formatBinding(binding: string | null | undefined): string {
  if (!binding) return ''
  const parsed = parseBinding(binding)
  return parsed ? serialize(parsed, true) : binding
}

/** 只认这四个字段，主进程 / 渲染层共用，避免依赖 DOM 的 KeyboardEvent 类型 */
export interface KeyEventLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * 把一次按键转成落盘用的组合键。
 * - 只按修饰键 / 单独的可打印字符 → null（调用方继续等待）
 * - Meta（mac 的 Cmd）折叠成 Ctrl，和 IDE 里「Ctrl 或 Cmd」的旧行为一致
 */
export function acceleratorFromEvent(e: KeyEventLike): string | null {
  const key = canonicalKey(e.key)
  if (!key) return null
  const ctrl = e.ctrlKey || e.metaKey
  if (!ctrl && !e.altKey && isBarePrintable(key)) return null
  return serialize(
    { ctrl, shift: e.shiftKey, alt: e.altKey, meta: false, key },
    false
  )
}

export function matchBinding(
  binding: string | null | undefined,
  e: KeyEventLike
): boolean {
  if (!binding) return false
  const parsed = parseBinding(binding)
  if (!parsed) return false
  if (!parsed.ctrl && !parsed.alt && !parsed.meta && isBarePrintable(parsed.key)) return false

  const eventMod = e.ctrlKey || e.metaKey
  if (parsed.ctrl) {
    if (!eventMod) return false
  } else if (parsed.meta) {
    if (!e.metaKey || e.ctrlKey) return false
  } else if (eventMod) {
    return false
  }

  if (parsed.shift !== e.shiftKey) return false
  if (parsed.alt !== e.altKey) return false
  return canonicalKey(e.key) === parsed.key
}

/** 默认值 + 用户覆盖 → 每条命令当前生效的组合键 */
export function resolveKeybindings(
  overrides: KeybindingOverrides | null | undefined
): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const c of KEYBINDING_COMMANDS) out[c.id] = c.defaultBinding
  if (overrides) {
    for (const [id, value] of Object.entries(overrides)) {
      if (COMMAND_IDS.has(id)) out[id] = value
    }
  }
  return out
}

/**
 * 读取落盘数据：丢弃未知命令和非法组合键，并且只保留「与默认值不同」的项。
 * 这样以后调整默认快捷键时，没改过的用户会自动跟着更新。
 */
export function normalizeKeybindings(raw: unknown): KeybindingOverrides {
  const out: KeybindingOverrides = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out

  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!COMMAND_IDS.has(id)) continue
    const fallback = defaultBindingOf(id)
    if (value === null) {
      if (fallback !== null) out[id] = null
      continue
    }
    if (typeof value !== 'string') continue
    const normalized = normalizeBinding(value)
    if (!normalized) continue
    if (fallback && normalizeBinding(fallback) === normalized) continue
    out[id] = normalized
  }
  return out
}

/** 找出同一组合键绑了多条命令的情况；返回 commandId → 冲突的其它命令 */
export function keybindingConflicts(
  resolved: Record<string, string | null>
): Record<string, string[]> {
  const byBinding = new Map<string, string[]>()
  for (const c of KEYBINDING_COMMANDS) {
    const binding = resolved[c.id]
    if (!binding) continue
    const normalized = normalizeBinding(binding)
    if (!normalized) continue
    const list = byBinding.get(normalized) ?? []
    list.push(c.id)
    byBinding.set(normalized, list)
  }

  const out: Record<string, string[]> = {}
  for (const ids of byBinding.values()) {
    if (ids.length < 2) continue
    for (const id of ids) out[id] = ids.filter((x) => x !== id)
  }
  return out
}
