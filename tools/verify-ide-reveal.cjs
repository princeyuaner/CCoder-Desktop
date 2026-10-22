/*
 * 开发辅助：验证「工具卡里的文件 → 在 IDE 中打开」这条链路。
 *
 * 覆盖三件事：
 *  1. 转写区里 Read/Edit 卡的文件名可点，点击会带 cwd / 绝对路径 / 行号
 *     调 ide:open-file；
 *  2. IDE 窗口首屏 query（?file=&line=）能直接开出对应标签；
 *  3. 已经开着的 IDE 窗口收到 ide:reveal 后切到目标文件（图片走图片查看器）。
 *
 * 用法：npx electron tools/verify-ide-reveal.cjs
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-ide-'))
const SID = 'verify-session'
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

fs.mkdirSync(path.join(CWD, 'src'), { recursive: true })
fs.writeFileSync(
  path.join(CWD, 'src', 'app.ts'),
  Array.from({ length: 12 }, (_, i) => `export const line${i + 1} = ${i + 1}`).join('\n') + '\n'
)
fs.writeFileSync(path.join(CWD, 'src', 'other.ts'), 'export const name = "other"\n')
fs.writeFileSync(path.join(CWD, 'src', 'pic.png'), Buffer.from(PNG, 'base64'))

const settings = {
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
    claude: { enabled: true, activeChannelId: null, channels: [], effort: 'medium' },
    codex: { enabled: false, activeChannelId: null, channels: [], effort: 'medium' }
  }
}

let openFileCall = null

ipcMain.handle('win:is-maximized', () => false)
ipcMain.handle('settings:get', () => settings)
ipcMain.handle('settings:save', (_e, s) => s)
ipcMain.handle('sessions:list', () => [])
ipcMain.handle('sessions:transcript', () => [])
ipcMain.handle('session:start', () => SID)
ipcMain.handle('session:send', () => ({ ok: true }))
ipcMain.handle('session:running', () => [])
ipcMain.handle('ide:open-file', (_e, cwd, file, line) => {
  openFileCall = { cwd, file, line }
  return { ok: true }
})
ipcMain.handle('ide:list-dir', (_e, cwd, rel) =>
  (rel || '') === ''
    ? [
        { name: 'src', rel: 'src', kind: 'dir' },
        { name: 'pic.png', rel: 'pic.png', kind: 'file' }
      ]
    : [
        { name: 'app.ts', rel: `${rel}/app.ts`, kind: 'file' },
        { name: 'other.ts', rel: `${rel}/other.ts`, kind: 'file' },
        { name: 'pic.png', rel: `${rel}/pic.png`, kind: 'file' }
      ]
)
ipcMain.handle('ide:read-file', (_e, cwd, rel) => {
  const text = fs.readFileSync(path.join(cwd, rel), 'utf8')
  return { rel, text, size: Buffer.byteLength(text), language: 'TypeScript', truncated: false, binary: false }
})
ipcMain.handle('ide:read-image', (_e, cwd, rel) => ({
  rel,
  dataUrl: `data:image/png;base64,${PNG}`,
  size: 68,
  mime: 'image/png'
}))
ipcMain.handle('ide:git-status', () => ({ repo: false, branch: '', files: [] }))
ipcMain.handle('ide:git-diff', () => ({ repo: false, diff: '' }))
ipcMain.handle('vcs:detect', () => ({
  ok: true,
  data: { repo: null, available: { git: true, svn: false }, reason: 'no-repo' }
}))
ipcMain.handle('vcs:status', () => ({
  ok: false,
  error: { code: 'no-repo', message: 'not a repo' }
}))
ipcMain.handle('workspace:search-files', () => [])

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) failures.push(label)
}

function newWindow() {
  return new BrowserWindow({
    width: 1280,
    height: 820,
    // 截图时得真显示窗口，隐藏窗口的合成帧可能停在旧内容上
    show: !!process.env.SHOT,
    frame: false,
    webPreferences: {
      preload: path.join(ROOT, 'out', 'preload', 'index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
}

app.whenReady().then(async () => {
  // ── 1. 聊天窗口：工具卡里的文件名可点 ──
  const chat = newWindow()
  await chat.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  await wait(1200)

  const send = (event) => chat.webContents.send('session:event', { sessionId: SID, event })
  chat.webContents.send('session:status', { sessionId: SID, status: 'running', providerSessionId: 'p1' })
  chat.webContents.send('session:event', {
    sessionId: SID,
    event: {
      t: 'session_started',
      sessionId: 'p1',
      provider: 'claude',
      model: 'm',
      cwd: CWD,
      tools: [],
      permissionMode: 'standard'
    }
  })
  send({ t: 'user_message', text: '看一下这个文件', at: new Date().toISOString() })
  send({
    t: 'tool_call',
    id: 't1',
    name: 'Read',
    input: { file_path: path.join(CWD, 'src', 'app.ts'), offset: 7 }
  })
  send({ t: 'tool_result', id: 't1', status: 'ok', content: 'export const answer = 42' })
  await wait(500)

  const link = await chat.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.tool__subject--open')
    return el ? { text: el.textContent, title: el.title } : null
  })()`)
  check(!!link, '工具卡渲染出可点击的文件名')
  check(!!link && link.title.includes(':7'), 'title 带上 Read 的起始行')

  const deco = await chat.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.tool__subjtext')
    const s = getComputedStyle(el)
    return { line: s.textDecorationLine, color: s.textDecorationColor }
  })()`)
  check(deco.line.includes('underline'), `可点文件名带常驻下划线（${deco.color}）`)
  if (process.env.SHOT) {
    fs.writeFileSync(process.env.SHOT, (await chat.capturePage()).toPNG())
  }

  await chat.webContents.executeJavaScript(
    `document.querySelector('.tool__subject--open').click()`
  )
  await wait(400)
  check(
    !!openFileCall &&
      openFileCall.cwd === CWD &&
      openFileCall.file === path.join(CWD, 'src', 'app.ts') &&
      openFileCall.line === 7,
    '点击交给主进程：cwd + 绝对路径 + 行号'
  )

  // ── 2. IDE 窗口首屏 query 直接定位 ──
  const target = encodeURIComponent('src/app.ts')
  const ide = newWindow()
  await ide.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'), {
    query: { view: 'ide', cwd: CWD, file: 'src/app.ts', line: '7' }
  })
  let ready = false
  for (let i = 0; i < 60; i++) {
    ready = await ide.webContents.executeJavaScript(`!!document.querySelector('.ide-monaco')?.__ccoderEditor`)
    if (ready) break
    await wait(100)
  }
  check(ready, '编辑器在 6 秒内完成加载')
  const first = await ide.webContents.executeJavaScript(`(() => {
    const host = document.querySelector('.ide-monaco')
    const editor = host && host.__ccoderEditor
    const pos = editor && editor.getPosition()
    return {
      tab: document.querySelector('.ide-tab.on .ide-tab-title')?.textContent ?? '',
      code: editor ? editor.getModel().getValue() : '',
      jumped: !!pos && pos.lineNumber === 7
    }
  })()`)
  check(first.tab === 'app.ts', 'IDE 首屏打开 query 指定的文件')
  check(first.code.includes('line8 = 8'), '文件内容已渲染')
  check(first.jumped, '按 line 跳到对应行')

  // ── 3. 已开窗口收到 reveal：切文件 / 图片 ──
  ide.webContents.send('ide:reveal', { rel: 'src/other.ts' })
  await wait(500)
  const second = await ide.webContents.executeJavaScript(
    `document.querySelector('.ide-tab.on .ide-tab-title')?.textContent ?? ''`
  )
  check(second === 'other.ts', 'reveal 在已开窗口里切到另一个文件')

  ide.webContents.send('ide:reveal', { rel: 'src/pic.png' })
  await wait(600)
  const pic = await ide.webContents.executeJavaScript(`(() => ({
    tabs: [...document.querySelectorAll('.ide-tab-title')].map((e) => e.textContent),
    img: !!document.querySelector('.ide-canvas img')
  }))()`)
  check(pic.tabs.includes('pic.png'), '图片目标开出图片标签')
  check(pic.img, '图片走 ImageViewer 渲染')

  if (failures.length) {
    console.error(`\n${failures.length} 项失败`)
    app.exit(1)
  } else {
    console.log('\n全部通过')
    app.exit(0)
  }
})
