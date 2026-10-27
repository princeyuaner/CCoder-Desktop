/*
 * 验证 Skills 门面：校验、去重、作用域、只读。
 * 先 esbuild 打包 src/main/skills-service.ts，再运行本文件。
 */
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const scratch = path.join(__dirname, '..', '.tmp-build', 'skills-service')
fs.mkdirSync(scratch, { recursive: true })
const dir = fs.mkdtempSync(path.join(scratch, 'case-'))
const service = require(path.join(__dirname, '..', '.tmp-build', 'skills-service.cjs'))

function write(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text, 'utf8')
}

const claudeDir = path.join(dir, '.claude')
const codexHome = path.join(dir, '.codex')
const homeDir = path.join(dir, 'home')
const dshHome = path.join(dir, 'dsh')
const project = path.join(dir, 'project')
fs.mkdirSync(project, { recursive: true })

const ctx = {
  claudeDir,
  codexHome,
  homeDir,
  dshHomes: [dshHome],
  backupRoot: path.join(dir, 'backups')
}

const base = {
  name: 'demo',
  description: 'A demo skill with a description long enough to pass.',
  body: '# Demo\n',
  scope: 'global',
  cwd: '',
  allowedTools: ['Read'],
  argumentHint: '',
  model: 'inherit',
  enabled: true
}

// 新建
let out = service.saveSkill('claude', base, project, ctx)
assert(out.ok, JSON.stringify(out))
assert(fs.existsSync(path.join(claudeDir, 'skills', 'demo', 'SKILL.md')))
assert(out.skillId)

// 重名
out = service.saveSkill('claude', base, project, ctx)
assert(!out.ok && out.errorKey === 'skill.error.nameTaken')

// 非法名字 / 空描述 / 超长
for (const [patch, key] of [
  [{ name: 'Bad Name' }, 'skill.error.nameInvalid'],
  [{ name: '-bad' }, 'skill.error.nameInvalid'],
  [{ description: '' }, 'skill.error.descRequired'],
  [{ body: 'x'.repeat(256 * 1024 + 1) }, 'skill.error.bodyTooLong']
]) {
  out = service.saveSkill('claude', { ...base, ...patch }, project, ctx)
  assert(!out.ok && out.errorKey === key, `${JSON.stringify(patch)} -> ${out.errorKey}`)
}

// 作用域
out = service.saveSkill('claude', { ...base, name: 'bad-scope', scope: 'home' }, project, ctx)
assert(!out.ok && out.errorKey === 'skill.error.invalidScope')
out = service.saveSkill('claude', { ...base, name: 'proj', scope: 'project', cwd: '' }, project, ctx)
assert(!out.ok && out.errorKey === 'skill.error.cwdRequired')

// 同名不同 scope 允许
out = service.saveSkill(
  'claude',
  { ...base, name: 'demo', scope: 'project', cwd: project },
  project,
  ctx
)
assert(out.ok, JSON.stringify(out))
assert(fs.existsSync(path.join(project, '.claude', 'skills', 'demo', 'SKILL.md')))

// 编辑时改名被拒
const projectList = service.listSkills('claude', project, ctx)
const projSkill = projectList.skills.find((s) => s.scope === 'project' && s.name === 'demo')
assert(projSkill)
out = service.saveSkill(
  'claude',
  { ...base, id: projSkill.id, name: 'renamed', scope: 'project', cwd: project },
  project,
  ctx
)
assert(!out.ok && out.errorKey === 'skill.error.nameLocked', JSON.stringify(out))

// 编辑时改 scope 被拒
out = service.saveSkill(
  'claude',
  { ...base, id: projSkill.id, name: 'demo', scope: 'global' },
  project,
  ctx
)
assert(!out.ok && out.errorKey === 'skill.error.scopeLocked')

// 只读插件技能
write(
  path.join(claudeDir, 'plugins', 'cache', 'p', 'skills', 'plug', 'SKILL.md'),
  '---\nname: plug\ndescription: Plugin skill with a description long enough.\n---\nBody\n'
)
const withPlugin = service.listSkills('claude', project, ctx)
const plugin = withPlugin.skills.find((s) => s.scope === 'plugin')
assert(plugin)
out = service.setSkillEnabled('claude', plugin.id, false, project, ctx)
assert(!out.ok && out.errorKey === 'skill.error.readOnly')
out = service.removeSkill('claude', plugin.id, project, ctx)
assert(!out.ok && out.errorKey === 'skill.error.readOnly')

// 不存在的 id
out = service.removeSkill('claude', 'claude|global|||nope', project, ctx)
assert(!out.ok && out.errorKey === 'skill.error.notFound')

// Codex
const codex = { ...base, name: 'review', scope: 'global' }
out = service.saveSkill('codex', codex, project, ctx)
assert(out.ok, JSON.stringify(out))
assert(fs.existsSync(path.join(codexHome, 'prompts', 'review.md')))
out = service.setSkillEnabled('codex', out.skillId, false, project, ctx)
assert(out.ok)
assert(fs.existsSync(path.join(codexHome, 'prompts', 'review.md.disabled')))
out = service.listSkills('codex', project, ctx)
assert(out.skills.length === 1 && out.skills[0].enabled === false)

// DSH home / shared
const dsh = { ...base, name: 'ctx', scope: 'home' }
out = service.saveSkill('dsh', dsh, project, ctx, { dshHome })
assert(out.ok, JSON.stringify(out))
assert(fs.existsSync(path.join(dshHome, 'skills', 'ctx', 'SKILL.md')))
out = service.saveSkill(
  'dsh',
  { ...base, name: 'shared-one', scope: 'shared' },
  project,
  ctx,
  { dshHome }
)
assert(out.ok, JSON.stringify(out))
assert(fs.existsSync(path.join(homeDir, '.dsh', 'skills', 'shared-one', 'SKILL.md')))
const dshList = service.listSkills('dsh', project, ctx, { dshHome })
assert(dshList.skills.some((s) => s.scope === 'home' && s.name === 'ctx'))
assert(dshList.skills.some((s) => s.scope === 'shared' && s.name === 'shared-one'))

// 非法的 DSH scope
out = service.saveSkill('dsh', { ...base, name: 'bad', scope: 'global' }, project, ctx, { dshHome })
assert(!out.ok && out.errorKey === 'skill.error.invalidScope')

console.log('Skills service OK')
fs.rmSync(dir, { recursive: true, force: true })
