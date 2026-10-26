/**
 * 指令弹层的共享词汇。
 *
 * 这里只定义**数据形状**，不包含任何文案：CLI 上报的原生指令带的是
 * 原始 description（CLI 自己的语言），宿主动作的文案在渲染层的 i18n 里。
 */

/** 宿主能执行的动作。`none` 只用于暂未接入的占位项。 */
export type CommandAction =
  | 'clear'
  | 'compact'
  | 'model'
  | 'permissions'
  | 'effort'
  | 'status'
  | 'help'
  | 'plan'
  | 'insert'
  | 'none'

/**
 * 一个 CLI 原生指令。
 *
 * `run` 决定谁来执行：
 *  - `send`：把 `/name args` 当普通用户消息发给 CLI，由 CLI 自己分发
 *    （Claude Code 的 slash 指令走这条路）；
 *  - `app`：宿主自己处理（Codex / dsh 协议没暴露的指令只能这样映射）。
 */
export interface NativeCommand {
  /** 不含前导斜杠 */
  name: string
  /** 展示名，和 name 不同时才用（例如 Claude 的 "Debug Issue" → debug-issue） */
  label?: string
  /** CLI 给的原始描述，不做翻译 */
  description: string
  argumentHint?: string
  aliases?: string[]
  run: 'send' | 'app'
  action?: CommandAction
  /** action === 'insert' 时插入输入框的文本（例如 '@'） */
  insert?: string
  /** 弹层里的分组：普通指令 / 技能 */
  group: 'command' | 'skill'
}
