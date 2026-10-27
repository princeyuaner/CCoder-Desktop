import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { SkillInput, SkillView, SkillWarning } from '../../shared/skills'
import { skillKey } from '../../shared/skills'
import { deriveDescription } from './frontmatter'
import {
  backupFile,
  backupSkillPath,
  ctime,
  isFile,
  mtime,
  readText,
  removePath,
  renamePath,
  writeAtomic
} from './fs'
import type { DirMutation } from './dir-skill'

/**
 * Codex 的自定义提示词。
 *
 * `~/.codex/prompts/<name>.md` 是 Codex 自己扫描的目录；文件名就是斜杠
 * 命令名，正文里用 `$ARGUMENTS` 接参数。Codex 不认 frontmatter，所以展示
 * 用的描述/参数提示存在同目录的 `.ccoder-skills.json` 里 —— 它不是 .md，
 * Codex 不会把它当成一条提示词。
 */

const INDEX_FILE = '.ccoder-skills.json'

interface CodexMeta {
  description?: string
  displayName?: string
  argumentHint?: string
  model?: string
  version?: string
}

interface CodexIndex {
  version: 1
  items: Record<string, CodexMeta>
}

function indexPath(root: string): string {
  return join(root, INDEX_FILE)
}

function readIndex(root: string): CodexIndex {
  const path = indexPath(root)
  if (!existsSync(path)) return { version: 1, items: {} }
  try {
    const file = readText(path)
    const raw = JSON.parse(file.ok ? file.text : '{}') as {
      items?: Record<string, CodexMeta>
    }
    const items: Record<string, CodexMeta> = {}
    for (const [k, v] of Object.entries(raw.items ?? {})) {
      if (!v || typeof v !== 'object') continue
      const meta: CodexMeta = {}
      if (typeof v.description === 'string') meta.description = v.description
      if (typeof v.displayName === 'string') meta.displayName = v.displayName
      if (typeof v.argumentHint === 'string') meta.argumentHint = v.argumentHint
      if (typeof v.model === 'string') meta.model = v.model
      if (typeof v.version === 'string') meta.version = v.version
      items[k] = meta
    }
    return { version: 1, items }
  } catch {
    return { version: 1, items: {} }
  }
}

function writeIndex(root: string, index: CodexIndex): { ok: boolean; detail?: string } {
  try {
    mkdirSync(root, { recursive: true })
    writeAtomic(indexPath(root), `${JSON.stringify(index, null, 2)}\n`)
    return { ok: true }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

function updateIndex(root: string, name: string, meta: CodexMeta | null): void {
  const index = readIndex(root)
  if (meta) index.items[name] = meta
  else delete index.items[name]
  writeIndex(root, index)
}

function warn(key: SkillWarning['key'], detail?: string): SkillWarning {
  return detail ? { key, detail } : { key }
}

function viewOf(root: string, file: string, index: CodexIndex): SkillView | null {
  const entry = basename(file)
  const disabled = entry.endsWith('.md.disabled')
  const name = disabled ? entry.slice(0, -'.md.disabled'.length) : entry.slice(0, -'.md'.length)
  if (!name || name.startsWith('.')) return null

  const read = readText(file)
  const meta = index.items[name] ?? {}
  if (!read.ok) {
    return {
      id: skillKey({ cli: 'codex', scope: 'global', name }),
      cli: 'codex',
      name,
      displayName: meta.displayName || name,
      description: meta.description || '',
      scope: 'global',
      enabled: !disabled,
      readOnly: false,
      readOnlyReason: null,
      path: file,
      dirPath: root,
      cwd: '',
      fileLabel: 'prompt.md',
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
      argumentHint: meta.argumentHint || '',
      model: meta.model || 'inherit',
      version: meta.version || '',
      resources: [],
      warnings: [warn('skill.warn.unreadable', read.detail)],
      createdAt: ctime(file),
      updatedAt: mtime(file),
      size: 0
    }
  }

  const derived = deriveDescription(read.text)
  const description = meta.description?.trim() || derived
  const warnings: SkillWarning[] = []
  if (read.truncated) warnings.push(warn('skill.warn.tooLarge'))
  if (!description) warnings.push(warn('skill.warn.missingDescription'))

  return {
    id: skillKey({ cli: 'codex', scope: 'global', name }),
    cli: 'codex',
    name,
    displayName: meta.displayName || name,
    description,
    scope: 'global',
    enabled: !disabled,
    readOnly: false,
    readOnlyReason: null,
    path: file,
    dirPath: root,
    cwd: '',
    fileLabel: 'prompt.md',
    body: read.text,
    rawContent: read.text,
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
    argumentHint: meta.argumentHint || '',
    model: meta.model || 'inherit',
    version: meta.version || '',
    resources: [
      {
        path: `${name}.md`,
        size: read.size,
        dir: false,
        modifiedAt: read.mtime
      }
    ],
    warnings,
    createdAt: ctime(file),
    updatedAt: read.mtime,
    size: read.size
  }
}

export function codexPromptsRoot(codexHome: string): string {
  return join(codexHome, 'prompts')
}

export function listCodexSkills(codexHome: string, limit = 500): SkillView[] {
  const root = codexPromptsRoot(codexHome)
  let entries: string[] = []
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  const index = readIndex(root)
  const out: SkillView[] = []
  const seen = new Set<string>()
  for (const entry of entries.sort()) {
    const isMd = entry.endsWith('.md')
    const isOff = entry.endsWith('.md.disabled')
    if (!isMd && !isOff) continue
    if (entry.startsWith('.')) continue
    const name = isOff ? entry.slice(0, -'.md.disabled'.length) : entry.slice(0, -'.md'.length)
    if (seen.has(name.toLowerCase())) continue
    // 同名的启用文件优先
    if (isOff && entries.includes(`${name}.md`)) continue
    const view = viewOf(root, join(root, entry), index)
    if (!view) continue
    seen.add(name.toLowerCase())
    out.push(view)
    if (out.length >= limit) break
  }
  return out
}

export function saveCodexSkill(
  codexHome: string,
  input: SkillInput,
  existing: SkillView | null,
  opts: { backupRoot: string }
): DirMutation {
  const root = codexPromptsRoot(codexHome)
  const name = input.name.trim().toLowerCase()
  const current = existing?.path ?? ''
  let file = existing ? current : join(root, `${name}${input.enabled ? '.md' : '.md.disabled'}`)

  if (!existing) {
    if (existsSync(join(root, `${name}.md`)) || existsSync(join(root, `${name}.md.disabled`))) {
      return { ok: false, errorKey: 'skill.error.nameTaken' }
    }
  }

  let backupPath: string | undefined
  if (existing && existsSync(current)) {
    const backup = backupFile(current, opts.backupRoot, 'codex', name)
    if (!backup.ok) return { ok: false, errorKey: backup.errorKey, detail: backup.detail }
    backupPath = backup.path
  }

  try {
    mkdirSync(root, { recursive: true })
    writeAtomic(file, `${input.body.replace(/\r\n/g, '\n').trimEnd()}\n`)
  } catch (e) {
    return {
      ok: false,
      errorKey: 'skill.error.writeFailed',
      detail: e instanceof Error ? e.message : String(e)
    }
  }

  if (existing && existing.enabled !== input.enabled) {
    const to = join(root, `${name}${input.enabled ? '.md' : '.md.disabled'}`)
    if (to !== file) {
      if (existsSync(to)) return { ok: false, errorKey: 'skill.error.nameTaken', backupPath }
      const moved = renamePath(file, to)
      if (!moved.ok) return { ...moved, backupPath }
      file = to
    }
  }

  updateIndex(root, name, {
    description: input.description.trim(),
    argumentHint: input.argumentHint.trim(),
    model: input.model.trim() || 'inherit',
    displayName: name
  })

  return {
    ok: true,
    skillId: skillKey({ cli: 'codex', scope: 'global', name }),
    backupPath
  }
}

export function removeCodexSkill(
  existing: SkillView,
  opts: { backupRoot: string }
): DirMutation {
  const backup = backupSkillPath(existing.path, opts.backupRoot, 'codex', existing.name)
  if (!backup.ok) return { ok: false, errorKey: backup.errorKey, detail: backup.detail }
  const removed = removePath(existing.path)
  if (!removed.ok) return { ...removed, backupPath: backup.path }
  updateIndex(codexPromptsRoot(dirname(existing.path)), existing.name, null)
  return { ok: true, backupPath: backup.path }
}

export function setCodexSkillEnabled(existing: SkillView, enabled: boolean): DirMutation {
  if (existing.enabled === enabled) return { ok: true }
  const root = dirname(existing.path)
  const to = join(root, `${existing.name}${enabled ? '.md' : '.md.disabled'}`)
  if (existsSync(to)) return { ok: false, errorKey: 'skill.error.nameTaken' }
  return renamePath(existing.path, to)
}

export function importCodexSkill(
  codexHome: string,
  source: string
): DirMutation {
  if (!isFile(source) || !source.toLowerCase().endsWith('.md')) {
    return { ok: false, errorKey: 'skill.error.importNoManifest' }
  }
  const base = basename(source).replace(/\.md$/i, '')
  const name = base.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return { ok: false, errorKey: 'skill.error.importName' }
  }
  const root = codexPromptsRoot(codexHome)
  if (existsSync(join(root, `${name}.md`)) || existsSync(join(root, `${name}.md.disabled`))) {
    return { ok: false, errorKey: 'skill.error.nameTaken' }
  }
  try {
    mkdirSync(root, { recursive: true })
    const text = readText(source)
    if (!text.ok) return { ok: false, errorKey: text.errorKey, detail: text.detail }
    writeAtomic(join(root, `${name}.md`), text.text)
    updateIndex(root, name, { description: deriveDescription(text.text) })
  } catch (e) {
    return {
      ok: false,
      errorKey: 'skill.error.importFailed',
      detail: e instanceof Error ? e.message : String(e)
    }
  }
  return { ok: true, skillId: skillKey({ cli: 'codex', scope: 'global', name }) }
}

