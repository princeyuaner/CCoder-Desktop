import type { CliId } from './settings'

/**
 * Agent Skills / 自定义提示词。
 *
 * 三家 CLI 的原生形态差别很大：
 *  - Claude Code：`<skills>/<name>/SKILL.md`，frontmatter 带 description /
 *    allowed-tools / argument-hint / model；插件缓存里的技能只读。
 *  - Codex CLI：`~/.codex/prompts/<name>.md`，一个文件就是一条提示词，
 *    文件名就是斜杠命令，正文里用 `$ARGUMENTS` 接参数。
 *  - DeepSeek Harness：`<DSH_HOME>/skills/<name>/SKILL.md`，和 Claude 同形；
 *    另有一份所有 home 共享的 `~/.dsh/skills`。
 *
 * 启停一律通过文件系统实现（目录 / 文件加 `.disabled` 后缀），不往正文里
 * 写非标准字段 —— 这样 CLI 自己看到的就是干净的目录。
 */

export type SkillScope = 'global' | 'project' | 'plugin' | 'home' | 'shared'

export type SkillReadOnlyReason = 'plugin'

export type SkillWarningKey =
  | 'skill.warn.descriptionShort'
  | 'skill.warn.missingDescription'
  | 'skill.warn.invalidFrontmatter'
  | 'skill.warn.nameMismatch'
  | 'skill.warn.tooLarge'
  | 'skill.warn.unreadable'

export interface SkillWarning {
  key: SkillWarningKey
  detail?: string
}

export interface SkillResource {
  /** 相对技能目录的路径，统一用 `/`；Codex 是单个文件名 */
  path: string
  size: number
  dir: boolean
  modifiedAt: number
}

export interface SkillFrontmatter {
  present: boolean
  name: string
  description: string
  allowedTools: string[]
  argumentHint: string
  model: string
  version: string
  /** 原样保留的未知字段，编辑时写回 */
  extras: Record<string, unknown>
  /** YAML 解析失败时的原话（不阻止读取，只标记） */
  error: string
}

export interface SkillView {
  /** 稳定 id，由 cli + 来源 + 位置 + 名称生成，只用于定位和 React key */
  id: string
  cli: CliId
  /** 目录名 / 文件名，也就是斜杠命令名 */
  name: string
  /** 界面展示名（frontmatter.name，缺省等于 name） */
  displayName: string
  description: string
  scope: SkillScope
  enabled: boolean
  readOnly: boolean
  readOnlyReason: SkillReadOnlyReason | null
  /** manifest 的绝对路径 */
  path: string
  /** 技能目录（Codex 为 prompts 目录） */
  dirPath: string
  /** Claude 项目级的定位目录；其它作用域为空 */
  cwd: string
  /** DSH 专用：这个技能所属的 DSH_HOME */
  home?: string
  /** 详情页页签显示的文件名 */
  fileLabel: 'SKILL.md' | 'prompt.md'
  /** 正文（不含 frontmatter；Codex 为整份文件） */
  body: string
  /** 磁盘上的原始内容，代码页签直接展示 */
  rawContent: string
  frontmatter: SkillFrontmatter
  allowedTools: string[]
  argumentHint: string
  model: string
  version: string
  resources: SkillResource[]
  warnings: SkillWarning[]
  createdAt: number
  updatedAt: number
  size: number
  /** 插件技能所属的缓存目录名 */
  pluginName?: string
}

export interface SkillSourceFile {
  scope: SkillScope
  path: string
  exists: boolean
  writable: boolean
  count: number
}

export interface SkillListResult {
  cli: CliId
  cwd: string
  skills: SkillView[]
  sources: SkillSourceFile[]
  dshHome?: string
  scannedAt: number
}

/** 新建 / 编辑表单提交的数据；id 为空表示新建 */
export interface SkillInput {
  id?: string
  name: string
  description: string
  /** 不含 frontmatter 的正文；Codex 是整份文件 */
  body: string
  scope: SkillScope
  cwd: string
  allowedTools: string[]
  argumentHint: string
  model: string
  enabled: boolean
}

export interface SkillMutationResult {
  ok: boolean
  errorKey?: string
  detail?: string
  skillId?: string
  backupPath?: string
  /** 用户取消了文件选择器；UI 直接忽略 */
  cancelled?: boolean
  list: SkillListResult
}

/* ── 能力表 ───────────────────────────────────────────────── */

export const SKILL_SCOPES: Record<CliId, SkillScope[]> = {
  claude: ['global', 'project'],
  codex: ['global'],
  dsh: ['home', 'shared']
}

/** 「只读来源」也算来源，但不参与新建 */
export const SKILL_SOURCES: Record<CliId, SkillScope[]> = {
  claude: ['global', 'project', 'plugin'],
  codex: ['global'],
  dsh: ['home', 'shared']
}

export const SKILL_FILE_LABEL: Record<CliId, 'SKILL.md' | 'prompt.md'> = {
  claude: 'SKILL.md',
  codex: 'prompt.md',
  dsh: 'SKILL.md'
}

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

export function isSkillScope(v: unknown): v is SkillScope {
  return v === 'global' || v === 'project' || v === 'plugin' || v === 'home' || v === 'shared'
}

export function emptySkillInput(cli: CliId, cwd = ''): SkillInput {
  return {
    name: '',
    description: '',
    body: '',
    scope: SKILL_SCOPES[cli][0],
    cwd,
    allowedTools: cli === 'codex' ? [] : ['Read', 'Grep'],
    argumentHint: '',
    model: 'inherit',
    enabled: true
  }
}

/** 渲染进程传来的对象一律按不可信处理；只认已知字段 */
export function coerceSkillInput(raw: unknown): SkillInput {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const text = (v: unknown): string => (typeof v === 'string' ? v : '')
  const list = (v: unknown): string[] =>
    Array.isArray(v)
      ? v
          .filter((x): x is string => typeof x === 'string')
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, 64)
      : []
  return {
    id: typeof o.id === 'string' && o.id ? o.id : undefined,
    name: text(o.name),
    description: text(o.description),
    body: text(o.body),
    scope: isSkillScope(o.scope) ? o.scope : 'global',
    cwd: text(o.cwd),
    allowedTools: list(o.allowedTools),
    argumentHint: text(o.argumentHint),
    model: text(o.model),
    enabled: o.enabled !== false
  }
}

/** 校验用户输入；返回第一个错误 i18n key，null = 通过。 */
export function validateSkillInput(
  cli: CliId,
  input: SkillInput,
  existingName?: string
): string | null {
  const name = input.name.trim().toLowerCase()
  if (!name) {
    return cli === 'codex' ? 'skill.error.nameRequired' : 'skill.error.dirRequired'
  }
  if (name.length > 64) return 'skill.error.nameTooLong'
  if (!SKILL_NAME_RE.test(name)) return 'skill.error.nameInvalid'
  if (existingName !== undefined && name !== existingName.trim().toLowerCase()) {
    return 'skill.error.nameLocked'
  }
  if (!SKILL_SCOPES[cli].includes(input.scope)) return 'skill.error.invalidScope'
  if (input.scope === 'project' && !input.cwd.trim()) return 'skill.error.cwdRequired'
  if (!input.description.trim()) return 'skill.error.descRequired'
  if (input.description.length > 1024) return 'skill.error.descTooLong'
  if (input.body.length > 256 * 1024) return 'skill.error.bodyTooLong'
  if (input.argumentHint.length > 160) return 'skill.error.argHintTooLong'
  if (input.model.length > 80) return 'skill.error.modelTooLong'
  if (input.allowedTools.some((t) => t.length > 80)) return 'skill.error.toolTooLong'
  return null
}

/** 原生视图 → 表单输入 */
export function toSkillInput(s: SkillView): SkillInput {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    body: s.body,
    scope: s.scope,
    cwd: s.cwd,
    allowedTools: [...s.allowedTools],
    argumentHint: s.argumentHint,
    model: s.model || 'inherit',
    enabled: s.enabled
  }
}

/** 生成稳定的定位 id。home / cwd 参与，避免不同 home 下同名技能互相覆盖。 */
export function skillKey(parts: {
  cli: CliId
  scope: SkillScope
  name: string
  cwd?: string
  home?: string
  plugin?: string
}): string {
  return [
    parts.cli,
    parts.scope,
    parts.plugin ?? '',
    parts.home ?? '',
    parts.cwd ?? '',
    parts.name
  ].join('|')
}

/** 斜杠命令名 */
export function skillCommand(name: string): string {
  return `/${name}`
}
