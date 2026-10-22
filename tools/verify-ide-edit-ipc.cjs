/*
 * IDE 编辑 / 新建 / 重命名 / 删除的真实 IPC + UI 验证。
 * 运行前先 build，并打包主进程模块：
 *   npx electron-vite build
 *   npx esbuild src/main/ide-fs.ts --bundle --platform=node --format=cjs \
 *     --outfile=tools/_ide-fs.cjs
 *   npx esbuild src/main/ide-window.ts --bundle --platform=node --format=cjs \
 *     --external:electron --outfile=tools/_ide-window.cjs
 *   node node_modules/electron/cli.js tools/verify-ide-edit-ipc.cjs
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '..')
process.env.ELECTRON_RENDERER_URL = pathToFileURL(
  path.join(ROOT, 'out', 'renderer', 'index.html')
).href
process.env.CCODER_PRELOAD_PATH = path.join(ROOT, 'out', 'preload', 'index.js')

const ide = require('./_ide-fs.cjs')
const { openIdeWindow, authorizeVcsSender, markIdeDirty, closeIdeWindow } = require('./_ide-window.cjs')

const NL = String.fromCharCode(10)
app.on('window-all-closed', () => {})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-edit-ipc-'))
const ws = path.join(base, 'ws')
fs.mkdirSync(ws)
fs.writeFileSync(path.join(ws, 'a.txt'), 'one\ntwo\n')
fs.mkdirSync(path.join(ws, 'src'))
fs.writeFileSync(path.join(ws, 'src', 'b.ts'), 'export const b = 1\n')

let failed = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok   ${label}`)
  else {
    failed++
    console.error(`  FAIL ${label}${detail === undefined ? '' : `\n       ${JSON.stringify(detail)}`}`)
  }
}

function denyRead() {
  throw new Error('这个窗口不能访问该工作区')
}
const denyWrite = () => ({ ok: false, code: 'forbidden', message: '这个窗口不能修改该工作区' })
function allow(e, cwd) {
  return typeof cwd === 'string' && authorizeVcsSender(e.sender.id, cwd)
}

function register() {
  ipcMain.handle('ide:list-dir', (e, cwd, rel) =>
    allow(e, cwd) ? ide.listDir(cwd, rel) : denyRead()
  )
  ipcMain.handle('ide:read-file', (e, cwd, rel) =>
    allow(e, cwd) ? ide.readTextFile(cwd, rel) : denyRead()
  )
  ipcMain.handle('ide:save-file', (e, req) =>
    req && allow(e, req.cwd) ? ide.saveTextFile(req) : denyWrite()
  )
  ipcMain.handle('ide:create-entry', (e, req) =>
    req && allow(e, req.cwd) ? ide.createEntry(req) : denyWrite()
  )
  ipcMain.handle('ide:rename-entry', (e, req) =>
    req && allow(e, req.cwd) ? ide.renameEntry(req) : denyWrite()
  )
  ipcMain.handle('ide:delete-entry', (e, req) =>
    req && allow(e, req.cwd) ? ide.deleteEntry(req) : denyWrite()
  )
  ipcMain.on('ide:dirty', (e, dirty) => markIdeDirty(e.sender.id, dirty === true))
  ipcMain.on('ide:confirm-close', (e) => closeIdeWindow(e.sender.id))
}

async function waitLoad(win) {
  if (!win.webContents.isLoadingMainFrame()) return
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  await sleep(500)
}

async function waitFor(win, expression, timeout = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try {
      if (await win.webContents.executeJavaScript(expression)) return true
    } catch {}
    await sleep(100)
  }
  return false
}

async function clickFile(win, name) {
  return win.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.ide-trow.is-file')]
      .find((r) => r.textContent.includes(${JSON.stringify(name)}))
    if (!row) return false
    row.click()
    return true
  })()`)
}

async function setValue(win, selector, value, proto = 'HTMLTextAreaElement') {
  return win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const set = Object.getOwnPropertyDescriptor(${proto}.prototype, 'value').set
    set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
}

async function setEditorValue(win, value) {
  return win.webContents.executeJavaScript(`(() => {
    const host = document.querySelector('.ide-monaco')
    const editor = host && host.__ccoderEditor
    if (!editor) return false
    editor.setValue(${JSON.stringify(value)})
    editor.focus()
    return true
  })()`)
}

async function editorValue(win) {
  return win.webContents.executeJavaScript(`(() => {
    const host = document.querySelector('.ide-monaco')
    const editor = host && host.__ccoderEditor
    return editor ? editor.getModel().getValue() : null
  })()`)
}

async function ctrlS(win) {
  await win.webContents.executeJavaScript(
    `document.querySelector('.ide-monaco')?.__ccoderEditor?.focus()`
  )
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'S', modifiers: ['control'] })
  win.webContents.sendInputEvent({ type: 'char', keyCode: 's', modifiers: ['control'] })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'S', modifiers: ['control'] })
}

app.whenReady().then(async () => {
  register()
  openIdeWindow(ws)
  await sleep(1400)
  const win = BrowserWindow.getAllWindows()[0]
  check('IDE 窗口已创建', !!win)
  if (!win) return app.exit(1)
  await waitLoad(win)

  console.log('编辑与保存')
  check('文件树已加载', await clickFile(win, 'a.txt'))
  check(
    '编辑器出现',
    await waitFor(win, `!!document.querySelector('.ide-monaco')?.__ccoderEditor`)
  )
  const initial = await editorValue(win)
  check('编辑器内容正确', initial === 'one\ntwo\n', initial)

  check(
    '输入新内容',
    await setEditorValue(win, ['one', 'two', 'three', ''].join(NL))
  )
  await sleep(300)
  const dirty = await win.webContents.executeJavaScript(`(() => ({
    dot: !!document.querySelector('.ide-tab-dirty'),
    save: document.querySelector('.ide-savebtn')?.textContent || ''
  }))()`)
  check('tab 显示未保存', dirty.dot === true, dirty)
  check('工具栏出现保存按钮', dirty.save.includes('保存'), dirty)

  await ctrlS(win)
  await sleep(1200)
  check('Ctrl+S 写入磁盘', fs.readFileSync(path.join(ws, 'a.txt'), 'utf8') === 'one\ntwo\nthree\n')
  const clean = await win.webContents.executeJavaScript(`(() => ({
    dot: !!document.querySelector('.ide-tab-dirty'),
    save: !!document.querySelector('.ide-savebtn')
  }))()`)
  check('保存后脏标记消失', clean.dot === false && clean.save === false, clean)

  console.log('外部改动冲突')
  fs.writeFileSync(path.join(ws, 'a.txt'), ['outside', ''].join(NL))
  const later = new Date(Date.now() + 5000)
  fs.utimesSync(path.join(ws, 'a.txt'), later, later)
  check('再次输入', await setEditorValue(win, ['mine again', ''].join(NL)))
  await ctrlS(win)
  check(
    '冲突确认层出现',
    await waitFor(win, `document.querySelector('.ide-dialog-title')?.textContent.includes('外部修改')`)
  )
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.ide-dialog-actions button')].find((b) => b.textContent === '仍然覆盖').click()`
  )
  await sleep(1000)
  check('覆盖后磁盘是编辑器内容', fs.readFileSync(path.join(ws, 'a.txt'), 'utf8') === ['mine again', ''].join(NL))
  check('覆盖后脏标记消失', await waitFor(win, `!document.querySelector('.ide-tab-dirty')`))

  console.log('新建文件')
  await win.webContents.executeJavaScript(
    `document.querySelector('.ide-side-actions button[title="新建文件"]').click()`
  )
  check('新建输入条出现', await waitFor(win, `!!document.querySelector('.ide-createpath input')`))
  check(
    '填写文件名',
    await setValue(win, '.ide-createpath input', 'hello.ts', 'HTMLInputElement')
  )
  await win.webContents.executeJavaScript(
    `document.querySelector('.ide-createfoot button[type="submit"]').click()`
  )
  await sleep(900)
  check('文件已创建', fs.existsSync(path.join(ws, 'hello.ts')))
  check(
    '新文件自动打开',
    await waitFor(win, `[...document.querySelectorAll('.ide-tab-title')].some((t) => t.textContent === 'hello.ts')`)
  )

  console.log('重命名')
  await win.webContents.executeJavaScript(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))`
  )
  check('重命名弹层出现', await waitFor(win, `!!document.querySelector('.ide-dialog-input')`))
  check(
    '填写新路径',
    await setValue(win, '.ide-dialog-input', 'src/hello.ts', 'HTMLInputElement')
  )
  await win.webContents.executeJavaScript(
    `document.querySelector('.ide-dialog-actions button.is-primary').click()`
  )
  await sleep(900)
  check('旧路径消失', !fs.existsSync(path.join(ws, 'hello.ts')))
  check('新路径存在', fs.existsSync(path.join(ws, 'src/hello.ts')))
  check(
    'tab 跟着改名',
    await waitFor(win, `!!document.querySelector('.ide-tab[title="src/hello.ts"]')`)
  )

  console.log('删除')
  await win.webContents.executeJavaScript(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`
  )
  check('删除确认出现', await waitFor(win, `!!document.querySelector('.ide-dialog-actions button.is-danger')`))
  await win.webContents.executeJavaScript(
    `document.querySelector('.ide-dialog-actions button.is-danger').click()`
  )
  await sleep(900)
  check('文件已删除', !fs.existsSync(path.join(ws, 'src/hello.ts')))
  check(
    'tab 已关闭',
    await waitFor(win, `!document.querySelector('.ide-tab[title="src/hello.ts"]')`)
  )

  console.log('授权')
  const outsider = new BrowserWindow({
    width: 600,
    height: 400,
    show: false,
    webPreferences: {
      preload: process.env.CCODER_PRELOAD_PATH,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  await outsider.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'), {
    query: { view: 'ide', cwd: ws }
  })
  await sleep(600)
  const forbidden = await outsider.webContents.executeJavaScript(
    `window.api.ide.saveFile(${JSON.stringify({
      cwd: ws,
      rel: 'a.txt',
      text: 'hacked\n',
      force: true
    })})`
  )
  check(
    '未绑定窗口不能保存',
    forbidden.ok === false && forbidden.code === 'forbidden',
    forbidden
  )
  check('文件没有被改写', fs.readFileSync(path.join(ws, 'a.txt'), 'utf8') === ['mine again', ''].join(NL))

  console.log('关窗拦截')
  outsider.destroy()
  await clickFile(win, 'a.txt')
  await sleep(500)
  check('重新输入未保存内容', await setEditorValue(win, ['dirty close', ''].join(NL)))
  await sleep(400)
  win.close()
  check(
    '有未保存修改时窗口不直接关闭',
    (await waitFor(win, `document.querySelector('.ide-dialog-title')?.textContent.includes('未保存')`)) &&
      !win.isDestroyed()
  )
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.ide-dialog-actions button')].find((b) => b.textContent === '取消').click()`
  )
  await sleep(300)
  check('取消后窗口仍开着', !win.isDestroyed())

  win.close()
  await waitFor(win, `document.querySelector('.ide-dialog-actions button.is-danger')`)
  await win.webContents.executeJavaScript(
    `document.querySelector('.ide-dialog-actions button.is-danger').click()`
  )
  await sleep(700)
  check('选择不保存后窗口关闭', win.isDestroyed())

  if (!win.isDestroyed()) win.destroy()
  try {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {}
  console.log(`\n${failed === 0 ? '全部通过 ✓' : `${failed} 项失败 ✗`}`)
  app.exit(failed === 0 ? 0 : 1)
})
