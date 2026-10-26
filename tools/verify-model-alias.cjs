/*
 * 验证模型胶囊不会被 CLI 报回来的内部 id 顶掉。
 *
 * 背景：dsh 运行时目录里 V4.1 Flash 的 id 是 `deepseek-flash`，显示名才是
 * 「DeepSeek-V4.1-Flash」；渠道里用户填的又常是 `deepseek-v4.1-flash`。
 * 三者是同一个模型，胶囊应该显示用户配置的写法，而不是会话启动后 CLI 报的 id。
 *
 * 不接真实 CLI：stub 掉 IPC，直接给一条历史会话，让记录里的模型是 id 写法。
 * 用法（先 npx electron-vite build）：
 *   node node_modules/electron/cli.js tools/verify-model-alias.cjs
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')

const CWD = 'C:/Users/CY/Desktop/CCoder-Desktop'
const SID = 'dsh-hist-1'
const now = Date.now()

const dshCh = {
  id: 'dsh-1',
  name: 'oepncode',
  kind: 'deepseek',
  baseUrl: 'https://opencode.ai/inference/go',
  model: 'deepseek-v4.1-flash',
  models: [],
  smallFastModel: '',
  authMode: 'token',
  secret: { v: 1, enc: '' },
  extraEnv: []
}

const DEMO = {
  permissionMode: 'standard',
  defaultCwd: CWD,
  openedCwds: [CWD],
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
    claude: { enabled: true, activeChannelId: null, channels: [], effort: 'medium', authMode: 'channel', officialModel: '' },
    codex: { enabled: false, activeChannelId: null, channels: [], effort: 'medium', authMode: 'channel', officialModel: '' },
    dsh: {
      enabled: true,
      activeChannelId: dshCh.id,
      channels: [dshCh],
      effort: 'high',
      authMode: 'channel',
      officialModel: 'deepseek-flash'
    }
  }
}

const SESSIONS = [{ id: SID, cwd: CWD, title: 'dsh 历史会话', createdAt: now - 3600_000, updatedAt: now - 60_000, cli: 'dsh' }]

/** 历史记录里 CLI 报的是规范化后的 id，不是用户配置的写法 */
const TRANSCRIPT = [
  {
    t: 'session_started',
    sessionId: SID,
    provider: 'dsh',
    model: 'deepseek-flash',
    cwd: CWD,
    tools: [],
    permissionMode: 'standard'
  },
  { t: 'user_message', text: '你好', at: new Date(now - 120_000).toISOString() },
  { t: 'text_delta', text: '你好，有什么可以帮你的？' }
]

ipcMain.handle('win:is-maximized', () => false)
ipcMain.handle('locale:info', () => ({ systemLocale: 'zh-CN', resolved: 'zh' }))
ipcMain.handle('updater:status', () => ({ state: 'idle' }))
ipcMain.handle('settings:get', () => DEMO)
ipcMain.handle('settings:save', (_e, s) => s)
ipcMain.handle('channel:test', () => ({ ok: true, message: 'pong', latencyMs: 1 }))
ipcMain.handle('sessions:list', () => SESSIONS)
ipcMain.handle('sessions:transcript', () => TRANSCRIPT)
ipcMain.handle('sessions:delete', () => ({ ok: true }))
ipcMain.handle('sessions:pick-dir', () => null)
ipcMain.handle('sessions:meta', () => ({}))
ipcMain.handle('sessions:set-meta', () => ({}))
ipcMain.handle('sessions:search', () => ({ hits: [], truncated: false, scanned: 0, offset: 0, nextOffset: 0, done: true, total: 0 }))
ipcMain.handle('session:running', () => [])
ipcMain.handle('session:start', () => SID)
ipcMain.handle('session:send', () => ({ ok: true }))
for (const name of ['session:stop', 'session:interrupt', 'session:reconfigure', 'session:respond-permission', 'session:respond-question']) {
  ipcMain.on(name, () => undefined)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const js = (w, code) => w.webContents.executeJavaScript(code)
/** 等到条件成立（渲染是异步的，尤其冷启动读设置/会话列表那一下） */
async function waitFor(w, code, timeout = 8000, interval = 200) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await js(w, code)) return true
    await sleep(interval)
  }
  return false
}
let failed = 0
function check(label, cond, detail) {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : String(detail))
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    show: true,
    frame: false,
    backgroundColor: '#191919',
    webPreferences: { preload: path.join(__dirname, '..', 'out', 'preload', 'index.js'), sandbox: false }
  })
  await win.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'index.html'))
  await sleep(1600)

  console.log('\n[1] 打开 dsh 历史会话')
  const listed = await waitFor(win, `document.querySelectorAll('.session').length > 0`)
  if (!listed) {
    const body = await js(win, `document.body.innerText.slice(0, 400)`)
    console.log('  页面正文：', JSON.stringify(body))
  }
  const opened = await js(win, `(() => {
    const row = [...document.querySelectorAll('.session')].find((el) => el.textContent.includes('dsh 历史会话'))
    if (!row) return false
    row.querySelector('.session__main')?.click()
    return true
  })()`)
  check('侧栏里找到并点开了会话', opened)
  await waitFor(win, `!!document.querySelector('.chip--model .chip__model')`)

  console.log('\n[2] 胶囊按用户配置的写法显示')
  const chip = await js(win, `(() => {
    const el = document.querySelector('.chip--model .chip__model')
    const ch = document.querySelector('.chip--model .chip__channel')
    return el ? { model: el.textContent.trim(), channel: ch ? ch.textContent.trim() : '' } : null
  })()`)
  check('胶囊已渲染', !!chip, JSON.stringify(chip))
  check('渠道是 oepncode', chip && chip.channel === 'oepncode', chip?.channel)
  check(
    '模型显示 deepseek-v4.1-flash（不是内部 id）',
    chip && chip.model === 'deepseek-v4.1-flash',
    chip?.model
  )

  app.exit(failed === 0 ? 0 : 1)
})
