/*
 * 临时验收：等待 / 思考的星核动效。
 *
 * 用假 IPC 把转写区推成「等待响应」和「思考中」，截图 + 直接问浏览器要
 * animation-name，确认动效真的挂在 DOM 上，而不只是截图里碰巧有一帧。
 *
 * 用法（先 npx electron-vite build）：
 *   node node_modules/electron/cli.js tools/verify-wait-thinking.cjs [dark|light|starfield]
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const THEME = process.argv[2] || 'dark'
const OUT = path.join(__dirname, '..', 'docs', 'mockups')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SID = 'wait-thinking-demo'
const CWD = 'E:\\CCoder-Desktop'

const DEMO = {
  permissionMode: 'standard',
  defaultCwd: CWD,
  openedCwds: [CWD],
  theme: THEME,
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

ipcMain.handle('win:is-maximized', () => false)
ipcMain.handle('settings:get', () => DEMO)
ipcMain.handle('settings:save', (_e, s) => s)
ipcMain.handle('channel:test', () => ({ ok: true, message: 'pong', latencyMs: 1 }))
ipcMain.handle('session:start', () => SID)
ipcMain.handle('session:send', () => ({ ok: true }))
ipcMain.handle('session:reconfigure', () => undefined)
ipcMain.on('session:interrupt', () => undefined)
ipcMain.on('session:stop', () => undefined)
ipcMain.on('session:respond-permission', () => undefined)
ipcMain.handle('session:running', () => [])
ipcMain.handle('sessions:list', () => [])
ipcMain.handle('sessions:transcript', () => [])
ipcMain.handle('sessions:pick-dir', () => null)
ipcMain.handle('sessions:delete', () => ({ ok: true }))

let failed = 0
function check(label, cond, detail) {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : String(detail))
  }
}

const css = (win, sel, props) =>
  win.webContents.executeJavaScript(
    `(() => {
       const el = document.querySelector(${JSON.stringify(sel)});
       if (!el) return null;
       const cs = getComputedStyle(el);
       const out = {};
       for (const p of ${JSON.stringify(props)}) out[p] = cs.getPropertyValue(p);
       return out;
     })()`
  )

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    frame: false,
    backgroundColor: '#191919',
    webPreferences: {
      preload: path.join(__dirname, '..', 'out', 'preload', 'index.js'),
      sandbox: false,
      // 隐藏窗口不画新帧，capturePage 会拿到旧画面
      backgroundThrottling: false
    }
  })

  await win.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'index.html'))
  // 隐藏窗口的合成器不更新，capturePage 会差一帧；显示出来但不抢焦点
  win.showInactive()
  await sleep(1600)

  const send = (event) => win.webContents.send('session:event', { sessionId: SID, event })
  const shot = async (name) => {
    const file = path.join(OUT, `live-${name}-${THEME}.png`)
    win.webContents.invalidate()
    await sleep(450)
    fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG())
    console.log('  截图:', file)
  }

  win.webContents.send('session:status', {
    sessionId: SID,
    status: 'running',
    providerSessionId: 'claude-demo'
  })
  send({
    t: 'session_started',
    sessionId: 'claude-demo',
    provider: 'claude',
    model: 'demo-model',
    cwd: CWD,
    tools: [],
    permissionMode: 'standard'
  })
  send({ t: 'user_message', text: '帮我看看这个项目的结构', at: new Date().toISOString() })
  await sleep(1300)

  console.log(`\n[${THEME}] 等待响应`)
  const orb = await css(win, '.tl__think--wait .tl__orb-core', ['animation-name', 'animation-play-state'])
  check('星核核心在呼吸', orb?.['animation-name'] === 'tl-core-breathe' && orb?.['animation-play-state'] === 'running', JSON.stringify(orb))
  const sat = await css(win, '.tl__think--wait .tl__orb-sat', ['animation-name', 'offset-path'])
  check('卫星沿轨道跑', sat?.['animation-name'] === 'tl-orbit' && sat?.['offset-path'] !== 'none', JSON.stringify(sat))
  const label = await css(win, '.tl__think--wait .tl__fxlabel', ['animation-name', 'background-clip', 'color'])
  check('标题渐变在流动', label?.['animation-name'] === 'tl-sheen' && label?.['background-clip'] === 'text', JSON.stringify(label))
  const timer = await win.webContents.executeJavaScript(
    `document.querySelector('.tl__waittime')?.textContent?.trim() ?? ''`
  )
  check('计时是 mm:ss', /^\d{2}:\d{2}$/.test(timer), timer)
  await shot('wait-thinking-wait')

  console.log(`\n[${THEME}] 思考中（折叠）`)
  send({
    t: 'thinking_delta',
    text: '先看看这个项目的结构。主进程和渲染进程是分开的，状态应该放在会话层，这样切换会话回来时计时还能接上。'
  })
  await sleep(900)
  const peek = await css(win, '.tl__peek-caret', ['animation-name'])
  check('折叠预览的游标在闪', peek?.['animation-name'] === 'tl-caret', JSON.stringify(peek))
  const mini = await css(win, '.tl__think[aria-expanded] .tl__orb--mini', ['width', 'height'])
  check('思考行有迷你星核', mini?.width === '18px' && mini?.height === '18px', JSON.stringify(mini))
  await shot('wait-thinking-collapsed')

  console.log(`\n[${THEME}] 思考中（展开）`)
  await win.webContents.executeJavaScript(
    `document.querySelector('.tl__think[aria-expanded]')?.click()`
  )
  await sleep(700)
  const card = await css(win, '.tl__thinkcard', ['animation-name'])
  check('展开卡边框在转 + 有入场', (card?.['animation-name'] || '').includes('tl-ang-spin') && (card?.['animation-name'] || '').includes('tl-think-in'), JSON.stringify(card))
  const scan = await css(win, '.tl__thinkcard-scan', ['animation-name'])
  check('扫描光带在跑', scan?.['animation-name'] === 'tl-scan', JSON.stringify(scan))
  const body = await css(win, '.tl__thinkbody', ['color', 'background-color', 'z-index'])
  check('正文压在卡片背景上', body?.['z-index'] === '1', JSON.stringify(body))
  await shot('wait-thinking-expanded')

  console.log(failed === 0 ? `\n${THEME} ALL PASS` : `\n${THEME} ${failed} FAILED`)
  app.exit(failed === 0 ? 0 : 1)
})
