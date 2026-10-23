/*
 * 实机截图：输入框里的「CLI › 渠道 › 模型」三列选择器。
 * 用法：先 electron-vite build，再 electron tools/shot-model-picker.cjs
 * 不参与打包，随时可删。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const OUT_DIR = path.join(__dirname, '..', 'docs', 'mockups')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const mk = (id, name, model, models) => ({
  id,
  name,
  kind: 'anthropic',
  baseUrl: 'https://api.deepseek.com/anthropic',
  model,
  models,
  smallFastModel: '',
  authMode: 'token',
  authToken: 'sk-xxxxxxxxxxxxxxxxxxxx',
  extraEnv: []
})

const channels = [
  mk('ch-deepseek', 'deepseek', 'deepseek-flash', ['deepseek-pro', 'deepseek-reasoner']),
  mk('ch-volc', '火山方舟', 'deepseek-v3', ['deepseek-r1']),
  mk('ch-local', '本地中转', 'deepseek-flash', [])
]

const codexChannel = {
  id: 'ch-codex',
  name: 'openai',
  kind: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.5',
  models: ['gpt-5.5-codex'],
  smallFastModel: '',
  authMode: 'token',
  authToken: 'sk-xxxxxxxxxxxxxxxxxxxx',
  wireApi: 'responses',
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
      activeChannelId: channels[0].id,
      effort: 'medium',
      channels
    },
    codex: {
      enabled: true,
      activeChannelId: codexChannel.id,
      effort: 'medium',
      channels: [codexChannel]
    }
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
  await sleep(350)
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
  await sleep(1800)

  const opened = await win.webContents.executeJavaScript(`(() => {
    const chip = document.querySelector('.chip--model')
    if (!chip) return 'no chip'
    chip.click()
    return 'clicked'
  })()`)
  console.log('  picker =', opened)
  await sleep(500)

  const info = await win.webContents.executeJavaScript(`(() => {
    const pop = document.querySelector('.picker__pop--left')
    if (!pop) return null
    const r = pop.getBoundingClientRect()
    return {
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      cols: [...pop.querySelectorAll('.mpick__col')].map((c) => c.textContent.trim().slice(0, 60)),
      on: [...pop.querySelectorAll('.mpick__it.is-on')].map((c) => c.textContent.trim())
    }
  })()`)
  console.log('  popup =', JSON.stringify(info))

  await shot(win, 'model-picker-live.png')

  // 悬停 Codex CLI：右两列应切到 Codex 的渠道/模型，但不提交
  await win.webContents.executeJavaScript(`(() => {
    const items = [...document.querySelectorAll('.mpick__col:first-child .mpick__it')]
    const codex = items[1]
    if (codex) codex.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    return !!codex
  })()`)
  await sleep(350)
  await shot(win, 'model-picker-live-hover.png')

  // 浅色主题
  await win.webContents.executeJavaScript(`(() => {
    document.documentElement.dataset.scheme = 'light'
    document.documentElement.dataset.theme = 'light'
  })()`)
  await sleep(450)
  await shot(win, 'model-picker-live-light.png')

  // 换 CLI 的确认条：先发一条消息让会话有内容，再点 Codex
  await win.webContents.executeJavaScript(`(() => {
    document.documentElement.dataset.scheme = 'dark'
    document.documentElement.dataset.theme = 'dark'
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    const ta = document.querySelector('.composer__input')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '帮我看看这个函数')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })()`)
  await sleep(900)

  await win.webContents.executeJavaScript(`(() => {
    const chip = document.querySelector('.chip--model')
    if (chip) chip.click()
    return !!chip
  })()`)
  await sleep(350)
  await win.webContents.executeJavaScript(`(() => {
    const items = [...document.querySelectorAll('.mpick__col:first-child .mpick__it')]
    if (items[1]) items[1].click()
    return items.length
  })()`)
  await sleep(350)
  await shot(win, 'model-picker-live-warn.png')

  app.exit(0)
})
