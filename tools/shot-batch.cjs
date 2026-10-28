/*
 * 给「批量勾选删除」截图：选择模式、勾选若干条、确认弹窗。
 * 用法（先 npx electron-vite build）：
 *   electron --no-sandbox tools/shot-batch.cjs [输出目录]
 * 不参与打包，随时可删。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

/*
 * electron 启动时 argv 里可能带着 --no-sandbox 之类的开关，脚本路径也在里面，
 * 所以不能直接取 argv[2]。只认「既不是开关、也不是 .cjs/.js」的那个参数。
 */
const argDir = process.argv.slice(1).find((a) => !a.startsWith('-') && !/\.c?js$/i.test(a))
const outDir = path.resolve(argDir || path.join(__dirname, '..', 'docs', 'mockups'))
/** 浅色稿加后缀，别覆盖深色那两张 */
const suffix = process.env.SHOT_THEME === 'light' ? '-light' : ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CWD_A = 'C:\\Users\\CY\\Desktop\\CCoder-Desktop'
const CWD_B = 'C:\\Users\\CY\\Desktop\\agent-kit'
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
  defaultCwd: '',
  openedCwds: [CWD_A, CWD_B],
  theme: process.env.SHOT_THEME || "dark",
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
      effort: 'medium',
      channels: [ch('demo-1', 'DeepSeek 中转', 'https://api.deepseek.com/anthropic', 'deepseek-chat')]
    },
    codex: { enabled: false, activeChannelId: null, effort: 'medium', channels: [] }
  }
}

const now = Date.now()
const SESSIONS = [
  { id: 'a-0001', cwd: CWD_A, title: '给示例服务补一个 /health 健康检查接口', createdAt: now - 1000, updatedAt: now - 1000, cli: 'claude' },
  { id: 'a-0002', cwd: CWD_A, title: '更新提示的位置', createdAt: now - 2000, updatedAt: now - 2000, cli: 'claude' },
  { id: 'a-0003', cwd: CWD_A, title: '把渠道测试改成走真实请求', createdAt: now - 3000, updatedAt: now - 3000, cli: 'claude' },
  { id: 'b-0001', cwd: CWD_B, title: '重构 run-state 的任务队列', createdAt: now - 4000, updatedAt: now - 4000, cli: 'claude' },
  { id: 'b-0002', cwd: CWD_B, title: '修 permission-preview 的越权提示', createdAt: now - 5000, updatedAt: now - 5000, cli: 'claude' }
]

let liveSeq = 0
ipcMain.handle('win:is-maximized', () => false)
ipcMain.handle('settings:get', () => DEMO)
ipcMain.handle('settings:save', (_e, s) => s)
ipcMain.handle('sessions:list', () => SESSIONS)
ipcMain.handle('sessions:transcript', () => [])
ipcMain.handle('sessions:meta', () => ({}))
ipcMain.handle('sessions:set-meta', () => ({}))
ipcMain.handle('sessions:search', () => ({ hits: [], total: 0 }))
ipcMain.handle('sessions:delete', () => ({ ok: true }))
ipcMain.handle('sessions:pick-dir', () => null)
ipcMain.handle('session:running', () => [])
ipcMain.handle('session:start', () => `live-${++liveSeq}`)
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

const js = (w, code) => w.webContents.executeJavaScript(code)
const shot = async (w, name) => {
  const img = await w.webContents.capturePage()
  fs.writeFileSync(path.join(outDir, name), img.toPNG())
  console.log('wrote', name)
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(outDir, { recursive: true })
  } catch {
    // 目录已经有了；不是错误
  }
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
  await sleep(2400)

  // 进入选择模式
  await js(win, `[...document.querySelectorAll('.sidebar__section-tools .iconbtn')].at(-1)?.click()`)
  await sleep(350)
  // 勾第一组的三条，另一个工作区勾一条
  await js(
    win,
    `(() => {
       const g = [...document.querySelectorAll('.sidebar .wsgroup')]
         .find((el) => el.querySelector('.wsgroup__name')?.textContent === 'CCoder-Desktop');
       g?.querySelector('.wsgroup__head .cbx')?.click();
       return true;
     })()`
  )
  await sleep(300)
  // 取消一条，露出半选态
  await js(
    win,
    `(() => {
       const row = [...document.querySelectorAll('.sidebar .session')].find(
         (r) => r.querySelector('.session__title')?.textContent === '把渠道测试改成走真实请求'
       );
       row?.querySelector('.session__main')?.click();
       return true;
     })()`
  )
  await sleep(300)
  await js(
    win,
    `(() => {
       const row = [...document.querySelectorAll('.sidebar .session')].find(
         (r) => r.querySelector('.session__title')?.textContent === '重构 run-state 的任务队列'
       );
       row?.querySelector('.session__main')?.click();
       return true;
     })()`
  )
  await sleep(400)
  await shot(win, `bd-real-select${suffix}.png`)

  // 让一条跑起来，再开确认弹窗
  win.webContents.send('session:status', {
    sessionId: 'live-run',
    status: 'running',
    providerSessionId: 'a-0001'
  })
  await sleep(400)
  await js(win, `document.querySelector('.batchbar__btn--danger')?.click()`)
  await sleep(500)
  await shot(win, `bd-real-confirm${suffix}.png`)

  app.exit(0)
})
