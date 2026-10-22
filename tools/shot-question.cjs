/*
 * 开发辅助：塞一条 AskUserQuestion 事件，截图核对提问抽屉。
 * 用法：SHOT_THEME=dark electron tools/shot-question.cjs out.png [step]
 * step: 1 = 单选已选中；2 = 多选题已勾两项（默认 1）
 * 不参与打包，随时可删。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const out = process.argv[2] || path.join(__dirname, '..', 'shot-question.png')
const step = process.argv[3] || '1'
const SID = 'demo-session'

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
  defaultCwd: 'C:/proj/ccoder',
  openedCwds: ['C:/proj/ccoder'],
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
      channels: [ch('demo-1', 'DeepSeek 中转', 'https://api.deepseek.com/anthropic', 'deepseek-chat')],
      effort: 'medium'
    },
    codex: { enabled: false, activeChannelId: null, channels: [], effort: 'medium' }
  }
}

const QUESTIONS = [
  {
    question: 'loadSettings() 读文件失败时，应该怎么处理？',
    header: '错误处理',
    multiSelect: false,
    options: [
      { label: '抛错，让调用方决定', description: '保持现在的行为：启动立即失败，坏掉的配置不会被静默吞掉。' },
      { label: '回退到默认值并记一条日志', description: '应用总能启动，但坏掉的配置会被悄悄忽略。' },
      { label: '回退到默认值，并在界面上提示', description: '最稳，但需要新增一条从主进程到界面的提示通路。' }
    ]
  },
  {
    question: '哪些页面需要展示这条配置提示？',
    header: '提示范围',
    multiSelect: true,
    options: [
      { label: '设置页', description: '用户改配置的地方，最相关。' },
      { label: '主界面', description: '一进来就能看到，但可能打扰。' },
      { label: '首次启动引导', description: '只在第一次启动时出现。' }
    ]
  },
  {
    question: '配置读取失败时用哪个日志级别？',
    header: '日志级别',
    multiSelect: false,
    options: [
      { label: 'warn', description: '能恢复的问题，不至于刷屏。' },
      { label: 'error', description: '当成真正的错误记录。' },
      { label: 'info', description: '只留一条流水。' }
    ]
  }
]

ipcMain.handle('win:is-maximized', () => false)
ipcMain.handle('settings:get', () => DEMO)
ipcMain.handle('settings:save', (_e, s) => s)
ipcMain.handle('channel:test', () => ({ ok: true, message: 'pong', latencyMs: 412 }))
ipcMain.handle('session:start', () => SID)
ipcMain.handle('session:send', () => ({ ok: true }))
ipcMain.handle('session:reconfigure', () => undefined)
ipcMain.handle('session:running', () => [])
ipcMain.on('session:interrupt', () => undefined)
ipcMain.on('session:stop', () => undefined)
ipcMain.on('session:respond-permission', () => undefined)
let responded = null
ipcMain.on('session:respond-question', (_e, _id, _requestId, answer) => {
  responded = answer
  console.log('[respond-question]', JSON.stringify(answer))
})
ipcMain.handle('sessions:list', () => [])
ipcMain.handle('sessions:transcript', () => [])
ipcMain.handle('sessions:pick-dir', () => null)
ipcMain.handle('sessions:delete', () => ({ ok: true }))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    show: true,
    frame: false,
    backgroundColor: DEMO.theme === 'light' ? '#f6f6f7' : '#191919',
    webPreferences: {
      preload: path.join(__dirname, '..', 'out', 'preload', 'index.js'),
      sandbox: false
    }
  })

  await win.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'index.html'))
  // 等设置和会话 stub 都就绪。太短的话事件会在 sessionRef 赋值前到，整段被丢掉。
  await sleep(3000)

  const send = (event) => win.webContents.send('session:event', { sessionId: SID, event })
  send({ t: 'user_message', text: '设置文件坏掉的时候，app 现在会怎样？', at: '' })
  await sleep(120)
  send({
    t: 'text_delta',
    text: '现在 main() 里直接 readFileSync，配置一坏整个进程就退出了。三种改法各有取舍，我先确认你要哪一种再动手：'
  })
  await sleep(120)
  send({
    t: 'tool_call',
    id: 'tu1',
    name: 'Read',
    input: { file_path: 'src/main/settings-store.ts' }
  })
  send({ t: 'tool_result', id: 'tu1', status: 'ok', content: '…' })
  await sleep(260)
  send({
    t: 'question_request',
    id: 'req-ask-1',
    tool: 'AskUserQuestion',
    input: { questions: QUESTIONS },
    questions: QUESTIONS
  })
  // 等到抽屉真的挂上再操作，别用固定 sleep 赌 React 的渲染时机
  await win.webContents.executeJavaScript(
    `new Promise((resolve) => {
      const t0 = Date.now()
      const tick = () => {
        if (document.querySelector('.qdrawer')) resolve(true)
        else if (Date.now() - t0 > 4000) resolve(false)
        else setTimeout(tick, 50)
      }
      tick()
    })`
  )
  await sleep(200)

  if (step === '4') {
    // 三道题全答一遍，点一次「提交」，核对：
    // 抽屉收起、时间线变成「已答」、输入框解锁、IPC 收到 answers。
    const clickOpts = (idxs) =>
      win.webContents.executeJavaScript(
        `(() => {
          const opts = [...document.querySelectorAll('.qdrawer .qopt:not(.qopt--other)')]
          ${idxs.map((i) => `if (opts[${i}]) opts[${i}].click()`).join(';')}
          return opts.length
        })()`
      )
    const clickPrimary = () =>
      win.webContents.executeJavaScript(
        `(() => { const b = document.querySelector('.qbtn--primary'); if (b && !b.disabled) b.click(); return b ? b.textContent : 'missing' })()`
      )

    await clickOpts([0])
    await sleep(350)
    await clickPrimary()
    await sleep(450)
    await clickOpts([0, 2])
    await sleep(350)
    await clickPrimary()
    await sleep(450)
    await clickOpts([0])
    await sleep(350)
    await clickPrimary()
    await sleep(600)
    console.log('[responded]', JSON.stringify(responded))
  } else if (step === '2') {
    // 先选第一题；等 React 把「下一题」置为可用后再点它，
    // 否则同一个 tick 里点到的还是 disabled 状态。
    await win.webContents.executeJavaScript(
      `(() => { const first = document.querySelector('.qdrawer .qopt'); if (first) first.click(); return true })()`
    )
    await sleep(350)
    await win.webContents.executeJavaScript(
      `(() => {
        const next = [...document.querySelectorAll('.qbtn')].find((b) => b.textContent.includes('下一题'))
        if (next && !next.disabled) next.click()
        return next ? next.disabled : 'missing'
      })()`
    )
    await sleep(450)
    await win.webContents.executeJavaScript(
      `(() => {
        const opts = [...document.querySelectorAll('.qdrawer .qopt:not(.qopt--other)')]
        if (opts[0]) opts[0].click()
        if (opts[2]) opts[2].click()
        return opts.length
      })()`
    )
    await sleep(400)
  } else {
    await win.webContents.executeJavaScript(
      `(() => { const first = document.querySelector('.qdrawer .qopt'); if (first) first.click(); return true })()`
    )
    await sleep(400)
  }

  // 窗口被遮挡 / 刚重绘时 capturePage 偶尔返回 0x0，重试一次
  win.show()
  await sleep(600)
  let img = await win.webContents.capturePage()
  if (img.getSize().width === 0) {
    await sleep(900)
    img = await win.webContents.capturePage()
  }
  fs.writeFileSync(out, img.toPNG())
  console.log('wrote', out, img.getSize())
  app.quit()
})
