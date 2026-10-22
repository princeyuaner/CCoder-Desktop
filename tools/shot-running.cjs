/*
 * 开发辅助：验证「会话运行中」这条链路，并截侧栏。
 *
 * 验的是三件事，不只是好不好看：
 *   1. 启动时主动问一次 `session:running`，名单里的行要对上；
 *   2. `session:status` 的 running / idle 能把图标的 is-running 打开、关掉；
 *   3. 运行中的行跟「当前打开的是哪条」互不影响（两个都在跑，只有一个是 active）。
 *
 * 用法：electron tools/shot-running.cjs [输出.png]
 * 不参与打包，随时可删。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const OUT = process.argv[2] || path.join(__dirname, '..', 'shot-running.png')
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

const CWD_A = 'C:\\Users\\CY\\Desktop\\CCoder-Desktop'
const CWD_B = 'C:\\Users\\CY\\Projects\\agent-kit'

const DEMO = {
  permissionMode: 'standard',
  defaultCwd: '',
  openedCwds: [CWD_A, CWD_B],
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
  // 这条正在跑，而且等会儿会被点开成 active
  { id: 'a1-running-0001', cwd: CWD_A, title: '给侧栏加运行中指示器', updatedAt: now - 40_000, cli: 'claude' },
  // 这条也在跑，但不是当前打开的 —— 证明指示器独立于 is-active
  { id: 'b2-running-0002', cwd: CWD_A, title: '修 permission-preview 的 diff', updatedAt: now - 90 * 60_000, cli: 'claude' },
  // 这两条没在跑，作为对照
  { id: 'c3-idle-0003', cwd: CWD_A, title: '把渠道测试改成走真实端点', updatedAt: now - 5 * 3600_000, cli: 'claude' },
  { id: 'd4-idle-0004', cwd: CWD_B, title: '重构 run-state 的任务合并逻辑', updatedAt: now - 26 * 3600_000, cli: 'claude' }
]

/** 启动时"已经在跑"的名单 —— 只放第一条，第二条靠状态事件加上去 */
const RUNNING_AT_BOOT = [SESSIONS[0].id]

ipcMain.handle('win:is-maximized', () => false)
ipcMain.handle('settings:get', () => DEMO)
ipcMain.handle('settings:save', (_e, s) => s)
ipcMain.handle('channel:test', () => ({ ok: true, message: 'pong', latencyMs: 412 }))
ipcMain.handle('sessions:list', () => SESSIONS)
ipcMain.handle('sessions:transcript', () => [])
ipcMain.handle('sessions:delete', () => ({ ok: true }))
ipcMain.handle('sessions:pick-dir', () => null)
ipcMain.handle('session:running', () => RUNNING_AT_BOOT)
ipcMain.handle('session:start', () => 'live-1')
ipcMain.handle('session:send', () => ({ ok: true }))

let failed = 0
function check(label, cond, detail) {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : String(detail))
  }
}

const countRunning = (w) =>
  w.webContents.executeJavaScript(
    `document.querySelectorAll('.session__cli.is-running').length`
  )

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    show: true,
    frame: false,
    backgroundColor: '#191919',
    webPreferences: { preload: path.join(__dirname, '..', 'out', 'preload', 'index.js'), sandbox: false }
  })

  await win.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'index.html'))
  await sleep(1500)

  console.log('\n[1] 启动名单（session:running）')
  const boot = await countRunning(win)
  check('只有名单里那一条在跑', boot === 1, `实际 ${boot}`)

  console.log('\n[2] 状态事件（session:status）')
  win.webContents.send('session:status', {
    sessionId: 'live-2',
    status: 'running',
    providerSessionId: SESSIONS[1].id
  })
  await sleep(250)
  const two = await countRunning(win)
  check('running 事件把第二条也点亮', two === 2, `实际 ${two}`)

  win.webContents.send('session:status', {
    sessionId: 'live-2',
    status: 'idle',
    providerSessionId: SESSIONS[1].id
  })
  await sleep(250)
  const back = await countRunning(win)
  check('idle 事件把它熄掉', back === 1, `实际 ${back}`)

  // 再点亮一次，留到截图里：两条在跑，一条 active、一条不是
  win.webContents.send('session:status', {
    sessionId: 'live-2',
    status: 'running',
    providerSessionId: SESSIONS[1].id
  })
  await sleep(250)

  // 点开第一条会话 —— 让「active」和「running」同时落在一条上，
  // 另一条只 running 不 active，正好看出两者是独立的
  const clicked = await win.webContents.executeJavaScript(
    `(() => { const b = document.querySelector('.session__main'); if (b) b.click(); return !!b })()`
  )
  check('点得开第一条会话', clicked)
  await sleep(600)

  const activeRunning = await win.webContents.executeJavaScript(
    `(() => {
       const rows = [...document.querySelectorAll('.session')];
       return rows.map((r) => ({
         active: r.classList.contains('is-active'),
         running: !!r.querySelector('.session__cli.is-running')
       }));
     })()`
  )
  check(
    'active 与 running 是两条独立的标记',
    activeRunning.filter((r) => r.running).length === 2 &&
      activeRunning.filter((r) => r.active).length === 1 &&
      activeRunning.some((r) => r.active && r.running) &&
      activeRunning.some((r) => !r.active && r.running),
    JSON.stringify(activeRunning)
  )

  /*
   * 截图前先确认动画真挂上了 —— 光看截图不算数：16px 的图标在 2 倍放大里
   * 也就 32px，5px 的位移靠肉眼比对行距很容易看走眼。这里直接问浏览器要计算值。
   */
  const animated = await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.session__cli.is-running svg')].map((el) => {
       const cs = getComputedStyle(el);
       return { name: cs.animationName, state: cs.animationPlayState, dur: cs.animationDuration };
     })`
  )
  check(
    '运行中的图标在跳（session-bounce / 0.9s / running）',
    animated.length === 2 &&
      animated.every((x) => x.name === 'session-bounce' && x.state === 'running' && x.dur === '0.9s'),
    JSON.stringify(animated)
  )

  /*
   * 截图时冻在最高点，否则抓到哪一帧全看运气。
   *
   * 不用「负 delay + paused」：两条会话是先后进入运行状态的，动画起点差了一截，
   * 同一时刻暂停会落在不同相位（实测一条 -4.9px、一条 -2.0px，看起来像没对齐）。
   * 直接写死关键帧那一帧的 transform，两张图标就都停在同一个高度。
   */
  await win.webContents.insertCSS(
    `.session__cli.is-running svg {
       animation: none !important;
       transform: translateY(-5px) scaleY(1.08) !important;
     }`
  )
  await sleep(150)

  const frozen = await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.session__cli.is-running svg')].map((el) => {
       const cs = getComputedStyle(el);
       const m = new DOMMatrixReadOnly(cs.transform === 'none' ? undefined : cs.transform);
       return { f: m.f, scaleY: m.d };
     })`
  )
  check(
    '冻帧停在最高点（上移 5px、竖向拉伸 1.08）',
    frozen.length === 2 &&
      frozen.every((x) => Math.abs(x.f + 5) < 0.01 && Math.abs(x.scaleY - 1.08) < 0.01),
    JSON.stringify(frozen)
  )

  /*
   * 计算值对了不代表真画上去了（老问题：样式被后面的规则压掉时，computed
   * 仍然报你写的那条）。getBoundingClientRect 把 transform 算在内，
   * 量它才等于量截图：运行中的图标顶边应当比图标框高约 5px，没跑的应当严丝合缝。
   */
  const geom = await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.session')].map((row) => {
       const mark = row.querySelector('.session__cli');
       const svg = row.querySelector('.session__cli svg');
       const box = mark.getBoundingClientRect();
       const r = svg.getBoundingClientRect();
       return { running: mark.classList.contains('is-running'), dy: +(r.top - box.top).toFixed(3) };
     })`
  )
  check(
    '像素位置也对：在跑的图标抬起来了，没跑的没动',
    geom.length === 4 &&
      geom.filter((g) => g.running).every((g) => g.dy <= -4.9) &&
      geom.filter((g) => !g.running).every((g) => Math.abs(g.dy) < 0.2),
    JSON.stringify(geom)
  )

  /*
   * 右侧那格：在跑的行写「运行中」，没跑的还是相对时间。
   * 颜色按通道判，不比对具体色值 —— 浅色主题会换成一档更深的珊瑚。
   */
  const labels = await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.session')].map((row) => ({
       running: !!row.querySelector('.session__cli.is-running'),
       text: row.querySelector('.session__time').textContent.trim(),
       color: getComputedStyle(row.querySelector('.session__time')).color
     }))`
  )
  const rgb = (c) => (c.match(/\d+/g) || []).map(Number)
  const isCoral = (c) => {
    const [r, g, b] = rgb(c)
    return r > 150 && r > g + 60 && g > b
  }
  check(
    '在跑的行写「运行中」，没跑的行还是时间',
    labels.length === 4 &&
      labels.filter((l) => l.running).every((l) => l.text === '运行中') &&
      labels.filter((l) => !l.running).every((l) => l.text !== '运行中'),
    JSON.stringify(labels)
  )
  check(
    '「运行中」是珊瑚色，不是普通的灰',
    labels.filter((l) => l.running).length === 2 && labels.filter((l) => l.running).every((l) => isCoral(l.color)),
    JSON.stringify(labels)
  )

  /*
   * 浅色主题下品牌珊瑚色直接搬过去对比度不够（#d97757 压在 #efeff1 上只有 4.3:1），
   * tokens.css 里换了一档更深的。这里切一下 data-theme 量一量，
   * 顺手算 WCAG 对比度 —— 12px 的字至少要 4.5:1。
   */
  await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = 'light'`)
  await sleep(180)
  const light = await win.webContents.executeJavaScript(
    `(() => {
       const el = document.querySelector('.session__time--running');
       return {
         fg: getComputedStyle(el).color,
         bg: getComputedStyle(document.querySelector('.sidebar')).backgroundColor
       };
     })()`
  )
  const lum = (c) => {
    const [r, g, b] = rgb(c).map((v) => {
      const s = v / 255
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const contrast = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }
  check(
    '浅色主题下「运行中」仍然读得清（对比度 ≥ 4.5:1）',
    light.fg !== labels[0].color && contrast(light.fg, light.bg) >= 4.5,
    JSON.stringify({ ...light, ratio: +contrast(light.fg, light.bg).toFixed(2) })
  )

  // 浅色下也留一张侧栏图 —— 深色那条规则会不会把状态字盖回去，只有真画出来才算数
  {
    const whole = await win.webContents.capturePage()
    const s = whole.getSize().width / win.getContentSize()[0]
    const crop = whole.crop({
      x: 0,
      y: Math.round(36 * s),
      width: Math.round(280 * s),
      height: Math.round(520 * s)
    })
    const zoomed = crop.resize({
      width: crop.getSize().width * 2,
      height: crop.getSize().height * 2,
      quality: 'best'
    })
    const out = OUT.replace(/\.png$/, '-sidebar-light.png')
    fs.writeFileSync(out, zoomed.toPNG())
    console.log(`wrote ${out}  (${zoomed.getSize().width}x${zoomed.getSize().height})`)
  }

  await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = 'dark'`)
  await sleep(180)

  const img = await win.webContents.capturePage()
  fs.writeFileSync(OUT, img.toPNG())
  console.log(`\nwrote ${OUT}  (${img.getSize().width}x${img.getSize().height})`)

  // 侧栏单独放大一份 —— 16px 的图标在整窗截图里太小，看不清动效
  const scale = img.getSize().width / win.getContentSize()[0]
  const crop = img.crop({
    x: 0,
    y: Math.round(36 * scale), // 标题栏高度
    width: Math.round(280 * scale),
    height: Math.round(520 * scale)
  })
  // nativeImage.resize 不认 factor，得自己算宽高
  const zoomed = crop.resize({
    width: crop.getSize().width * 2,
    height: crop.getSize().height * 2,
    quality: 'best'
  })
  fs.writeFileSync(OUT_SIDEBAR, zoomed.toPNG())
  console.log(`wrote ${OUT_SIDEBAR}  (${zoomed.getSize().width}x${zoomed.getSize().height})`)

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
  app.exit(failed === 0 ? 0 : 1)
})
