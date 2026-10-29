import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HookNativeContext } from './types'

export * from './types'
export * from './claude'
export * from './test'

/**
 * 解析 Claude 配置目录。
 *
 * 和 MCP / Skills 保持一致：优先 CLAUDE_CONFIG_DIR，否则 ~/.claude。
 * backupRoot / disabledPath 由 index.ts 从 app.getPath('userData') 传进来。
 */
export function createHookNativeContext(opts: {
  backupRoot: string
  disabledPath: string
  claudeDir?: string
}): HookNativeContext {
  const env = process.env.CLAUDE_CONFIG_DIR?.trim()
  return {
    claudeDir: opts.claudeDir?.trim() || env || join(homedir(), '.claude'),
    backupRoot: opts.backupRoot,
    disabledPath: opts.disabledPath
  }
}
