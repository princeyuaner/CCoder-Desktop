/*
 * 验证原生 MCP 适配器：Claude JSONC、Codex TOML 块编辑、DSH YAML。
 * 用法：先 esbuild 打包 src/main/mcp-native/index.ts，再 node tools/verify-mcp-native.cjs
 */
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const scratch = path.join(__dirname, '..', '.tmp-build', 'mcp-native')
fs.mkdirSync(scratch, { recursive: true })
const dir = fs.mkdtempSync(path.join(scratch, 'case-'))

const native = require(path.join(__dirname, '..', '.tmp-build', 'mcp-native.cjs'))

function write(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text, 'utf8')
}

function read(p) {
  return fs.readFileSync(p, 'utf8')
}

function ctx(dshHomes) {
  return {
    claudeJson: path.join(dir, '.claude.json'),
    claudeDir: path.join(dir, '.claude'),
    codexConfig: path.join(dir, 'codex', 'config.toml'),
    backupRoot: path.join(dir, 'backups'),
    dshHomes
  }
}

/* ------------------------------------------------------------- Claude -- */
console.log('=== Claude')
const projectCwd = path.join(dir, 'project-a')
fs.mkdirSync(projectCwd, { recursive: true })
const projectCwdForward = projectCwd.replace(/\\/g, '/')
write(
  path.join(dir, '.claude.json'),
  `{
  // keep this comment
  "numStartups": 9,
  "projects": {
    "${projectCwdForward}": {
      "history": [1, 2],
      "mcpServers": {
        "local-one": { "type": "stdio", "command": "local", "args": ["a"], "timeout": 5 }
      },
      "disabledMcpServers": ["local-two"]
    }
  },
  "mcpServers": {
    "user-one": { "type": "stdio", "command": "user", "args": ["x"] }
  },
  "disabledMcpServers": []
}
`
)
write(
  path.join(projectCwd, '.mcp.json'),
  `{
  // project comment
  "mcpServers": {
    "proj-one": { "type": "http", "url": "https://example.com/mcp", "headers": { "X-A": "b" } }
  },
  "extra": { "keep": true }
}
`
)

const c = ctx([path.join(dir, 'dsh-home')])
const claudeList = native.listNative('claude', { cwd: projectCwd }, c)
console.log('claude servers:', claudeList.servers.map((s) => `${s.scope}:${s.name}`))
assert.strictEqual(claudeList.servers.length, 3)
const userOne = claudeList.servers.find((s) => s.name === 'user-one')
assert(userOne && userOne.scope === 'user')
assert.deepStrictEqual(userOne.nativeExtras, [])

const localOne = claudeList.servers.find((s) => s.name === 'local-one')
assert(localOne && localOne.scope === 'local')
assert.deepStrictEqual(localOne.nativeExtras, ['timeout'])
assert.strictEqual(localOne.cwd, projectCwd)

const projOne = claudeList.servers.find((s) => s.name === 'proj-one')
assert(projOne && projOne.scope === 'project')
assert.strictEqual(projOne.transport, 'http')
assert.strictEqual(projOne.tools?.length ?? 0, 0)

// 用户级新增 + 保留无关内容
let saved = native.saveNative(
  'claude',
  {
    name: 'user-two',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'demo'],
    env: [{ key: 'TOKEN', value: 'secret' }],
    url: '',
    headers: [],
    workingDir: '',
    enabled: true,
    scope: 'user',
    cwd: ''
  },
  null,
  { cwd: projectCwd },
  c
)
assert(saved.ok, JSON.stringify(saved))
let json = read(c.claudeJson)
assert(json.includes('// keep this comment'), 'claude comment lost')
assert(json.includes('"numStartups": 9'), 'unrelated key lost')
assert(json.includes('"user-two"'), 'new user server missing')
assert(json.includes('"TOKEN": "secret"'), 'env missing')

// 编辑 local，保留未知字段
const localExisting = native
  .listNative('claude', { cwd: projectCwd }, c)
  .servers.find((s) => s.name === 'local-one')
assert(localExisting)
saved = native.saveNative(
  'claude',
  {
    id: localExisting.id,
    name: 'local-one',
    transport: 'stdio',
    command: 'local2',
    args: ['a', 'b'],
    env: [],
    url: '',
    headers: [],
    workingDir: '',
    enabled: false,
    scope: 'local',
    cwd: projectCwd
  },
  localExisting,
  { cwd: projectCwd },
  c
)
assert(saved.ok, JSON.stringify(saved))
json = read(c.claudeJson)
assert(json.includes('"timeout": 5'), 'unknown native field lost')
assert(json.includes('"local-two"') && json.includes('"local-one"'), 'disabled list update missing')
const afterLocal = native
  .listNative('claude', { cwd: projectCwd }, c)
  .servers.find((s) => s.name === 'local-one')
assert(afterLocal && afterLocal.enabled === false)

// 项目级新增 + 审批状态
saved = native.saveNative(
  'claude',
  {
    name: 'proj-two',
    transport: 'stdio',
    command: 'proj',
    args: [],
    env: [],
    url: '',
    headers: [],
    workingDir: '',
    enabled: true,
    scope: 'project',
    cwd: projectCwd
  },
  null,
  { cwd: projectCwd },
  c
)
assert(saved.ok, JSON.stringify(saved))
assert(read(path.join(projectCwd, '.mcp.json')).includes('"proj-two"'))
json = read(c.claudeJson)
assert(json.includes('"enabledMcpjsonServers"'), 'project approval missing')
const projTwo = native
  .listNative('claude', { cwd: projectCwd }, c)
  .servers.find((s) => s.name === 'proj-two')
assert(projTwo && projTwo.enabled === true && projTwo.approvalState === 'enabled')

// 改名
const projTwoNow = native
  .listNative('claude', { cwd: projectCwd }, c)
  .servers.find((s) => s.name === 'proj-two')
saved = native.saveNative(
  'claude',
  {
    id: projTwoNow.id,
    name: 'proj-renamed',
    transport: 'stdio',
    command: 'proj',
    args: [],
    env: [],
    url: '',
    headers: [],
    workingDir: '',
    enabled: true,
    scope: 'project',
    cwd: projectCwd
  },
  projTwoNow,
  { cwd: projectCwd },
  c
)
assert(saved.ok, JSON.stringify(saved))
const renamed = native
  .listNative('claude', { cwd: projectCwd }, c)
  .servers.some((s) => s.name === 'proj-renamed')
assert(renamed, 'rename failed')

// 删除
const userTwo = native
  .listNative('claude', { cwd: projectCwd }, c)
  .servers.find((s) => s.name === 'user-two')
let removed = native.removeNative('claude', userTwo, { cwd: projectCwd }, c)
assert(removed.ok, JSON.stringify(removed))
assert(!read(c.claudeJson).includes('"user-two"'), 'remove failed')
assert(fs.existsSync(c.backupRoot), 'backup root missing')
assert(fs.readdirSync(path.join(c.backupRoot, 'claude')).some((f) => f.endsWith('.bak')))

// 解析失败不写
const broken = path.join(dir, 'broken.json')
write(broken, '{ bad json')
const before = read(broken)
const brokenCtx = { ...c, claudeJson: broken }
const brokenList = native.listNative('claude', { cwd: projectCwd }, brokenCtx)
assert(brokenList.sources.some((s) => s.path === broken && s.error))
assert.strictEqual(read(broken), before, 'invalid file was modified')

/* -------------------------------------------------------------- Codex -- */
console.log('=== Codex')
const codexHome = path.join(dir, 'codex')
write(
  c.codexConfig,
  `# top comment
model = "deepseek-v4"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com"

# MCP comment
[mcp_servers.plain]
type = "stdio"
command = "codegraph"
args = ["serve", "--mcp"]
tool_timeout_sec = 30

[mcp_servers."quoted name"]
type = "stdio"
command = "npx"
args = ["-y", "demo"]

[tui]
theme = "dark"
`
)
let codexList = native.listNative('codex', { cwd: projectCwd }, c)
console.log('codex servers:', codexList.servers.map((s) => s.name))
assert.strictEqual(codexList.servers.length, 2)
const plain = codexList.servers.find((s) => s.name === 'plain')
assert(plain && plain.command === 'codegraph')
assert(plain.nativeExtras.includes('tool_timeout_sec'))

saved = native.saveNative(
  'codex',
  {
    name: 'newhttp',
    transport: 'http',
    command: '',
    args: [],
    env: [],
    url: 'https://example.com/mcp',
    headers: [{ key: 'Authorization', value: 'Bearer x' }],
    workingDir: '',
    enabled: true,
    scope: 'global',
    cwd: ''
  },
  null,
  { cwd: projectCwd },
  c
)
assert(saved.ok, JSON.stringify(saved))
let toml = read(c.codexConfig)
assert(toml.includes('# top comment'), 'toml top comment lost')
assert(toml.includes('# MCP comment'), 'toml MCP comment lost')
assert(toml.includes('[model_providers.deepseek]'), 'toml unrelated table lost')
assert(toml.includes('[tui]'), 'toml tui lost')
assert(toml.includes('[mcp_servers.newhttp]'), 'new codex table missing')
assert(toml.includes('http_headers'), 'codex headers missing')

// 编辑数组（toml-patch 会失败，我们的块编辑器应通过）
const plainNow = native.listNative('codex', { cwd: projectCwd }, c).servers.find((s) => s.name === 'plain')
saved = native.saveNative(
  'codex',
  {
    id: plainNow.id,
    name: 'plain',
    transport: 'stdio',
    command: 'codegraph2',
    args: ['serve', '--other'],
    env: [{ key: 'A', value: 'b' }],
    url: '',
    headers: [],
    workingDir: '/tmp',
    enabled: false,
    scope: 'global',
    cwd: ''
  },
  plainNow,
  { cwd: projectCwd },
  c
)
assert(saved.ok, JSON.stringify(saved))
toml = read(c.codexConfig)
assert(toml.includes('--other'), 'codex array edit missing')
assert(toml.includes('command = "codegraph2"'), 'codex command edit missing')
assert(toml.includes('tool_timeout_sec = 30'), 'codex unknown field lost')
assert(toml.includes('enabled = false'), 'codex enabled missing')
assert(toml.includes('cwd = "/tmp"'), 'codex workingDir missing')
assert(toml.includes('[mcp_servers."quoted name"]'), 'quoted table lost')

removed = native.removeNative('codex', { ...plainNow, name: 'plain' }, { cwd: projectCwd }, c)
assert(removed.ok, JSON.stringify(removed))
toml = read(c.codexConfig)
assert(!toml.includes('[mcp_servers.plain]'), 'codex remove failed')
assert(toml.includes('[tui]') && toml.includes('[model_providers.deepseek]'), 'codex unrelated lost')

/* ---------------------------------------------------------------- DSH -- */
console.log('=== DSH')
const dshHome = path.join(dir, 'dsh-home')
const patch = path.join(dshHome, 'profiles', 'acp', 'cordis.patch.yml')
write(
  patch,
  `# user patch
- id: custom
  name: some-plugin
  config:
    path: !!js dshHomePath('sessions')

# a foreign MCP row
- insert:
    - id: user-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: user-mcp
        command: /usr/bin/npx
`
)
const dctx = ctx([dshHome])
let dshList = native.listNative('dsh', { cwd: projectCwd, dshHome }, dctx)
console.log('dsh servers:', dshList.servers.map((s) => `${s.name}:${s.readOnly}`))
assert.strictEqual(dshList.servers.length, 1)
assert(dshList.servers[0].readOnly, 'foreign row should be read-only')

saved = native.saveNative(
  'dsh',
  {
    name: 'demo',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'demo'],
    env: [{ key: 'TOKEN', value: 'secret' }],
    url: '',
    headers: [],
    workingDir: '',
    enabled: true,
    scope: 'home',
    cwd: ''
  },
  null,
  { cwd: projectCwd, dshHome },
  dctx
)
assert(saved.ok, JSON.stringify(saved))
let yaml = read(patch)
assert(yaml.includes('# user patch'), 'dsh comment lost')
assert(yaml.includes('# a foreign MCP row'), 'dsh foreign comment lost')
assert(yaml.includes('!!js'), 'dsh !!js lost')
assert(yaml.includes('ccoder-mcp-demo'), 'dsh row missing')
assert(yaml.includes('serverName: demo'), 'dsh serverName missing')

const demo = native
  .listNative('dsh', { cwd: projectCwd, dshHome }, dctx)
  .servers.find((s) => s.name === 'demo')
assert(demo && !demo.readOnly && demo.enabled)

saved = native.setNativeEnabled('dsh', demo, false, { cwd: projectCwd, dshHome }, dctx)
assert(saved.ok, JSON.stringify(saved))
yaml = read(patch)
assert(yaml.includes('disabled: true'), 'dsh disable missing')
const demoOff = native
  .listNative('dsh', { cwd: projectCwd, dshHome }, dctx)
  .servers.find((s) => s.name === 'demo')
assert(demoOff && demoOff.enabled === false)

// 编辑成 HTTP
saved = native.saveNative(
  'dsh',
  {
    id: demoOff.id,
    name: 'demo',
    transport: 'http',
    command: '',
    args: [],
    env: [],
    url: 'https://example.com/mcp',
    headers: [{ key: 'X-A', value: 'b' }],
    workingDir: '',
    enabled: true,
    scope: 'home',
    cwd: ''
  },
  demoOff,
  { cwd: projectCwd, dshHome },
  dctx
)
assert(saved.ok, JSON.stringify(saved))
yaml = read(patch)
assert(yaml.includes('streamable-http'), 'dsh http transport missing')
assert(yaml.includes('url: https://example.com/mcp'), 'dsh url missing')

removed = native.removeNative(
  'dsh',
  { ...demoOff, id: demoOff.id },
  { cwd: projectCwd, dshHome },
  dctx
)
// 重新读一次拿 id（上面的 demoOff 是禁用时的 id，删除应仍能定位）
if (!removed.ok) {
  const now = native
    .listNative('dsh', { cwd: projectCwd, dshHome }, dctx)
    .servers.find((s) => s.name === 'demo')
  removed = native.removeNative('dsh', now, { cwd: projectCwd, dshHome }, dctx)
}
assert(removed.ok, JSON.stringify(removed))
yaml = read(patch)
assert(!yaml.includes('ccoder-mcp-demo'), 'dsh remove failed')
assert(yaml.includes('user-mcp') && yaml.includes('!!js'), 'dsh user rows lost')

// profile 未初始化
const emptyHome = path.join(dir, 'empty-home')
fs.mkdirSync(emptyHome, { recursive: true })
const emptyCtx = ctx([emptyHome])
const emptyList = native.listNative('dsh', { cwd: projectCwd, dshHome: emptyHome }, emptyCtx)
assert(emptyList.sources[0].errorKey === 'mcp.error.dshProfileNotInitialized')

// 非法 home
const bad = native.listNative('dsh', { cwd: projectCwd, dshHome: path.join(dir, 'nope') }, dctx)
assert(bad.sources[0].errorKey === 'mcp.error.homeNotAllowed')

console.log('\nMCP native OK')
fs.rmSync(dir, { recursive: true, force: true })
