/*
 * 验证 Skills 原生适配器：Claude / DSH 的 SKILL.md 目录、Codex 的 prompts/*.md、
 * frontmatter、启停改名、备份、导入。
 *
 * 用法：先 esbuild 打包 src/main/skills-native/index.ts，再运行本文件。
 */
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const scratch = path.join(__dirname, '..', '.tmp-build', 'skills')
fs.mkdirSync(scratch, { recursive: true })
const dir = fs.mkdtempSync(path.join(scratch, 'case-'))

const native = require(path.join(__dirname, '..', '.tmp-build', 'skills-native.cjs'))

function write(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text, 'utf8')
}
function read(p) {
  return fs.readFileSync(p, 'utf8')
}
function exists(p) {
  return fs.existsSync(p)
}

const claudeDir = path.join(dir, '.claude')
const codexHome = path.join(dir, '.codex')
const homeDir = path.join(dir, 'home')
const dshA = path.join(dir, 'dsh-a')
const dshB = path.join(dir, 'dsh-b')
const project = path.join(dir, 'project')
fs.mkdirSync(project, { recursive: true })

const ctx = {
  claudeDir,
  codexHome,
  homeDir,
  dshHomes: [dshA, dshB],
  backupRoot: path.join(dir, 'backups')
}

/* ------------------------------------------------------------- Claude -- */
console.log('=== Claude')
write(
  path.join(claudeDir, 'skills', 'code-review', 'SKILL.md'),
  `---
name: code-review
description: Review a diff for correctness, security, and missing tests.
allowed-tools: Read, Grep
argument-hint: "[path]"
model: opus
version: 1.2.0
custom-key: keep-me
---
# Code review

Read the diff, then report findings.
`
)
write(path.join(claudeDir, 'skills', 'code-review', 'scripts', 'run.sh'), 'echo hi\n')
write(
  path.join(claudeDir, 'skills', 'short-desc', 'SKILL.md'),
  `---
name: short-desc
description: short
---
Body
`
)
write(
  path.join(project, '.claude', 'skills', 'project-only', 'SKILL.md'),
  `---
name: project-only
description: Only available in this workspace and useful for testing.
---
Project body
`
)
write(
  path.join(claudeDir, 'plugins', 'cache', 'market', 'my-plugin', 'skills', 'plug-skill', 'SKILL.md'),
  `---
name: plug-skill
description: A plugin-provided skill that must stay read-only.
---
Plugin body
`
)
// 同一插件的旧版本：列表里只能留下较新的那份
const oldPlugin = path.join(
  claudeDir,
  'plugins',
  'cache',
  'market',
  'my-plugin',
  'old-version',
  'skills',
  'plug-skill',
  'SKILL.md'
)
write(
  oldPlugin,
  `---
name: plug-skill
description: An old plugin version that should be hidden.
---
Old body
`
)
const oldTime = new Date(Date.now() - 86400000)
fs.utimesSync(oldPlugin, oldTime, oldTime)

let list = native.listNativeSkills('claude', { cwd: project }, ctx)
console.log('claude:', list.skills.map((s) => `${s.scope}:${s.name}`))
assert.strictEqual(list.skills.length, 4)

const review = list.skills.find((s) => s.name === 'code-review')
assert(review)
assert.strictEqual(review.enabled, true)
assert.strictEqual(review.scope, 'global')
assert.deepStrictEqual(review.allowedTools, ['Read', 'Grep'])
assert.strictEqual(review.argumentHint, '[path]')
assert.strictEqual(review.model, 'opus')
assert.strictEqual(review.version, '1.2.0')
assert.strictEqual(review.frontmatter.extras['custom-key'], 'keep-me')
assert(review.resources.some((r) => r.path === 'scripts/run.sh'))
assert(review.rawContent.includes('name: code-review'))
assert(review.warnings.length === 0, JSON.stringify(review.warnings))

const shortDesc = list.skills.find((s) => s.name === 'short-desc')
assert(shortDesc.warnings.some((w) => w.key === 'skill.warn.descriptionShort'))

const plugins = list.skills.filter((s) => s.name === 'plug-skill')
assert.strictEqual(plugins.length, 1, 'plugin cache versions must be de-duplicated')
const plugin = plugins[0]
assert(plugin && plugin.scope === 'plugin' && plugin.readOnly && plugin.readOnlyReason === 'plugin')
assert.strictEqual(plugin.pluginName, 'market')
assert(plugin.path.includes('my-plugin'), plugin.path)
assert(!plugin.path.includes('old-version'), 'should keep the newer plugin version')
assert.strictEqual(new Set(list.skills.map((s) => s.id)).size, list.skills.length, 'ids must be unique')

const projectSkill = list.skills.find((s) => s.name === 'project-only')
assert(projectSkill && projectSkill.scope === 'project' && projectSkill.cwd === project)
assert.strictEqual(list.sources.find((s) => s.scope === 'plugin').writable, false)

// 停用 → manifest 改名；启用 → 改回来
let enabled = native.setNativeSkillEnabled('claude', review, false, { cwd: project }, ctx)
assert(enabled.ok, JSON.stringify(enabled))
assert(exists(path.join(claudeDir, 'skills', 'code-review', 'SKILL.md.disabled')))
assert(!exists(path.join(claudeDir, 'skills', 'code-review', 'SKILL.md')))
list = enabled.list
let off = list.skills.find((s) => s.name === 'code-review')
assert(off && off.enabled === false)
enabled = native.setNativeSkillEnabled('claude', off, true, { cwd: project }, ctx)
assert(enabled.ok, JSON.stringify(enabled))
assert(exists(path.join(claudeDir, 'skills', 'code-review', 'SKILL.md')))
assert(!exists(path.join(claudeDir, 'skills', 'code-review', 'SKILL.md.disabled')))

// 编辑：保留未知 frontmatter 字段
const editing = enabled.list.skills.find((s) => s.name === 'code-review')
const saved = native.saveNativeSkill(
  'claude',
  {
    id: editing.id,
    name: 'code-review',
    description: 'Review a diff for correctness, security, and missing tests. Updated.',
    body: '# Code review\n\nUpdated body.\n',
    scope: 'global',
    cwd: '',
    allowedTools: ['Read'],
    argumentHint: '',
    model: 'inherit',
    enabled: true
  },
  editing,
  { cwd: project },
  ctx
)
assert(saved.ok, JSON.stringify(saved))
const text = read(path.join(claudeDir, 'skills', 'code-review', 'SKILL.md'))
assert(text.includes('custom-key: keep-me'), 'unknown frontmatter key lost')
assert(text.includes('Updated body.'))
assert(text.includes('allowed-tools: Read'))
assert(!text.includes('argument-hint'), 'argument hint should be removed')
assert(!text.includes('model: opus'), 'model should be replaced')

// 新建（停用）+ 重名
const created = native.saveNativeSkill(
  'claude',
  {
    name: 'brand-new',
    description: 'A brand new skill created by the verification harness.',
    body: '# New\n',
    scope: 'global',
    cwd: '',
    allowedTools: [],
    argumentHint: '',
    model: 'inherit',
    enabled: false
  },
  null,
  { cwd: project },
  ctx
)
assert(created.ok, JSON.stringify(created))
assert(created.skillId)
assert(exists(path.join(claudeDir, 'skills', 'brand-new', 'SKILL.md.disabled')))
assert(!exists(path.join(claudeDir, 'skills', 'brand-new', 'SKILL.md')))
const dup = native.saveNativeSkill(
  'claude',
  {
    name: 'brand-new',
    description: 'duplicate',
    body: '',
    scope: 'global',
    cwd: '',
    allowedTools: [],
    argumentHint: '',
    model: '',
    enabled: true
  },
  null,
  { cwd: project },
  ctx
)
assert(!dup.ok && dup.errorKey === 'skill.error.nameTaken')

// 编辑停用技能：仍写 SKILL.md.disabled；通过编辑启用后改回 SKILL.md
let brand = created.list.skills.find((s) => s.name === 'brand-new')
const brandEdited = native.saveNativeSkill(
  'claude',
  {
    id: brand.id,
    name: 'brand-new',
    description: 'A brand new skill created by the verification harness. Edited.',
    body: '# New\n\nEdited while disabled.\n',
    scope: 'global',
    cwd: '',
    allowedTools: [],
    argumentHint: '',
    model: 'inherit',
    enabled: false
  },
  brand,
  { cwd: project },
  ctx
)
assert(brandEdited.ok, JSON.stringify(brandEdited))
assert(exists(path.join(claudeDir, 'skills', 'brand-new', 'SKILL.md.disabled')))
assert(!exists(path.join(claudeDir, 'skills', 'brand-new', 'SKILL.md')))
assert(read(path.join(claudeDir, 'skills', 'brand-new', 'SKILL.md.disabled')).includes('Edited while disabled'))
brand = brandEdited.list.skills.find((s) => s.name === 'brand-new')
const brandEnabled = native.saveNativeSkill(
  'claude',
  {
    id: brand.id,
    name: 'brand-new',
    description: 'A brand new skill created by the verification harness. Edited.',
    body: '# New\n\nEdited while disabled.\n',
    scope: 'global',
    cwd: '',
    allowedTools: [],
    argumentHint: '',
    model: 'inherit',
    enabled: true
  },
  brand,
  { cwd: project },
  ctx
)
assert(brandEnabled.ok, JSON.stringify(brandEnabled))
assert(exists(path.join(claudeDir, 'skills', 'brand-new', 'SKILL.md')))
assert(!exists(path.join(claudeDir, 'skills', 'brand-new', 'SKILL.md.disabled')))

// 删除 → 备份存在
const beforeDelete = created.list.skills.find((s) => s.name === 'brand-new')
const removed = native.removeNativeSkill('claude', beforeDelete, { cwd: project }, ctx)
assert(removed.ok, JSON.stringify(removed))
assert(removed.backupPath && exists(removed.backupPath))
assert(!exists(path.join(claudeDir, 'skills', 'brand-new')))

// 导入文件夹
const importSrc = path.join(dir, 'import-me')
write(path.join(importSrc, 'SKILL.md'), '---\nname: import-me\ndescription: Imported skill with a valid description.\n---\nBody\n')
const imported = native.importNativeSkill(
  'claude',
  { name: '', description: '', body: '', scope: 'global', cwd: '', allowedTools: [], argumentHint: '', model: '', enabled: true },
  importSrc,
  { cwd: project },
  ctx
)
assert(imported.ok, JSON.stringify(imported))
assert(exists(path.join(claudeDir, 'skills', 'import-me', 'SKILL.md')))

// 插件只读
const pluginNow = imported.list.skills.find((s) => s.name === 'plug-skill')
const denied = native.removeNativeSkill('claude', pluginNow, { cwd: project }, ctx)
assert(!denied.ok && denied.errorKey === 'skill.error.readOnly')

/* -------------------------------------------------------------- Codex -- */
console.log('=== Codex')
write(
  path.join(codexHome, 'prompts', 'codex-review.md'),
  '# Codex review\n\nReview this diff:\n\n$ARGUMENTS\n'
)
let codexList = native.listNativeSkills('codex', { cwd: project }, ctx)
assert.strictEqual(codexList.skills.length, 1)
let prompt = codexList.skills[0]
assert.strictEqual(prompt.name, 'codex-review')
assert(prompt.description.includes('Codex review'))
assert.strictEqual(prompt.scope, 'global')
assert.strictEqual(prompt.fileLabel, 'prompt.md')

const codexSaved = native.saveNativeSkill(
  'codex',
  {
    name: 'codex-review',
    description: 'Review a diff with Codex and report findings.',
    body: '# Codex review\n\nUpdated.\n',
    scope: 'global',
    cwd: '',
    allowedTools: [],
    argumentHint: '[path]',
    model: 'gpt-5',
    enabled: true
  },
  prompt,
  { cwd: project },
  ctx
)
assert(codexSaved.ok, JSON.stringify(codexSaved))
assert(read(path.join(codexHome, 'prompts', 'codex-review.md')).includes('Updated.'))
const index = JSON.parse(read(path.join(codexHome, 'prompts', '.ccoder-skills.json')))
assert.strictEqual(index.items['codex-review'].description, 'Review a diff with Codex and report findings.')
assert.strictEqual(index.items['codex-review'].model, 'gpt-5')

prompt = codexSaved.list.skills.find((s) => s.name === 'codex-review')
const codexOff = native.setNativeSkillEnabled('codex', prompt, false, { cwd: project }, ctx)
assert(codexOff.ok)
assert(exists(path.join(codexHome, 'prompts', 'codex-review.md.disabled')))
let offPrompt = codexOff.list.skills.find((s) => s.name === 'codex-review')
assert(offPrompt && offPrompt.enabled === false)
const codexOn = native.setNativeSkillEnabled('codex', offPrompt, true, { cwd: project }, ctx)
assert(codexOn.ok)

const codexCreated = native.saveNativeSkill(
  'codex',
  {
    name: 'explain-diff',
    description: 'Explain a diff in plain language.',
    body: 'Explain this diff:\n\n$ARGUMENTS\n',
    scope: 'global',
    cwd: '',
    allowedTools: [],
    argumentHint: '',
    model: '',
    enabled: true
  },
  null,
  { cwd: project },
  ctx
)
assert(codexCreated.ok && codexCreated.skillId)
assert(exists(path.join(codexHome, 'prompts', 'explain-diff.md')))

const codexRemoved = native.removeNativeSkill(
  'codex',
  codexCreated.list.skills.find((s) => s.name === 'explain-diff'),
  { cwd: project },
  ctx
)
assert(codexRemoved.ok)
assert(!exists(path.join(codexHome, 'prompts', 'explain-diff.md')))

const codexImportSrc = path.join(dir, 'import-prompt.md')
write(codexImportSrc, '# Imported\n\nDo the thing with $ARGUMENTS.\n')
const codexImported = native.importNativeSkill(
  'codex',
  { name: '', description: '', body: '', scope: 'global', cwd: '', allowedTools: [], argumentHint: '', model: '', enabled: true },
  codexImportSrc,
  { cwd: project },
  ctx
)
assert(codexImported.ok, JSON.stringify(codexImported))
assert(exists(path.join(codexHome, 'prompts', 'import-prompt.md')))

/* ---------------------------------------------------------------- DSH -- */
console.log('=== DSH')
write(
  path.join(dshA, 'skills', 'context-budget', 'SKILL.md'),
  '---\nname: context-budget\ndescription: Keep the working context small and focused.\nallowed-tools:\n  - Read\n---\nBody A\n'
)
write(
  path.join(homeDir, '.dsh', 'skills', 'team-style', 'SKILL.md'),
  '---\nname: team-style\ndescription: Apply the team writing style to every response.\n---\nShared body\n'
)
let dshList = native.listNativeSkills('dsh', { cwd: project, dshHome: dshA }, ctx)
assert.strictEqual(dshList.skills.length, 2)
assert(dshList.skills.some((s) => s.scope === 'home' && s.home === dshA))
assert(dshList.skills.some((s) => s.scope === 'shared'))

const otherHome = native.listNativeSkills('dsh', { cwd: project, dshHome: dshB }, ctx)
assert.strictEqual(otherHome.skills.length, 1, 'dsh home switch should only show shared')

// official 模式的当前 home 就是 ~/.dsh：home 与 shared 指向同一目录时不能重复列出
const officialHome = path.join(homeDir, '.dsh')
const official = native.listNativeSkills('dsh', { cwd: project, dshHome: officialHome }, ctx)
assert.strictEqual(official.skills.length, 1, 'same home/shared directory should be de-duplicated')
assert.strictEqual(official.skills[0].scope, 'shared')

const dshCreated = native.saveNativeSkill(
  'dsh',
  {
    name: 'task-decompose',
    description: 'Break a large task into small, verifiable steps.',
    body: '# Decompose\n',
    scope: 'home',
    cwd: '',
    allowedTools: ['Read'],
    argumentHint: '',
    model: 'inherit',
    enabled: true
  },
  null,
  { cwd: project, dshHome: dshA },
  ctx
)
assert(dshCreated.ok, JSON.stringify(dshCreated))
assert(exists(path.join(dshA, 'skills', 'task-decompose', 'SKILL.md')))

const sharedSaved = native.saveNativeSkill(
  'dsh',
  {
    name: 'team-style',
    description: 'Apply the team writing style to every response. Updated.',
    body: '# Style\n',
    scope: 'shared',
    cwd: '',
    allowedTools: [],
    argumentHint: '',
    model: 'inherit',
    enabled: true
  },
  dshCreated.list.skills.find((s) => s.name === 'team-style'),
  { cwd: project, dshHome: dshA },
  ctx
)
assert(sharedSaved.ok, JSON.stringify(sharedSaved))
assert(read(path.join(homeDir, '.dsh', 'skills', 'team-style', 'SKILL.md')).includes('Updated.'))

// 越权 home 在 service 层处理；native 只接受显式路径，这里确认 sourcePathForScope
assert.strictEqual(
  native.sourcePathForScope('dsh', 'home', { cwd: project, dshHome: dshA }, ctx),
  path.join(dshA, 'skills')
)
assert.strictEqual(
  native.sourcePathForScope('dsh', 'shared', { cwd: project, dshHome: dshA }, ctx),
  path.join(homeDir, '.dsh', 'skills')
)
assert.strictEqual(
  native.sourcePathForScope('claude', 'project', { cwd: project }, ctx),
  path.join(project, '.claude', 'skills')
)

console.log('\nSkills native OK')
fs.rmSync(dir, { recursive: true, force: true })
