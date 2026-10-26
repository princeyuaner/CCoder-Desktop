/*
 * 临时视觉核对：把工具卡的四种状态塞进转写区后截图。
 * 用法：electron tools/shot-tool-status.cjs <out.png>
 * 需要先跑 npm run build。核对完可删。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'tool-status-ui.png'))
const SID = 'demo-session'
const theme = process.env.SHOT_THEME || 'dark'

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
  defaultCwd: 'C:/proj/ccoder',
  openedCwds: ['C:/proj/ccoder'],
  theme,
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
      channels: [ch('demo-1', 'DeepSeek 中转', 'https://api.deepseek.com/anthropic', 'deepseek-chat')],
      effort: 'medium'
    },
    codex: { enabled: false, activeChannelId: null, channels: [], effort: 'medium' },
    dsh: { enabled: false, activeChannelId: null, channels: [], effort: 'medium' }
  }
}

ipcMain.handle('win:is-maximized', () => false)
ipcMain.handle('settings:get', () => DEMO)
ipcMain.handle('settings:save', (_e, s) => s)
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1180,
    height: 940,
    show: true,
    frame: false,
    backgroundColor: theme === 'light' ? '#f6f6f7' : '#191919',
    webPreferences: {
      preload: path.join(__dirname, '..', 'out', 'preload', 'index.js'),
      sandbox: false
    }
  })

  await win.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'index.html'))
  await sleep(1500)

  const send = (event) => win.webContents.send('session:event', { sessionId: SID, event })
  const status = (s) =>
    win.webContents.send('session:status', {
      sessionId: SID,
      status: s,
      providerSessionId: 'claude-demo'
    })

  status('running')
  send({
    t: 'session_started',
    sessionId: 'claude-demo',
    provider: 'claude',
    model: 'deepseek-v4.1-flash[1m]',
    cwd: DEMO.defaultCwd,
    tools: [],
    permissionMode: 'standard'
  })
  send({ t: 'user_message', text: '把这几个工具的状态显示重做一下，成功和失败要一眼分得清。', at: new Date().toISOString() })
  send({ t: 'text_delta', text: '先跑一轮校验，确认状态徽章在真实转写区里的密度。\n\n' })

  // 成功：Bash
  send({ t: 'tool_call', id: 't1', name: 'Bash', input: { command: 'Get-Process electron', description: 'Inspect running Electron test processes' } })
  await sleep(120)
  send({ t: 'tool_result', id: 't1', status: 'ok', content: 'No process found.' })

  // 成功：Edit，带增删行数
  send({ t: 'tool_call', id: 't2', name: 'Edit', input: { file_path: 'C:/proj/ccoder/tools/verify-mcp-store.cjs', old_string: 'a\nb', new_string: 'a\nb\nc' } })
  await sleep(90)
  send({ t: 'tool_result', id: 't2', status: 'ok', content: 'updated', stat: { added: 3, removed: 2 } })

  // 失败：带错误摘要与退出码
  send({
    t: 'tool_call',
    id: 't3',
    name: 'Bash',
    input: { command: 'node tools/verify-mcp-probe.cjs', description: 'Run MCP probe against fixture server' }
  })
  await sleep(160)
  send({
    t: 'tool_result',
    id: 't3',
    status: 'error',
    content:
      'starting fixture server…\nError: Timed out waiting for response (15000ms)\n    at waitForResponse (C:/proj/ccoder/tools/verify-mcp-probe.cjs:42:11)\n[exit code: 1]'
  })

  // 已拒绝：琥珀色，不走错误红
  send({ t: 'tool_call', id: 't4', name: 'Write', input: { file_path: 'C:/proj/ccoder/tmp/cleanup.txt' } })
  await sleep(80)
  send({ t: 'tool_result', id: 't4', status: 'denied', content: '' })

  // 运行中：不发送结果，让耗时自己跳
  send({
    t: 'tool_call',
    id: 't5',
    name: 'Bash',
    input: { command: 'npm run build', description: 'Bundle and test MCP store/service' }
  })

  // 保持 running，让运行中的耗时继续跳；截图时能看到它真的在走
  await sleep(2200)

  const img = await win.webContents.capturePage()
  fs.writeFileSync(out, img.toPNG())
  console.log(`wrote ${out} (${img.getSize().width}x${img.getSize().height})`)
  app.quit()
})
