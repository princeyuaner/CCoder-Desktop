/*
 * 验证「会话列表批量勾选删除」这条链路。
 *
 * 不接真实 CLI：stub 掉 main 的 IPC，只检查渲染层的决策 ——
 *   1. 「批量选择」入口能进选择模式，行首出现勾选框；
 *   2. 点整行 = 勾选（不是切会话）；再点一次取消；
 *   3. 组头全选 / 半选态正确，N 条 = 组内会话数；
 *   4. 底部操作条显示已选条数，未选时「删除」禁用；
 *   5. 确认弹窗按工作区分组列出、运行中的会话带标记；
 *   6. 确认后逐条调用 sessions:delete，删除完成后退出选择模式；
 *   7. 部分失败时汇总提示，不吞掉成功条数。
 *
 * 用法（先 npx electron-vite build）：
 *   node node_modules/electron/cli.js tools/verify-batch-delete.cjs
 * 不参与打包，随时可删。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')

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
  { id: 'a-0001', cwd: CWD_A, title: '会话 A', createdAt: now - 1000, updatedAt: now - 1000, cli: 'claude' },
  { id: 'a-0002', cwd: CWD_A, title: '会话 B', createdAt: now - 2000, updatedAt: now - 2000, cli: 'claude' },
  { id: 'a-0003', cwd: CWD_A, title: '会话 C', createdAt: now - 3000, updatedAt: now - 3000, cli: 'claude' },
  { id: 'b-0001', cwd: CWD_B, title: '会话 D', createdAt: now - 4000, updatedAt: now - 4000, cli: 'claude' }
]

const starts = []
const deletes = []
/** 让第 N 次删除失败，用来验证部分失败的汇总提示 */
let failDeleteId = null
let liveSeq = 0

ipcMain.handle('win:is-maximized', () => false)
ipcMain.handle('settings:get', () => DEMO)
ipcMain.handle('settings:save', (_e, s) => s)
ipcMain.handle('sessions:list', () => SESSIONS.filter((s) => !deletes.includes(s.id)))
ipcMain.handle('sessions:transcript', () => [])
ipcMain.handle('sessions:meta', () => ({}))
ipcMain.handle('sessions:set-meta', () => ({}))
ipcMain.handle('sessions:search', () => ({ hits: [], total: 0 }))
ipcMain.handle('sessions:delete', (_e, cwd, id) => {
  if (id === failDeleteId) return { ok: false, message: '文件被占用' }
  deletes.push(id)
  return { ok: true }
})
ipcMain.handle('sessions:pick-dir', () => null)
ipcMain.handle('session:running', () => [])
ipcMain.handle('session:start', (_e, options) => {
  const id = `live-${++liveSeq}`
  starts.push({ id, options })
  return id
})
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

let failed = 0
function check(label, cond, detail) {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : String(detail))
  }
}

const js = (w, code) => w.webContents.executeJavaScript(code)

async function waitFor(fn, timeout = 3000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true
    await sleep(100)
  }
  return false
}

/** 侧栏里所有会话行的标题 */
const rowTitles = (w) =>
  js(w, `[...document.querySelectorAll('.sidebar .session__title')].map((e) => e.textContent)`)

/** 点「批量选择」入口 */
const enterSelect = (w) =>
  js(
    w,
    `(() => {
       const b = [...document.querySelectorAll('.sidebar__section-tools .iconbtn')].at(-1);
       b?.click();
       return !!b;
     })()`
  )

/** 点某一行的整行（选择模式下等于勾选） */
const clickRow = (w, title) =>
  js(
    w,
    `(() => {
       const row = [...document.querySelectorAll('.sidebar .session')].find(
         (r) => r.querySelector('.session__title')?.textContent === ${JSON.stringify(title)}
       );
       row?.querySelector('.session__main')?.click();
       return !!row;
     })()`
  )

/** 点某一组的全选复选框 */
const clickGroup = (w, name) =>
  js(
    w,
    `(() => {
       const g = [...document.querySelectorAll('.sidebar .wsgroup')].find(
         (el) => el.querySelector('.wsgroup__name')?.textContent === ${JSON.stringify(name)}
       );
       const cbx = g?.querySelector('.wsgroup__head .cbx');
       cbx?.click();
       return !!cbx;
     })()`
  )

const state = (w) =>
  js(
    w,
    `(() => {
       const box = document.querySelector('.batchbar');
       return {
         selecting: !!document.querySelector('.sidebar__scroll.is-selecting'),
         checkboxes: document.querySelectorAll('.session.is-selecting .cbx').length,
         checked: document.querySelectorAll('.session.is-checked').length,
         bar: !!box,
         count: box?.querySelector('.batchbar__count')?.textContent || '',
         deleteDisabled: box ? box.querySelector('.batchbar__btn--danger').disabled : null,
         groupMixed: !!document.querySelector('.wsgroup__head .cbx.is-mixed'),
         groupOn: !!document.querySelector('.wsgroup__head .cbx.is-on'),
         modal: !!document.querySelector('.modal__dlg'),
         modalRows: [...document.querySelectorAll('.delbatch__title')].map((e) => e.textContent),
         modalGroups: [...document.querySelectorAll('.delbatch__cwd')].map((e) => e.textContent),
         modalTitle: document.querySelector('.modal__t')?.textContent || '',
         modalWarn: [...document.querySelectorAll('.delinfo__warn')].map((e) => e.textContent)
       };
     })()`
  )

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
  await sleep(2200)

  console.log('\n[1] 进入批量选择模式')
  check('进入前没有勾选框', (await state(win)).checkboxes === 0)
  check('点得到「批量选择」入口', await enterSelect(win))
  await sleep(300)
  let s = await state(win)
  check('进入选择模式', s.selecting, JSON.stringify(s))
  check('每行都出现勾选框', s.checkboxes === 4, String(s.checkboxes))
  check('底部操作条出现', s.bar)
  check('未勾选时「删除」禁用', s.deleteDisabled === true, String(s.deleteDisabled))
  check('未勾选时计数为 0', s.count.includes('0'), s.count)

  console.log('\n[2] 点整行 = 勾选（不切会话）')
  const startsBefore = starts.length
  check('找到会话 A', await clickRow(win, '会话 A'))
  await sleep(250)
  s = await state(win)
  check('会话 A 被勾上', s.checked === 1, String(s.checked))
  check('没有因为勾选去开会话', starts.length === startsBefore, `${startsBefore} → ${starts.length}`)
  check('计数变成 1', s.count.includes('1'), s.count)
  check('「删除」变为可用', s.deleteDisabled === false)

  check('再点一次取消勾选', await clickRow(win, '会话 A'))
  await sleep(250)
  s = await state(win)
  check('勾选数回到 0', s.checked === 0, String(s.checked))
  check('「删除」重新禁用', s.deleteDisabled === true)

  console.log('\n[3] 组头全选与半选')
  check('点得下 CCoder-Desktop 的全选', await clickGroup(win, 'CCoder-Desktop'))
  await sleep(250)
  s = await state(win)
  check('这一组的 3 条全勾上', s.checked === 3, String(s.checked))
  check('组头是全选态', s.groupOn && !s.groupMixed, JSON.stringify(s))
  check('计数是 3', s.count.includes('3'), s.count)

  check('取消一条后变半选', await clickRow(win, '会话 B'))
  await sleep(250)
  s = await state(win)
  check('剩 2 条勾选', s.checked === 2, String(s.checked))
  check('组头是半选态', s.groupMixed, JSON.stringify(s))

  check('再点组头恢复全选', await clickGroup(win, 'CCoder-Desktop'))
  await sleep(250)
  check('又回到 3 条', (await state(win)).checked === 3)

  console.log('\n[4] 跨工作区勾选 + 确认弹窗')
  check('勾上另一个工作区的会话 D', await clickRow(win, '会话 D'))
  await sleep(250)
  s = await state(win)
  check('总共 4 条', s.checked === 4, String(s.checked))

  // 让会话 A 处于运行中，确认页要标出来
  win.webContents.send('session:status', {
    sessionId: 'live-run',
    status: 'running',
    providerSessionId: 'a-0001'
  })
  await sleep(300)

  await js(win, `document.querySelector('.batchbar__btn--danger')?.click()`)
  await sleep(400)
  s = await state(win)
  check('确认弹窗打开', s.modal, JSON.stringify(s))
  check('标题写 4 条', s.modalTitle.includes('4'), s.modalTitle)
  check('按两个工作区分组', s.modalGroups.length === 2, JSON.stringify(s.modalGroups))
  check('列出 4 条标题', s.modalRows.length === 4, JSON.stringify(s.modalRows))
  check(
    '警告里提到有 1 条正在运行',
    s.modalWarn.some((w) => w.includes('1') && w.includes('运行')),
    JSON.stringify(s.modalWarn)
  )

  console.log('\n[5] 取消：勾选保留，一条都不删')
  await js(win, `document.querySelector('.modal .btn')?.click()`)
  await sleep(300)
  s = await state(win)
  check('弹窗关闭', !s.modal)
  check('勾选还留着', s.checked === 4, String(s.checked))
  check('没有调用删除', deletes.length === 0, JSON.stringify(deletes))

  console.log('\n[5b] 弹窗开着按 Esc：只关弹窗，不清勾选')
  await js(win, `document.querySelector('.batchbar__btn--danger')?.click()`)
  await sleep(400)
  await js(
    win,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
  )
  await sleep(350)
  s = await state(win)
  check('Esc 关掉了弹窗', !s.modal, JSON.stringify(s))
  check('Esc 没有顺手清掉勾选', s.checked === 4, String(s.checked))
  check('仍然停在选择模式', s.selecting, JSON.stringify(s))

  console.log('\n[6] 确认删除：逐条删、删完退出选择模式')
  await js(win, `document.querySelector('.batchbar__btn--danger')?.click()`)
  await sleep(400)
  await js(
    win,
    `(() => {
       const btns = [...document.querySelectorAll('.modal .btn')];
       btns.at(-1)?.click();
       return true;
     })()`
  )
  const done = await waitFor(async () => deletes.length === 4, 5000)
  check('4 条都调了删除', done, JSON.stringify(deletes))
  check('删光了列表里那 4 条', (await rowTitles(win)).length === 0, JSON.stringify(await rowTitles(win)))
  await sleep(500)
  s = await state(win)
  check('删完自动退出选择模式', !s.selecting && !s.bar && s.checkboxes === 0, JSON.stringify(s))

  console.log('\n[7] 部分失败：汇总提示，不静默吞掉')
  // 让列表重新出现两条会话来测
  deletes.length = 0
  failDeleteId = 'a-0002'
  await win.webContents.reload()
  await sleep(2200)
  await enterSelect(win)
  await sleep(250)
  await clickRow(win, '会话 A')
  await clickRow(win, '会话 B')
  await sleep(250)
  await js(win, `document.querySelector('.batchbar__btn--danger')?.click()`)
  await sleep(400)
  await js(win, `[...document.querySelectorAll('.modal .btn')].at(-1)?.click()`)
  await waitFor(async () => deletes.length === 1, 4000)
  await sleep(400)
  const notice = await js(win, `document.querySelector('.notice')?.textContent || ''`)
  check('成功的 1 条被计入', deletes.length === 1, JSON.stringify(deletes))
  check('提示里说明 1 条失败', notice.includes('1') && notice.includes('失败'), notice)
  s = await state(win)
  check('失败的那条留在勾选里，可以重试', s.checked === 1, String(s.checked))
  check('选择模式没有退出（还有失败的）', s.selecting, JSON.stringify(s))

  console.log('\n[8] 失败后重试：去掉失败原因就能删掉')
  failDeleteId = null
  await js(win, `document.querySelector('.batchbar__btn--danger')?.click()`)
  await sleep(400)
  await js(win, `[...document.querySelectorAll('.modal .btn')].at(-1)?.click()`)
  await waitFor(async () => deletes.length === 2, 4000)
  await sleep(500)
  s = await state(win)
  check('重试把剩下的也删掉了', deletes.length === 2, JSON.stringify(deletes))
  check('删干净后退出选择模式', !s.selecting && s.checked === 0, JSON.stringify(s))

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
  app.exit(failed === 0 ? 0 : 1)
})
