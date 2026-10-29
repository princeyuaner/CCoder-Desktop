import type {
  HookEntry,
  HookEvent,
  HookView,
  HookWritableScope
} from '../../shared/hooks'

/**
 * Hooks 原生适配器的显式上下文。
 *
 * 和 MCP / Skills 一样，适配器不直接读 homedir / env / electron；
 * index.ts 解析好路径传进来，测试用临时目录构造即可。
 */
export interface HookNativeContext {
  /** ~/.claude（尊重 CLAUDE_CONFIG_DIR） */
  claudeDir: string
  /** userData/hooks-backups */
  backupRoot: string
  /** userData/hooks-disabled.json */
  disabledPath: string
}

/** 应用侧禁用的 Hook：真正从 settings.json 移除，启用时再写回 */
export interface DisabledHook {
  id: string
  scope: HookWritableScope
  event: HookEvent
  matcher: string
  hook: HookEntry
  sourceFile: string
  /** user 作用域为空；project / local 记录工作区 */
  cwd: string
  disabledAt: number
}

/** 在某个 settings 文件里定位到的一条 Hook */
export interface LocatedHook {
  view: HookView
  file: string
  matcherIndex: number
  hookIndex: number
  disabledEntry?: DisabledHook
}

export interface HookReadResult {
  hooks: LocatedHook[]
  error?: string
  exists: boolean
}
