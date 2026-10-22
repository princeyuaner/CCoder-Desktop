/*
 * 开发辅助：把已构建的渲染层截图，用于核对视觉。
 * 用法：electron tools/shot.cjs <输出.png> [依次点击的选择器...]
 * 选择器按顺序点，每次点完等一会儿 —— 需要先展开菜单再点菜单项的场景用得上。
 * 不参与打包，随时可删。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const out = process.argv[2] || path.join(__dirname, '..', 'shot.png')
const clickSelectors = process.argv.slice(3)

const ch = (id, name, baseUrl, model, authMode) => ({
  id,
  name,
  kind: 'anthropic',
  baseUrl,
  model,
  smallFastModel: '',
  authMode,
  authToken: 'sk-xxxxxxxxxxxxxxxxxxxx',
  extraEnv: []
})

// 截图环境没有真正的主进程，给几个桩让页面能渲染出来
const DEMO = {
  permissionMode: 'standard',
  defaultCwd: '',
  openedCwds: [],
  // 外观 / 对话 / 输入的默认值 —— 截图桩也要给全，否则设置页拿不到这些字段
  theme: process.env.SHOT_THEME || 'dark',
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
      channels: [
        ch('demo-1', 'DeepSeek 中转', 'https://api.deepseek.com/anthropic', 'deepseek-chat', 'token'),
        ch('demo-2', '公司网关', 'https://gw.corp.internal/anthropic', 'claude-sonnet-4-5', 'key')
      ]
    },
    codex: {
      enabled: false,
      activeChannelId: 'demo-x1',
      channels: [ch('demo-x1', 'OpenAI 中转', 'https://api.openai.com/v1', 'gpt-5-codex', 'token')]
    }
  }
}

let saveCount = 0
ipcMain.handle('win:is-maximized', () => false)
ipcMain.handle('settings:get', () => DEMO)
ipcMain.handle('settings:save', (_e, s) => {
  saveCount += 1
  return s
})
ipcMain.handle('channel:test', () => ({
  ok: true,
  message: 'pong',
  latencyMs: 412
}))

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
  await new Promise((r) => setTimeout(r, 1200))

  for (const sel of clickSelectors) {
    const hit = await win.webContents.executeJavaScript(
      `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.click(); return !!el })()`
    )
    if (!hit) console.log('[warn] 没找到选择器:', sel)
    await new Promise((r) => setTimeout(r, 700))
  }

  if (process.env.SHOT_AUTOSAVE) {
    const flush = process.env.SHOT_AUTOSAVE === 'flush'
    const r = await win.webContents.executeJavaScript(`(async () => {
      const el = document.querySelector('.settings__content select');
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      set.call(el, 'light');
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (${flush}) {
        // 改完立刻返回：防抖还没到点，靠离开时的兜底落盘
        document.querySelector('.settings__head .btn--ghost')?.click();
        await new Promise((r) => setTimeout(r, 900));
        return { status: '(已返回)', theme: document.documentElement.dataset.theme };
      }
      await new Promise((r) => setTimeout(r, 1000));
      return {
        status: document.querySelector('.settings__head-right .saved-flash')?.textContent ?? '',
        theme: document.documentElement.dataset.theme
      };
    })()`)
    console.log('AUTOSAVE', JSON.stringify(r), 'saves =', saveCount)
  }

  if (process.env.SHOT_SCROLL === 'bottom') {
    await win.webContents.executeJavaScript(
      `document.querySelector('.settings__content')?.scrollTo(0, 1e9)`
    )
    await new Promise((r) => setTimeout(r, 300))
  }

  const img = await win.webContents.capturePage()
  fs.writeFileSync(out, img.toPNG())
  console.log('wrote', out)
  app.quit()
})
