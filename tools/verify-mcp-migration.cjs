/*
 * 验证旧 mcp-servers.json → 原生配置迁移。
 * 用 plain Node 运行；通过 mock electron 的 app/safeStorage 指向临时 userData，
 * 避免启动一个真实的 Electron 窗口。
 *
 * 用法：esbuild 打包 src/main/mcp-migration.ts --external:electron，再 node 本脚本。
 */
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const scratch = path.join(__dirname, '..', '.tmp-build')
fs.mkdirSync(scratch, { recursive: true })
const dir = fs.mkdtempSync(path.join(scratch, 'mcp-migration-'))

// 在 require bundle 之前替换 electron
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getPath: () => dir },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.from(''),
        decryptString: () => ''
      }
    }
  }
  return originalLoad.apply(this, arguments)
}

const { previewMigration, applyMigration } = require(path.join(
  __dirname,
  '..',
  '.tmp-build',
  'mcp-migration.cjs'
))

function write(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text, 'utf8')
}

function read(p) {
  return fs.readFileSync(p, 'utf8')
}

function secret(value) {
  return { v: 0, plain: value }
}

function legacyEntry(id, name, scope, cwd, command) {
  return {
    id,
    name,
    description: '',
    transport: 'stdio',
    command,
    args: ['-y', name],
    env: [{ key: 'TOKEN', value: secret('secret-' + name) }],
    url: '',
    headers: [],
    enabled: true,
    scope,
    cwd,
    createdAt: 1,
    updatedAt: 1
  }
}

const proj = path.join(dir, 'proj')
fs.mkdirSync(proj, { recursive: true })
const projKey = proj.replace(/\\/g, '/')

const claudeJson = path.join(dir, '.claude.json')
write(
  claudeJson,
  JSON.stringify(
    {
      numStartups: 1,
      projects: { [projKey]: { mcpServers: {} } },
      mcpServers: {},
      disabledMcpServers: []
    },
    null,
    2
  )
)
const codexConfig = path.join(dir, 'codex', 'config.toml')
write(codexConfig, '# codex\n[mcp_servers.keep]\ncommand = "keep"\n')
const dshHome = path.join(dir, 'dsh-home')
write(path.join(dshHome, 'profiles', 'acp', 'cordis.patch.yml'), '# dsh\n[]\n')

write(
  path.join(dir, 'mcp-servers.json'),
  JSON.stringify(
    {
      v: 1,
      servers: {
        claude: [
          legacyEntry('c1', 'legacy-user', 'global', '', 'user-cmd'),
          legacyEntry('c2', 'legacy-local', 'project', proj, 'local-cmd')
        ],
        codex: [legacyEntry('x1', 'legacy-codex', 'global', '', 'codex-cmd')],
        dsh: [legacyEntry('d1', 'legacy-dsh', 'global', '', 'dsh-cmd')]
      }
    },
    null,
    2
  )
)

const ctx = {
  claudeJson,
  claudeDir: path.join(dir, '.claude'),
  codexConfig,
  backupRoot: path.join(dir, 'backups'),
  dshHomes: [dshHome]
}

const preview = previewMigration(ctx, dshHome)
console.log('preview:', preview.entries.map((e) => `${e.cli}:${e.name}:${e.status}`))
assert.strictEqual(preview.count, 4)
assert(preview.entries.every((e) => e.status === 'migrate'), 'some entries not migratable')

const ids = preview.entries.map((e) => e.legacyId)
const result = applyMigration(ids, ctx, dshHome)
console.log('result:', result)
assert(result.ok, JSON.stringify(result))
assert.strictEqual(result.migrated, 4)

const cj = JSON.parse(read(claudeJson))
assert(cj.mcpServers['legacy-user'], 'claude user missing')
assert(cj.projects[projKey].mcpServers['legacy-local'], 'claude local missing')
assert.strictEqual(cj.mcpServers['legacy-user'].env.TOKEN, 'secret-legacy-user')

const toml = read(codexConfig)
assert(toml.includes('# codex'), 'codex comment lost')
assert(toml.includes('[mcp_servers.keep]'), 'codex keep lost')
assert(toml.includes('[mcp_servers.legacy-codex]'), 'codex migrated missing')
assert(toml.includes('secret-legacy-codex'), 'codex secret missing')

const yaml = read(path.join(dshHome, 'profiles', 'acp', 'cordis.patch.yml'))
assert(yaml.includes('# dsh'), 'dsh comment lost')
assert(yaml.includes('legacy-dsh'), 'dsh migrated missing')

assert(!fs.existsSync(path.join(dir, 'mcp-servers.json')), 'legacy file not renamed')
const renamed = fs.readdirSync(dir).find((f) => f.startsWith('mcp-servers.json.migrated-'))
assert(renamed, 'legacy renamed file missing')
assert(result.backupPath && fs.existsSync(result.backupPath), 'migration backup missing')
assert(fs.readdirSync(path.join(ctx.backupRoot, 'claude')).length > 0, 'claude backup missing')

// 冲突：目标已有同名不同配置，不能覆盖
write(
  path.join(dir, 'mcp-servers.json'),
  JSON.stringify(
    {
      v: 1,
      servers: {
        claude: [legacyEntry('c3', 'legacy-user', 'global', '', 'different')],
        codex: [],
        dsh: []
      }
    },
    null,
    2
  )
)
const conflictPreview = previewMigration(ctx, dshHome)
assert.strictEqual(conflictPreview.entries[0].status, 'conflict', 'conflict not detected')
const conflictResult = applyMigration([conflictPreview.entries[0].legacyId], ctx, dshHome)
assert.strictEqual(conflictResult.conflicts, 1)
assert.strictEqual(conflictResult.migrated, 0)
assert(
  JSON.parse(read(claudeJson)).mcpServers['legacy-user'].command === 'user-cmd',
  'conflict overwrote native'
)

console.log('MCP migration OK')
fs.rmSync(dir, { recursive: true, force: true })
