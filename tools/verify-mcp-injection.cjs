/*
 * 验证 CCoder 生成的 MCP 注入参数：
 *  - Claude: --mcp-config 与 JSON 形状
 *  - Codex: -c 覆盖项能被真实 codex 解析
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const claude = require(path.join(__dirname, '..', '.tmp-build', 'claude-adapter.cjs'))
const codex = require(path.join(__dirname, '..', '.tmp-build', 'codex-runner.cjs'))
const dsh = require(path.join(__dirname, '..', '.tmp-build', 'dsh-adapter.cjs'))

function assert(ok, msg) {
  if (!ok) throw new Error(msg)
}

async function main() {
  const servers = [
    {
      name: 'remote',
      transport: 'http',
      command: '',
      args: [],
      env: {},
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer abc' }
    },
    {
      name: 'local',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'demo server'],
      env: { TOKEN: 'x' },
      url: '',
      headers: {}
    }
  ]

  const claudeArgs = claude.buildClaudeArgs({
    model: '',
    permissionMode: 'standard',
    effort: 'medium',
    addDirs: [],
    resumeId: null,
    official: false,
    mcpConfigPath: 'C:\\temp\\mcp.json'
  })
  assert(claudeArgs.includes('--mcp-config'), 'Claude args missing --mcp-config')
  assert(claudeArgs.includes('C:\\temp\\mcp.json'), 'Claude args missing config path')

  const cfg = claude.buildClaudeMcpConfig(servers)
  assert(cfg.mcpServers.remote.type === 'http', 'Claude HTTP type wrong')
  assert(cfg.mcpServers.remote.headers.Authorization === 'Bearer abc', 'Claude headers lost')
  assert(cfg.mcpServers.local.args[1] === 'demo server', 'Claude args lost')
  assert(cfg.mcpServers.local.env.TOKEN === 'x', 'Claude env lost')

  const overrides = codex.codexMcpOverrides(servers)
  console.log('Codex overrides:\n' + overrides.join('\n'))
  const mcpEnv = codex.codexMcpEnv(servers)
  assert(Object.values(mcpEnv).includes('Bearer abc'), 'Codex header env missing')

  const acp = dsh.acpMcpServers(servers)
  assert(acp[0].type === 'http' && acp[0].url === 'https://example.com/mcp', 'DSH HTTP shape wrong')
  assert(acp[0].headers[0].name === 'Authorization', 'DSH headers lost')
  assert(acp[1].type === undefined, 'DSH stdio must not carry type')
  assert(acp[1].env[0].name === 'TOKEN', 'DSH env lost')
  console.log('DSH mcpServers shape OK')

  const codexJs =
    'C:\\Users\\CY\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'
  if (!fs.existsSync(codexJs)) {
    console.log('codex.js not found; skip live Codex override check')
    console.log('MCP injection OK')
    return
  }
  const home = path.join(__dirname, '..', '.tmp-build', 'codex-mcp-check')
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(home, { recursive: true })
  try {
    const raw = execFileSync(
      process.execPath,
      [codexJs, 'mcp', 'list', '--json', ...overrides.flatMap((x) => ['-c', x])],
      {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, CODEX_HOME: home, ...mcpEnv },
        encoding: 'utf8',
        windowsHide: true
      }
    )
    const list = JSON.parse(raw)
    console.log(JSON.stringify(list, null, 2))
    const remote = list.find((x) => x.name === 'remote')
    const local = list.find((x) => x.name === 'local')
    assert(remote && remote.transport.url === 'https://example.com/mcp', 'Codex HTTP URL lost')
    assert(remote.transport.env_http_headers.Authorization, 'Codex header env mapping lost')
    assert(local && local.transport.command === 'npx', 'Codex command lost')
    assert(local.transport.args[1] === 'demo server', 'Codex args lost')
    assert(local.transport.env.TOKEN === 'x', 'Codex env lost')
    console.log('Codex parsed overrides OK')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
  console.log('MCP injection OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
