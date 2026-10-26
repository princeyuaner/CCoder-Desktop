import type { CommandAction, NativeCommand } from '@shared/commands'
import { STATIC_NATIVE_COMMANDS } from '@shared/native-commands'
import { cliDef, type CliId } from '@shared/settings'
import type { MessageKey } from '@shared/i18n'

/**
 * 输入框里 `/` 弹出的指令。
 *
 * 两类来源合成一张表：
 *  - CCoder 自己的系统指令（文案走 i18n，排在前面）；
 *  - 当前 CLI 的原生指令（Claude 动态上报；Codex / dsh 用可执行静态子集）。
 *
 * 同名指令以 CCoder 版本优先 —— 它能打开宿主的选择器，比直接发给
 * CLI 更好用；`alias` 也参与去重，避免 `/clear` 和 `/new` 同时出现。
 */
export interface PopupCommand {
  /** 带斜杠，如 /clear */
  name: string
  /** 搜索/展示用的别名（CCoder 的 label，原生指令的展示名） */
  label?: string
  description: string
  detail?: string
  /** 已翻译的分组标题 */
  group: string
  action?: CommandAction
  /** send = 把 /name args 发给 CLI；app = 宿主动作 */
  run: 'send' | 'app'
  /** action === 'insert' 时插入的文本 */
  insert?: string
  argumentHint?: string
  /** 暂未接入 */
  disabled?: boolean
  warning?: string
  /** 额外搜索词 */
  keywords?: string[]
  source: 'app' | 'cli'
  kind: 'app' | 'command' | 'skill'
  /** 原生指令的图标；CCoder 指令由 commandGlyph 的 switch 决定 */
  glyph?: string
}

interface AppCommandDef {
  name: string
  labelKey: MessageKey
  descriptionKey: MessageKey
  detailKey: MessageKey
  groupKey: MessageKey
  action: CommandAction
  warningKey?: MessageKey
  disabled?: boolean
  keywords?: string[]
}

const APP_COMMANDS: AppCommandDef[] = [
  {
    name: '/clear',
    labelKey: 'commands.clear.label',
    descriptionKey: 'commands.clear.description',
    detailKey: 'commands.clear.detail',
    groupKey: 'commands.group.session',
    action: 'clear',
    warningKey: 'commands.clear.warning',
    keywords: ['clear', 'reset', 'new', '新会话', '重置', '清空']
  },
  {
    name: '/compact',
    labelKey: 'commands.compact.label',
    descriptionKey: 'commands.compact.description',
    detailKey: 'commands.compact.detail',
    groupKey: 'commands.group.session',
    action: 'compact',
    keywords: ['compact', 'context', '压缩', '上下文']
  },
  {
    name: '/model',
    labelKey: 'commands.model.label',
    descriptionKey: 'commands.model.description',
    detailKey: 'commands.model.detail',
    groupKey: 'commands.group.modelPermissions',
    action: 'model',
    keywords: ['model', '模型']
  },
  {
    name: '/permissions',
    labelKey: 'commands.permissions.label',
    descriptionKey: 'commands.permissions.description',
    detailKey: 'commands.permissions.detail',
    groupKey: 'commands.group.modelPermissions',
    action: 'permissions',
    keywords: ['permissions', 'permission', 'approval', '权限', '审批']
  },
  {
    name: '/effort',
    labelKey: 'commands.effort.label',
    descriptionKey: 'commands.effort.description',
    detailKey: 'commands.effort.detail',
    groupKey: 'commands.group.modelPermissions',
    action: 'effort',
    keywords: ['effort', 'thinking', '思考', '深度']
  },
  {
    name: '/status',
    labelKey: 'commands.status.label',
    descriptionKey: 'commands.status.description',
    detailKey: 'commands.status.detail',
    groupKey: 'commands.group.system',
    action: 'status',
    keywords: ['status', 'info', '状态', '信息']
  },
  {
    name: '/help',
    labelKey: 'commands.help.label',
    descriptionKey: 'commands.help.description',
    detailKey: 'commands.help.detail',
    groupKey: 'commands.group.system',
    action: 'help',
    keywords: ['help', 'commands', '帮助', '指令']
  },
  {
    name: '/resume',
    labelKey: 'commands.resume.label',
    descriptionKey: 'commands.resume.description',
    detailKey: 'commands.resume.detail',
    groupKey: 'commands.group.system',
    action: 'none',
    disabled: true,
    keywords: ['resume', 'restore', '恢复', '会话']
  },
  {
    name: '/doctor',
    labelKey: 'commands.doctor.label',
    descriptionKey: 'commands.doctor.description',
    detailKey: 'commands.doctor.detail',
    groupKey: 'commands.group.system',
    action: 'none',
    disabled: true,
    keywords: ['doctor', 'diagnose', 'env', '诊断', '环境']
  }
]

/** 名字和 alias 全归一成小写、带前导斜杠，供去重使用 */
function commandKeys(n: { name: string; aliases?: string[] }): string[] {
  return [n.name, ...(n.aliases ?? [])]
    .map((s) => s.trim().replace(/^\/+/, '').toLowerCase())
    .filter(Boolean)
    .map((s) => `/${s}`)
}

function appCommands(t: (key: MessageKey) => string): PopupCommand[] {
  return APP_COMMANDS.map((c) => ({
    name: c.name,
    label: t(c.labelKey),
    description: t(c.descriptionKey),
    detail: t(c.detailKey),
    group: t(c.groupKey),
    action: c.action,
    run: 'app',
    ...(c.disabled ? { disabled: true } : {}),
    ...(c.warningKey ? { warning: t(c.warningKey) } : {}),
    ...(c.keywords ? { keywords: c.keywords } : {}),
    source: 'app',
    kind: 'app'
  }))
}

/**
 * 把 CLI 原生指令转成弹层条目。
 *
 * 返回 null 表示同名（或 alias 撞名）的指令已经存在 —— 先到先得，
 * CCoder 指令总是先占位。
 */
function nativeCommand(
  n: NativeCommand,
  t: (key: MessageKey) => string,
  cli: CliId,
  seen: Set<string>
): PopupCommand | null {
  const rawName = n.name.trim().replace(/^\/+/, '')
  if (!rawName) return null

  const keys = commandKeys(n)
  if (keys.length === 0 || keys.some((k) => seen.has(k))) return null
  for (const k of keys) seen.add(k)

  const name = `/${rawName}`
  return {
    name,
    ...(n.label && n.label !== n.name ? { label: n.label } : {}),
    description: n.description,
    detail: n.description,
    group: n.group === 'skill' ? t('commands.group.skills') : cliDef(cli).name,
    ...(n.action ? { action: n.action } : {}),
    run: n.run,
    ...(n.insert ? { insert: n.insert } : {}),
    ...(n.argumentHint ? { argumentHint: n.argumentHint } : {}),
    ...(n.aliases ? { keywords: n.aliases } : {}),
    source: 'cli',
    kind: n.group,
    glyph: n.group === 'skill' ? '✦' : '⌘'
  }
}

/**
 * 合成当前会话的完整指令表。
 *
 * 顺序很重要：弹层按**连续同名分组**画标题，所以原生指令必须先分区
 * （commands 全部在前、skills 全部在后），否则 Claude 返回的交错顺序
 * 会画出多个“Claude Code / 技能”标题。
 */
export function buildCommandItems(
  t: (key: MessageKey) => string,
  cli: CliId,
  native: NativeCommand[]
): PopupCommand[] {
  const app = appCommands(t)
  const seen = new Set<string>()
  for (const c of app) for (const k of commandKeys({ name: c.name })) seen.add(k)

  const merged: PopupCommand[] = []
  const allNative = [...native, ...(STATIC_NATIVE_COMMANDS[cli] ?? [])]
  for (const n of allNative) {
    const item = nativeCommand(n, t, cli, seen)
    if (item) merged.push(item)
  }

  return [
    ...app,
    ...merged.filter((c) => c.kind === 'command'),
    ...merged.filter((c) => c.kind === 'skill')
  ]
}

/** 按 `/` 后面的内容过滤；空查询返回全部。 */
export function filterCommands(items: PopupCommand[], query: string): PopupCommand[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter((c) => {
    const hay = [
      c.name,
      c.label,
      c.description,
      c.detail,
      c.group,
      c.argumentHint,
      ...(c.keywords ?? [])
    ]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .join(' ')
      .toLowerCase()
    return hay.includes(q)
  })
}
