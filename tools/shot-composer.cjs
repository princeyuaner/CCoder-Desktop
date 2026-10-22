/*
 * 输入框增强的实机验证 + 截图：
 *   1. @ 文件引用弹层、Enter 插入路径
 *   2. / 系统指令弹层、/model 打开选择器
 *   3. Ctrl+V 图片 → 附件缩略图 → 发送时带上 base64 image
 *
 * 用法：先 electron-vite build，再 electron tools/shot-composer.cjs
 * 不参与打包，随时可删。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const OUT_DIR = path.join(__dirname, '..', 'docs', 'mockups')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ch = (id, name, baseUrl, model) => ({
  id,
  name,
  kind: 'anthropic',
  baseUrl,
  model,
  models: [],
  smallFastModel: '',
  authMode: 'token',
  authToken: 'sk-xxxxxxxxxxxxxxxxxxxx',
  extraEnv: []
})

const CWD = 'C:\\Users\\CY\\Desktop\\CCoder-Desktop'

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
      channels: [ch('demo-1', 'DeepSeek 中转', 'https://api.deepseek.com/anthropic', 'deepseek-reasoner')]
    },
    codex: { enabled: false, activeChannelId: null, effort: 'medium', channels: [] }
  }
}

const SESSIONS = [
  {
    id: 'a1-new-0001',
    cwd: CWD,
    title: '输入框 · 图片 / @ / 指令',
    updatedAt: Date.now() - 30_000,
    cli: 'claude'
  }
]

const FILES = [
  { path: 'src/renderer/src/useChat.ts', name: 'useChat.ts', dir: 'src/renderer/src', kind: 'file' },
  { path: 'src/renderer/src/useSettings.ts', name: 'useSettings.ts', dir: 'src/renderer/src', kind: 'file' },
  { path: 'src/renderer/src/useSessions.ts', name: 'useSessions.ts', dir: 'src/renderer/src', kind: 'file' },
  { path: 'src/renderer/src/components/Composer.tsx', name: 'Composer.tsx', dir: 'src/renderer/src/components', kind: 'file' },
  { path: 'src/renderer/src/run-state.ts', name: 'run-state.ts', dir: 'src/renderer/src', kind: 'file' }
]

let lastSend = null

ipcMain.handle('win:is-maximized', () => false)
ipcMain.handle('settings:get', () => DEMO)
ipcMain.handle('settings:save', (_e, s) => s)
ipcMain.handle('channel:test', () => ({ ok: true, message: 'pong', latencyMs: 120 }))
ipcMain.handle('sessions:list', () => SESSIONS)
ipcMain.handle('sessions:transcript', () => [])
ipcMain.handle('sessions:delete', () => ({ ok: true }))
ipcMain.handle('sessions:pick-dir', () => null)
ipcMain.handle('session:running', () => [])
ipcMain.handle('session:start', () => 'live-composer')
ipcMain.handle('session:send', (_e, id, input) => {
  lastSend = input
  return { ok: true }
})
ipcMain.handle('workspace:search-files', (_e, cwd, query) => {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return FILES.slice(0, 20)
  return FILES.filter(
    (f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)
  ).slice(0, 20)
})

let failed = 0
function check(label, cond, detail) {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : String(detail))
  }
}

/** 直接改 React 受控 textarea 的 value 不会触发 onChange —— 走原生 setter + input 事件 */
async function setInput(win, value) {
  return win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.composer__input');
    if (!el) return null;
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()`)
}

const q = (win, sel, fn) =>
  win.webContents.executeJavaScript(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
    return (${fn})(els);
  })()`)

async function shot(win, name) {
  const img = await win.webContents.capturePage()
  const out = path.join(OUT_DIR, name)
  fs.writeFileSync(out, img.toPNG())
  console.log(`wrote ${out}`)
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
  await sleep(1600)

  console.log('\n[0] /clear 从已有会话回到新会话')
  await win.webContents.executeJavaScript(`document.querySelector('.session__main')?.click()`)
  await sleep(600)
  const openedTitle = await win.webContents.executeJavaScript(
    `document.querySelector('.chathead__title')?.textContent`
  )
  check('已打开侧栏里的已有会话', openedTitle === '输入框 · 图片 / @ / 指令', openedTitle)

  await setInput(win, '/')
  await sleep(250)
  await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('.cpop--command .ccmd')];
    const row = rows.find((r) => r.querySelector('.ccmd__name').textContent === '/clear');
    if (row) row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  })()`)
  await sleep(500)
  const cleared = await win.webContents.executeJavaScript(`({
    title: document.querySelector('.chathead__title')?.textContent,
    text: document.querySelector('.composer__input')?.value,
    rows: document.querySelectorAll('.session').length
  })`)
  check(
    '/clear 回到新会话且不删侧栏记录',
    cleared.title === '新会话' && cleared.text === '' && cleared.rows === 1,
    JSON.stringify(cleared)
  )

  console.log('\n[1] @ 文件引用')
  await setInput(win, '@use')
  await sleep(500)
  const mention = await q(
    win,
    '.cpop--mention .citem',
    (els) => ({ count: els.length, names: els.map((e) => e.querySelector('.citem__name').textContent) })
  )
  check('@ 弹层出现并列出匹配文件', mention.count >= 3, JSON.stringify(mention))
  await shot(win, 'live-composer-at.png')

  await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.composer__input');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`)
  await sleep(250)
  const inserted = await win.webContents.executeJavaScript(
    `document.querySelector('.composer__input').value`
  )
  check('Enter 插入文件路径', inserted.includes('@src/renderer/src/useChat.ts'), inserted)

  console.log('\n[2] / 系统指令')
  await setInput(win, '/')
  await sleep(250)
  const commands = await q(
    win,
    '.cpop--command .ccmd',
    (els) => ({ count: els.length, names: els.map((e) => e.querySelector('.ccmd__name').textContent) })
  )
  check('指令弹层出现', commands.count >= 5 && commands.names.includes('/model'), JSON.stringify(commands))
  await shot(win, 'live-composer-slash.png')

  // 选中 /model（/clear, /compact, /model 里的第三个），应打开模型选择器
  await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('.cpop--command .ccmd')];
    const row = rows.find((r) => r.querySelector('.ccmd__name').textContent === '/model');
    if (row) row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  })()`)
  await sleep(250)
  const pickerOpen = await win.webContents.executeJavaScript(
    `!!document.querySelector('.picker__pop')`
  )
  check('/model 打开模型选择器', pickerOpen)

  // 关掉模型选择器，别让它挡住后面的图片附件截图
  await win.webContents.executeJavaScript(
    `document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`
  )
  await sleep(200)
  const pickerClosed = await win.webContents.executeJavaScript(
    `!document.querySelector('.picker__pop')`
  )
  check('点外面能收起模型选择器', pickerClosed)

  console.log('\n[3] Ctrl+V 图片粘贴')
  await setInput(win, '')
  await sleep(100)
  // 用一张真实截图当“粘进来的图”，缩略图和用户气泡才看得出来
  const png = fs
    .readFileSync(path.join(__dirname, '..', 'shot-running.png'))
    .toString('base64')
  const pasted = await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.composer__input');
    if (!el) return 'no input';
    const bytes = Uint8Array.from(atob(${JSON.stringify(png)}), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'shot.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: dt });
    el.dispatchEvent(ev);
    return 'ok';
  })()`)
  await sleep(700)
  const attach = await q(
    win,
    '.composer__attach',
    (els) => els.map((e) => !!e.querySelector('img'))
  )
  check('粘贴后出现附件缩略图', pasted === 'ok' && attach.length === 1 && attach[0], JSON.stringify(attach))
  await setInput(win, '看下这张截图，分隔线是不是太亮了？')
  await sleep(200)
  await shot(win, 'live-composer-image.png')

  await win.webContents.executeJavaScript(
    `document.querySelector('.composer__bar .send')?.click()`
  )
  await sleep(500)
  check(
    '发送时图片以 base64 image 附件带上',
    !!lastSend && lastSend.images && lastSend.images.length === 1 &&
      lastSend.images[0].mediaType === 'image/png' &&
      lastSend.images[0].data.length > 10,
    JSON.stringify(lastSend && { text: lastSend.text, images: lastSend.images?.map((i) => i.mediaType) })
  )
  await shot(win, 'live-composer-sent.png')

  console.log('\n[4] 浅色主题')
  await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = 'light'`)
  await setInput(win, '@use')
  await sleep(400)
  await shot(win, 'live-composer-at-light.png')
  await setInput(win, '/')
  await sleep(300)
  await shot(win, 'live-composer-slash-light.png')

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
  app.exit(failed === 0 ? 0 : 1)
})
