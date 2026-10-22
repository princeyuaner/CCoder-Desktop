/*
 * 回归：工具卡必须在**入参开始流**时就出现，不能等整个 tool_call 生成完。
 *
 * 背景：写大文件时，模型的入参（也就是整个文件内容）可能要流几十秒；
 * 完整的 tool_call 事件（带 input）只在块结束时才到。以前界面在这段时间
 * 完全空着，看起来像卡死。现在 content_block_start 一到就发 tool_started，
 * 先把卡片画出来；完整入参到达后按 id 原地补全，不能变成两张卡。
 *
 * 用法（先 npx electron-vite build）：
 *   node node_modules/electron/cli.js tools/verify-tool-start.cjs
 * 不参与打包。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SID = 'tool-start-demo'
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
    console.log('  FAIL', label, detail === undefined ? '' : JSON.stringify(detail))
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
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
  const cards = () =>
    win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.tool')].map((el) => ({
         running: el.classList.contains('is-running'),
         subject: el.querySelector('.tool__subject')?.textContent ?? '',
         time: el.querySelector('.tool__time')?.textContent ?? '',
         stat: el.querySelector('.tool__stat')?.textContent ?? ''
       }))`
    )

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
  send({ t: 'user_message', text: '把配置写成文件。', at: new Date().toISOString() })

  console.log('\n[1] 入参刚开始流：卡片就应该出现')
  send({ t: 'tool_started', id: 'w1', name: 'Write' })
  await sleep(200)
  let list = await cards()
  check('只有一张工具卡', list.length === 1, list)
  check('  处于运行中', list[0]?.running === true, list[0])
  check('  显示「运行中」', list[0]?.time === '运行中', list[0]?.time)
  // 「运行中」要一直在动：静止的文字看起来就像卡死
  const anim = await win.webContents.executeJavaScript(
    `(() => {
       const el = document.querySelector('.tool.is-running .tool__time');
       if (!el) return null;
       const cs = getComputedStyle(el);
       return { name: cs.animationName, state: cs.animationPlayState };
     })()`
  )
  check('  「运行中」在闪（pulse）', anim?.name === 'pulse' && anim?.state === 'running', anim)

  // 留一张「入参还在流」时的截图，方便肉眼确认卡片不是空的
  const shot = path.join(require('node:os').tmpdir(), 'ccoder-tool-start.png')
  require('node:fs').writeFileSync(shot, (await win.webContents.capturePage()).toPNG())
  console.log('  截图:', shot)

  console.log('\n[2] 从流里认出 file_path：文件名提前补上')
  send({
    t: 'tool_started',
    id: 'w1',
    name: 'Write',
    path: 'C:\\Users\\CY\\Desktop\\CCoder-Desktop\\src\\config\\app.json'
  })
  await sleep(150)
  list = await cards()
  check('还是一张卡', list.length === 1, list.length)
  check('  主题变成文件名', list[0]?.subject === 'app.json', list[0]?.subject)

  console.log('\n[3] 完整入参到达：原地补全，不新增卡片')
  send({
    t: 'tool_call',
    id: 'w1',
    name: 'Write',
    input: {
      file_path: 'C:\\Users\\CY\\Desktop\\CCoder-Desktop\\src\\config\\app.json',
      content: '{\n  "theme": "dark"\n}\n'
    }
  })
  await sleep(150)
  list = await cards()
  check('仍然只有一张卡', list.length === 1, list.length)
  check('  文件名不变', list[0]?.subject === 'app.json', list[0]?.subject)
  check('  行数统计补上（+3）', (list[0]?.stat || '').includes('+3'), list[0]?.stat)
  check('  还在运行中', list[0]?.running === true, list[0])

  console.log('\n[4] 回执到达：收尾')
  send({ t: 'tool_result', id: 'w1', status: 'ok', content: 'File created successfully' })
  await sleep(150)
  list = await cards()
  check('不再显示运行中', list[0]?.running === false, list[0])
  check('耗时已显示', /^\d+(\.\d+)?(ms|s)$/.test(list[0]?.time || ''), list[0]?.time)

  console.log(`\n${failed === 0 ? '全部通过 ✓' : `${failed} 项失败 ✗`}`)
  app.exit(failed === 0 ? 0 : 1)
})
