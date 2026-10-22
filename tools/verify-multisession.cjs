/*
 * 验证「多个会话同时运行」这条链路。
 *
 * 不接真实 CLI：stub 掉 main 的 IPC，只检查 renderer 的生命周期决策 ——
 *   1. 切到另一条会话时，前一条**不** stop；
 *   2. 后台 Live 的事件会继续累积，切回来不重新 start、转写完整；
 *   3. 打开/关闭设置页不产生 start/stop；
 *   4. /clear 与删除各只 stop 一次；
 *   5. 新会话拿到 CLI id 后变成侧栏行，点它不会二次 start。
 *
 * 用法（先 npx electron-vite build）：
 *   node node_modules/electron/cli.js tools/verify-multisession.cjs
 * 不参与打包，随时可删。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CWD_A = 'C:\\Users\\CY\\Desktop\\CCoder-Desktop'

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
  openedCwds: [CWD_A],
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
      activeChannelId: 'demo-1',
      effort: 'medium',
      channels: [
        ch('demo-1', 'DeepSeek 中转', 'https://api.deepseek.com/anthropic', 'deepseek-chat')
      ]
    },
    codex: { enabled: false, activeChannelId: null, effort: 'medium', channels: [] }
  }
}

const now = Date.now()
const SESSIONS = [
  { id: 'a-session-0001', cwd: CWD_A, title: '会话 A', updatedAt: now - 10_000, cli: 'claude' },
  { id: 'b-session-0002', cwd: CWD_A, title: '会话 B', updatedAt: now - 60_000, cli: 'claude' }
]

const starts = []
const stops = []
const sends = []
const deletes = []
let liveSeq = 0

ipcMain.handle('win:is-maximized', () => false)
ipcMain.handle('settings:get', () => DEMO)
ipcMain.handle('settings:save', (_e, s) => s)
ipcMain.handle('channel:test', () => ({ ok: true, message: 'pong', latencyMs: 412 }))
ipcMain.handle('sessions:list', () => SESSIONS)
ipcMain.handle('sessions:transcript', () => [])
ipcMain.handle('sessions:delete', (_e, cwd, id) => {
  deletes.push({ cwd, id })
  return { ok: true }
})
ipcMain.handle('sessions:pick-dir', () => null)
ipcMain.handle('session:running', () => [])
ipcMain.handle('session:start', (_e, options) => {
  const id = `live-${++liveSeq}`
  starts.push({ id, options })
  return id
})
ipcMain.handle('session:send', (_e, id, input) => {
  sends.push({ id, input })
  return { ok: true }
})
// 其余通道静默收下即可
for (const name of [
  'session:stop',
  'session:interrupt',
  'session:reconfigure',
  'session:respond-permission',
  'session:respond-question'
]) {
  ipcMain.on(name, (_e, id) => {
    if (name === 'session:stop') stops.push(id)
  })
}

let failed = 0
function check(label, cond, detail) {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : String(detail))
  }
}

const js = (w, code) => w.webContents.executeJavaScript(code)
const textHas = (w, text) =>
  js(w, `document.body.innerText.includes(${JSON.stringify(text)})`)

/** 等一段 UI 状态稳定下来 */
async function waitFor(fn, timeout = 3000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true
    await sleep(100)
  }
  return false
}

const clickSession = (w, title) =>
  js(
    w,
    `(() => {
       const row = [...document.querySelectorAll('.session')].find(
         (r) => r.querySelector('.session__title')?.textContent === ${JSON.stringify(title)}
       );
       row?.querySelector('.session__main')?.click();
       return !!row;
     })()`
  )

const deleteSession = (w, title) =>
  js(
    w,
    `(() => {
       const row = [...document.querySelectorAll('.session')].find(
         (r) => r.querySelector('.session__title')?.textContent === ${JSON.stringify(title)}
       );
       row?.querySelector('.session__del')?.click();
       return !!row;
     })()`
  )

/** 用 React 认账的方式改 textarea */
async function typeText(w, text) {
  await js(
    w,
    `(() => {
       const ta = document.querySelector('.composer__input');
       if (!ta) return false;
       const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
       set.call(ta, ${JSON.stringify(text)});
       ta.dispatchEvent(new Event('input', { bubbles: true }));
       return true;
     })()`
  )
  await sleep(120)
}

/** 普通消息：改 textarea 后点发送按钮 */
async function typeAndSend(w, text) {
  await typeText(w, text)
  await js(w, `document.querySelector('.send')?.click()`)
}

/** 斜杠指令：改 textarea 后回车，让命令弹层自己选中当前项 */
async function typeAndEnter(w, text) {
  await typeText(w, text)
  await js(
    w,
    `(() => {
       const ta = document.querySelector('.composer__input');
       ta?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
     })()`
  )
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
  await sleep(2000)

  console.log('\n[1] 启动：只建一条新会话（StrictMode 不重复 start）')
  check('boot 只有一次 session:start', starts.length === 1, JSON.stringify(starts))
  const bootLive = starts[0]?.id
  check('boot 的是新会话（没有 resumeId）', starts[0]?.options?.resumeId == null)

  console.log('\n[2] 点开会话 A：只回收空的新会话，不碰别的东西')
  check('点得开会话 A', await clickSession(win, '会话 A'))
  await waitFor(async () => starts.length === 2)
  check('会话 A 已 start', starts.length === 2, JSON.stringify(starts.map((s) => s.id)))
  check('空新会话被回收（stop bootLive）', stops.filter((x) => x === bootLive).length === 1)
  check('会话 A 带 resumeId', starts[1]?.options?.resumeId === 'a-session-0001')
  const liveA = starts[1]?.id

  console.log('\n[3] 在 A 里发消息，再切到 B')
  await typeAndSend(win, 'A 的长任务')
  await waitFor(async () => sends.length === 1)
  check(
    '消息发给 A 的 Live',
    sends.length === 1 && sends[0].id === liveA && sends[0].input.text === 'A 的长任务',
    JSON.stringify(sends)
  )

  // A 进入运行中（侧栏靠这条状态事件点亮）
  win.webContents.send('session:status', {
    sessionId: liveA,
    status: 'running',
    providerSessionId: 'a-session-0001'
  })
  await sleep(200)

  check('点得开会话 B', await clickSession(win, '会话 B'))
  await waitFor(async () => starts.length === 3)
  check('会话 B 已 start', starts.length === 3, JSON.stringify(starts.map((s) => s.id)))
  check('切到 B 时 A 没有被 stop', !stops.includes(liveA), JSON.stringify(stops))
  const liveB = starts[2]?.id
  check('B 带自己的 resumeId', starts[2]?.options?.resumeId === 'b-session-0002')
  check('A 仍显示运行中', await js(win, `document.querySelectorAll('.session__cli.is-running').length >= 1`))

  console.log('\n[4] B 在前台时，A 的后台事件照常累积')
  win.webContents.send('session:event', {
    sessionId: liveA,
    event: { t: 'text_delta', text: '后台输出' }
  })
  win.webContents.send('session:event', {
    sessionId: liveA,
    event: {
      t: 'turn_end',
      durationMs: 1200,
      steps: 1,
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
      }
    }
  })
  win.webContents.send('session:status', {
    sessionId: liveA,
    status: 'idle',
    providerSessionId: 'a-session-0001'
  })
  await sleep(300)

  console.log('\n[5] 切回 A：不重新 start，转写还在')
  const beforeBack = starts.length
  check('点得回会话 A', await clickSession(win, '会话 A'))
  await sleep(500)
  check('切回 A 没有重新 start', starts.length === beforeBack, `${beforeBack} → ${starts.length}`)
  check('后台累积的输出还在', await textHas(win, '后台输出'))
  check('A 依然没有被 stop', !stops.includes(liveA))

  console.log('\n[6] 打开设置再返回：会话不受影响')
  const beforeSettings = { starts: starts.length, stops: stops.length }
  await js(win, `document.querySelector('.sidebar__settings')?.click()`)
  await sleep(500)
  await js(
    win,
    `(() => {
       const b = [...document.querySelectorAll('button')].find(
         (x) => x.textContent.trim() === '返回'
       );
       b?.click();
       return !!b;
     })()`
  )
  await sleep(800)
  check(
    '设置页往返没有 start/stop',
    starts.length === beforeSettings.starts && stops.length === beforeSettings.stops,
    JSON.stringify({ beforeSettings, starts: starts.length, stops: stops.length })
  )
  check('返回后转写还在', await textHas(win, '后台输出'))

  console.log('\n[7] /clear：只停当前会话一次，并开一条新会话')
  const beforeClearStarts = starts.length
  await typeAndEnter(win, '/clear')
  await waitFor(async () => starts.length === beforeClearStarts + 1)
  check('/clear 后开了一条新会话', starts.length === beforeClearStarts + 1)
  check('/clear 把 A stop 了一次', stops.filter((x) => x === liveA).length === 1, JSON.stringify(stops))
  const postClearLive = starts[starts.length - 1]?.id

  console.log('\n[8] 新会话跑出 CLI id 之后，点侧栏那一行不二次 start')
  SESSIONS.unshift({
    id: 'new-session-0003',
    cwd: CWD_A,
    title: '新会话转已存',
    updatedAt: Date.now() + 5000,
    cli: 'claude'
  })
  win.webContents.send('session:event', {
    sessionId: postClearLive,
    event: {
      t: 'session_started',
      sessionId: 'new-session-0003',
      provider: 'claude',
      model: 'deepseek-chat',
      cwd: CWD_A,
      tools: [],
      permissionMode: 'standard'
    }
  })
  win.webContents.send('session:event', {
    sessionId: postClearLive,
    event: { t: 'text_delta', text: '新会话输出' }
  })
  // turn_end 会触发侧栏刷新（有 800ms 节流）
  win.webContents.send('session:event', {
    sessionId: postClearLive,
    event: {
      t: 'turn_end',
      durationMs: 800,
      steps: 1,
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
      }
    }
  })
  await sleep(1500)

  const hasNewRow = await js(
    win,
    `[...document.querySelectorAll('.session__title')].some(
       (x) => x.textContent === '新会话转已存'
     )`
  )
  check('侧栏出现了这条新会话', hasNewRow)
  const beforeAlias = starts.length
  check('点得开新会话行', await clickSession(win, '新会话转已存'))
  await sleep(500)
  check(
    '点它没有二次 start（复用同一个 Live）',
    starts.length === beforeAlias,
    `${beforeAlias} → ${starts.length}`
  )
  check('新会话的转写还在', await textHas(win, '新会话输出'))

  console.log('\n[9] 删除后台会话 B：只 stop B 一次')
  check('点得到 B 的删除按钮', await deleteSession(win, '会话 B'))
  await sleep(250)
  check(
    '确认弹窗出现',
    await js(win, `!!document.querySelector('.modal__dlg .btn--danger')`)
  )
  await js(win, `document.querySelector('.modal__dlg .btn--danger')?.click()`)
  await sleep(500)
  check(
    'delete 请求发给主进程',
    deletes.some((d) => d.id === 'b-session-0002'),
    JSON.stringify(deletes)
  )
  check('B 被 stop 一次', stops.filter((x) => x === liveB).length === 1, JSON.stringify(stops))

  console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}\n`)
  setTimeout(() => app.exit(failed === 0 ? 0 : 1), 200)
})
