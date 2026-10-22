/*
 * 回归：新会话应当自动出现在侧栏，不需要用户点一下别的会话。
 *
 * 背景：侧栏以前只在 turn_end 时刷新，而且是「800ms 内直接丢弃」的节流；
 * CLI 的 jsonl 又是异步落盘的，事件来早/来晚都可能扑空。现在收到
 * session_started 后会用短间隔重试，直到 CLI 的 session id 出现在索引里。
 *
 * 这个脚本模拟真实时序：事件先到，sessions:list 要过 700ms 才包含新会话。
 * 期间**不点击任何会话行**，只等侧栏自己更新。
 *
 * 用法（先 npx electron-vite build）：
 *   node node_modules/electron/cli.js tools/verify-session-auto-refresh.cjs
 * 不参与打包。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CWD = 'C:\\Users\\CY\\Desktop\\CCoder-Desktop'
const NEW_ID = 'new-session-auto-0001'
const NEW_TITLE = '自动出现的新会话'

const DEMO = {
  permissionMode: 'standard',
  defaultCwd: CWD,
  openedCwds: [CWD],
  theme: 'dark',
  uiZoom: 1,
  chatFontSize: 14,
  uiFont: "system-ui, 'Segoe UI', sans-serif",
  monoFont: "'Cascadia Mono', Consolas, monospace",
  showTimestamps: false,
  thinkingOpen: false,
  toolDetail: 'full',
  sendKey: 'enter',
  clis: {
    claude: {
      enabled: true,
      activeChannelId: 'demo-1',
      effort: 'medium',
      channels: [
        {
          id: 'demo-1',
          name: 'Demo',
          kind: 'anthropic',
          baseUrl: 'https://example.invalid/anthropic',
          model: 'demo-model',
          models: [],
          smallFastModel: '',
          authMode: 'token',
          authToken: 'sk-demo',
          extraEnv: []
        }
      ]
    },
    codex: { enabled: false, activeChannelId: null, effort: 'medium', channels: [] }
  }
}

const OLD = {
  id: 'old-session-0001',
  cwd: CWD,
  title: '旧会话',
  createdAt: Date.now() - 3600_000,
  updatedAt: Date.now() - 3600_000,
  cli: 'claude'
}
const NEW = {
  id: NEW_ID,
  cwd: CWD,
  title: NEW_TITLE,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  cli: 'claude'
}

/** 模拟 jsonl 延迟落盘：到这个时刻之后，索引里才看得到新会话 */
let visibleAt = Infinity

ipcMain.handle('win:is-maximized', () => false)
ipcMain.handle('settings:get', () => DEMO)
ipcMain.handle('settings:save', (_e, s) => s)
ipcMain.handle('channel:test', () => ({ ok: true, message: 'pong', latencyMs: 1 }))
ipcMain.handle('sessions:list', () => (Date.now() >= visibleAt ? [NEW, OLD] : [OLD]))
ipcMain.handle('sessions:transcript', () => [])
ipcMain.handle('sessions:delete', () => ({ ok: true }))
ipcMain.handle('sessions:pick-dir', () => null)
ipcMain.handle('session:running', () => [])
ipcMain.handle('session:start', () => 'live-1')
ipcMain.handle('session:send', () => ({ ok: true }))
for (const name of [
  'session:stop',
  'session:interrupt',
  'session:reconfigure',
  'session:respond-permission',
  'session:respond-question'
]) {
  ipcMain.on(name, () => undefined)
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    show: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'out', 'preload', 'index.js'),
      sandbox: false
    }
  })

  await win.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'index.html'))
  await sleep(1400)

  // 事件先到，文件 700ms 后才在索引里出现
  visibleAt = Date.now() + 700
  win.webContents.send('session:event', {
    sessionId: 'live-1',
    event: {
      t: 'session_started',
      sessionId: NEW_ID,
      provider: 'claude',
      model: 'demo-model',
      cwd: CWD,
      tools: [],
      permissionMode: 'standard'
    }
  })

  // 不点击任何会话行，只等自动刷新
  const appeared = await (async () => {
    for (let i = 0; i < 30; i++) {
      const hit = await win.webContents.executeJavaScript(
        `[...document.querySelectorAll('.session__title')].some(
           (x) => x.textContent === ${JSON.stringify(NEW_TITLE)}
         )`
      )
      if (hit) return true
      await sleep(150)
    }
    return false
  })()

  console.log(appeared ? '  PASS 新会话自动出现在侧栏' : '  FAIL 新会话没有自动出现')
  console.log(`\n${appeared ? 'ALL PASS' : '1 FAILED'}\n`)
  setTimeout(() => app.exit(appeared ? 0 : 1), 200)
})
