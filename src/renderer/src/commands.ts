/**
 * 输入框里 `/` 弹出的系统指令。
 *
 * 只放**应用能真正处理**的指令；CLI 端才认识的指令明确标 disabled，
 * 不装作能用。`action` 由 Composer 负责翻译成具体动作。
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
  /** 列表里显示的中文名 */
  label: string
  /** 一行摘要 */
  description: string
  /** 右侧详情 */
  detail: string
  group: string
  action: CommandAction
  /** 需要额外确认/知道的风险提示 */
  warning?: string
  /** 暂未接入 */
  disabled?: boolean
  /** 额外搜索词 */
  keywords?: string[]
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: '/clear',
    label: '清空当前对话',
    description: '清空转写并重开一条 CLI 会话',
    detail:
      '清空当前会话的转写记录与上下文，界面回到空白状态。CLI 磁盘上的会话记录不会被删除。',
    group: '会话',
    action: 'clear',
    warning: '这一步不可撤销。如果想保留记录，请先复制需要的内容或新开一条会话。',
    keywords: ['clear', '新会话', '重置']
  },
  {
    name: '/compact',
    label: '压缩上下文',
    description: '请 CLI 压缩当前会话上下文',
    detail:
      '把当前会话交给 CLI 的上下文压缩流程，保留关键信息、腾出上下文窗口。是否支持取决于当前 CLI 版本。',
    group: '会话',
    action: 'compact',
    keywords: ['compact', '压缩', '上下文']
  },
  {
    name: '/model',
    label: '切换模型',
    description: '打开模型选择器',
    detail: '打开输入框底部的模型选择器。换模型会重启 CLI 进程并用 --resume 接回当前会话，上下文不丢。',
    group: '模型与权限',
    action: 'model',
    keywords: ['model', '模型']
  },
  {
    name: '/permissions',
    label: '切换权限模式',
    description: '打开权限模式选择器',
    detail: '在标准 / 接受编辑 / 自动 / 计划等模式之间切换。改完和换模型一样会重启进程并 --resume 接回。',
    group: '模型与权限',
    action: 'permissions',
    keywords: ['permissions', '权限', '审批']
  },
  {
    name: '/effort',
    label: '调整思考深度',
    description: '打开思考深度滑轨',
    detail: '调整本会话的 --effort 档位。档位越高，模型在动代码前推演得越多，也越慢越贵。',
    group: '模型与权限',
    action: 'effort',
    keywords: ['effort', '思考', '深度']
  },
  {
    name: '/status',
    label: '查看会话状态',
    description: '模型 / 权限 / 思考深度 / 轮数',
    detail: '在输入框上方显示当前会话的模型、权限模式、思考深度、轮数和步数。',
    group: '系统',
    action: 'status',
    keywords: ['status', '状态', '信息']
  },
  {
    name: '/help',
    label: '查看全部指令',
    description: '重新列出所有系统指令',
    detail: '把输入框重置为 / 并重新列出全部指令。',
    group: '系统',
    action: 'help',
    keywords: ['help', '帮助', '指令']
  },
  {
    name: '/resume',
    label: '恢复一条会话',
    description: '从侧栏的已有会话继续',
    detail: '当前版本请直接在侧栏点一条已有会话；这里暂不提供会话选择器。',
    group: '系统',
    action: 'none',
    disabled: true,
    keywords: ['resume', '恢复', '会话']
  },
  {
    name: '/doctor',
    label: '诊断 CLI 环境',
    description: '检查 CLI 安装与渠道配置',
    detail: '当前版本请先在终端运行 claude doctor。应用内的诊断面板还没接入。',
    group: '系统',
    action: 'none',
    disabled: true,
    keywords: ['doctor', '诊断', '环境']
  }
]

/** 按 `/` 后面的内容过滤；空查询返回全部 */
export function filterCommands(query: string): SlashCommand[] {
  const q = query.trim().toLowerCase()
  if (!q) return SLASH_COMMANDS
  return SLASH_COMMANDS.filter((c) => {
    const hay = [c.name, c.label, c.description, ...(c.keywords ?? [])]
      .join(' ')
      .toLowerCase()
    return hay.includes(q)
  })
}
