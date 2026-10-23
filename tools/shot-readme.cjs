/*
 * 开发辅助：生成 README 英文版用的界面截图（英文 UI + 英文演示内容）。
 * 用法：
 *   ELECTRON_DISABLE_SANDBOX=1 electron tools/shot-readme.cjs
 * 输出：docs/screenshots/chat.en.png、chat-end.en.png
 * 不参与打包。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const SID = 'demo-session'
const OUT = path.join(__dirname, '..', 'docs', 'screenshots')
const CWD = 'C:/proj/ccoder-demo'

const ch = (id, name, baseUrl, model) => ({
  id,
  name,
  kind: 'anthropic',
  baseUrl,
  model,
  smallFastModel: '',
  authMode: 'token',
  authToken: 'sk-xxxxxxxxxxxxxxxxxxxx',
  extraEnv: []
})

const DEMO = {
  permissionMode: 'standard',
  defaultCwd: CWD,
  openedCwds: [CWD],
  language: 'en',
  theme: 'dark',
  uiZoom: 1,
  chatFontSize: 14,
  uiFont: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
  monoFont: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
  showTimestamps: false,
  thinkingOpen: false,
  toolDetail: 'full',
  sendKey: 'enter',
  clis: {
    claude: {
      enabled: true,
      activeChannelId: 'demo-1',
      channels: [ch('demo-1', 'Company Gateway', 'https://gw.corp.internal/anthropic', 'claude-sonnet-4-5')],
      effort: 'medium'
    },
    codex: { enabled: false, activeChannelId: null, channels: [], effort: 'medium' },
    dsh: { enabled: false, activeChannelId: null, channels: [], effort: 'medium', authMode: 'official' }
  }
}

ipcMain.handle('locale:info', () => ({ systemLocale: 'en-US', resolved: 'en' }))
ipcMain.handle('win:is-maximized', () => false)
ipcMain.handle('settings:get', () => DEMO)
ipcMain.handle('settings:save', (_e, s) => s)
ipcMain.handle('channel:test', () => ({ ok: true, message: 'pong', latencyMs: 412 }))
ipcMain.handle('session:running', () => null)
ipcMain.handle('session:start', () => SID)
ipcMain.handle('session:send', () => ({ ok: true }))
ipcMain.handle('session:reconfigure', () => undefined)
ipcMain.on('session:interrupt', () => undefined)
ipcMain.on('session:stop', () => undefined)
ipcMain.on('session:respond-permission', () => undefined)
ipcMain.handle('sessions:list', () => [])
ipcMain.handle('sessions:transcript', () => [])
ipcMain.handle('sessions:pick-dir', () => null)
ipcMain.handle('sessions:delete', () => ({ ok: true }))
ipcMain.handle('updater:status', () => ({ state: 'idle' }))
ipcMain.handle('claude:auth-status', () => ({
  installed: true,
  path: 'C:\\Users\\CY\\AppData\\Roaming\\npm\\claude.cmd',
  version: '2.1.303 (Claude Code)',
  loggedIn: true,
  authMethod: 'oauth_token',
  apiProvider: 'firstParty',
  checkedAt: Date.now()
}))
ipcMain.handle('claude:auth-login-state', () => ({
  phase: 'idle',
  url: null,
  running: false,
  output: ''
}))

const read = (id, file, content) => [
  { t: 'tool_call', id, name: 'Read', input: { file_path: `${CWD}/${file}` } },
  { t: 'tool_result', id, status: 'ok', content }
]
const edit = (id, file, added, removed) => [
  { t: 'tool_call', id, name: 'Edit', input: { file_path: `${CWD}/${file}`, old_string: 'a', new_string: 'b' } },
  { t: 'tool_result', id, status: 'ok', content: 'The file has been updated.', stat: { added, removed } },
  { t: 'file_change', path: `${CWD}/${file}`, added, removed, source: 'agent' }
]

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    show: true,
    frame: false,
    backgroundColor: '#191919',
    webPreferences: {
      preload: path.join(__dirname, '..', 'out', 'preload', 'index.js'),
      sandbox: false
    }
  })

  await win.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'index.html'))
  await new Promise((r) => setTimeout(r, 1500))

  const send = (event) => win.webContents.send('session:event', { sessionId: SID, event })
  const status = (s) => win.webContents.send('session:status', { sessionId: SID, status: s })
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const capture = async (name) => {
    const img = await win.webContents.capturePage()
    const file = path.join(OUT, name)
    fs.writeFileSync(file, img.toPNG())
    console.log('wrote', file)
  }

  status('running')
  send({
    t: 'session_started',
    sessionId: 'claude-demo',
    provider: 'claude',
    model: 'claude-sonnet-4-5',
    cwd: CWD,
    tools: [],
    permissionMode: 'standard'
  })
  send({
    t: 'user_message',
    text: 'Add a /health endpoint to this demo service, pull duration formatting into a shared helper, then have a subagent review the module split independently.',
    at: new Date().toISOString()
  })
  send({
    t: 'thinking_delta',
    text: 'Break this into tasks that can be checked off one by one, implement them in order, and finish with an independent review by an Explore subagent.'
  })
  send({
    t: 'text_delta',
    text: "I'll split this into trackable tasks, then work through them in order.\n\nFirst, let me see how the existing routes are organized."
  })
  read('r1', 'src/servers.ts', 'export const routes = []').forEach(send)
  send({ t: 'text_delta', text: 'The routes are an array — adding a matching `/health` entry is enough.' })

  const tasks = [
    { subject: 'Map the existing service structure', description: 'Find route registration and startup flow', activeForm: 'Mapping the service structure' },
    { subject: 'Extract duration formatting into a helper', description: 'Move formatting into src/utils.ts', activeForm: 'Extracting the duration helper' },
    { subject: 'Add the /health endpoint', description: 'Return uptime, rss and ok', activeForm: 'Adding the /health endpoint' },
    { subject: 'Have Explore review the module split', description: 'Independent review of boundaries', activeForm: 'Reviewing the module split' },
    { subject: 'Run an end-to-end smoke test', description: 'Start the service and hit /health', activeForm: 'Running the smoke test' }
  ]
  tasks.forEach((task, i) => {
    const id = `tc${i}`
    send({ t: 'tool_call', id, name: 'TaskCreate', input: task })
    send({
      t: 'tool_result',
      id,
      status: 'ok',
      content: `Task #${i + 1} created successfully: ${task.subject}`,
      task: { created: { id: String(i + 1), subject: task.subject } }
    })
  })
  const update = (id, taskId, from, to) => {
    send({ t: 'tool_call', id, name: 'TaskUpdate', input: { taskId: String(taskId), status: to } })
    send({
      t: 'tool_result',
      id,
      status: 'ok',
      content: `Updated task #${taskId} status`,
      task: { updated: { taskId: String(taskId), from, to } }
    })
  }
  update('tu1', 1, 'pending', 'completed')
  update('tu2', 2, 'pending', 'completed')
  update('tu3', 3, 'pending', 'completed')
  update('tu5', 5, 'pending', 'in_progress')

  edit('e1', 'src/servers.ts', 8, 0).forEach(send)
  edit('e2', 'src/utils.ts', 9, 0).forEach(send)
  send({
    t: 'tool_call',
    id: 'ag1',
    name: 'Agent',
    input: {
      description: 'Review the module split',
      subagent_type: 'Explore',
      prompt: 'Review the module boundaries under src/'
    }
  })
  send({
    t: 'tool_result',
    id: 'ag1',
    status: 'ok',
    content: 'Two places mix route registration with startup logic; utils.ts now owns formatting.',
    agent: {
      agentId: 'agent-demo-1',
      agentType: 'Explore',
      status: 'completed',
      durationMs: 19000,
      totalTokens: 12400,
      toolUseCount: 18,
      toolStats: {
        readCount: 10,
        searchCount: 3,
        bashCount: 4,
        editFileCount: 0,
        linesAdded: 0,
        linesRemoved: 0,
        otherToolCount: 1
      },
      summary: 'Two places mix route registration with startup logic; utils.ts now owns formatting.'
    }
  })
  send({
    t: 'tool_call',
    id: 'b1',
    name: 'Bash',
    input: { command: 'npm run typecheck', description: 'Run the type checker' }
  })
  send({ t: 'tool_result', id: 'b1', status: 'ok', content: 'typecheck:node ✓\ntypecheck:web ✓' })
  send({
    t: 'text_delta',
    text: 'The health endpoint and the shared duration helper are in place. The subagent review found no breakage in the existing routes.'
  })
  send({
    t: 'turn_end',
    durationMs: 8400,
    steps: 5,
    usage: {
      inputTokens: 1800,
      outputTokens: 420,
      cacheReadTokens: 2600,
      cacheCreationTokens: 180,
      tokensPerSecond: 74,
      contextPercent: 6,
      contextTokens: 11400
    }
  })
  status('idle')
  await wait(1200)
  await capture('chat.en.png')

  // 第二轮：补 README，截图停在对话底部
  status('running')
  send({
    t: 'user_message',
    text: 'Write the /health response fields into the README and explain how to start the service locally.',
    at: new Date().toISOString()
  })
  send({ t: 'text_delta', text: 'I’ll read the README first, then add a short section to the existing structure.' })
  read('r2', 'README.md', '# ccoder-demo').forEach(send)
  send({ t: 'text_delta', text: 'README updated. One task left: start the service and run the smoke test.' })
  edit('e3', 'README.md', 13, 0).forEach(send)
  send({
    t: 'text_delta',
    text: 'The README now documents the startup command and the /health payload. The full review report is available from the run panel.'
  })
  send({
    t: 'turn_end',
    durationMs: 3600,
    steps: 2,
    usage: {
      inputTokens: 900,
      outputTokens: 180,
      cacheReadTokens: 3200,
      cacheCreationTokens: 90,
      tokensPerSecond: 62,
      contextPercent: 7,
      contextTokens: 13800
    }
  })
  status('idle')
  await wait(1000)
  await win.webContents.executeJavaScript(
    `document.querySelector('.transcript')?.scrollTo(0, 1e9)`
  )
  await wait(400)
  await capture('chat-end.en.png')

  app.quit()
})
