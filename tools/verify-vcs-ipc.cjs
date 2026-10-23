/*
 * 验证 VCS 的真实 IPC 链路：IDE 窗口能调用，普通窗口被拒绝。
 * 用法（先 npx electron-vite build）：
 *   npx esbuild src/main/ide-window.ts --bundle --platform=node --format=cjs \
 *     --external:electron --outfile=tools/_ide-window.cjs
 *   npx esbuild src/main/vcs/index.ts --bundle --platform=node --format=cjs \
 *     --outfile=tools/_vcs.cjs
 *   npx esbuild src/main/chat-bridge.ts --bundle --platform=node --format=cjs \
 *     --external:electron --outfile=tools/_chat-bridge.cjs
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
const { openIdeWindow, authorizeVcsSender, isIdeSender } = require('./_ide-window.cjs')
const chatBridge = require('./_chat-bridge.cjs')

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
  handle('vcs:worktree-list', (req) => vcs.worktreeList(req))
  handle('vcs:worktree-add', (req) => vcs.worktreeAdd(req))
  handle('vcs:worktree-remove', (req) => vcs.worktreeRemove(req))
  handle('vcs:worktree-prune', (req) => vcs.worktreePrune(req))
  handle('vcs:cancel', (req) => vcs.cancel(req))

  // 与生产 handler 同一套规则：只有绑定了工作区的 IDE 窗口能请求
  ipcMain.handle('workspace:open-session', (e, cwd) => {
    if (!isIdeSender(e.sender.id)) return { ok: false, message: '只有 IDE 窗口可以请求打开会话' }
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      return { ok: false, message: '路径必须是绝对路径' }
    }
    return chatBridge.openSessionInChat(cwd)
  })
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
  // 测试窗口别弹到用户屏幕上；隐藏窗口照样能执行 JS / 渲染 DOM
  ide.hide()

  const detect = await ide.webContents.executeJavaScript(`window.api.vcs.detect(${JSON.stringify(ws)})`)
  check('detect 成功', detect.ok && detect.data.repo?.kind === 'git', detect)

  const status = await ide.webContents.executeJavaScript(
    `window.api.vcs.status({ cwd: ${JSON.stringify(ws)} })`
  )
  check('status 有 1 个改动', status.ok && status.data.counts.total === 1, status)

  const trees = await ide.webContents.executeJavaScript(
    `window.api.vcs.worktreeList({ cwd: ${JSON.stringify(ws)} })`
  )
  check('worktree list via IPC', trees.ok && trees.data.worktrees.length === 1, trees)

  const wtPath = path.join(base, 'ws.worktrees', 'ipc-wt')
  const added = await ide.webContents.executeJavaScript(
    `window.api.vcs.worktreeAdd({ cwd: ${JSON.stringify(ws)}, opId: 'ipc-wt-add', path: ${JSON.stringify(wtPath)}, branch: 'ipc-wt', base: 'main' })`
  )
  check('worktree add via IPC', added.ok && added.data.worktrees.length === 2, added)
  check('worktree checkout exists', fs.existsSync(path.join(wtPath, 'a.txt')))

  const removedWt = await ide.webContents.executeJavaScript(
    `window.api.vcs.worktreeRemove({ cwd: ${JSON.stringify(ws)}, opId: 'ipc-wt-rm', path: ${JSON.stringify(wtPath)}, force: true })`
  )
  check('worktree remove via IPC', removedWt.ok && removedWt.data.worktrees.length === 1, removedWt)

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

  const wtTab = await ide.webContents.executeJavaScript(`(() => {
    const b = [...document.querySelectorAll('.ide-vcs-tabs > button')].find((x) =>
      x.textContent.includes('工作树')
    )
    if (!b) return false
    b.click()
    return true
  })()`)
  check('工作树 tab 存在', wtTab === true, wtTab)
  await sleep(900)
  const wtRows = await ide.webContents.executeJavaScript(
    `document.querySelectorAll('.ide-vcs-wtrow').length`
  )
  check('工作树行已渲染', wtRows === 1, wtRows)

  const openedCreate = await ide.webContents.executeJavaScript(`(() => {
    const b = [...document.querySelectorAll('.ide-vcs-sidehead .ide-vcs-mini')].find(
      (x) => x.textContent.trim() === '新建'
    )
    if (!b) return false
    b.click()
    return true
  })()`)
  check('打开新建工作树对话框', openedCreate === true, openedCreate)
  await sleep(300)

  const filledBranch = await ide.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.ide-vcs-form input')
    if (!input) return false
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(input, 'ui-branch')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  check('填写分支名', filledBranch === true, filledBranch)
  await sleep(300)

  const autoPath = await ide.webContents.executeJavaScript(
    `document.querySelectorAll('.ide-vcs-form input')[2]?.value || ''`
  )
  check('自动生成工作树路径', autoPath.includes('ui-branch'), autoPath)

  const clickedCreate = await ide.webContents.executeJavaScript(`(() => {
    const b = [...document.querySelectorAll('.ide-vcs-confirm .ide-vcs-btn')].find(
      (x) => x.textContent.trim() === '创建'
    )
    if (!b || b.disabled) return false
    b.click()
    return true
  })()`)
  check('点击创建', clickedCreate === true, clickedCreate)
  await sleep(1800)

  const wtRowsAfterCreate = await ide.webContents.executeJavaScript(
    `document.querySelectorAll('.ide-vcs-wtrow').length`
  )
  check('创建后工作树行增加', wtRowsAfterCreate === 2, wtRowsAfterCreate)
  check('新工作树目录存在', fs.existsSync(autoPath))

  const clickedDelete = await ide.webContents.executeJavaScript(`(() => {
    const b = document.querySelector('.ide-vcs-wtdetail .ide-vcs-btn.is-danger')
    if (!b) return false
    b.click()
    return true
  })()`)
  check('点击删除工作树', clickedDelete === true, clickedDelete)
  await sleep(300)

  const confirmedDelete = await ide.webContents.executeJavaScript(`(() => {
    const b = [...document.querySelectorAll('.ide-vcs-confirm .ide-vcs-btn')].find(
      (x) => x.textContent.trim() === '删除'
    )
    if (!b) return false
    b.click()
    return true
  })()`)
  check('确认删除工作树', confirmedDelete === true, confirmedDelete)
  await sleep(1800)

  const wtRowsAfterDelete = await ide.webContents.executeJavaScript(
    `document.querySelectorAll('.ide-vcs-wtrow').length`
  )
  check('删除后工作树行恢复', wtRowsAfterDelete === 1, wtRowsAfterDelete)

  await ide.webContents.executeJavaScript(`(() => {
    const b = [...document.querySelectorAll('.ide-vcs-tabs > button')].find((x) =>
      x.textContent.includes('更改')
    )
    if (b) b.click()
  })()`)
  await sleep(400)

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
    svnWin.hide()
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

  const forbiddenWt = await outsider.webContents.executeJavaScript(
    `window.api.vcs.worktreeList({ cwd: ${JSON.stringify(ws)} })`
  )
  check(
    '未绑定窗口不能读工作树',
    forbiddenWt.ok === false && forbiddenWt.error.code === 'forbidden',
    forbiddenWt
  )

  console.log('工作树 → 新会话桥')
  const chatWin = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      preload: process.env.CCODER_PRELOAD_PATH,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  try {
    await chatWin.loadURL('data:text/html,<html><body>chat</body></html>')
    chatBridge.setChatMainWindow(chatWin)
    // 末尾的 true 很重要：onOpenSession 返回取消订阅函数，
    // executeJavaScript 会试图把返回值克隆回主进程，函数克隆失败会让脚本挂住。
    await chatWin.webContents.executeJavaScript(
      `window.__got = null; window.api.workspace.onOpenSession((cwd) => { window.__got = cwd }); true`
    )

    const requested = await ide.webContents.executeJavaScript(
      `window.api.workspace.openSession(${JSON.stringify(ws)})`
    )
    chatWin.hide()
    check('IDE 请求打开新会话', requested.ok === true, requested)
    await sleep(400)
    const got = await chatWin.webContents.executeJavaScript(`window.__got`)
    check('主窗口收到目标目录', got === ws, got)

    const deniedOpen = await outsider.webContents.executeJavaScript(
      `window.api.workspace.openSession(${JSON.stringify(ws)})`
    )
    check('未绑定窗口不能请求新会话', deniedOpen.ok === false, deniedOpen)
  } finally {
    chatBridge.setChatMainWindow(null)
    chatWin.destroy()
  }

  outsider.destroy()
  ide.destroy()
  try {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {}
  console.log(`\n${failed === 0 ? '全部通过 ✓' : `${failed} 项失败 ✗`}`)
  app.exit(failed === 0 ? 0 : 1)
}).catch((err) => {
  // 任何 await 失败都要退出，别把测试进程挂在那里
  console.error(err)
  app.exit(1)
})
