/*
 * IDE 搜索选项 / 工作区全部替换的真实 IPC + UI 验证。
 * 运行前先 build，并打包主进程模块：
 *   npx electron-vite build
 *   npx esbuild src/main/ide-fs.ts --bundle --platform=node --format=cjs \
 *     --outfile=tools/_ide-fs.cjs
 *   npx esbuild src/main/ide-window.ts --bundle --platform=node --format=cjs \
 *     --external:electron --outfile=tools/_ide-window.cjs
 *   node node_modules/electron/cli.js tools/verify-ide-search-ipc.cjs
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

app.on('window-all-closed', () => {})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-search-ipc-'))
const ws = path.join(base, 'ws')
fs.mkdirSync(path.join(ws, 'src'), { recursive: true })
fs.mkdirSync(path.join(ws, 'docs'), { recursive: true })
fs.writeFileSync(path.join(ws, 'src', 'a.ts'), 'foo Foo\nbar foo\n')
fs.writeFileSync(path.join(ws, 'src', 'b.ts'), 'nothing here\n')
fs.writeFileSync(path.join(ws, 'docs', 'x.md'), 'foo\n')

let failed = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok   ${label}`)
  else {
    failed++
    console.error(`  FAIL ${label}${detail === undefined ? '' : `\n       ${JSON.stringify(detail)}`}`)
  }
}

const denyWrite = () => ({ ok: false, code: 'forbidden', message: '这个窗口不能修改该工作区' })
const denyRead = () => {
  throw new Error('这个窗口不能访问该工作区')
}
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
  ipcMain.handle('ide:search-code', (e, req) =>
    req && allow(e, req.cwd) ? ide.searchCode(req) : denyRead()
  )
  ipcMain.handle('ide:replace-in-workspace', (e, req) =>
    req && allow(e, req.cwd) ? ide.replaceInWorkspace(req) : denyWrite()
  )
  ipcMain.on('ide:dirty', (e, dirty) => markIdeDirty(e.sender.id, dirty === true))
  ipcMain.on('ide:confirm-close', (e) => closeIdeWindow(e.sender.id))
}

async function waitLoad(win) {
  if (!win.webContents.isLoadingMainFrame()) return
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  await sleep(500)
}

async function waitFor(win, expression, timeout = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try {
      if (await win.webContents.executeJavaScript(expression)) return true
    } catch {}
    await sleep(100)
  }
  return false
}

async function setInput(win, selector, value) {
  return win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
}

async function click(win, selector) {
  return win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    el.click()
    return true
  })()`)
}

async function summary(win) {
  return win.webContents.executeJavaScript(
    `document.querySelector('.ide-searchsum')?.textContent || ''`
  )
}

async function matchCount(win) {
  return win.webContents.executeJavaScript(
    `document.querySelectorAll('.ide-smatch').length`
  )
}

app.whenReady().then(async () => {
  register()
  openIdeWindow(ws)
  await sleep(1400)
  const win = BrowserWindow.getAllWindows()[0]
  check('IDE 窗口已创建', !!win)
  if (!win) return app.exit(1)
  await waitLoad(win)

  console.log('搜索选项')
  check('打开搜索面板', await click(win, '.ide-act[title^="搜索代码"]'))
  check('搜索框出现', await waitFor(win, `!!document.querySelector('.ide-searchview input')`))
  check('输入查询', await setInput(win, '.ide-searchview input', 'foo'))
  check('默认返回 4 处', await waitFor(win, `document.querySelectorAll('.ide-smatch').length === 4`))
  check('摘要显示 4 个结果', (await summary(win)).includes('4 个结果'), await summary(win))

  check('切换区分大小写', await click(win, '.ide-sopt:nth-child(1)'))
  check('区分大小写后 3 处', await waitFor(win, `document.querySelectorAll('.ide-smatch').length === 3`))
  check('再切回不区分', await click(win, '.ide-sopt:nth-child(1)'))
  await waitFor(win, `document.querySelectorAll('.ide-smatch').length === 4`)

  check('开启正则', await click(win, '.ide-sopt:nth-child(3)'))
  check('输入正则', await setInput(win, '.ide-searchview input', 'f(o+)'))
  check('正则返回 4 处', await waitFor(win, `document.querySelectorAll('.ide-smatch').length === 4`))

  console.log('glob 筛选')
  check('展开筛选', await click(win, '.ide-sopt:nth-child(4)'))
  check('填写包含 glob', await setInput(win, '.ide-sglob input', 'src/**'))
  check(
    'include 只保留 src 下的 3 处',
    await waitFor(win, `document.querySelectorAll('.ide-smatch').length === 3`)
  )
  check('清空包含 glob', await setInput(win, '.ide-sglob input', ''))
  await waitFor(win, `document.querySelectorAll('.ide-smatch').length === 4`)
  check(
    '填写排除 glob',
    await setInput(win, '.ide-sglob input:nth-child(2)', '**/*.md')
  )
  check(
    'exclude 去掉 Markdown 的 1 处',
    await waitFor(win, `document.querySelectorAll('.ide-smatch').length === 3`)
  )
  check('清空排除 glob', await setInput(win, '.ide-sglob input:nth-child(2)', ''))
  await waitFor(win, `document.querySelectorAll('.ide-smatch').length === 4`)

  console.log('全部替换')
  check('展开替换行', await click(win, '.ide-sreplace-toggle'))
  check('替换输入框出现', await waitFor(win, `!!document.querySelector('.ide-searchbox--replace input')`))
  check(
    '填写替换串',
    await setInput(win, '.ide-searchbox--replace input', 'F$1')
  )
  check('点击全部替换', await click(win, '.ide-replaceall'))
  check('确认层出现', await waitFor(win, `!!document.querySelector('.ide-dialog-actions button.is-danger')`))
  check('确认替换', await click(win, '.ide-dialog-actions button.is-danger'))
  check('出现完成摘要', await waitFor(win, `!!document.querySelector('.ide-searchsum.is-done')`))
  const done = await win.webContents.executeJavaScript(
    `document.querySelector('.ide-searchsum.is-done')?.textContent || ''`
  )
  check('完成摘要包含 4 处', done.includes('4 处'), done)
  check(
    '磁盘内容按正则替换',
    fs.readFileSync(path.join(ws, 'src', 'a.ts'), 'utf8') === 'Foo Foo\nbar Foo\n',
    fs.readFileSync(path.join(ws, 'src', 'a.ts'), 'utf8')
  )
  check(
    'Markdown 也被替换',
    fs.readFileSync(path.join(ws, 'docs', 'x.md'), 'utf8') === 'Foo\n',
    fs.readFileSync(path.join(ws, 'docs', 'x.md'), 'utf8')
  )
  check(
    '无命中文件不变',
    fs.readFileSync(path.join(ws, 'src', 'b.ts'), 'utf8') === 'nothing here\n'
  )

  console.log('错误与授权')
  check('输入非法正则', await setInput(win, '.ide-searchview input', '['))
  check(
    '面板显示错误而不是崩溃',
    await waitFor(win, `!!document.querySelector('.ide-searchsum.is-error')`)
  )
  const errorText = await summary(win)
  check('错误信息提到正则', /正则/.test(errorText), errorText)

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
    `window.api.ide.replaceInWorkspace(${JSON.stringify({
      cwd: ws,
      query: 'Foo',
      replacement: 'hacked'
    })})`
  )
  check(
    '未绑定窗口不能替换',
    forbidden.ok === false && forbidden.code === 'forbidden',
    forbidden
  )
  const searchForbidden = await outsider.webContents.executeJavaScript(
    `window.api.ide.searchCode(${JSON.stringify({ cwd: ws, query: 'Foo' })}).then(
      () => 'resolved',
      (e) => 'rejected:' + e.message
    )`
  )
  check('未绑定窗口不能搜索', String(searchForbidden).startsWith('rejected'), searchForbidden)
  check(
    '越权替换没有改文件',
    fs.readFileSync(path.join(ws, 'docs', 'x.md'), 'utf8') === 'Foo\n'
  )

  outsider.destroy()
  if (!win.isDestroyed()) win.destroy()
  try {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {}
  console.log(`\n${failed === 0 ? '全部通过 ✓' : `${failed} 项失败 ✗`}`)
  app.exit(failed === 0 ? 0 : 1)
})
