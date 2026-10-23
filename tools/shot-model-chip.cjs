/*
 * 实机截图：输入框模型胶囊（CLI 图标 + 渠道名 + 模型名）。
 * 用法：先 electron-vite build，再 electron tools/shot-model-chip.cjs
 * 不参与打包，随时可删。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const OUT_DIR = path.join(__dirname, '..', 'docs', 'mockups')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ch = {
  id: 'demo-1',
  name: 'DeepSeek 官方',
  kind: 'anthropic',
  baseUrl: 'https://api.deepseek.com/anthropic',
  model: 'deepseek-v4.1-flash[1m]',
  models: ['deepseek-v4.1-pro'],
  smallFastModel: '',
  authMode: 'token',
  authToken: 'sk-xxxxxxxxxxxxxxxxxxxx',
  extraEnv: []
}

const DEMO = {
  permissionMode: 'standard',
  defaultCwd: 'C:\\Users\\CY\\Desktop\\CCoder-Desktop',
  openedCwds: ['C:\\Users\\CY\\Desktop\\CCoder-Desktop'],
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
      activeChannelId: ch.id,
      effort: 'medium',
      channels: [ch]
    },
    codex: { enabled: false, activeChannelId: null, effort: 'medium', channels: [] }
  }
}

ipcMain.handle('win:is-maximized', () => false)
ipcMain.handle('settings:get', () => DEMO)
ipcMain.handle('settings:save', (_e, s) => s)
ipcMain.handle('channel:test', () => ({ ok: true, message: 'pong', latencyMs: 120 }))
ipcMain.handle('sessions:list', () => [])
ipcMain.handle('sessions:transcript', () => [])
ipcMain.handle('sessions:delete', () => ({ ok: true }))
ipcMain.handle('sessions:pick-dir', () => null)
ipcMain.handle('session:running', () => [])
ipcMain.handle('session:start', () => 'demo-session')
ipcMain.handle('session:send', () => ({ ok: true }))
ipcMain.handle('session:stop', () => ({}))
ipcMain.handle('workspace:search-files', () => [])

async function shot(win, name) {
  await sleep(300)
  const img = await win.webContents.capturePage()
  const out = path.join(OUT_DIR, name)
  const png = img.toPNG()
  fs.writeFileSync(out, png)
  console.log(`wrote ${out} (${png.length} bytes, empty=${img.isEmpty()})`)
}

app.whenReady().then(async () => {
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
  await sleep(1600)

  const chip = await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.chip--model');
    return el ? { text: el.textContent.trim(), w: el.getBoundingClientRect().width } : null;
  })()`)
  console.log('  chip =', JSON.stringify(chip))

  await shot(win, 'model-chip-live.png')

  await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = 'light'`)
  await sleep(350)
  await shot(win, 'model-chip-live-light.png')

  app.exit(0)
})
