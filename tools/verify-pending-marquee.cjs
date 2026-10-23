/*
 * 开发辅助：验证「后台会话卡在审批上」的侧栏跑马灯（方案 D）。
 *
 * 验的是：
 *   1. 非当前会话收到 permission_request → 那一行挂 is-pending / 跑马灯 / 胶囊；
 *   2. 当前会话收到同样的请求 → 不挂（审批面板本来就在主区）；
 *   3. 答复（这里用 turn_end 模拟）→ 标记立刻收起；
 *   4. 动画确实挂上了（animation-name 直接问浏览器要，光看截图不算数）。
 *
 * 用法：electron tools/verify-pending-marquee.cjs [输出.png]
 * 不参与打包，随时可删。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const OUT = process.argv[2] || path.join(__dirname, '..', 'docs', 'mockups', 'session-pending-marquee-live.png')
const OUT_SIDEBAR = OUT.replace(/\.png$/, '-sidebar.png')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

const CWD = 'C:\\Users\\CY\\Desktop\\CCoder-Desktop'

const DEMO = {
  permissionMode: 'standard',
  defaultCwd: CWD,
  openedCwds: [CWD],
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
  {
    id: 'a1-background-0001',
    cwd: CWD,
    title: '重构设置页的渠道卡片',
    createdAt: now - 2 * 3600_000,
    updatedAt: now - 26 * 60_000,
    cli: 'claude'
  },
  {
    id: 'b2-active-0002',
    cwd: CWD,
    title: '给侧栏加待审批跑马灯',
    createdAt: now - 3600_000,
    updatedAt: now - 40_000,
    cli: 'claude'
  },
  {
    id: 'c3-idle-0003',
    cwd: CWD,
    title: '把渠道测试改成走真实端点',
    createdAt: now - 5 * 3600_000,
    updatedAt: now - 4 * 3600_000,
    cli: 'claude'
  }
]

/** session:start 返回的 Live id → 这次启动的 resumeId */
let liveSeq = 0
const starts = []

ipcMain.handle('win:is-maximized', () => false)
ipcMain.handle('settings:get', () => DEMO)
ipcMain.handle('settings:save', (_e, s) => s)
ipcMain.handle('channel:test', () => ({ ok: true, message: 'pong', latencyMs: 412 }))
ipcMain.handle('sessions:list', () => SESSIONS)
ipcMain.handle('sessions:transcript', () => [])
ipcMain.handle('sessions:delete', () => ({ ok: true }))
ipcMain.handle('sessions:pick-dir', () => null)
ipcMain.handle('session:running', () => [])
ipcMain.handle('session:start', (_e, o) => {
  const id = `live-${++liveSeq}`
  starts.push({ id, resumeId: o.resumeId ?? null })
  return id
})
ipcMain.handle('session:send', () => ({ ok: true }))

let failed = 0
function check(label, cond, detail) {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : String(detail))
  }
}

const clickByTitle = (win, title) =>
  win.webContents.executeJavaScript(
    `(() => {
       const rows = [...document.querySelectorAll('.session__main')];
       const row = rows.find((r) => r.textContent.includes(${JSON.stringify(title)}));
       if (!row) return false;
       row.click();
       return true;
     })()`
  )

const rowState = (win) =>
  win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.session')].map((r) => ({
       title: r.querySelector('.session__title')?.textContent ?? '',
       pendingTitle: r.querySelector('.session__mq-item')?.textContent ?? '',
       tag: r.querySelector('.session__pending-tag')?.textContent ?? '',
       active: r.classList.contains('is-active'),
       pending: r.classList.contains('is-pending'),
       scrolling: !!r.querySelector('.session__mq.is-scrolling'),
       marqueeAnim: r.querySelector('.session__mq-track')
         ? getComputedStyle(r.querySelector('.session__mq-track')).animationName
         : '',
       sweepAnim: getComputedStyle(r, '::after').animationName
     }))`
  )

const permissionEvent = {
  t: 'permission_request',
  id: 'req-1',
  tool: 'Bash',
  input: { command: 'npm install electron-builder --save-dev' },
  preview: {
    kind: 'command',
    title: '执行命令',
    command: 'npm install electron-builder --save-dev'
  },
  options: [
    { value: 'allow', label: '允许' },
    { value: 'allow-always', label: '本会话内都允许' },
    { value: 'deny', label: '拒绝', danger: true }
  ]
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
  await sleep(1500)

  console.log('\n[1] 打开 A（将成为后台会话），再切到 B')
  check('点得开 A', await clickByTitle(win, SESSIONS[0].title))
  await sleep(700)
  check('点得开 B', await clickByTitle(win, SESSIONS[1].title))
  await sleep(700)

  const liveA = starts.find((s) => s.resumeId === SESSIONS[0].id)?.id
  const liveB = starts.find((s) => s.resumeId === SESSIONS[1].id)?.id
  check('A / B 各自拉起了一条 Live', !!liveA && !!liveB, JSON.stringify(starts))

  console.log('\n[2] A 收到审批请求（A 不是当前会话）')
  win.webContents.send('session:event', { sessionId: liveA, event: permissionEvent })
  await sleep(500)

  const afterPermission = await rowState(win)
  const pendingRow = afterPermission.find((r) => r.pending)
  check('恰好一行挂上 is-pending', afterPermission.filter((r) => r.pending).length === 1)
  check('挂上的是 A，且不是 active', !!pendingRow && !pendingRow.active, JSON.stringify(pendingRow))
  check(
    '跑马灯文案说明在等什么',
    !!pendingRow && pendingRow.pendingTitle.includes('待审批 · 允许运行 npm install'),
    pendingRow && pendingRow.pendingTitle
  )
  check('右侧胶囊是「待审批」', !!pendingRow && pendingRow.tag === '待审批', pendingRow && pendingRow.tag)
  check('标题确实在滚（放得下就不该滚）', !!pendingRow && pendingRow.scrolling)
  check(
    '跑马灯 keyframes 挂上了',
    !!pendingRow && pendingRow.marqueeAnim === 'session-marquee',
    pendingRow && pendingRow.marqueeAnim
  )
  check(
    '扫光 keyframes 挂上了',
    !!pendingRow && pendingRow.sweepAnim === 'session-sweep',
    pendingRow && pendingRow.sweepAnim
  )

  console.log('\n[3] 当前会话 B 收到同样的请求 → 不挂')
  win.webContents.send('session:event', { sessionId: liveB, event: { ...permissionEvent, id: 'req-2' } })
  await sleep(400)
  const afterActive = await rowState(win)
  check(
    '仍然只有后台那一行在闪',
    afterActive.filter((r) => r.pending).length === 1 &&
      afterActive.find((r) => r.active)?.pending === false,
    JSON.stringify(afterActive.filter((r) => r.pending || r.active))
  )

  // 截图前再等一下，让跑马灯滚到一个好看的位置
  await sleep(1400)
  const shot = await win.webContents.capturePage()
  fs.writeFileSync(OUT, shot.toPNG())
  console.log(`\nwrote ${OUT}`)

  const sidebarShot = await win.webContents.capturePage({ x: 0, y: 36, width: 280, height: 520 })
  fs.writeFileSync(OUT_SIDEBAR, sidebarShot.toPNG())
  console.log(`wrote ${OUT_SIDEBAR}`)

  console.log('\n[4] 答复后（turn_end）立刻收起')
  win.webContents.send('session:event', {
    sessionId: liveA,
    event: { t: 'turn_end', steps: 1 }
  })
  await sleep(400)
  const afterEnd = await rowState(win)
  check('跑马灯标记消失', afterEnd.every((r) => !r.pending))
  check(
    '文案回到原标题',
    afterEnd.some((r) => r.title.includes(SESSIONS[0].title)),
    JSON.stringify(afterEnd.map((r) => r.title))
  )

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
  app.quit()
})
