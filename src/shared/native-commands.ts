import type { NativeCommand } from './commands'
import type { CliId } from './settings'

/**
 * 协议没有暴露指令表的 CLI —— 只放宿主**真能执行**的原生指令。
 *
 * 不在这里放 disabled 占位：点不动的条目只会制造“原生表”的错觉。
 *
 * 来源：
 *  - Codex 0.163 的 TUI slash 指令表（codex-rs/tui/src/slash_command.rs），
 *    取其中桌面端能映射出动作的几条；`compact` 由宿主动作直接走
 *    app-server 的 thread/compact/start，不在这里重复。
 *  - DeepSeek Harness 0.2.1-rc.2 的命令插件（dsh-command-* / dsh-permission-presets
 *    / dsh-plan-mode），取宿主能映射的两条。ACP 目前不广播指令表，
 *    `/compact`、`/goal`、`/feedback`、`/export` 无法经 ACP 执行，故不列。
 */
export const STATIC_NATIVE_COMMANDS: Partial<Record<CliId, NativeCommand[]>> = {
  codex: [
    {
      name: 'plan',
      description: 'Switch to Plan mode',
      run: 'app',
      action: 'plan',
      group: 'command'
    },
    {
      name: 'new',
      description: 'start a new chat during a conversation',
      run: 'app',
      action: 'clear',
      group: 'command'
    },
    {
      name: 'mention',
      description: 'mention a file',
      run: 'app',
      action: 'insert',
      insert: '@',
      group: 'command'
    }
  ],
  dsh: [
    {
      name: 'permission',
      description: 'Switch the permission preset (sandbox mode + approval policy)',
      run: 'app',
      action: 'permissions',
      group: 'command'
    },
    {
      name: 'plan',
      description: 'Enter or leave plan mode',
      run: 'app',
      action: 'plan',
      group: 'command'
    }
  ]
}
