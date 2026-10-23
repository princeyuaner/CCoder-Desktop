import type { MessageKey } from '@shared/i18n'

/**
 * 输入框里 `/` 弹出的系统指令。
 *
 * 只放**应用能真正处理**的指令；CLI 端才认识的指令明确标 disabled，
 * 不装作能用。`action` 由 Composer 负责翻译成具体动作。
 *
 * 展示文案存 key，渲染时按当前语言解析；`keywords` 保留中英文两份，
 * 这样两种界面语言下的 `/` 搜索都能命中。
 */
export type CommandAction =
  | 'clear'
  | 'compact'
  | 'model'
  | 'permissions'
  | 'effort'
  | 'status'
  | 'help'
  | 'none'

export interface SlashCommand {
  /** 带斜杠，如 /clear */
  name: string
  labelKey: MessageKey
  descriptionKey: MessageKey
  detailKey: MessageKey
  groupKey: MessageKey
  action: CommandAction
  warningKey?: MessageKey
  /** 暂未接入 */
  disabled?: boolean
  /** 额外搜索词（中英文都放） */
  keywords?: string[]
}

export const SLASH_COMMANDS: SlashCommand[] = [
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

/** 按 `/` 后面的内容过滤；空查询返回全部。t 用来把 key 解析成当前语言。 */
export function filterCommands(
  query: string,
  t: (key: MessageKey) => string
): SlashCommand[] {
  const q = query.trim().toLowerCase()
  if (!q) return SLASH_COMMANDS
  return SLASH_COMMANDS.filter((c) => {
    const hay = [
      c.name,
      t(c.labelKey),
      t(c.descriptionKey),
      t(c.groupKey),
      ...(c.keywords ?? [])
    ]
      .join(' ')
      .toLowerCase()
    return hay.includes(q)
  })
}
