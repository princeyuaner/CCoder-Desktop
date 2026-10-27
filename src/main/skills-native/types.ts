import type { SkillListResult, SkillMutationResult } from '../../shared/skills'

/**
 * 技能适配器的显式路径上下文。
 *
 * 不在这里读 homedir/env/electron —— index.ts 解析好路径传进来，
 * 测试用临时目录构造，不会碰真实用户配置。
 */
export interface SkillNativeContext {
  /** ~/.claude（尊重 CLAUDE_CONFIG_DIR） */
  claudeDir: string
  /** $CODEX_HOME，默认 ~/.codex */
  codexHome: string
  /** 用户 home，用于共享 DSH 目录 ~/.dsh */
  homeDir: string
  /** 允许写入的 DSH_HOME 列表 */
  dshHomes: string[]
  /** userData/skills-backups */
  backupRoot: string
}

export interface SkillQuery {
  /** Claude 项目级技能与工作区定位 */
  cwd: string
  /** DSH 选中的 home；为空时用 context 的第一个 */
  dshHome?: string
}

export interface SkillListOptions {
  dshHome?: string
}

/** manifest 的实际位置；enabled=false 时文件名带 .disabled */
export interface ManifestLocation {
  /** 技能目录（Codex 为文件所在目录） */
  dir: string
  /** manifest 绝对路径 */
  file: string
  /** 不含 .disabled 的文件名 */
  manifest: string
  enabled: boolean
}

export type NativeMutationResult = SkillMutationResult
export type NativeListResult = SkillListResult
