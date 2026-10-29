/*
 * Hooks 原生层验证：不碰真实 ~/.claude，全部在临时目录里跑。
 * 用法：npm run verify:hooks
 */
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const hooks = require('../.tmp-build/hooks-native.cjs')

let failed = 0
function check(label, cond, detail) {
  if (cond) {
    console.log('  ok  ' + label)
  } else {
    failed++
    console.error('  FAIL ' + label + (detail ? ' — ' + detail : ''))
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-hooks-'))
const claudeDir = path.join(tmp, 'claude')
const proj = path.join(tmp, 'proj')
const pluginDir = path.join(tmp, 'plugin')
const ctx = {
  claudeDir,
  backupRoot: path.join(tmp, 'backups'),
  disabledPath: path.join(tmp, 'disabled.json')
}

fs.mkdirSync(path.join(proj, '.claude'), { recursive: true })
fs.mkdirSync(path.join(claudeDir, 'plugins'), { recursive: true })
fs.mkdirSync(path.join(pluginDir, 'hooks'), { recursive: true })

const userSettings = path.join(claudeDir, 'settings.json')
fs.writeFileSync(
  userSettings,
  `{
  // keep this comment
  "theme": "contrast",
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node guard.mjs", "timeout": 10 } ] }
    ],
    "PostToolUse": [
      { "hooks": [ { "type": "command", "command": "node post.mjs" } ] }
    ]
  }
}
`,
  'utf8'
)

fs.writeFileSync(
  path.join(pluginDir, 'hooks', 'hooks.json'),
  JSON.stringify(
    {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'node plugin.mjs' }] }
        ]
      }
    },
    null,
    2
  ),
  'utf8'
)
fs.writeFileSync(
  path.join(claudeDir, 'plugins', 'installed_plugins.json'),
  JSON.stringify(
    {
      version: 2,
      plugins: {
        'demo@market': [{ scope: 'user', installPath: pluginDir }]
      }
    },
    null,
    2
  ),
  'utf8'
)

async function run() {
  console.log('read')
  let list = hooks.listHooksNative(proj, ctx)
  check('user hooks read', list.hooks.filter((h) => h.scope === 'user').length === 2)
  check('plugin hook read', list.hooks.filter((h) => h.scope === 'plugin').length === 1)
  check('plugin is read-only', list.hooks.find((h) => h.scope === 'plugin').readOnly === true)
  check('plugin name attached', list.hooks.find((h) => h.scope === 'plugin').pluginName === 'demo')
  check('sources include plugin', list.sources.some((s) => s.scope === 'plugin' && s.exists))

  console.log('create project hook')
  const saved = hooks.saveHookNative(
    {
      scope: 'project',
      cwd: proj,
      event: 'PreToolUse',
      matcher: 'Edit|Write',
      hook: { type: 'command', command: 'node protect.mjs', timeout: 15 },
      enabled: true
    },
    proj,
    ctx
  )
  check('save ok', saved.ok, saved.errorKey)
  const projectFile = path.join(proj, '.claude', 'settings.json')
  check('project file created', fs.existsSync(projectFile))
  let projectText = fs.readFileSync(projectFile, 'utf8')
  check('project hook written', projectText.includes('protect.mjs'))
  check('user comment preserved', fs.readFileSync(userSettings, 'utf8').includes('// keep this comment'))

  list = saved.list
  let created = list.hooks.find((h) => h.scope === 'project')
  check('created hook listed', !!created)
  const createdId = created && created.id

  console.log('disable / enable')
  let disabled = hooks.setHookEnabledNative(createdId, false, proj, ctx)
  check('disable ok', disabled.ok, disabled.errorKey)
  projectText = fs.readFileSync(projectFile, 'utf8')
  check('hook removed from settings', !projectText.includes('protect.mjs'))
  const registry = JSON.parse(fs.readFileSync(ctx.disabledPath, 'utf8'))
  check('disabled registry has entry', registry.entries.length === 1)
  let view = disabled.list.hooks.find((h) => h.id === createdId)
  check('disabled view listed', !!view && view.enabled === false && view.disabled === true)

  let enabled = hooks.setHookEnabledNative(createdId, true, proj, ctx)
  check('enable ok', enabled.ok, enabled.errorKey)
  projectText = fs.readFileSync(projectFile, 'utf8')
  check('hook restored to settings', projectText.includes('protect.mjs'))
  check('registry empty after enable', JSON.parse(fs.readFileSync(ctx.disabledPath, 'utf8')).entries.length === 0)

  console.log('edit')
  const edited = hooks.saveHookNative(
    {
      id: createdId,
      scope: 'project',
      cwd: proj,
      event: 'PreToolUse',
      matcher: 'Edit|Write',
      hook: { type: 'command', command: 'node protect-v2.mjs', timeout: 20 },
      enabled: true
    },
    proj,
    ctx
  )
  check('edit ok', edited.ok, edited.errorKey)
  projectText = fs.readFileSync(projectFile, 'utf8')
  check('new command written', projectText.includes('protect-v2.mjs'))
  check('old command removed', !projectText.includes('protect.mjs"'))
  check('still one project hook', edited.list.hooks.filter((h) => h.scope === 'project').length === 1)

  console.log('prompt / http / mcp_tool types')
  const promptSave = hooks.saveHookNative(
    {
      scope: 'local',
      cwd: proj,
      event: 'Stop',
      matcher: '',
      hook: { type: 'prompt', prompt: 'Verify tests passed.', model: 'haiku' },
      enabled: true
    },
    proj,
    ctx
  )
  check('prompt save ok', promptSave.ok, promptSave.errorKey)
  check(
    'prompt local file has type',
    fs.readFileSync(path.join(proj, '.claude', 'settings.local.json'), 'utf8').includes('"type": "prompt"')
  )

  const httpSave = hooks.saveHookNative(
    {
      scope: 'user',
      cwd: '',
      event: 'Notification',
      matcher: '',
      hook: {
        type: 'http',
        url: 'https://example.com/hook',
        headers: { Authorization: 'Bearer $TOKEN' },
        allowedEnvVars: ['TOKEN'],
        timeout: 8
      },
      enabled: true
    },
    proj,
    ctx
  )
  check('http save ok', httpSave.ok, httpSave.errorKey)
  check(
    'http hook written',
    fs.readFileSync(userSettings, 'utf8').includes('https://example.com/hook')
  )

  const mcpSave = hooks.saveHookNative(
    {
      scope: 'user',
      cwd: '',
      event: 'Stop',
      matcher: '',
      hook: {
        type: 'mcp_tool',
        server: 'demo',
        tool: 'notify',
        input: { path: '${tool_input.file_path}' }
      },
      enabled: true
    },
    proj,
    ctx
  )
  check('mcp_tool save ok', mcpSave.ok, mcpSave.errorKey)
  check(
    'mcp_tool input written',
    fs.readFileSync(userSettings, 'utf8').includes('"server": "demo"') &&
      fs.readFileSync(userSettings, 'utf8').includes('tool_input.file_path')
  )

  console.log('delete')
  const currentProject = edited.list.hooks.find((h) => h.scope === 'project')
  const removed = hooks.removeHookNative(currentProject.id, proj, ctx)
  check('delete ok', removed.ok, removed.errorKey)
  check('deleted from settings', !fs.readFileSync(projectFile, 'utf8').includes('protect-v2.mjs'))

  console.log('unsupported type is read-only')
  const withUnknown = fs.readFileSync(userSettings, 'utf8').replace(
    '"hooks": {',
    '"hooks": {\n    "ConfigChange": [ { "hooks": [ { "type": "future_hook", "foo": 1 } ] } ],'
  )
  fs.writeFileSync(userSettings, withUnknown, 'utf8')
  list = hooks.listHooksNative(proj, ctx)
  const unknown = list.hooks.find((h) => h.hook.type === 'future_hook')
  check('unknown listed', !!unknown)
  check('unknown read-only', unknown && unknown.readOnly === true && unknown.readOnlyReason === 'unsupported')

  const deletedUnknown = hooks.removeHookNative(unknown.id, proj, ctx)
  check('unsupported can be deleted', deletedUnknown.ok, deletedUnknown.errorKey)
  check('unsupported removed', !fs.readFileSync(userSettings, 'utf8').includes('future_hook'))

  console.log('test run')
  const tested = await hooks.testHookNative(
    {
      scope: 'project',
      cwd: proj,
      event: 'Stop',
      matcher: '',
      hook: {
        type: 'command',
        command: process.execPath,
        args: [
          '-e',
          'process.stdin.resume();process.stdin.on("data",()=>{console.log("hook-ok")})'
        ]
      }
    },
    ctx
  )
  check('test exit 0', tested.exitCode === 0, JSON.stringify(tested))
  check('test captured stdout', tested.stdout.includes('hook-ok'), JSON.stringify(tested))

  console.log('')
  if (failed) {
    console.error(failed + ' check(s) failed')
    process.exitCode = 1
  } else {
    console.log('all hooks checks passed')
  }
}

run()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })
