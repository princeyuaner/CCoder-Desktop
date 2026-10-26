/*
 * 截图：IDE 里的目录同步实现（运行中 / 首次配置 / 有失败 / 被占用 / 气泡）。
 * 先 npx electron-vite build，再：
 *   npx esbuild src/main/ide-fs.ts --bundle --platform=node --format=cjs --outfile=tools/_ide-fs.cjs
 *   npx esbuild src/main/ide-window.ts --bundle --platform=node --format=cjs --external:electron --outfile=tools/_ide-window.cjs
 *   node node_modules/electron/cli.js --no-sandbox tools/shot-sync-impl.cjs
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '..')
process.env.ELECTRON_RENDERER_URL = pathToFileURL(
  path.join(ROOT, 'out', 'renderer', 'index.html')
).href
process.env.CCODER_PRELOAD_PATH = path.join(ROOT, 'out', 'preload', 'index.js')
app.commandLine.appendSwitch('force-device-scale-factor', '1')

const ide = require('./_ide-fs.cjs')
const { openIdeWindow, authorizeVcsSender } = require('./_ide-window.cjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const base = path.join(ROOT, '.buildtmp', 'sync-shot')
fs.rmSync(base, { recursive: true, force: true })
fs.mkdirSync(base, { recursive: true })
const ws = path.join(base, 'CCoder-Desktop')
const target = path.join(base, 'm71-server')

function put(rel, text) {
  const full = path.join(ws, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, text)
}
fs.mkdirSync(target, { recursive: true })
put('src/main/index.ts', 'export const boot = () => 0\n')
put('src/main/file-sync.ts', 'export const sync = () => 0\n')
put('src/shared/sync.ts', 'export const config = {} as const\n')
put('src/renderer/src/components/SyncPanel.tsx', 'export function SyncPanel() { return null }\n')
put('src/renderer/src/App.tsx', 'export function App() { return null }\n')
put('docs/old-sync.md', '# old\n')

const now = Date.now()
const cfgRun = {
  enabled: true,
  src: ws,
  dst: target,
  syncRoots: ['src', 'docs'],
  exclude: ['.claude', 'dist', '*.log', 'docs/old-*'],
  settleMs: 1500,
  sweepMs: 60000,
  deleteMissing: true
}
const snapRun = {
  run: 'running',
  problem: null,
  occupiedBy: null,
  busy: false,
  lastRoundAtMs: now - 8000,
  lastCostMs: 480,
  copied: 12,
  deleted: 3,
  pruned: 1,
  unchanged: 1328,
  failed: 0,
  plannedCopies: 12,
  plannedDeletes: 3,
  firstRun: false,
  watchedDirs: 1391,
  hints: 37,
  error: null,
  copiedNames: ['src/main/file-sync.ts', 'src/shared/sync.ts', 'src/renderer/src/components/SyncPanel.tsx'],
  deletedNames: ['docs/old-sync.md'],
  changes: [
    { rel: 'src/main/file-sync.ts', kind: 'copy' },
    { rel: 'src/shared/sync.ts', kind: 'copy' },
    { rel: 'src/renderer/src/components/SyncPanel.tsx', kind: 'copy' },
    { rel: 'docs/old-sync.md', kind: 'delete' }
  ],
  failedItems: [],
  keptItems: [],
  log: [
    '[事件] 3 个路径被触碰（最近：src/main/file-sync.ts）→ 开始检查',
    '[待复制] 12 个文件，[待删除] 3 项',
    '[已核实] 两侧一致 1,328 个',
    '[完成] 复制 12/12，删除 3 项（0 项目标端本不存在），顺带清掉 1 个空目录，失败 0 项（用时 480 ms）'
  ]
}

const cfgSetup = {
  enabled: false,
  src: ws,
  dst: '',
  syncRoots: [],
  exclude: [],
  settleMs: 1500,
  sweepMs: 60000,
  deleteMissing: true
}
const snapSetup = {
  run: 'disabled',
  problem: null,
  occupiedBy: null,
  busy: false,
  lastRoundAtMs: null,
  lastCostMs: null,
  copied: 0,
  deleted: 0,
  pruned: 0,
  unchanged: 0,
  failed: 0,
  plannedCopies: 0,
  plannedDeletes: 0,
  firstRun: false,
  watchedDirs: 0,
  hints: 0,
  error: null,
  copiedNames: [],
  deletedNames: [],
  changes: [],
  failedItems: [],
  keptItems: [],
  log: []
}

const snapTrouble = {
  ...snapRun,
  run: 'failed',
  lastRoundAtMs: now - 30000,
  lastCostMs: 1200,
  copied: 0,
  deleted: 0,
  pruned: 0,
  failed: 2,
  plannedCopies: 2,
  plannedDeletes: 1,
  copiedNames: [],
  deletedNames: [],
  changes: [
    { rel: 'src/main/index.ts', kind: 'failed', reason: '复制后大小不一致（源 9,231，目标 4,096）' },
    { rel: 'src/renderer/src/App.tsx', kind: 'failed', reason: '目标端拒绝写入：磁盘空间不足' },
    { rel: 'docs/old-sync.md', kind: 'kept', why: 'targetModified' }
  ],
  failedItems: [
    { rel: 'src/main/index.ts', reason: '复制后大小不一致（源 9,231，目标 4,096）—— 网络盘写入被截断' },
    { rel: 'src/renderer/src/App.tsx', reason: '目标端拒绝写入：磁盘空间不足' }
  ],
  keptItems: [{ rel: 'docs/old-sync.md', why: 'targetModified' }],
  log: [
    '[事件] 4 个路径被触碰（最近：src/main/index.ts）→ 开始检查',
    '[待复制] 2 个文件，[待删除] 1 项',
    '[完成] 复制 0/2，删除 0 项，失败 2 项（用时 1.2 s）',
    '  [失败] 复制 src/main/index.ts — 复制后大小不一致（源 9,231，目标 4,096）',
    '  [失败] 复制 src/renderer/src/App.tsx — 目标端拒绝写入：磁盘空间不足',
    '  [提醒] docs/old-sync.md — 目标端那份已被别处改动过，未删除',
    '[退避] 20 秒后重试'
  ]
}

const snapBusy = {
  ...snapRun,
  run: 'occupied',
  occupiedBy: 'CCoder-Desktop (other window)',
  busy: false,
  watchedDirs: 0,
  hints: 0,
  log: [
    '[占用] 这一对目录已被另一个 IDE 窗口同步（CCoder-Desktop）—— 本窗口不启动',
    '（两个窗口同时同步会互相删掉对方刚写的文件）',
    '[重试] 60 秒后重新检查占用'
  ]
}

let current = { cwd: ws, config: cfgRun, snapshot: snapRun }
const states = { run: cfgRun, setup: cfgSetup, trouble: cfgRun, busy: cfgRun }

function allow(e, cwd) {
  return typeof cwd === 'string' && authorizeVcsSender(e.sender.id, cwd)
}

function register() {
  ipcMain.handle('locale:info', () => ({ systemLocale: 'zh-CN', resolved: 'zh' }))
  ipcMain.handle('settings:get', () => ({
    theme: 'dark',
    uiZoom: 1,
    chatFontSize: 14,
    uiFont: '',
    monoFont: '',
    language: 'zh'
  }))
  ipcMain.handle('win:is-maximized', () => false)
  ipcMain.handle('vcs:detect', (_e, cwd) =>
    allow(_e, cwd) ? { ok: true, data: { repo: null } } : { ok: false, error: { message: 'forbidden' } }
  )
  ipcMain.handle('ide:list-dir', (e, cwd, rel) => (allow(e, cwd) ? ide.listDir(cwd, rel) : []))
  ipcMain.handle('ide:read-file', (e, cwd, rel) =>
    allow(e, cwd) ? ide.readTextFile(cwd, rel) : Promise.reject(new Error('forbidden'))
  )
  ipcMain.handle('ide:read-image', () => Promise.reject(new Error('not used')))
  ipcMain.handle('ide:search-code', () => [])
  ipcMain.handle('ide:save-file', (e, req) =>
    req && allow(e, req.cwd)
      ? ide.saveTextFile(req)
      : { ok: false, code: 'forbidden', message: 'forbidden' }
  )
  ipcMain.handle('ide:create-entry', () => ({ ok: false, code: 'forbidden', message: 'x' }))
  ipcMain.handle('ide:rename-entry', () => ({ ok: false, code: 'forbidden', message: 'x' }))
  ipcMain.handle('ide:delete-entry', () => ({ ok: false, code: 'forbidden', message: 'x' }))
  ipcMain.on('ide:dirty', () => {})
  ipcMain.on('ide:confirm-close', () => {})

  ipcMain.handle('sync:get', (_e, cwd) => {
    if (!allow(_e, cwd)) throw new Error('forbidden')
    return current
  })
  ipcMain.handle('sync:save', (_e, cwd, config) => {
    if (!allow(_e, cwd)) throw new Error('forbidden')
    current = { ...current, config }
    return current
  })
  ipcMain.handle('sync:pick-dir', () => null)
  ipcMain.handle('sync:now', () => ({ ok: true }))
  ipcMain.handle('sync:open-target', () => ({ ok: true }))
}

async function shot(win, name) {
  const img = await win.webContents.capturePage()
  const out = path.join(ROOT, 'docs', 'mockups', name)
  fs.writeFileSync(out, img.toPNG())
  console.log('wrote', out, img.getSize().width + 'x' + img.getSize().height)
}

async function loadScene(win, scene, snapshot) {
  current = { cwd: ws, config: states[scene], snapshot }
  await win.webContents.reload()
  await sleep(1600)
  await win.webContents.executeJavaScript(`document.querySelectorAll('.ide-act')[3]?.click()`)
  await sleep(500)
}

app.whenReady().then(async () => {
  register()
  openIdeWindow(ws)
  await sleep(1800)
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return app.exit(1)
  win.setContentSize(1440, 900)
  await sleep(400)

  await loadScene(win, 'run', snapRun)
  await shot(win, 'sync-impl-run.png')

  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('.sync-iconbtn')].find((b) => b.title.includes('日志'))
    btn?.click()
  })()`)
  await sleep(400)
  await shot(win, 'sync-impl-log.png')

  await loadScene(win, 'setup', snapSetup)
  await shot(win, 'sync-impl-setup.png')

  await loadScene(win, 'trouble', snapTrouble)
  await shot(win, 'sync-impl-trouble.png')

  current = { cwd: ws, config: cfgRun, snapshot: snapBusy }
  await win.webContents.reload()
  await sleep(1600)
  await win.webContents.executeJavaScript(`document.querySelectorAll('.ide-act')[3]?.click()`)
  await sleep(500)
  await shot(win, 'sync-impl-busy.png')

  // 气泡：切回文件视图后推一轮新结果
  await win.webContents.executeJavaScript(`document.querySelectorAll('.ide-act')[0]?.click()`)
  await sleep(300)
  const bubbleSnap = { ...snapRun, lastRoundAtMs: Date.now() + 1, copied: 3, deleted: 1 }
  win.webContents.send('sync:status', { cwd: ws, snapshot: bubbleSnap })
  await sleep(350)
  await shot(win, 'sync-impl-bubble.png')

  app.exit(0)
})
