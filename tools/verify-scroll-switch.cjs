/*
 * 开发辅助：验证「切到一条正在跑的会话时，转写区是否落在最后一行」。
 *
 * 场景：
 *   1. 点开会话 A（长历史，走 sessions:transcript）；
 *   2. A 进入 running，持续往外吐字；
 *   3. 切到会话 B，A 在后台继续吐；
 *   4. 再切回 A —— 此时 A 的 items 已经在内存里，不是异步加载，
 *      正是「切换运行中的会话」那条路径。
 *
 * 只看 DOM 事实：容器离底多少像素、最后一行是否在可视区内。
 * 用法：electron tools/verify-scroll-switch.cjs
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CWD = 'C:\\Users\\CY\\Desktop\\CCoder-Desktop'

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
  openedCwds: [CWD],
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
      channels: [ch('demo-1', 'DeepSeek 中转', 'https://api.deepseek.com/anthropic', 'deepseek-chat')]
    },
    codex: { enabled: false, activeChannelId: null, effort: 'medium', channels: [] }
  }
}

const SESSIONS = [
  { id: 'a1-long-running', cwd: CWD, title: '运行中的长会话 A', updatedAt: Date.now(), cli: 'claude' },
  { id: 'b2-idle', cwd: CWD, title: '另一条会话 B', updatedAt: Date.now() - 60_000, cli: 'claude' },
  { id: 'c3-cold-running', cwd: CWD, title: '本次刚打开的运行中会话 C', updatedAt: Date.now() - 120_000, cli: 'claude' }
]

/**
 * 造一段像真会话的历史：每轮 user → text → tool → result → turn_end。
 * 正文长度故意有长有短 —— content-visibility 的块高度估算就是按
 * 平均行长算的，内容越不均匀越容易在切换后落不到底。
 */
function history(seed, turns, lines = 34) {
  const out = []
  for (let i = 0; i < turns; i++) {
    const tall = lines > 10
    const n = tall ? lines : lines + ((i + seed) % 3)
    out.push({
      t: 'user_message',
      text: `第 ${i + 1} 轮：请检查 src/renderer/src/App.tsx 里第 ${i + 1} 处的逻辑。`,
      at: new Date(Date.now() - (turns - i) * 60_000).toISOString()
    })
    out.push({
      t: 'thinking_delta',
      text: `先定位第 ${i + 1} 处，确认调用链，再决定怎么改。`
    })
    out.push({
      t: 'text_delta',
      text: Array.from({ length: n }, (_, k) => `第 ${i + 1} 轮的第 ${k + 1} 行：这里是用来撑高度的正文。`).join('\n')
    })
    out.push({ t: 'tool_call', id: `t-${seed}-${i}`, name: 'Read', input: { file_path: `${CWD}/src/renderer/src/App.tsx`, offset: i + 1 } })
    out.push({ t: 'tool_result', id: `t-${seed}-${i}`, status: 'ok', content: 'export function App() { ... }' })
    out.push({
      t: 'turn_end',
      durationMs: 1200,
      steps: 3,
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0 }
    })
  }
  return out
}

const TRANSCRIPTS = {
  // A 的行很高、B 的行很矮：两条会话来回切时转写区的块元素会被复用，
  // content-visibility 记住的块高度是上一条会话的，落差越大越容易露馅。
  'a1-long-running': history(1, 1300, 34),
  'b2-idle': history(4, 1300, 1),
  // C 从没在本窗口打开过：历史要现读，模拟大文件的一次 IPC 往返
  'c3-cold-running': history(7, 1300, 20)
}

/** B 的历史里留一个子代理，切过去时执行台会自动展开（hasRunInfo） */
TRANSCRIPTS['b2-idle'].push(
  { t: 'task_started', taskId: 'task-b', toolUseId: 'agent-b', agentType: 'Explore', description: '梳理转写区滚动逻辑' },
  { t: 'text_delta', text: '子代理还在跑，先把这段写完。' }
)

/** resumeId → live id，事件按 live id 派发 */
const liveByResume = new Map()
let liveSeq = 0

ipcMain.handle('win:is-maximized', () => false)
ipcMain.handle('settings:get', () => DEMO)
ipcMain.handle('settings:save', (_e, s) => s)
ipcMain.handle('channel:test', () => ({ ok: true, message: 'pong', latencyMs: 12 }))
ipcMain.handle('sessions:list', () => SESSIONS)
ipcMain.handle('sessions:transcript', async (_e, _cwd, id) => {
  // 冷会话的历史慢一拍 —— 真实场景里大 jsonl 的读取能到几百毫秒
  if (id === 'c3-cold-running') await sleep(800)
  return TRANSCRIPTS[id] ?? []
})
ipcMain.handle('sessions:delete', () => ({ ok: true }))
ipcMain.handle('sessions:pick-dir', () => null)
ipcMain.handle('session:running', () => [])
ipcMain.handle('session:start', (_e, o) => {
  if (!liveByResume.has(o.resumeId)) liveByResume.set(o.resumeId, `live-${++liveSeq}`)
  return liveByResume.get(o.resumeId)
})
ipcMain.handle('session:send', () => ({ ok: true }))
ipcMain.on('session:stop', () => undefined)
ipcMain.on('session:interrupt', () => undefined)
ipcMain.on('session:reconfigure', () => undefined)

let failed = 0
function check(label, cond, detail) {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : String(detail))
  }
}

const clickSession = (win, title) =>
  win.webContents.executeJavaScript(
    `(() => {
       const row = [...document.querySelectorAll('.session')].find(
         (r) => r.querySelector('.session__title')?.textContent === ${JSON.stringify(title)}
       );
       if (!row) return false;
       row.querySelector('.session__main')?.click();
       return true;
     })()`
  )

/** 容器离底多远、最后一行是否完整可见 */
const measure = (win) =>
  win.webContents.executeJavaScript(
    `(() => {
       const t = document.querySelector('.transcript');
       if (!t) return null;
       const rows = t.querySelectorAll('.tl__row');
       const last = rows[rows.length - 1];
       const tr = t.getBoundingClientRect();
       const lr = last ? last.getBoundingClientRect() : null;
       return {
         rows: rows.length,
         gap: Math.round(t.scrollHeight - t.scrollTop - t.clientHeight),
         scrollTop: Math.round(t.scrollTop),
         scrollHeight: t.scrollHeight,
         clientHeight: t.clientHeight,
         lastVisible: !!lr && lr.bottom <= tr.bottom + 1,
         lastBottom: lr ? Math.round(lr.bottom) : null,
         viewBottom: Math.round(tr.bottom),
         chunks: (() => {
           const cs = [...t.querySelectorAll('.tl__chunk')];
           const lc = cs[cs.length - 1];
           return lc
             ? {
                 count: cs.length,
                 lastH: lc.offsetHeight,
                 lastRectH: Math.round(lc.getBoundingClientRect().height),
                 lastCV: getComputedStyle(lc).contentVisibility,
                 lastRows: lc.querySelectorAll('.tl__row').length
               }
             : null;
         })()
       };
     })()`
  )

const send = (win, liveId, event) =>
  win.webContents.send('session:event', { sessionId: liveId, event })
const status = (win, liveId, s, providerSessionId) =>
  win.webContents.send('session:status', {
    sessionId: liveId,
    status: s,
    providerSessionId
  })

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    show: true,
    frame: false,
    backgroundColor: '#191919',
    webPreferences: {
      preload: path.join(__dirname, '..', 'out', 'preload', 'index.js'),
      sandbox: false,
      // 无头跑测试时窗口可能被别的窗口挡住；rAF 一旦被节流，
      // 「滚动后停止跟随」这类断言就会看运气
      backgroundThrottling: false
    }
  })
  await win.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'index.html'))
  await sleep(1500)

  console.log('\n[1] 打开会话 A（长历史）')
  check('点得开会话 A', await clickSession(win, SESSIONS[0].title))
  await sleep(900)
  const liveA = liveByResume.get(SESSIONS[0].id)
  console.log('  liveA =', liveA, ' liveByResume =', JSON.stringify([...liveByResume]))
  check('会话 A 的 Live 已建立', !!liveA)

  // A 进入 running 并持续吐字
  status(win, liveA, 'running', SESSIONS[0].id)
  for (let i = 0; i < 6; i++) {
    send(win, liveA, { t: 'text_delta', text: `\n运行中的第 ${i + 1} 段输出。` })
  }
  // A 也来一个子代理，让执行台出现
  send(win, liveA, {
    t: 'task_started',
    taskId: 'task-a',
    toolUseId: 'agent-a',
    agentType: 'Explore',
    description: '检查 Transcript 的滚动 effect'
  })
  await sleep(400)
  check('会话 A 正在跑', (await measure(win))?.rows > 0)

  // 把执行台收起来 —— 切走时 panelPref=false 会留到下一次会话的首帧
  const collapsed = await win.webContents.executeJavaScript(
    `(() => {
       const btn = document.querySelector('.chathead__right .chip--icon');
       if (!btn) return false;
       btn.click();
       return true;
     })()`
  )
  check('收起执行台', collapsed)
  await sleep(250)

  console.log('\n[2] 切到会话 B')
  check('点得开会话 B', await clickSession(win, SESSIONS[1].title))
  await sleep(700)
  const liveB = liveByResume.get(SESSIONS[1].id)
  check('会话 B 的 Live 已建立', !!liveB)
  status(win, liveB, 'idle', SESSIONS[1].id)

  for (const wait of [50, 300, 1000]) {
    await sleep(wait)
    const m = await measure(win)
    console.log(`  切到 B 后 +${wait}ms`, JSON.stringify(m))
    check(
      `切到 B 后 ${wait}ms 停在最后一行`,
      !!m && m.gap <= 2 && m.lastVisible,
      JSON.stringify(m)
    )
  }

  console.log('\n[3] A 在后台继续吐字')
  for (let i = 0; i < 25; i++) {
    send(win, liveA, { t: 'text_delta', text: `\n后台追加的正文第 ${i + 1} 行，用来把内容继续撑高。` })
  }
  await sleep(300)

  console.log('\n[4] 切回正在跑的 A')
  check('点得回 A', await clickSession(win, SESSIONS[0].title))

  for (const wait of [50, 300, 1000]) {
    await sleep(wait)
    const m = await measure(win)
    console.log(`  +${wait}ms`, JSON.stringify(m))
    check(
      `切换后 ${wait}ms 停在最后一行（gap ≤ 2px 且最后一行可见）`,
      !!m && m.gap <= 2 && m.lastVisible,
      JSON.stringify(m)
    )
  }

  // A 继续吐，跟随应该还在
  for (let i = 0; i < 5; i++) {
    send(win, liveA, { t: 'text_delta', text: `\n再看一行。` })
  }
  await sleep(300)
  const after = await measure(win)
  console.log('  继续流式后', JSON.stringify(after))
  check('继续流式时仍然跟随最后一行', !!after && after.gap <= 2 && after.lastVisible, JSON.stringify(after))

  /*
   * 反向验证：用户自己往上翻之后，不能再被自动跟随拽回底部。
   * 先等过切会话的锁定窗口（400ms），再翻上去。
   */
  console.log('\n[5] 用户往上翻之后应停止跟随')
  await sleep(600)
  await win.webContents.executeJavaScript(
    `(() => { const t = document.querySelector('.transcript'); t.scrollTop -= 1200; return t.scrollTop; })()`
  )
  // 滚动监听走 rAF；窗口被遮挡时 rAF 会被节流，多等一会儿再断言
  await sleep(700)
  const jumped = await win.webContents.executeJavaScript(
    `(() => {
       const t = document.querySelector('.transcript');
       return {
         gap: Math.round(t.scrollHeight - t.scrollTop - t.clientHeight),
         jumpBtn: !!document.querySelector('.jump-bottom')
       };
     })()`
  )
  check('往上翻之后离底了，并出现「回到底部」', jumped.gap > 100 && jumped.jumpBtn, JSON.stringify(jumped))

  for (let i = 0; i < 5; i++) {
    send(win, liveA, { t: 'text_delta', text: `\n翻上去之后的增量 ${i + 1}。` })
  }
  await sleep(300)
  const stayed = await measure(win)
  check('新内容不会把用户拽回底部', !!stayed && stayed.gap > 100, JSON.stringify(stayed))

  await win.webContents.executeJavaScript(`document.querySelector('.jump-bottom')?.click()`)
  await sleep(150)
  const back = await measure(win)
  check('点「回到底部」能回到最后一行', !!back && back.gap <= 2 && back.lastVisible, JSON.stringify(back))

  /*
   * 冷会话：本窗口第一次点开一条「正在跑」的会话，历史还在从磁盘读。
   * 这段空窗期里状态先到 running、增量也可能先到，历史随后才把 items
   * 一次性换掉 —— 高度变化发生在一个和 sessionKey 无关的更新里。
   */
  console.log('\n[6] 首次打开一条正在跑的冷会话')
  check('点得开 C', await clickSession(win, SESSIONS[2].title))
  const liveC = liveByResume.get(SESSIONS[2].id)
  check('C 的 Live 已建立', !!liveC)
  if (liveC) {
    status(win, liveC, 'running', SESSIONS[2].id)
    for (let i = 0; i < 10; i++) {
      send(win, liveC, { t: 'text_delta', text: `\n冷会话先到的第 ${i + 1} 段。` })
    }
  }
  await sleep(1300)
  const cold = await measure(win)
  console.log('  历史落地后', JSON.stringify(cold))
  check('历史落地后停在最后一行', !!cold && cold.gap <= 2 && cold.lastVisible, JSON.stringify(cold))

  if (liveC) {
    for (let i = 0; i < 10; i++) {
      send(win, liveC, { t: 'text_delta', text: `\n历史之后继续输出 ${i + 1}。` })
    }
    await sleep(300)
    const cold2 = await measure(win)
    console.log('  继续流式后', JSON.stringify(cold2))
    check('冷会话继续流式仍跟随', !!cold2 && cold2.gap <= 2 && cold2.lastVisible, JSON.stringify(cold2))
  }

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
  app.exit(failed === 0 ? 0 : 1)
})
