/*
 * 验证 VCS 的真实 IPC 链路：IDE 窗口能调用，普通窗口被拒绝。
 * 用法（先 npx electron-vite build）：
 *   npx esbuild src/main/ide-window.ts --bundle --platform=node --format=cjs \
 *     --external:electron --outfile=tools/_ide-window.cjs
 *   npx esbuild src/main/vcs/index.ts --bundle --platform=node --format=cjs \
 *     --outfile=tools/_vcs.cjs
 *   node node_modules/electron/cli.js tools/verify-vcs-ipc.cjs
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

const vcs = require('./_vcs.cjs')
const { openIdeWindow, authorizeVcsSender } = require('./_ide-window.cjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-vcs-ipc-'))
const ws = path.join(base, 'ws')
fs.mkdirSync(ws)
execFileSync('git', ['init', '-b', 'main', ws], { windowsHide: true })
execFileSync('git', ['config', 'user.name', 'verify'], { cwd: ws, windowsHide: true })
execFileSync('git', ['config', 'user.email', 'verify@example.invalid'], { cwd: ws, windowsHide: true })
execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: ws, windowsHide: true })
execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: ws, windowsHide: true })
fs.writeFileSync(path.join(ws, 'a.txt'), 'one\n')
execFileSync('git', ['add', '-A'], { cwd: ws, windowsHide: true })
execFileSync('git', ['commit', '-m', 'init'], { cwd: ws, windowsHide: true })
fs.writeFileSync(path.join(ws, 'a.txt'), 'one\ntwo\n')

let failed = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok   ${label}`)
  else {
    failed++
    console.error(`  FAIL ${label}${detail === undefined ? '' : `\n       ${JSON.stringify(detail)}`}`)
  }
}

const deny = () => ({ ok: false, error: { code: 'forbidden', message: 'forbidden' } })
function ok(e, cwd) {
  return typeof cwd === 'string' && authorizeVcsSender(e.sender.id, cwd)
}

function register() {
  const handle = (channel, fn) => ipcMain.handle(channel, (e, req) => {
    const cwd = typeof req === 'string' ? req : req?.cwd
    if (!ok(e, cwd)) return deny()
    return fn(req)
  })
  handle('vcs:detect', (cwd) => vcs.detect(cwd))
  handle('vcs:status', (req) => vcs.status(req))
  handle('vcs:diff', (req) => vcs.diff(req))
  handle('vcs:log', (req) => vcs.log(req))
  handle('vcs:commit-detail', (req) => vcs.commitDetail(req))
  handle('vcs:stage', (req) => vcs.stage(req))
  handle('vcs:unstage', (req) => vcs.unstage(req))
  handle('vcs:discard', (req) => vcs.discard(req))
  handle('vcs:revert', (req) => vcs.revert(req))
  handle('vcs:resolve', (req) => vcs.resolve(req))
  handle('vcs:commit', (req) => vcs.commit(req))
  handle('vcs:fetch', (req) => vcs.fetch(req))
  handle('vcs:pull', (req) => vcs.pull(req))
  handle('vcs:push', (req) => vcs.push(req))
  handle('vcs:update', (req) => vcs.update(req))
  handle('vcs:cancel', (req) => vcs.cancel(req))
}

async function waitLoad(win) {
  if (!win.webContents.isLoadingMainFrame()) return
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  await sleep(500)
}

app.whenReady().then(async () => {
  register()
  console.log('IDE 窗口')
  openIdeWindow(ws)
  await sleep(1200)
  const ide = BrowserWindow.getAllWindows()[0]
  check('IDE 窗口已创建', !!ide)
  if (!ide) return app.exit(1)
  await waitLoad(ide)

  const detect = await ide.webContents.executeJavaScript(`window.api.vcs.detect(${JSON.stringify(ws)})`)
  check('detect 成功', detect.ok && detect.data.repo?.kind === 'git', detect)

  const status = await ide.webContents.executeJavaScript(
    `window.api.vcs.status({ cwd: ${JSON.stringify(ws)} })`
  )
  check('status 有 1 个改动', status.ok && status.data.counts.total === 1, status)

  const diff = await ide.webContents.executeJavaScript(
    `window.api.vcs.diff({ cwd: ${JSON.stringify(ws)}, rel: 'a.txt', source: 'working' })`
  )
  check('diff 有 +two', diff.ok && diff.data.diff.includes('+two'), diff)

  const staged = await ide.webContents.executeJavaScript(
    `window.api.vcs.stage({ cwd: ${JSON.stringify(ws)}, opId: 'ipc-stage', paths: ['a.txt'] })`
  )
  check('stage 成功', staged.ok, staged)

  const committed = await ide.webContents.executeJavaScript(
    `window.api.vcs.commit({ cwd: ${JSON.stringify(ws)}, opId: 'ipc-commit', message: 'ipc test' })`
  )
  check('commit 成功', committed.ok && !!committed.data.id, committed)

  console.log('UI 操作')
  fs.writeFileSync(path.join(ws, 'a.txt'), 'one\ntwo\nthree\n')
  await ide.webContents.executeJavaScript(`document.querySelectorAll('.ide-act')[2].click()`)
  await sleep(500)
  await ide.webContents.executeJavaScript(
    `document.querySelector('.ide-vcs-headacts .ide-iconbtn')?.click()`
  )
  await sleep(800)
  const rows = await ide.webContents.executeJavaScript(
    `document.querySelectorAll('.ide-vcs-row').length`
  )
  check('VCS 行已渲染', rows > 0, rows)

  const clicked = await ide.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.ide-vcs-row')].find((r) => r.textContent.includes('a.txt'))
    if (!row) return false
    const btn = [...row.querySelectorAll('.ide-vcs-mini')].find((b) => b.textContent.includes('暂存'))
    if (!btn) return false
    btn.click()
    return true
  })()`)
  check('点击暂存', clicked === true, clicked)
  await sleep(900)
  const afterStage = await ide.webContents.executeJavaScript(
    `window.api.vcs.status({ cwd: ${JSON.stringify(ws)} })`
  )
  check(
    'UI 暂存已生效',
    afterStage.ok && afterStage.data.files.some((f) => f.rel === 'a.txt' && f.staged),
    afterStage
  )

  const typed = await ide.webContents.executeJavaScript(`(() => {
    const ta = document.querySelector('.ide-vcs-msg textarea')
    if (!ta) return false
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, 'ui commit')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  check('填写提交信息', typed === true, typed)
  await sleep(300)

  const commitClick = await ide.webContents.executeJavaScript(`(() => {
    const b = document.querySelector('.ide-vcs-commit')
    if (!b || b.disabled) return false
    b.click()
    return true
  })()`)
  check('点击提交', commitClick === true, commitClick)
  await sleep(1400)
  const clean = await ide.webContents.executeJavaScript(
    `window.api.vcs.status({ cwd: ${JSON.stringify(ws)} })`
  )
  check('UI 提交后状态干净', clean.ok && clean.data.clean, clean)

  console.log('SVN UI')
  const svnBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-vcs-ipc-svn-'))
  const svnRepo = path.join(svnBase, 'repo')
  const svnWc = path.join(svnBase, 'wc')
  try {
    execFileSync('svnadmin', ['create', svnRepo], { windowsHide: true })
    const svnUrl = pathToFileURL(svnRepo).href
    execFileSync('svn', ['checkout', '--non-interactive', '--no-auth-cache', svnUrl, svnWc], {
      windowsHide: true
    })
    fs.writeFileSync(path.join(svnWc, 'a.txt'), 'one\n')
    execFileSync('svn', ['add', '--non-interactive', '--no-auth-cache', path.join(svnWc, 'a.txt')], {
      cwd: svnWc,
      windowsHide: true
    })
    execFileSync(
      'svn',
      ['commit', '--non-interactive', '--no-auth-cache', '-m', 'init', path.join(svnWc, 'a.txt')],
      { cwd: svnWc, windowsHide: true }
    )
    fs.writeFileSync(path.join(svnWc, 'a.txt'), 'one\ntwo\n')

    openIdeWindow(svnWc)
    await sleep(1400)
    const svnWin =
      BrowserWindow.getAllWindows().find((w) =>
        decodeURIComponent(w.webContents.getURL()).includes(svnWc)
      ) ?? BrowserWindow.getAllWindows()[BrowserWindow.getAllWindows().length - 1]
    await waitLoad(svnWin)
    await svnWin.webContents.executeJavaScript(`document.querySelectorAll('.ide-act')[2].click()`)
    await sleep(1200)
    const kind = await svnWin.webContents.executeJavaScript(
      `document.querySelector('.ide-vcs-kind')?.textContent || ''`
    )
    check('SVN 面板显示 SVN', kind.trim() === 'SVN', kind)
    const cbCount = await svnWin.webContents.executeJavaScript(
      `document.querySelectorAll('.ide-vcs-cb').length`
    )
    check('SVN 行有选择框', cbCount > 0, cbCount)

    const typedSvn = await svnWin.webContents.executeJavaScript(`(() => {
      const ta = document.querySelector('.ide-vcs-msg textarea')
      if (!ta) return false
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      set.call(ta, 'svn ui commit')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    check('SVN 填写提交信息', typedSvn === true, typedSvn)
    await sleep(300)
    const commitSvn = await svnWin.webContents.executeJavaScript(`(() => {
      const b = document.querySelector('.ide-vcs-commit')
      if (!b || b.disabled) return false
      b.click()
      return true
    })()`)
    check('SVN 点击提交', commitSvn === true, commitSvn)
    await sleep(1500)
    const svnStatus = await svnWin.webContents.executeJavaScript(
      `window.api.vcs.status({ cwd: ${JSON.stringify(svnWc)} })`
    )
    check('SVN 提交后状态干净', svnStatus.ok && svnStatus.data.clean, svnStatus)
    svnWin.destroy()
  } catch (err) {
    check('SVN UI 流程', false, String(err))
  } finally {
    try {
      fs.rmSync(svnBase, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {}
  }

  console.log('普通窗口')
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
    `window.api.vcs.detect(${JSON.stringify(ws)})`
  )
  check('未绑定窗口被拒绝', forbidden.ok === false && forbidden.error.code === 'forbidden', forbidden)

  outsider.destroy()
  ide.destroy()
  try {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {}
  console.log(`\n${failed === 0 ? '全部通过 ✓' : `${failed} 项失败 ✗`}`)
  app.exit(failed === 0 ? 0 : 1)
})
