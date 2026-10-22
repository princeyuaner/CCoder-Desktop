/*
 * 实现效果截图：真实 IDE 渲染 + 真实 Git/SVN 适配器，不参与打包。
 * 用法：node node_modules/electron/cli.js tools/shot-vcs-impl.cjs
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const vcs = require('./_vcs.cjs')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'docs', 'mockups')
const KIND = process.env.VCS_KIND === 'svn' ? 'svn' : 'git'
const THEME = process.env.VCS_THEME === 'light' ? 'light' : 'dark'
const CONFLICT = process.env.VCS_CONFLICT === '1'
const THEME_SUFFIX = THEME === 'light' ? '-light' : ''
const SCENE_SUFFIX = `${KIND === 'svn' ? '' : CONFLICT ? '-conflict' : ''}${THEME_SUFFIX}`
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-vcs-shot-'))
let REPO = BASE

const IGNORE = new Set(['node_modules', '.git', 'out', 'release', 'dist', 'build', '.codegraph'])
const LANG = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript React', '.js': 'JavaScript',
  '.json': 'JSON', '.css': 'CSS', '.md': 'Markdown', '.txt': 'Text'
}

const settings = {
  permissionMode: 'standard',
  defaultCwd: REPO,
  openedCwds: [REPO],
  // REPO 在 SVN 模式下是 checkout 出来的工作副本，setup 之后再补

  theme: THEME,
  uiZoom: 1,
  chatFontSize: 14,
  uiFont: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
  monoFont: "'Cascadia Mono', 'JetBrains Mono', Consolas, monospace",
  showTimestamps: false,
  thinkingOpen: false,
  toolDetail: 'full',
  sendKey: 'enter',
  clis: {
    claude: { enabled: true, activeChannelId: null, channels: [], effort: 'medium' },
    codex: { enabled: false, activeChannelId: null, channels: [], effort: 'medium' }
  }
}

function sh(bin, args, cwd) {
  return execFileSync(bin, args, { cwd, encoding: 'utf8', windowsHide: true })
}

function setupSvn() {
  const repo = path.join(BASE, 'repo')
  const wc = path.join(BASE, 'wc')
  sh('svnadmin', ['create', repo])
  const url = pathToFileURL(repo).href
  sh('svn', ['checkout', '--non-interactive', '--no-auth-cache', url, wc])
  fs.writeFileSync(path.join(wc, 'README.md'), '# Demo\n\nA tiny SVN working copy.\n')
  fs.writeFileSync(path.join(wc, 'a.txt'), 'one\n')
  fs.writeFileSync(path.join(wc, 'b.txt'), 'bee\n')
  fs.writeFileSync(path.join(wc, 'c.txt'), 'sea\n')
  sh('svn', ['add', '--non-interactive', '--no-auth-cache', '--force', '--parents', wc], wc)
  sh('svn', ['commit', '--non-interactive', '--no-auth-cache', '-m', 'init', wc], wc)
  fs.writeFileSync(path.join(wc, 'a.txt'), 'one\nchanged\n')
  fs.writeFileSync(path.join(wc, 'c.txt'), 'sea\nunstaged\n')
  fs.writeFileSync(path.join(wc, 'notes.md'), '# notes\n\n- wire the panel\n')
  sh('svn', ['lock', '--non-interactive', '--no-auth-cache', path.join(wc, 'b.txt')], wc)
  fs.writeFileSync(path.join(wc, 'b.txt'), 'bee\nlocked\n')
  REPO = wc
  settings.defaultCwd = REPO
  settings.openedCwds = [REPO]
}

function setupRepo() {
  sh('git', ['init', '-b', 'main', REPO])
  sh('git', ['config', 'user.name', 'ccoder'], REPO)
  sh('git', ['config', 'user.email', 'ccoder@example.invalid'], REPO)
  sh('git', ['config', 'core.autocrlf', 'false'], REPO)
  sh('git', ['config', 'commit.gpgsign', 'false'], REPO)
  fs.writeFileSync(path.join(REPO, 'README.md'), '# Demo\n\nA tiny workspace for the VCS panel.\n')
  fs.writeFileSync(path.join(REPO, 'a.txt'), 'one\n')
  fs.writeFileSync(path.join(REPO, 'b.txt'), 'bee\n')
  fs.writeFileSync(path.join(REPO, 'c.txt'), 'sea\n')
  sh('git', ['add', '-A'], REPO)
  sh('git', ['commit', '-m', 'init'], REPO)

  if (CONFLICT) {
    // 造一个冲突
    sh('git', ['checkout', '-b', 'feature'], REPO)
    fs.writeFileSync(path.join(REPO, 'a.txt'), 'feature\n')
    sh('git', ['commit', '-am', 'feature'], REPO)
    sh('git', ['checkout', 'main'], REPO)
    fs.writeFileSync(path.join(REPO, 'a.txt'), 'main\n')
    sh('git', ['commit', '-am', 'main'], REPO)
    try {
      sh('git', ['merge', 'feature'], REPO)
    } catch {
      // 冲突是预期结果
    }
  }

  // 暂存一个、改一个、再加一个未跟踪
  fs.writeFileSync(path.join(REPO, 'b.txt'), 'bee\nstaged\n')
  sh('git', ['add', 'b.txt'], REPO)
  fs.writeFileSync(path.join(REPO, 'c.txt'), 'sea\nunstaged\n')
  fs.writeFileSync(path.join(REPO, 'notes.md'), '# notes\n\n- wire the panel\n')
}

function listDir(cwd, rel) {
  const abs = path.join(cwd, rel || '')
  const entries = fs.readdirSync(abs, { withFileTypes: true })
  const out = []
  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue
    if (ent.isDirectory() && IGNORE.has(ent.name)) continue
    if (!ent.isDirectory() && !ent.isFile()) continue
    out.push({
      name: ent.name,
      rel: (rel ? `${rel}/` : '') + ent.name,
      kind: ent.isDirectory() ? 'dir' : 'file'
    })
  }
  out.sort((a, b) => (a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)))
  return out
}

function readText(cwd, rel) {
  const abs = path.join(cwd, rel)
  const st = fs.statSync(abs)
  const text = fs.readFileSync(abs, 'utf8')
  return {
    rel,
    text,
    size: st.size,
    language: LANG[path.extname(rel).toLowerCase()] || 'Text',
    truncated: false,
    binary: false
  }
}

function registerMockIpc() {
  ipcMain.handle('win:is-maximized', () => false)
  ipcMain.handle('settings:get', () => settings)
  ipcMain.handle('settings:save', (_e, s) => s)
  ipcMain.handle('sessions:list', () => [])
  ipcMain.handle('sessions:transcript', () => [])
  ipcMain.handle('sessions:pick-dir', () => null)
  ipcMain.handle('sessions:delete', () => ({ ok: true }))
  ipcMain.handle('session:start', () => 'shot-session')
  ipcMain.handle('session:send', () => ({ ok: true }))
  ipcMain.handle('session:running', () => [])
  ipcMain.handle('channel:test', () => ({ ok: true, message: 'pong', latencyMs: 10 }))
  ipcMain.handle('workspace:search-files', () => [])
  ipcMain.handle('ide:open', () => undefined)
  ipcMain.handle('ide:open-file', () => ({ ok: true }))
  ipcMain.handle('ide:list-dir', (_e, cwd, rel) => listDir(cwd, rel))
  ipcMain.handle('ide:read-file', (_e, cwd, rel) => readText(cwd, rel))
  ipcMain.handle('ide:read-image', () => {
    throw new Error('not used')
  })
  ipcMain.handle('ide:search-code', () => [])
  ipcMain.handle('ide:git-status', () => ({ repo: false, branch: '', files: [] }))
  ipcMain.handle('ide:git-diff', () => ({ repo: false, diff: '' }))

  ipcMain.handle('vcs:detect', (_e, cwd) => vcs.detect(cwd))
  ipcMain.handle('vcs:status', (_e, req) => vcs.status(req))
  ipcMain.handle('vcs:diff', (_e, req) => vcs.diff(req))
  ipcMain.handle('vcs:log', (_e, req) => vcs.log(req))
  ipcMain.handle('vcs:commit-detail', (_e, req) => vcs.commitDetail(req))
  ipcMain.handle('vcs:stage', (_e, req) => vcs.stage(req))
  ipcMain.handle('vcs:unstage', (_e, req) => vcs.unstage(req))
  ipcMain.handle('vcs:discard', (_e, req) => vcs.discard(req))
  ipcMain.handle('vcs:revert', (_e, req) => vcs.revert(req))
  ipcMain.handle('vcs:resolve', (_e, req) => vcs.resolve(req))
  ipcMain.handle('vcs:commit', (_e, req) => vcs.commit(req))
  ipcMain.handle('vcs:fetch', (_e, req) => vcs.fetch(req))
  ipcMain.handle('vcs:pull', (_e, req) => vcs.pull(req))
  ipcMain.handle('vcs:push', (_e, req) => vcs.push(req))
  ipcMain.handle('vcs:update', (_e, req) => vcs.update(req))
  ipcMain.handle('vcs:cancel', (_e, req) => vcs.cancel(req))
}

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.on('window-all-closed', () => {})

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  if (KIND === 'svn') setupSvn()
  else setupRepo()
  registerMockIpc()

  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    useContentSize: true,
    show: true,
    frame: false,
    backgroundColor: '#191919',
    webPreferences: {
      preload: path.join(ROOT, 'out', 'preload', 'index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.setAlwaysOnTop(true)
  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'), {
    query: { view: 'ide', cwd: REPO }
  })
  await wait(900)
  await win.webContents.executeJavaScript(`document.querySelectorAll('.ide-act')[2].click()`)
  await wait(1400)
  // 填一条提交信息，让主按钮处于可提交状态，和效果稿一致
  await win.webContents.executeJavaScript(`(() => {
    const ta = document.querySelector('.ide-vcs-msg textarea')
    if (!ta) return
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, 'feat: 接入 Git / SVN 源代码管理')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await wait(300)
  // 默认会选冲突文件；截图时切到一个普通的工作区改动，diff 更有代表性
  await win.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.ide-vcs-row')].find(r => r.textContent.includes('c.txt'))
    if (row) row.click()
  })()`)
  await wait(800)
  const img = await win.capturePage()
  const file = path.join(
    OUT,
    KIND === 'svn'
      ? `impl-vcs-svn-workspace${SCENE_SUFFIX}.png`
      : `impl-vcs-workspace${SCENE_SUFFIX}.png`
  )
  fs.writeFileSync(file, img.toPNG())
  console.log('wrote', file, img.getSize().width + 'x' + img.getSize().height)

  // 第二个文件：Git 看已暂存，SVN 看锁定文件
  await win.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.ide-vcs-row')].find(r => r.textContent.includes('b.txt'))
    if (row) row.click()
  })()`)
  await wait(700)
  const imgStaged = await win.capturePage()
  const fileStaged = path.join(
    OUT,
    KIND === 'svn'
      ? `impl-vcs-svn-locked${SCENE_SUFFIX}.png`
      : `impl-vcs-staged${SCENE_SUFFIX}.png`
  )
  fs.writeFileSync(fileStaged, imgStaged.toPNG())
  console.log('wrote', fileStaged, imgStaged.getSize().width + 'x' + imgStaged.getSize().height)

  // 历史页
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.ide-vcs-tabs button')].find(b => b.textContent.includes('历史')).click()`
  )
  await wait(1000)
  const img2 = await win.capturePage()
  const file2 = path.join(
    OUT,
    KIND === 'svn'
      ? `impl-vcs-svn-history${SCENE_SUFFIX}.png`
      : `impl-vcs-history${SCENE_SUFFIX}.png`
  )
  fs.writeFileSync(file2, img2.toPNG())
  console.log('wrote', file2, img2.getSize().width + 'x' + img2.getSize().height)

  app.quit()
})
