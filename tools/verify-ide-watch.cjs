/*
 * IDE 外部文件变化自动刷新的真实 IPC + UI 验证。
 * 运行前先 build，并打包主进程模块：
 *   npx electron-vite build
 *   npx esbuild src/main/ide-fs.ts --bundle --platform=node --format=cjs \
 *     --outfile=tools/_ide-fs.cjs
 *   npx esbuild src/main/ide-window.ts --bundle --platform=node --format=cjs \
 *     --external:electron --outfile=tools/_ide-window.cjs
 *   npx esbuild src/main/vcs/index.ts --bundle --platform=node --format=cjs \
 *     --outfile=tools/_vcs.cjs
 *   npx esbuild src/main/ide-watch.ts --bundle --platform=node --format=cjs \
 *     --outfile=tools/_ide-watch.cjs
 *   node node_modules/electron/cli.js tools/verify-ide-watch.cjs
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '..')
process.env.ELECTRON_RENDERER_URL = pathToFileURL(
  path.join(ROOT, 'out', 'renderer', 'index.html')
).href
process.env.CCODER_PRELOAD_PATH = path.join(ROOT, 'out', 'preload', 'index.js')

const ide = require('./_ide-fs.cjs')
const vcsApi = require('./_vcs.cjs')
const { startWorkspaceWatch } = require('./_ide-watch.cjs')
const { openIdeWindow, authorizeVcsSender, markIdeDirty, closeIdeWindow } = require('./_ide-window.cjs')

const NL = String.fromCharCode(10)
app.on('window-all-closed', () => {})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-watch-ipc-'))
const ws = path.join(base, 'ws')
fs.mkdirSync(ws)
fs.writeFileSync(path.join(ws, 'a.txt'), ['one', 'two', ''].join(NL))

let failed = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok   ${label}`)
  else {
    failed++
    console.error(`  FAIL ${label}${detail === undefined ? '' : `\n       ${JSON.stringify(detail)}`}`)
  }
}

function git(...args) {
  return execFileSync('git', ['-C', ws, ...args], {
    encoding: 'utf8',
    windowsHide: true
  }).trim()
}

const denyRead = () => {
  throw new Error('这个窗口不能访问该工作区')
}
const denyWrite = () => ({ ok: false, code: 'forbidden', message: '这个窗口不能修改该工作区' })
const denyVcs = () => ({ ok: false, error: { code: 'forbidden', message: '这个窗口不能操作该工作区' } })
const allow = (e, cwd) => typeof cwd === 'string' && authorizeVcsSender(e.sender.id, cwd)

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
  ipcMain.handle('vcs:detect', (e, cwd) => (allow(e, cwd) ? vcsApi.detect(cwd) : denyVcs()))
  ipcMain.handle('vcs:status', (e, req) =>
    req && allow(e, req.cwd) ? vcsApi.status(req) : denyVcs()
  )
  ipcMain.handle('vcs:diff', (e, req) => (req && allow(e, req.cwd) ? vcsApi.diff(req) : denyVcs()))
  ipcMain.on('ide:dirty', (e, dirty) => markIdeDirty(e.sender.id, dirty === true))
  ipcMain.on('ide:confirm-close', (e) => closeIdeWindow(e.sender.id))
}

async function waitFor(win, expression, timeout = 6000) {
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

async function setCursor(win, line, column) {
  return win.webContents.executeJavaScript(`(() => {
    const host = document.querySelector('.ide-monaco')
    const editor = host && host.__ccoderEditor
    if (!editor) return false
    editor.setPosition({ lineNumber: ${line}, column: ${column} })
    editor.focus()
    return true
  })()`)
}

async function cursorPos(win) {
  return win.webContents.executeJavaScript(`(() => {
    const host = document.querySelector('.ide-monaco')
    const editor = host && host.__ccoderEditor
    const p = editor && editor.getPosition()
    return p ? { line: p.lineNumber, col: p.column } : null
  })()`)
}

async function extMarker(win) {
  return win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.ide-tab-ext')
    return el ? el.className + '|' + el.getAttribute('title') : null
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

async function clickDialog(win, label) {
  return win.webContents.executeJavaScript(`(() => {
    const b = [...document.querySelectorAll('.ide-dialog-actions button')]
      .find((x) => x.textContent === ${JSON.stringify(label)})
    if (!b) return false
    b.click()
    return true
  })()`)
}

/* ── watcher 单元 ─────────────────────────────────────── */

async function testWatcher() {
  console.log('watcher 单元')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-watch-unit-'))
  fs.mkdirSync(path.join(dir, 'sub'))
  fs.mkdirSync(path.join(dir, 'node_modules'))
  fs.mkdirSync(path.join(dir, '.git'))
  fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), '1')

  const batches = []
  const stop = startWorkspaceWatch(dir, (b) => batches.push(b), {
    debounceMs: 80,
    maxWaitMs: 500
  })
  await sleep(150)

  fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), '2')
  fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), '3')
  fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), '4')
  await sleep(400)
  check(
    '连续写入合并为一个批次',
    batches.length === 1 && batches[0].rels.includes('sub/a.txt'),
    batches
  )

  const before = batches.length
  fs.writeFileSync(path.join(dir, 'node_modules', 'x.txt'), 'x')
  fs.writeFileSync(path.join(dir, '.git', 'index'), 'x')
  await sleep(400)
  check('忽略 node_modules / .git', batches.length === before, batches.length - before)

  stop()
  fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), '5')
  await sleep(300)
  check('停止后不再回调', batches.length === before, batches.length - before)

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-watch-unit2-'))
  const batches2 = []
  const stop2 = startWorkspaceWatch(dir2, (b) => batches2.push(b), {
    debounceMs: 80,
    maxPaths: 1
  })
  await sleep(150)
  fs.writeFileSync(path.join(dir2, 'a.txt'), 'a')
  fs.writeFileSync(path.join(dir2, 'b.txt'), 'b')
  await sleep(400)
  stop2()
  check(
    '超出路径上限标记 truncated',
    batches2.some((b) => b.truncated === true),
    batches2
  )

  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    fs.rmSync(dir2, { recursive: true, force: true, maxRetries: 3 })
  } catch {}
}

app.whenReady().then(async () => {
  register()
  await testWatcher()

  git('init', '-q')
  git('config', 'user.email', 'verify@example.com')
  git('config', 'user.name', 'Verify')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')

  openIdeWindow(ws)
  await sleep(1500)
  const win = BrowserWindow.getAllWindows()[0]
  check('IDE 窗口已创建', !!win)
  if (!win) return app.exit(1)
  if (win.webContents.isLoadingMainFrame()) {
    await new Promise((r) => win.webContents.once('did-finish-load', r))
  }
  await sleep(600)

  console.log('干净缓冲区自动重载')
  check('文件树已加载', await clickFile(win, 'a.txt'))
  check(
    '编辑器出现',
    await waitFor(win, `!!document.querySelector('.ide-monaco')?.__ccoderEditor`)
  )
  check('初始内容正确', (await editorValue(win)) === ['one', 'two', ''].join(NL))
  await setCursor(win, 2, 2)

  fs.writeFileSync(path.join(ws, 'a.txt'), ['external', 'line2', ''].join(NL))
  check(
    '外部修改后编辑器自动更新',
    await waitFor(win, `(() => {
      const e = document.querySelector('.ide-monaco')?.__ccoderEditor
      return e ? e.getModel().getValue() === ${JSON.stringify(['external', 'line2', ''].join(NL))} : false
    })()`)
  )
  const pos = await cursorPos(win)
  check('光标保持在第 2 行第 2 列', pos && pos.line === 2 && pos.col === 2, pos)
  check('干净重载不产生外部标记', (await extMarker(win)) === null)

  console.log('脏缓冲区不被覆盖')
  check('输入草稿', await setEditorValue(win, ['mine', ''].join(NL)))
  await sleep(300)
  fs.writeFileSync(path.join(ws, 'a.txt'), ['theirs', ''].join(NL))
  await sleep(1800)
  check('编辑器保留草稿', (await editorValue(win)) === ['mine', ''].join(NL))
  const marker = await extMarker(win)
  check(
    '标签出现外部修改标记',
    typeof marker === 'string' && marker.includes('is-modified') && marker.includes('外部修改'),
    marker
  )

  await ctrlS(win)
  check(
    '保存时出现冲突对话框',
    await waitFor(win, `document.querySelector('.ide-dialog-title')?.textContent.includes('外部修改')`)
  )
  await clickDialog(win, '仍然覆盖')
  await sleep(1200)
  check('覆盖后磁盘是草稿内容', fs.readFileSync(path.join(ws, 'a.txt'), 'utf8') === ['mine', ''].join(NL))
  check('保存后标记消失', await waitFor(win, `!document.querySelector('.ide-tab-ext')`))

  console.log('外部删除与重新创建')
  fs.unlinkSync(path.join(ws, 'a.txt'))
  check(
    '标签出现已删除标记',
    await waitFor(win, `document.querySelector('.ide-tab-ext')?.classList.contains('is-deleted')`)
  )
  await ctrlS(win)
  check(
    '保存时出现已删除对话框',
    await waitFor(win, `document.querySelector('.ide-dialog-title')?.textContent.includes('已被删除')`)
  )
  await clickDialog(win, '重新创建')
  await sleep(1200)
  check('文件已重新创建', fs.existsSync(path.join(ws, 'a.txt')))
  check('重建后标记消失', await waitFor(win, `!document.querySelector('.ide-tab-ext')`))

  console.log('文件树自动刷新')
  fs.writeFileSync(path.join(ws, 'fresh.md'), '# fresh')
  check(
    '外部新建出现在文件树',
    await waitFor(win, `[...document.querySelectorAll('.ide-trow')].some((r) => r.textContent.includes('fresh.md'))`)
  )
  fs.unlinkSync(path.join(ws, 'fresh.md'))
  check(
    '外部删除从文件树消失',
    await waitFor(win, `![...document.querySelectorAll('.ide-trow')].some((r) => r.textContent.includes('fresh.md'))`)
  )

  console.log('VCS 状态自动刷新')
  git('add', '-A')
  git('commit', '-q', '-m', 'clean')
  await sleep(2200)
  check(
    '提交后工作区干净',
    await waitFor(win, `document.querySelector('.ide-changes')?.textContent.trim().startsWith('0')`, 6000)
  )
  fs.appendFileSync(path.join(ws, 'a.txt'), 'edit' + NL)
  check(
    '外部修改后变更数变为 1',
    await waitFor(win, `document.querySelector('.ide-changes')?.textContent.trim().startsWith('1')`, 8000)
  )

  console.log('仅动 .git 时靠窗口聚焦刷新')
  git('add', '-A')
  git('commit', '-q', '-m', 'external')
  await sleep(1600)
  check(
    'watcher 不监听 .git，变更数暂未更新',
    (await win.webContents.executeJavaScript(
      `document.querySelector('.ide-changes')?.textContent.trim().startsWith('1')`
    )) === true
  )
  await win.webContents.executeJavaScript(`window.dispatchEvent(new Event('focus'))`)
  check(
    '窗口聚焦后变更数归零',
    await waitFor(win, `document.querySelector('.ide-changes')?.textContent.trim().startsWith('0')`, 8000)
  )

  console.log('自己保存不产生残留标记')
  await clickFile(win, 'a.txt')
  await sleep(400)
  await setEditorValue(win, ['self', ''].join(NL))
  await sleep(300)
  await ctrlS(win)
  await sleep(1500)
  check('保存后没有外部标记', (await extMarker(win)) === null)
  check('磁盘内容已写入', fs.readFileSync(path.join(ws, 'a.txt'), 'utf8') === ['self', ''].join(NL))

  if (!win.isDestroyed()) win.destroy()
  try {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {}
  console.log(`\n${failed === 0 ? '全部通过 ✓' : `${failed} 项失败 ✗`}`)
  app.exit(failed === 0 ? 0 : 1)
})
