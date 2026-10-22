/*
 * 回归：松散有序列表不能每项都显示 1。
 *
 * 背景：模型回复经常在编号项之间空一行（合法 Markdown 的 loose list）。
 * 以前的解析器遇到空行就结束列表，下一项另起一个 <ol> —— 而 HTML 的
 * <ol> 默认从 1 开始，整段就变成「1. 1. 1.」。同样，缩进的续行会掉出去
 * 变成独立段落。这里直接查渲染后的 DOM。
 *
 * 用法（先 npx electron-vite build）：
 *   node node_modules/electron/cli.js tools/verify-markdown-list.cjs
 * 不参与打包。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SID = 'markdown-list-demo'
const CWD = 'C:\\Users\\CY\\Desktop\\CCoder-Desktop'

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

ipcMain.handle('win:is-maximized', () => false)
ipcMain.handle('settings:get', () => DEMO)
ipcMain.handle('settings:save', (_e, s) => s)
ipcMain.handle('channel:test', () => ({ ok: true, message: 'pong', latencyMs: 1 }))
ipcMain.handle('session:start', () => SID)
ipcMain.handle('session:send', () => ({ ok: true }))
ipcMain.handle('session:reconfigure', () => undefined)
ipcMain.handle('session:running', () => [])
ipcMain.on('session:interrupt', () => undefined)
ipcMain.on('session:stop', () => undefined)
ipcMain.on('session:respond-permission', () => undefined)
ipcMain.handle('sessions:list', () => [])
ipcMain.handle('sessions:transcript', () => [])
ipcMain.handle('sessions:pick-dir', () => null)
ipcMain.handle('sessions:delete', () => ({ ok: true }))

let failed = 0
function check(label, cond, detail) {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : JSON.stringify(detail))
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1100,
    height: 900,
    show: true,
    frame: false,
    backgroundColor: '#191919',
    webPreferences: {
      preload: path.join(__dirname, '..', 'out', 'preload', 'index.js'),
      sandbox: false
    }
  })

  await win.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'index.html'))
  await sleep(1500)

  const send = (event) => win.webContents.send('session:event', { sessionId: SID, event })
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
  send({ t: 'user_message', text: '渲染一段列表', at: new Date().toISOString() })

  // 1–6 每项之间空一行（松散列表），且带缩进续行；后面再跟一段正文切断列表
  const md = [
    '1. **删除渠道没有确认**',
    '   `ChannelForm.tsx:190` 直接调 deleteChannel。',
    '',
    '2. **测试结果会过期**',
    '   `SettingsPage.tsx:152` 只在切渠道时清空。',
    '',
    '3. **显示密钥串渠道**',
    '   给组件加 key。',
    '',
    '4. **activeChannelId 没校验**',
    '   加载时回落。',
    '',
    '5. **空渠道可以设为当前**',
    '   用 channelIsUsable 挡住。',
    '',
    '6. **保存失败没原因**',
    '   把 message 露出来。',
    '',
    '普通段落，切断列表。',
    '',
    '3. 从三开始',
    '4. 第四项',
    '',
    '- 无序一',
    '',
    '- 无序二'
  ].join('\n')
  send({ t: 'text_delta', text: md })
  await sleep(400)

  const got = await win.webContents.executeJavaScript(`(() => {
    const md = [...document.querySelectorAll('.md')]
      .find((el) => el.textContent.includes('删除渠道没有确认'));
    if (!md) return null;
    return {
      ols: [...md.querySelectorAll('ol')].map((el) => ({
        start: el.getAttribute('start'),
        items: [...el.children].map((li) => li.textContent.trim())
      })),
      uls: [...md.querySelectorAll('ul')].map((el) =>
        [...el.children].map((li) => li.textContent.trim())
      ),
      paras: [...md.querySelectorAll('.md-p')].map((el) => el.textContent.trim())
    };
  })()`)

  check('找到渲染出来的 Markdown', !!got, got)

  console.log('\n[1] 松散有序列表')
  check('两组有序列表分开渲染', got?.ols.length === 2, got?.ols.length)
  check('第一组 6 项', got?.ols[0]?.items.length === 6, got?.ols[0]?.items.length)
  check('从 1 开始', !got?.ols[0]?.start || got.ols[0].start === '1', got?.ols[0]?.start)

  console.log('\n[2] 缩进续行属于当前项')
  check(
    '第 1 项包含续行内容',
    !!got?.ols[0]?.items[0]?.includes('ChannelForm.tsx:190'),
    got?.ols[0]?.items[0]
  )
  check(
    '续行没有掉成独立段落',
    !got?.paras.some((p) => p.includes('ChannelForm.tsx:190')),
    got?.paras
  )

  console.log('\n[3] 起始编号')
  check('第二组从 3 开始', got?.ols[1]?.start === '3', got?.ols[1]?.start)
  check('第二组 2 项', got?.ols[1]?.items.length === 2, got?.ols[1]?.items.length)

  console.log('\n[4] 松散无序列表')
  check('只有 1 个 <ul>', got?.uls.length === 1, got?.uls.length)
  check('2 项', got?.uls[0]?.length === 2, got?.uls[0]?.length)

  // 留一张图，肉眼确认序号不是一排 1
  const shot = path.join(require('node:os').tmpdir(), 'ccoder-markdown-list.png')
  require('node:fs').writeFileSync(shot, (await win.webContents.capturePage()).toPNG())
  console.log('  截图:', shot)

  console.log(`\n${failed === 0 ? '全部通过 ✓' : `${failed} 项失败 ✗`}`)
  app.exit(failed === 0 ? 0 : 1)
})
