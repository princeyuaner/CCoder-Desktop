import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { CliId } from '../../shared/settings'
import {
  SKILL_FILE_LABEL,
  skillKey,
  type SkillInput,
  type SkillResource,
  type SkillScope,
  type SkillView,
  type SkillWarning
} from '../../shared/skills'
import { composeSkillFile, deriveDescription, parseSkillFile } from './frontmatter'
import {
  backupFile,
  backupSkillPath,
  collectResources,
  ctime,
  isDir,
  mtime,
  readText,
  removePath,
  renamePath,
  writeAtomic
} from './fs'

/**
 * `SKILL.md` 目录形态的读写，Claude 与 DSH 共用。
 *
 * 启停用目录改名（`name` ↔ `name.disabled`）实现：CLI 只扫目录里的
 * SKILL.md，改名后整个技能从它的视角消失，重新启用时连资源一起回来。
 */

export interface DirSkillRoot {
  scope: Exclude<SkillScope, 'plugin'>
  root: string
  cli: CliId
  /** Claude 项目级的定位目录 */
  cwd: string
  /** DSH 所属 home */
  home?: string
  readOnly?: boolean
  pluginName?: string
}

export function claudeGlobalRoot(claudeDir: string): DirSkillRoot {
  return { scope: 'global', root: join(claudeDir, 'skills'), cli: 'claude', cwd: '' }
}

export function claudeProjectRoot(cwd: string): DirSkillRoot {
  return {
    scope: 'project',
    root: join(cwd, '.claude', 'skills'),
    cli: 'claude',
    cwd
  }
}

export function dshHomeRoot(home: string): DirSkillRoot {
  return { scope: 'home', root: join(home, 'skills'), cli: 'dsh', cwd: '', home }
}

export function dshSharedRoot(homeDir: string): DirSkillRoot {
  return {
    scope: 'shared',
    root: join(homeDir, '.dsh', 'skills'),
    cli: 'dsh',
    cwd: ''
  }
}

function warning(key: SkillWarning['key'], detail?: string): SkillWarning {
  return detail ? { key, detail } : { key }
}

/** 读取一个 SKILL.md 目录；返回 null 表示这不是技能目录 */
export function readDirSkill(
  root: DirSkillRoot,
  entry: string,
  opts: { readOnly?: boolean; pluginName?: string; displayRoot?: string } = {}
): SkillView | null {
  if (!entry || entry.startsWith('.')) return null
  const dirPath = join(root.root, entry)
  if (!isDir(dirPath)) return null

  const enabledManifest = join(dirPath, 'SKILL.md')
  const disabledManifest = join(dirPath, 'SKILL.md.disabled')
  let manifest = ''
  let manifestEnabled = false
  if (existsSync(enabledManifest)) {
    manifest = enabledManifest
    manifestEnabled = true
  } else if (existsSync(disabledManifest)) {
    manifest = disabledManifest
  } else {
    return null
  }

  // 启停只改 manifest 文件名：目录名保持稳定，资源不会因为改名而丢失。
  // 目录里没有 SKILL.md 时 CLI 会跳过它，比依赖目录名的约定更可靠。
  const name = entry
  const enabled = manifestEnabled
  const read = readText(manifest)
  if (!read.ok) {
    return {
      id: skillKey({ cli: root.cli, scope: root.scope, name, cwd: root.cwd, home: root.home }),
      cli: root.cli,
      name,
      displayName: name,
      description: '',
      scope: root.scope,
      enabled,
      readOnly: !!opts.readOnly,
      readOnlyReason: opts.readOnly ? 'plugin' : null,
      path: manifest,
      dirPath,
      cwd: root.cwd,
      home: root.home,
      fileLabel: SKILL_FILE_LABEL[root.cli],
      body: '',
      rawContent: '',
      frontmatter: {
        present: false,
        name: '',
        description: '',
        allowedTools: [],
        argumentHint: '',
        model: '',
        version: '',
        extras: {},
        error: ''
      },
      allowedTools: [],
      argumentHint: '',
      model: 'inherit',
      version: '',
      resources: [],
      warnings: [warning('skill.warn.unreadable', read.detail)],
      createdAt: ctime(manifest),
      updatedAt: mtime(manifest),
      size: 0,
      ...(opts.pluginName ? { pluginName: opts.pluginName } : {})
    }
  }

  const parsed = parseSkillFile(read.text)
  const fm = parsed.frontmatter
  const warnings: SkillWarning[] = []
  if (fm.error) warnings.push(warning('skill.warn.invalidFrontmatter', fm.error))
  if (read.truncated) warnings.push(warning('skill.warn.tooLarge'))
  if (!fm.description.trim()) warnings.push(warning('skill.warn.missingDescription'))
  else if (fm.description.trim().length < 20) warnings.push(warning('skill.warn.descriptionShort'))
  if (fm.name && fm.name.toLowerCase() !== name.toLowerCase()) {
    warnings.push(warning('skill.warn.nameMismatch', fm.name))
  }

  const description = fm.description.trim() || deriveDescription(parsed.body)
  const resources: SkillResource[] = [
    {
      path: basename(manifest).replace(/\.disabled$/, ''),
      size: read.size,
      dir: false,
      modifiedAt: read.mtime
    },
    ...collectResources(dirPath, basename(manifest))
  ]

  return {
    id: skillKey({ cli: root.cli, scope: root.scope, name, cwd: root.cwd, home: root.home }),
    cli: root.cli,
    name,
    displayName: fm.name || name,
    description,
    scope: root.scope,
    enabled,
    readOnly: !!opts.readOnly,
    readOnlyReason: opts.readOnly ? 'plugin' : null,
    path: manifest,
    dirPath,
    cwd: root.cwd,
    home: root.home,
    fileLabel: SKILL_FILE_LABEL[root.cli],
    body: parsed.body,
    rawContent: read.text,
    frontmatter: fm,
    allowedTools: fm.allowedTools,
    argumentHint: fm.argumentHint,
    model: fm.model || 'inherit',
    version: fm.version,
    resources,
    warnings,
    createdAt: ctime(manifest),
    updatedAt: read.mtime,
    size: read.size,
    ...(opts.pluginName ? { pluginName: opts.pluginName } : {})
  }
}

/** 扫描一个根目录；SKILL.md.disabled 也会读出来，UI 才能重新启用 */
export function listDirRoot(root: DirSkillRoot, limit = 500): SkillView[] {
  const out: SkillView[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(root.root) as string[]
  } catch {
    return out
  }
  for (const entry of entries.sort()) {
    const view = readDirSkill(root, entry)
    if (!view) continue
    out.push(view)
    if (out.length >= limit) break
  }
  return out
}

function targetRoot(root: DirSkillRoot, input: SkillInput): string {
  if (root.cli === 'claude' && input.scope === 'project') {
    return join(input.cwd, '.claude', 'skills')
  }
  return root.root
}

function actualDir(existing: SkillView): string {
  return existing.dirPath
}

function manifestName(enabled: boolean): string {
  return enabled ? 'SKILL.md' : 'SKILL.md.disabled'
}

/**
 * 切换 manifest 文件名。启用 / 停用都只是同目录内的一次 rename，
 * 目录里的脚本和资源原样保留。
 */
function renameManifest(dir: string, enabled: boolean): { ok: boolean; errorKey?: string } {
  const from = join(dir, enabled ? 'SKILL.md.disabled' : 'SKILL.md')
  const to = join(dir, manifestName(enabled))
  if (existsSync(to)) return { ok: false, errorKey: 'skill.error.nameTaken' }
  if (!existsSync(from)) return { ok: false, errorKey: 'skill.error.notFound' }
  const moved = renamePath(from, to)
  return moved.ok ? { ok: true } : { ok: false, errorKey: moved.errorKey }
}

export interface DirMutation {
  ok: boolean
  errorKey?: string
  detail?: string
  skillId?: string
  backupPath?: string
}

/**
 * 新建 / 编辑。
 *
 * 新建时在同名目录里写 `SKILL.md`（停用则写 `SKILL.md.disabled`）；
 * 编辑时先写当前 manifest，再按需只改文件名，目录本身从不移动。
 */
export function saveDirSkill(
  root: DirSkillRoot,
  input: SkillInput,
  existing: SkillView | null,
  opts: { backupRoot: string; cli: CliId }
): DirMutation {
  if (existing?.readOnly || existing?.readOnlyReason === 'plugin') {
    return { ok: false, errorKey: 'skill.error.readOnly' }
  }

  const name = input.name.trim().toLowerCase()
  const target = existing ? actualDir(existing) : join(targetRoot(root, input), name)
  if (!existing) {
    if (existsSync(target)) {
      return { ok: false, errorKey: 'skill.error.nameTaken' }
    }
    try {
      mkdirSync(target, { recursive: true })
    } catch (e) {
      return {
        ok: false,
        errorKey: 'skill.error.writeFailed',
        detail: e instanceof Error ? e.message : String(e)
      }
    }
    const created = writeManifest(target, input.enabled, input, null, opts)
    if (!created.ok) return created
    return {
      ...created,
      skillId: skillKey({
        cli: root.cli,
        scope: root.scope,
        name,
        cwd: root.cwd,
        home: root.home
      })
    }
  }

  const currentManifest = existing.path
  let backupPath: string | undefined
  if (existsSync(currentManifest)) {
    const backup = backupFile(currentManifest, opts.backupRoot, opts.cli, existing.name)
    if (!backup.ok) return { ok: false, errorKey: backup.errorKey, detail: backup.detail }
    backupPath = backup.path
  }

  // 先写到当前实际的文件名，保持“停用的技能保存后仍然是停用的”
  const currentEnabled = existing.enabled
  const written = writeManifest(target, currentEnabled, input, existing, opts, backupPath)
  if (!written.ok) return written

  if (input.enabled !== currentEnabled) {
    const toggled = renameManifest(target, input.enabled)
    if (!toggled.ok) return { ...toggled, backupPath }
  }
  return { ...written, backupPath }
}

function writeManifest(
  dir: string,
  enabled: boolean,
  input: SkillInput,
  existing: SkillView | null,
  opts: { backupRoot: string; cli: CliId },
  backupPath?: string
): DirMutation {
  try {
    mkdirSync(dir, { recursive: true })
  } catch (e) {
    return {
      ok: false,
      errorKey: 'skill.error.writeFailed',
      detail: e instanceof Error ? e.message : String(e)
    }
  }
  const file = join(dir, manifestName(enabled))
  const extra = existing?.frontmatter.extras ?? {}
  const text = composeSkillFile(input, { extra })
  try {
    writeAtomic(file, text)
  } catch (e) {
    return {
      ok: false,
      errorKey: 'skill.error.writeFailed',
      detail: e instanceof Error ? e.message : String(e)
    }
  }
  return { ok: true, skillId: input.id, backupPath }
}

export function removeDirSkill(
  existing: SkillView,
  opts: { backupRoot: string; cli: CliId }
): DirMutation {
  if (existing.readOnly || existing.readOnlyReason === 'plugin') {
    return { ok: false, errorKey: 'skill.error.readOnly' }
  }
  const dir = actualDir(existing)
  const backup = backupSkillPath(dir, opts.backupRoot, opts.cli, existing.name)
  if (!backup.ok) return { ok: false, errorKey: backup.errorKey, detail: backup.detail }
  const removed = removePath(dir)
  if (!removed.ok) return { ...removed, backupPath: backup.path }
  return { ok: true, backupPath: backup.path }
}

export function setDirSkillEnabled(
  existing: SkillView,
  enabled: boolean,
  opts: { backupRoot: string; cli: CliId }
): DirMutation {
  if (existing.readOnly || existing.readOnlyReason === 'plugin') {
    return { ok: false, errorKey: 'skill.error.readOnly' }
  }
  if (existing.enabled === enabled) return { ok: true }
  return renameManifest(actualDir(existing), enabled)
}

/** 从文件夹导入：源目录必须直接包含 SKILL.md */
export function importDirSkill(
  root: DirSkillRoot,
  source: string,
  opts: { backupRoot: string; cli: CliId }
): DirMutation {
  const name = basename(source).trim().toLowerCase()
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return { ok: false, errorKey: 'skill.error.importName' }
  }
  if (!existsSync(join(source, 'SKILL.md'))) {
    return { ok: false, errorKey: 'skill.error.importNoManifest' }
  }
  const target = join(root.root, name)
  if (existsSync(target)) {
    return { ok: false, errorKey: 'skill.error.nameTaken' }
  }
  try {
    mkdirSync(target, { recursive: true })
    cpSync(source, target, { recursive: true, dereference: false })
  } catch (e) {
    removePath(target)
    return {
      ok: false,
      errorKey: 'skill.error.importFailed',
      detail: e instanceof Error ? e.message : String(e)
    }
  }
  return { ok: true, skillId: skillKey({ cli: root.cli, scope: root.scope, name, cwd: root.cwd, home: root.home }) }
}

/* ── Claude 插件缓存（只读） ─────────────────────────────── */

export interface PluginSkill {
  name: string
  dir: string
  manifest: string
  /** 缓存目录的第一段（通常是 marketplace 名） */
  pluginName: string
  /** marketplace/plugin；同一插件的多个版本共用这个键 */
  pluginKey: string
  mtime: number
}

/**
 * 在插件缓存里递归找 SKILL.md。
 *
 * 缓存目录会保留同一插件的多个版本（`<plugin>/<hash>/skills/...`）。
 * 这里按 marketplace + plugin + skill 去重，只留 manifest 最新的那份，
 * 否则列表里会出现两条同名技能 —— 它们的 React key 也会撞车。
 */
export function findPluginSkills(claudeDir: string, max = 300): PluginSkill[] {
  const root = join(claudeDir, 'plugins', 'cache')
  const found: PluginSkill[] = []
  const walk = (dir: string, rel: string, depth: number): void => {
    if (found.length >= max || depth > 6) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir) as string[]
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git' || entry.startsWith('.')) continue
      const abs = join(dir, entry)
      if (!isDir(abs)) continue
      const nextRel = rel ? `${rel}/${entry}` : entry
      if (existsSync(join(abs, 'SKILL.md'))) {
        const parts = nextRel.split('/')
        found.push({
          name: entry,
          dir: abs,
          manifest: join(abs, 'SKILL.md'),
          pluginName: parts[0] || entry,
          pluginKey: parts.length > 1 ? `${parts[0]}/${parts[1]}` : entry,
          mtime: mtime(join(abs, 'SKILL.md'))
        })
        if (found.length >= max) return
      }
      walk(abs, nextRel, depth + 1)
    }
  }
  walk(root, '', 0)

  const newest = new Map<string, PluginSkill>()
  for (const skill of found) {
    const key = `${skill.pluginKey}/${skill.name}`
    const prev = newest.get(key)
    if (!prev || skill.mtime > prev.mtime) newest.set(key, skill)
  }
  return [...newest.values()]
}

export function readPluginSkill(plugin: PluginSkill): SkillView | null {
  const root: DirSkillRoot = {
    scope: 'global',
    root: dirname(plugin.dir),
    cli: 'claude',
    cwd: '',
    readOnly: true
  }
  const view = readDirSkill(root, basename(plugin.dir), {
    readOnly: true,
    pluginName: plugin.pluginName
  })
  if (!view) return null
  return {
    ...view,
    id: skillKey({
      cli: 'claude',
      scope: 'plugin',
      name: plugin.name,
      plugin: plugin.pluginKey
    }),
    scope: 'plugin',
    readOnly: true,
    readOnlyReason: 'plugin',
    pluginName: plugin.pluginName
  }
}