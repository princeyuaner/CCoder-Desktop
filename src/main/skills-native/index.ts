import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CliId } from '../../shared/settings'
import type {
  SkillInput,
  SkillListResult,
  SkillMutationResult,
  SkillSourceFile,
  SkillView
} from '../../shared/skills'
import { pathKey } from '../path-key'
import type { SkillListOptions, SkillNativeContext, SkillQuery } from './types'
import {
  claudeGlobalRoot,
  claudeProjectRoot,
  dshHomeRoot,
  dshSharedRoot,
  findPluginSkills,
  importDirSkill,
  listDirRoot,
  readPluginSkill,
  removeDirSkill,
  saveDirSkill,
  setDirSkillEnabled,
  type DirMutation,
  type DirSkillRoot
} from './dir-skill'
import {
  codexPromptsRoot,
  importCodexSkill,
  listCodexSkills,
  removeCodexSkill,
  saveCodexSkill,
  setCodexSkillEnabled
} from './codex'

export type { SkillNativeContext, SkillQuery, SkillListOptions } from './types'

/**
 * 解析三家 CLI 的默认技能目录。
 *
 * 只有这里读 env/homedir；适配器接收显式 context，测试可以注入临时目录。
 */
export function createSkillNativeContext(opts: {
  backupRoot: string
  dshHomes: string[]
}): SkillNativeContext {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim()
  return {
    claudeDir: configDir || join(homedir(), '.claude'),
    codexHome: process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'),
    homeDir: homedir(),
    dshHomes: opts.dshHomes,
    backupRoot: opts.backupRoot
  }
}

export function defaultDshHome(ctx: SkillNativeContext): string {
  return ctx.dshHomes[0] ?? ''
}

export function queryFor(ctx: SkillNativeContext, q: SkillQuery): Required<SkillQuery> {
  return { cwd: q.cwd || '', dshHome: q.dshHome?.trim() || defaultDshHome(ctx) }
}

function source(
  scope: SkillSourceFile['scope'],
  path: string,
  writable: boolean,
  skills: SkillView[]
): SkillSourceFile {
  return {
    scope,
    path,
    exists: existsSync(path),
    writable,
    count: skills.filter((s) => s.scope === scope).length
  }
}

function rootsFor(cli: CliId, q: Required<SkillQuery>, ctx: SkillNativeContext): DirSkillRoot[] {
  if (cli === 'claude') {
    const roots = [claudeGlobalRoot(ctx.claudeDir)]
    if (q.cwd) roots.push(claudeProjectRoot(q.cwd))
    return roots
  }
  if (cli === 'dsh') {
    const home = dshHomeRoot(q.dshHome)
    const shared = dshSharedRoot(ctx.homeDir)
    // official 模式下当前 home 就是 ~/.dsh；两个 scope 指向同一目录时只列一次，
    // 否则列表里每条技能都会出现两遍。
    if (pathKey(home.root) === pathKey(shared.root)) return [shared]
    return [home, shared]
  }
  return []
}

export function listNativeSkills(
  cli: CliId,
  query: SkillQuery,
  ctx: SkillNativeContext
): { skills: SkillView[]; sources: SkillSourceFile[] } {
  const q = queryFor(ctx, query)
  if (cli === 'codex') {
    const skills = listCodexSkills(ctx.codexHome)
    const path = codexPromptsRoot(ctx.codexHome)
    return { skills, sources: [source('global', path, true, skills)] }
  }

  const roots = rootsFor(cli, q, ctx)
  const skills: SkillView[] = []
  for (const root of roots) skills.push(...listDirRoot(root))

  let pluginSkills: SkillView[] = []
  if (cli === 'claude') {
    for (const plugin of findPluginSkills(ctx.claudeDir)) {
      const view = readPluginSkill(plugin)
      if (view) pluginSkills.push(view)
    }
    skills.push(...pluginSkills)
  }

  const sources = roots.map((r) => source(r.scope, r.root, !r.readOnly, skills))
  if (cli === 'claude') {
    sources.push(
      source('plugin', join(ctx.claudeDir, 'plugins', 'cache'), false, pluginSkills)
    )
  }
  return { skills, sources }
}

function rootFor(
  cli: CliId,
  input: SkillInput,
  q: Required<SkillQuery>,
  ctx: SkillNativeContext
): DirSkillRoot | null {
  if (cli === 'claude') {
    if (input.scope === 'global') return claudeGlobalRoot(ctx.claudeDir)
    if (input.scope === 'project') return claudeProjectRoot(input.cwd)
    return null
  }
  if (cli === 'dsh') {
    if (input.scope === 'home') return dshHomeRoot(q.dshHome)
    if (input.scope === 'shared') return dshSharedRoot(ctx.homeDir)
    return null
  }
  return null
}

function finish(
  cli: CliId,
  q: SkillQuery,
  ctx: SkillNativeContext,
  result: DirMutation
): SkillMutationResult {
  return {
    ok: result.ok,
    errorKey: result.errorKey,
    detail: result.detail,
    skillId: result.skillId,
    backupPath: result.backupPath,
    list: {
      ...listNativeSkills(cli, q, ctx),
      cli,
      cwd: q.cwd,
      dshHome: cli === 'dsh' ? queryFor(ctx, q).dshHome : undefined,
      scannedAt: Date.now()
    }
  }
}

export function saveNativeSkill(
  cli: CliId,
  input: SkillInput,
  existing: SkillView | null,
  q: Required<SkillQuery>,
  ctx: SkillNativeContext
): SkillMutationResult {
  let result: DirMutation
  if (cli === 'codex') {
    result = saveCodexSkill(ctx.codexHome, input, existing, { backupRoot: ctx.backupRoot })
  } else {
    const root = rootFor(cli, input, q, ctx)
    if (!root) result = { ok: false, errorKey: 'skill.error.invalidScope' }
    else result = saveDirSkill(root, input, existing, { backupRoot: ctx.backupRoot, cli })
  }
  return finish(cli, q, ctx, result)
}

export function removeNativeSkill(
  cli: CliId,
  existing: SkillView,
  q: Required<SkillQuery>,
  ctx: SkillNativeContext
): SkillMutationResult {
  let result: DirMutation
  if (cli === 'codex') {
    result = removeCodexSkill(existing, { backupRoot: ctx.backupRoot })
  } else {
    result = removeDirSkill(existing, { backupRoot: ctx.backupRoot, cli })
  }
  return finish(cli, q, ctx, result)
}

export function setNativeSkillEnabled(
  cli: CliId,
  existing: SkillView,
  enabled: boolean,
  q: Required<SkillQuery>,
  ctx: SkillNativeContext
): SkillMutationResult {
  const result =
    cli === 'codex'
      ? setCodexSkillEnabled(existing, enabled)
      : setDirSkillEnabled(existing, enabled, { backupRoot: ctx.backupRoot, cli })
  return finish(cli, q, ctx, result)
}

export function importNativeSkill(
  cli: CliId,
  input: SkillInput,
  sourcePath: string,
  q: Required<SkillQuery>,
  ctx: SkillNativeContext
): SkillMutationResult {
  let result: DirMutation
  if (cli === 'codex') {
    result = importCodexSkill(ctx.codexHome, sourcePath)
  } else {
    const root = rootFor(cli, input, q, ctx)
    if (!root) result = { ok: false, errorKey: 'skill.error.invalidScope' }
    else result = importDirSkill(root, sourcePath, { backupRoot: ctx.backupRoot, cli })
  }
  const out = finish(cli, q, ctx, result)
  // 导入后把来源加入快照，UI 直接选中新建的那条
  if (result.ok && result.skillId) out.skillId = result.skillId
  return out
}

export function sourcePathForScope(
  cli: CliId,
  scope: SkillSourceFile['scope'],
  q: Required<SkillQuery>,
  ctx: SkillNativeContext
): string | null {
  if (cli === 'claude') {
    if (scope === 'global') return claudeGlobalRoot(ctx.claudeDir).root
    if (scope === 'project') return q.cwd ? claudeProjectRoot(q.cwd).root : null
    if (scope === 'plugin') return join(ctx.claudeDir, 'plugins', 'cache')
    return null
  }
  if (cli === 'codex') return codexPromptsRoot(ctx.codexHome)
  if (scope === 'home') return dshHomeRoot(q.dshHome).root
  if (scope === 'shared') return dshSharedRoot(ctx.homeDir).root
  return null
}
