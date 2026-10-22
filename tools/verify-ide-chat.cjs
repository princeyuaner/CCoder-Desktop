/*
 * 开发辅助：验证 IDE → 聊天 的完整链路。
 *
 *  1. 选中代码 → 右键「发送选区到聊天」→ 确认层 → 主进程收到 refs
 *  2. 右键「发送当前文件到聊天」→ 整文件引用
 *  3. 资源管理器右键文件 →「发送到聊天」
 *  4. 选区超过 500 行 → 提示「前 500 行 / 整份文件」
 *  5. 聊天窗口收到引用 → 输入框卡片 → 发送正文带 <ide_reference> 块
 *  6. 转写区把引用块还原成卡片，不把 XML 露给用户
 *
 * 用法：npx electron tools/verify-ide-chat.cjs
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-ide-chat-'))
const SID = 'verify-ide-chat'

// 别跟正在运行的正式实例抢同一个 userData / LevelDB 锁
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-verify-userdata-')))

fs.mkdirSync(path.join(CWD, 'src'), { recursive: true })
fs.writeFileSync(
  path.join(CWD, 'src', 'sample.ts'),
  Array.from({ length: 20 }, (_, i) => `export const line${i + 1} = ${i + 1}`).join('\n') + '\n'
)
fs.writeFileSync(
  path.join(CWD, 'src', 'big.ts'),
  Array.from({ length: 600 }, (_, i) => `export const big${i + 1} = ${i + 1}`).join('\n') + '\n'
)

const IMAGE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const ch = {
  id: 'demo',
  name: 'DeepSeek 中转',
  kind: 'anthropic',
  baseUrl: 'https://api.deepseek.com/anthropic',
  model: 'deepseek-v4.1-flash[1m]',
  smallFastModel: '',
  authMode: 'token',
  authToken: 'sk-xxxxxxxxxxxxxxxxxxxx',
  extraEnv: []
}

const settings = {
  permissionMode: 'standard',
  defaultCwd: CWD,
  openedCwds: [CWD],
  theme: process.env.SHOT_THEME === 'light' ? 'light' : 'dark',
  uiZoom: 1,
  chatFontSize: 14,
  uiFont: "system-ui, 'Segoe UI', sans-serif",
  monoFont: "'Cascadia Mono', Consolas, monospace",
  showTimestamps: false,
  thinkingOpen: false,
  toolDetail: 'full',
  sendKey: 'enter',
  clis: {
    claude: { enabled: true, activeChannelId: 'demo', channels: [ch], effort: 'medium' },
    codex: { enabled: false, activeChannelId: null, channels: [], effort: 'medium' }
  }
}

const LANG = { '.ts': 'TypeScript', '.tsx': 'TypeScript React', '.md': 'Markdown' }

function listDir(cwd, rel) {
  const out = fs.readdirSync(path.join(cwd, rel || ''), { withFileTypes: true }).map((e) => ({
    name: e.name,
    rel: (rel ? `${rel}/` : '') + e.name,
    kind: e.isDirectory() ? 'dir' : 'file'
  }))
  return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
}

function readFile(cwd, rel) {
  const abs = path.join(cwd, rel)
  const text = fs.readFileSync(abs, 'utf8')
  return {
    rel,
    text,
    size: Buffer.byteLength(text),
    language: LANG[path.extname(rel).toLowerCase()] || 'Text',
    truncated: false,
    binary: false
  }
}

let sendRefsPayload = null
let sentInput = null

ipcMain.handle('win:is-maximized', () => false)
ipcMain.handle('settings:get', () => settings)
ipcMain.handle('settings:save', (_e, s) => s)
ipcMain.handle('channel:test', () => ({ ok: true, message: 'pong' }))
ipcMain.handle('sessions:list', () => [])
ipcMain.handle('sessions:transcript', () => [])
ipcMain.handle('sessions:pick-dir', () => null)
ipcMain.handle('sessions:delete', () => ({ ok: true }))
ipcMain.handle('session:start', () => SID)
ipcMain.handle('session:send', (_e, _id, input) => {
  sentInput = input
  return { ok: true }
})
ipcMain.handle('session:running', () => [])
ipcMain.handle('workspace:search-files', () => [])
ipcMain.handle('ide:open', () => undefined)
ipcMain.handle('ide:open-file', () => ({ ok: true }))
ipcMain.handle('ide:list-dir', (_e, cwd, rel) => listDir(cwd, rel))
ipcMain.handle('ide:read-file', (_e, cwd, rel) => readFile(cwd, rel))
ipcMain.handle('ide:read-image', () => ({
  rel: 'src/pic.png',
  dataUrl: `data:image/png;base64,${IMAGE_PNG}`,
  size: 68,
  mime: 'image/png'
}))
ipcMain.handle('ide:search-code', () => [])
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
ipcMain.handle('ide:chat-targets', () => [
  {
    kind: 'active',
    id: null,
    cwd: CWD,
    title: '修复登录流程',
    cli: 'claude',
    isNew: true
  }
])
ipcMain.handle('ide:send-refs', (_e, payload) => {
  sendRefsPayload = payload
  return { ok: true }
})
ipcMain.on('chat:report-active', () => undefined)

app.on('window-all-closed', () => {})

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const SHOT_DIR = process.env.SHOT_DIR || ''
const shot = async (win, name) => {
  if (!SHOT_DIR) return
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), (await win.capturePage()).toPNG())
}
const failures = []
const check = (ok, label, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

function newWindow() {
  return new BrowserWindow({
    width: 1360,
    height: 860,
    show: true,
    frame: false,
    backgroundColor: '#191919',
    webPreferences: {
      preload: path.join(ROOT, 'out', 'preload', 'index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
}

async function loadIde(win, file, line) {
  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'), {
    query: { view: 'ide', cwd: CWD, file, ...(line ? { line: String(line) } : {}) }
  })
  await wait(1300)
}

const selectLines = `
(() => {
  const host = document.querySelector('.ide-monaco')
  const editor = host && host.__ccoderEditor
  const monaco = host && host.__ccoderMonaco
  if (!editor || !monaco) return false
  const model = editor.getModel()
  editor.focus()
  editor.setSelection(
    new monaco.Selection(START, 1, END, model.getLineMaxColumn(END))
  )
  return true
})()
`

app.whenReady().then(async () => {
  // ── 1. 选区发送 ──
  const ide = newWindow()
  ide.setPosition(80, 40)
  await loadIde(ide, 'src/sample.ts', 3)

  await ide.webContents.executeJavaScript(
    selectLines.replaceAll('START', '3').replaceAll('END', '6')
  )
  await wait(350)
  const selectedLines = await ide.webContents.executeJavaScript(`(() => {
    const editor = document.querySelector('.ide-monaco')?.__ccoderEditor
    const sel = editor?.getSelection()
    return sel ? Math.abs(sel.endLineNumber - sel.startLineNumber) + 1 : 0
  })()`)
  check(selectedLines === 4, '选区行数正确', String(selectedLines))
  await shot(ide, 'ide-selection-lines')

  const selectionAction = await ide.webContents.executeJavaScript(`(() => {
    const editor = document.querySelector('.ide-monaco')?.__ccoderEditor
    const action = editor?.getAction('ccoder.sendSelection')
    if (!action) return false
    action.run()
    return true
  })()`)
  check(selectionAction, '「发送选区到聊天」动作存在')
  await wait(400)
  const pop = await ide.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.ide-sendpop')
    return el ? {
      text: el.textContent,
      target: el.querySelector('.ide-target__name')?.textContent ?? '',
      range: el.querySelector('.ide-refpreview__range')?.textContent ?? '',
      code: el.querySelector('.ide-refpreview__code')?.textContent ?? ''
    } : null
  })()`)
  check(!!pop, '确认层打开')
  check(pop && pop.target === '修复登录流程', '目标会话是当前会话', pop && pop.target)
  check(pop && pop.range === 'L3–6', '引用范围正确', pop && pop.range)
  check(pop && pop.code.includes('line4'), '代码预览正确')
  await shot(ide, 'ide-selection')

  await ide.webContents.executeJavaScript(`document.querySelector('.ide-sendpop__send').click()`)
  await wait(400)
  check(!!sendRefsPayload, '主进程收到发送请求')
  check(
    sendRefsPayload &&
      sendRefsPayload.refs[0].kind === 'selection' &&
      sendRefsPayload.refs[0].startLine === 3 &&
      sendRefsPayload.refs[0].endLine === 6,
    '选区行号正确',
    sendRefsPayload && JSON.stringify({
      start: sendRefsPayload.refs[0].startLine,
      end: sendRefsPayload.refs[0].endLine
    })
  )
  const selCode = sendRefsPayload?.refs[0]?.code ?? ''
  check(
    selCode.includes('line3') && selCode.includes('line6') && !selCode.includes('line7'),
    '选区代码是文件原文'
  )
  const flash = await ide.webContents.executeJavaScript(
    `document.querySelector('.ide-toast.is-ok')?.textContent ?? ''`
  )
  check(flash.includes('已附加到聊天'), 'IDE 显示 2 秒轻提示', flash)

  // ── 2. 整文件发送 ──
  sendRefsPayload = null
  await ide.webContents.executeJavaScript(`(() => {
    const editor = document.querySelector('.ide-monaco')?.__ccoderEditor
    editor?.getAction('ccoder.sendFile')?.run()
  })()`)
  await wait(300)
  const fileRange = await ide.webContents.executeJavaScript(
    `document.querySelector('.ide-refpreview__range')?.textContent ?? ''`
  )
  check(fileRange.includes('全文'), '整文件模式显示「全文」', fileRange)
  await ide.webContents.executeJavaScript(`document.querySelector('.ide-sendpop__send').click()`)
  await wait(300)
  check(
    sendRefsPayload && sendRefsPayload.refs[0].kind === 'file' &&
      sendRefsPayload.refs[0].code.includes('line20'),
    '整文件引用包含完整内容'
  )

  // 资源管理器右键菜单里的「发送到聊天」
  await ide.webContents.executeJavaScript(`(() => {
    const el = [...document.querySelectorAll('.ide-trow.is-dir')]
      .find((r) => r.getAttribute('title') === 'src')
    if (el) el.click()
  })()`)
  await wait(450)
  await ide.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.ide-trow.is-file')]
      .find((r) => r.getAttribute('title') === 'src/sample.ts')
    if (!row) return false
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 240,
      clientY: 320
    }))
    return true
  })()`)
  await wait(200)
  const treeMenu = await ide.webContents.executeJavaScript(
    `document.querySelector('.ide-ctx')?.textContent ?? ''`
  )
  check(treeMenu.includes('发送到聊天'), '文件右键菜单出现发送项', treeMenu)
  const treeSend = await ide.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('.ide-ctx button')]
      .find((b) => b.textContent.includes('发送到聊天'))
    if (!btn) return false
    btn.click()
    return true
  })()`)
  await wait(350)
  const treeDraft = await ide.webContents.executeJavaScript(
    `document.querySelector('.ide-refpreview__range')?.textContent ?? ''`
  )
  check(treeSend && treeDraft.includes('全文'), '文件树行可以发送整文件', treeDraft)
  await ide.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  await wait(200)

  // ── 3. 超长选区 ──
  sendRefsPayload = null
  await loadIde(ide, 'src/big.ts', 300)
  await ide.webContents.executeJavaScript(
    selectLines.replaceAll('START', '1').replaceAll('END', '600')
  )
  await wait(350)
  const bigLines = await ide.webContents.executeJavaScript(`(() => {
    const editor = document.querySelector('.ide-monaco')?.__ccoderEditor
    const sel = editor?.getSelection()
    return sel ? Math.abs(sel.endLineNumber - sel.startLineNumber) + 1 : 0
  })()`)
  check(bigLines === 600, '600 行选区被识别', String(bigLines))
  await ide.webContents.executeJavaScript(`(() => {
    const editor = document.querySelector('.ide-monaco')?.__ccoderEditor
    editor?.getAction('ccoder.sendSelection')?.run()
  })()`)
  await wait(350)
  const warn = await ide.webContents.executeJavaScript(
    `document.querySelector('.ide-sendpop__warn')?.textContent ?? ''`
  )
  check(warn.includes('600') && warn.includes('500'), '超长选区显示提示', warn)
  const actions = await ide.webContents.executeJavaScript(`(() => ({
    ghost: document.querySelector('.ide-sendpop__ghost')?.textContent ?? '',
    send: document.querySelector('.ide-sendpop__send')?.textContent ?? ''
  }))()`)
  check(actions.ghost.includes('整份文件') && actions.send.includes('前 500 行'), '提供两个出口')
  await shot(ide, 'ide-oversized')
  await ide.webContents.executeJavaScript(`document.querySelector('.ide-sendpop__send').click()`)
  await wait(300)
  const clipped = sendRefsPayload?.refs[0]
  check(
    clipped && clipped.kind === 'selection' && clipped.startLine === 1 && clipped.endLine === 500 &&
      clipped.code.split('\n').length === 500,
    '「前 500 行」截断正确',
    clipped && `${clipped.startLine}-${clipped.endLine} / ${clipped.code.split('\n').length}`
  )
  ide.destroy()

  // ── 4. 聊天窗口接收 + 发送格式 ──
  const chat = newWindow()
  chat.setPosition(120, 70)
  await chat.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  await wait(1600)

  const ref = {
    id: 'ref-1',
    kind: 'selection',
    rel: 'src/sample.ts',
    path: `${CWD.replace(/\\/g, '/')}/src/sample.ts`,
    name: 'sample.ts',
    startLine: 3,
    endLine: 6,
    lang: 'ts',
    code: 'export const line3 = 3\nexport const line4 = 4\nexport const line5 = 5\nexport const line6 = 6',
    totalLines: 20,
    cwd: CWD
  }
  chat.webContents.send('chat:attach-refs', {
    target: {
      kind: 'active',
      id: null,
      cwd: CWD,
      title: '新会话',
      cli: 'claude',
      isNew: true
    },
    refs: [ref]
  })
  await wait(500)
  const card = await chat.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.composer__ref')
    return el ? {
      text: el.textContent,
      range: el.querySelector('.composer__ref-range')?.textContent ?? '',
      code: el.querySelector('.composer__ref-code')?.textContent ?? ''
    } : null
  })()`)
  check(!!card, '聊天输入框出现引用卡')
  check(card && card.range === 'L3–6', '输入框范围正确', card && card.range)
  check(card && card.text.includes('来自 IDE'), '输入框标明来源')
  await shot(chat, 'chat-ref')

  await chat.webContents.executeJavaScript(`(() => {
    const ta = document.querySelector('.composer__input')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '这两段可以合并吗？')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await wait(200)
  await chat.webContents.executeJavaScript(`document.querySelector('.send').click()`)
  await wait(500)

  const body = sentInput?.text ?? ''
  check(body.startsWith('这两段可以合并吗？'), '用户原话保留')
  check(body.includes('<ide_reference path="src/sample.ts" lines="3-6" lang="ts">'), '正文带引用标签')
  check(body.includes('export const line4 = 4'), '正文含完整选区代码')
  await chat.webContents.executeJavaScript(`document.querySelector('.tl__ref-head')?.click()`)
  await wait(200)
  const after = await chat.webContents.executeJavaScript(`(() => ({
    refCard: !!document.querySelector('.composer__ref'),
    bubble: document.querySelector('.tl__me')?.textContent ?? '',
    userRef: !!document.querySelector('.tl__ref'),
    refCode: document.querySelector('.tl__ref-code')?.textContent ?? ''
  }))()`)
  check(!after.refCard, '发送后输入框清空引用')
  check(after.bubble === '这两段可以合并吗？', '气泡只显示用户原话', after.bubble)
  check(after.userRef, '转写区出现引用卡')
  check(after.refCode.includes('line3') && after.refCode.includes('line6'), '转写区引用卡带代码')
  const headTitle = await chat.webContents.executeJavaScript(
    `document.querySelector('.chathead__title')?.textContent ?? ''`
  )
  check(headTitle === '这两段可以合并吗？', '会话标题只保留用户原话', headTitle)
  await shot(chat, 'chat-sent')

  if (failures.length) {
    console.error(`\n${failures.length} 项失败`)
    app.exit(1)
  } else {
    console.log('\n全部通过')
    app.exit(0)
  }
})
