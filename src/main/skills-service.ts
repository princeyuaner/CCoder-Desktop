import { CLI_IDS, type CliId } from '../shared/settings'
import {
  SKILL_SCOPES,
  validateSkillInput,
  type SkillInput,
  type SkillListResult,
  type SkillMutationResult,
  type SkillScope,
  type SkillView
} from '../shared/skills'
import {
  importNativeSkill,
  listNativeSkills,
  queryFor,
  removeNativeSkill,
  saveNativeSkill,
  setNativeSkillEnabled,
  sourcePathForScope,
  type SkillListOptions,
  type SkillNativeContext,
  type SkillQuery
} from './skills-native'

/**
 * 技能门面：扫描、校验、去重、写入。
 *
 * 适配器只认路径；这里负责把渲染进程给的 cli / scope / cwd / home
 * 收敛成已知值，再决定写哪个目录。
 */

export function asSkillCliId(v: unknown): CliId | null {
  return typeof v === 'string' && (CLI_IDS as string[]).includes(v) ? (v as CliId) : null
}

function queryForCall(
  ctx: SkillNativeContext,
  cwd: string,
  opts?: SkillListOptions
): Required<SkillQuery> {
  return queryFor(ctx, { cwd, dshHome: opts?.dshHome })
}

export function listSkills(
  cli: CliId,
  cwd: string,
  ctx: SkillNativeContext,
  opts?: SkillListOptions
): SkillListResult {
  const read = listNativeSkills(cli, { cwd, dshHome: opts?.dshHome }, ctx)
  return {
    cli,
    cwd,
    skills: read.skills,
    sources: read.sources,
    dshHome: cli === 'dsh' ? queryForCall(ctx, cwd, opts).dshHome : undefined,
    scannedAt: Date.now()
  }
}

function findSkill(
  cli: CliId,
  id: string,
  cwd: string,
  ctx: SkillNativeContext,
  opts?: SkillListOptions
): SkillView | null {
  if (!id) return null
  return (
    listNativeSkills(cli, { cwd, dshHome: opts?.dshHome }, ctx).skills.find((s) => s.id === id) ??
    null
  )
}

function duplicated(
  cli: CliId,
  input: SkillInput,
  existing: SkillView | null,
  cwd: string,
  ctx: SkillNativeContext,
  opts?: SkillListOptions
): SkillView | null {
  const name = input.name.trim().toLowerCase()
  const all = listNativeSkills(cli, { cwd, dshHome: opts?.dshHome }, ctx).skills
  for (const s of all) {
    if (existing && s.id === existing.id) continue
    if (s.scope !== input.scope) continue
    if (s.name.toLowerCase() === name) return s
  }
  return null
}

export function saveSkill(
  cli: CliId,
  input: SkillInput,
  cwd: string,
  ctx: SkillNativeContext,
  opts?: SkillListOptions
): SkillMutationResult {
  const list = (): SkillListResult => listSkills(cli, cwd, ctx, opts)
  const existing = input.id ? findSkill(cli, input.id, cwd, ctx, opts) : null
  if (input.id && !existing) {
    return { ok: false, errorKey: 'skill.error.notFound', list: list() }
  }
  if (existing && existing.scope !== input.scope) {
    return { ok: false, errorKey: 'skill.error.scopeLocked', list: list() }
  }
  if (!SKILL_SCOPES[cli].includes(input.scope)) {
    return { ok: false, errorKey: 'skill.error.invalidScope', list: list() }
  }

  const bad = validateSkillInput(cli, input, existing?.name)
  if (bad) return { ok: false, errorKey: bad, list: list() }

  if (duplicated(cli, input, existing, cwd, ctx, opts)) {
    return { ok: false, errorKey: 'skill.error.nameTaken', list: list() }
  }

  const q = queryForCall(ctx, input.cwd || cwd, opts)
  return saveNativeSkill(cli, input, existing, q, ctx)
}

export function removeSkill(
  cli: CliId,
  id: string,
  cwd: string,
  ctx: SkillNativeContext,
  opts?: SkillListOptions
): SkillMutationResult {
  const existing = findSkill(cli, id, cwd, ctx, opts)
  if (!existing) {
    return { ok: false, errorKey: 'skill.error.notFound', list: listSkills(cli, cwd, ctx, opts) }
  }
  if (existing.readOnly) {
    return { ok: false, errorKey: 'skill.error.readOnly', list: listSkills(cli, cwd, ctx, opts) }
  }
  return removeNativeSkill(cli, existing, queryForCall(ctx, cwd, opts), ctx)
}

export function setSkillEnabled(
  cli: CliId,
  id: string,
  enabled: boolean,
  cwd: string,
  ctx: SkillNativeContext,
  opts?: SkillListOptions
): SkillMutationResult {
  const existing = findSkill(cli, id, cwd, ctx, opts)
  if (!existing) {
    return { ok: false, errorKey: 'skill.error.notFound', list: listSkills(cli, cwd, ctx, opts) }
  }
  if (existing.readOnly) {
    return { ok: false, errorKey: 'skill.error.readOnly', list: listSkills(cli, cwd, ctx, opts) }
  }
  return setNativeSkillEnabled(cli, existing, enabled, queryForCall(ctx, cwd, opts), ctx)
}

export function importSkill(
  cli: CliId,
  scope: SkillScope,
  cwd: string,
  sourcePath: string,
  ctx: SkillNativeContext,
  opts?: SkillListOptions
): SkillMutationResult {
  if (!SKILL_SCOPES[cli].includes(scope)) {
    return {
      ok: false,
      errorKey: 'skill.error.invalidScope',
      list: listSkills(cli, cwd, ctx, opts)
    }
  }
  const input: SkillInput = {
    name: '',
    description: '',
    body: '',
    scope,
    cwd,
    allowedTools: [],
    argumentHint: '',
    model: '',
    enabled: true
  }
  return importNativeSkill(cli, input, sourcePath, queryForCall(ctx, cwd, opts), ctx)
}

/** 诊断页「打开目录」用：只接受已列出的 scope */
export function sourcePathOf(
  cli: CliId,
  scope: SkillScope,
  cwd: string,
  ctx: SkillNativeContext,
  opts?: SkillListOptions
): string | null {
  return sourcePathForScope(cli, scope, queryForCall(ctx, cwd, opts), ctx)
}
