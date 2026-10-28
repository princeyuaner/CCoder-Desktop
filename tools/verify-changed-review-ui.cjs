/*
 * 验证「本轮改动 → IDE 审阅」这条链路的界面行为。
 *
 * 不接真实 CLI / 不碰真实磁盘：stub 掉 main 的 IPC，只检查渲染层的决策，
 * 以及发出去的 IPC 参数 ——
 *   1. 本轮有改动时出现「N 个文件」按钮，点开是清单；
 *   2. 点一行 → 调用 ide:open-diffs，参数是工作区相对路径；
 *   3. 「在 IDE 中审阅」一次带上全部可审阅的文件；
 *   4. 工作区外的文件标「工作区外」且点不开；
 *   5. 不是仓库时不出现「还原」入口；是仓库时悬停行才出现；
 *   6. 还原要点两次（二次确认），确认后带正确参数调用 vcs:discard；
 *   7. 还原成功后该行变成「已还原」，不再有还原按钮。
 *
 * 用法（先 npx electron-vite build）：
 *   node node_modules/electron/cli.js tools/verify-changed-review-ui.cjs
 * 不参与打包，随时可删。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CWD = 'C:\\Users\\CY\\Desktop\\CCoder-Desktop'
const OTHER = 'C:\\Users\\CY\\Desktop\\agent-kit'

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
      channels: [
        ch('demo-1', 'DeepSeek 中转', 'https://api.deepseek.com/anthropic', 'deepseek-chat')
      ]
    },
    codex: { enabled: false, activeChannelId: null, effort: 'medium', channels: [] },
    dsh: { enabled: false, activeChannelId: null, effort: 'medium', channels: [] }
  }
}

const SESSIONS = [
  {
    id: 'sess-1',
    cwd: CWD,
    title: '审阅本轮改动',
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 60_000,
    cli: 'claude'
  }
]

/**
 * 最后一轮：三条工作区内的改动 + 一条工作区外的。
 *
 * 路径故意混着写：绝对正斜杠、绝对反斜杠、工作区相对（DSH 那种）。
 * 三种都要能换算成 rel。
 */
const TRANSCRIPT = [
  { t: 'user_message', text: '把这三处改一下', at: new Date().toISOString() },
  {
    t: 'file_change',
    path: `${CWD}/src/main/index.ts`,
    added: 12,
    removed: 3,
    source: 'agent'
  },
  {
    t: 'file_change',
    path: `${CWD}\\src\\renderer\\src\\App.tsx`,
    added: 4,
    removed: 1,
    wrote: true,
    source: 'agent'
  },
  { t: 'file_change', path: 'docs/notes.md', added: 5, removed: 0, created: true, source: 'subagent' },
  { t: 'file_change', path: `${OTHER}/secret.ts`, added: 2, removed: 0, source: 'agent' },
  { t: 'turn_end', durationMs: 1000, usage: { inputTokens: 1, outputTokens: 1 }, steps: 3 }
]

const calls = { openDiffs: [], discard: [], revert: [] }
let discardResult = { ok: true, data: { affected: 1, paths: [] } }

ipcMain.handle('win:is-maximized', () => false)
ipcMain.handle('settings:get', () => DEMO)
ipcMain.handle('settings:save', (_e, s) => s)
ipcMain.handle('sessions:list', () => SESSIONS)
ipcMain.handle('sessions:transcript', () => TRANSCRIPT)
ipcMain.handle('sessions:meta', () => ({}))
ipcMain.handle('sessions:set-meta', () => ({}))
ipcMain.handle('sessions:search', () => ({ hits: [], total: 0 }))
ipcMain.handle('sessions:pick-dir', () => null)
ipcMain.handle('session:running', () => [])
ipcMain.handle('session:start', () => 'live-1')
ipcMain.handle('session:send', () => ({ ok: true }))
for (const name of [
  'session:stop',
  'session:interrupt',
  'session:reconfigure',
  'session:respond-permission',
  'session:respond-question'
]) {
  ipcMain.on(name, () => undefined)
}

const REPO = {
  kind: 'git',
  root: CWD,
  workspacePrefix: '',
  branch: 'main',
  head: 'abc123',
  headShort: 'abc123',
  ahead: 0,
  behind: 0,
  detached: false,
  capabilities: {
    stage: true,
    unstage: true,
    discard: true,
    revert: false,
    resolve: true,
    fetch: true,
    pull: true,
    push: true,
    update: false,
    amend: true,
    log: true,
    commitDetail: true,
    branches: true,
    worktrees: true
  }
}

/** 设为 false 来验证「不是仓库」时的情况 */
let hasRepo = true

ipcMain.handle('vcs:detect', () => ({
  ok: true,
  data: { repo: hasRepo ? REPO : null, available: { git: true, svn: false } }
}))
ipcMain.handle('vcs:status', () => ({
  ok: true,
  data: { repo: REPO, files: [], counts: { total: 0, staged: 0, unstaged: 0, untracked: 0 }, clean: true }
}))
ipcMain.handle('vcs:worktree-list', () => ({ ok: true, data: { worktrees: [] } }))
ipcMain.handle('ide:open-diffs', (_e, cwd, rels) => {
  calls.openDiffs.push({ cwd, rels })
  return { ok: true }
})
ipcMain.handle('vcs:discard', (_e, req) => {
  calls.discard.push(req)
  return discardResult
})
ipcMain.handle('vcs:revert', (_e, req) => {
  calls.revert.push(req)
  return { ok: true, data: { affected: req.paths.length, paths: req.paths } }
})
/** IDE 的 diff 页签按这个拉内容；返回一段最小可解析的 hunk */
ipcMain.handle('vcs:diff', (_e, req) => {
  calls.diff = calls.diff || []
  calls.diff.push(req)
  return {
    ok: true,
    data: {
      repoKind: 'git',
      rel: req.rel,
      source: req.source,
      diff: `diff --git a/${req.rel} b/${req.rel}\n--- a/${req.rel}\n+++ b/${req.rel}\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n`,
      binary: false,
      untracked: false,
      truncated: false,
      added: 1,
      removed: 1
    }
  }
})

let failed = 0
function check(label, cond, detail) {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : String(detail))
  }
}

const js = (w, code) => w.webContents.executeJavaScript(code)

async function waitFor(fn, timeout = 4000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true
    await sleep(100)
  }
  return false
}

/** 打开清单（第一次会顺便触发仓库探测） */
async function openPop(w) {
  await js(w, `document.querySelector('.cfbtn')?.click()`)
  await sleep(400)
}

const state = (w) =>
  js(
    w,
    `(() => {
       const rows = [...document.querySelectorAll('.cfpop .cfrow')];
       return {
         button: document.querySelector('.cfbtn__label b')?.textContent || '',
         pop: !!document.querySelector('.cfpop'),
         rows: rows.map((r) => ({
           name: r.querySelector('.cfrow__name')?.textContent || '',
           outside: !!r.querySelector('.cfrow__outside'),
           openDisabled: r.querySelector('.cfrow__open')?.disabled ?? null,
           undo: !!r.querySelector('.cfrow__undo'),
           reverted: !!r.querySelector('.cfrow__reverted'),
           seen: !!r.querySelector('.cfrow__seen'),
           confirm: !!r.querySelector('.cfrow__confirm')
         })),
         review: document.querySelector('.cfpop__review')?.textContent || '',
         foot: document.querySelector('.cfpop__foot')?.textContent || ''
       };
     })()`
  )

const clickRow = (w, name) =>
  js(
    w,
    `(() => {
       const row = [...document.querySelectorAll('.cfpop .cfrow')].find(
         (r) => r.querySelector('.cfrow__name')?.textContent === ${JSON.stringify(name)}
       );
       const btn = row?.querySelector('.cfrow__open');
       btn?.click();
       return !!btn && !btn.disabled;
     })()`
  )

const clickUndo = (w, name) =>
  js(
    w,
    `(() => {
       const row = [...document.querySelectorAll('.cfpop .cfrow')].find(
         (r) => r.querySelector('.cfrow__name')?.textContent === ${JSON.stringify(name)}
       );
       const btn = row?.querySelector('.cfrow__undo');
       btn?.click();
       return !!btn;
     })()`
  )

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
  await sleep(2200)

  console.log('\n[1] 打开已有会话 → 本轮改动按钮')
  await js(win, `document.querySelector('.session__main')?.click()`)
  const ready = await waitFor(async () => (await state(win)).button === '4')
  check('按钮上是 4 个文件', ready, (await state(win)).button)
  check('清单默认收起', (await state(win)).pop === false)

  console.log('\n[2] 展开清单')
  await openPop(win)
  let s = await state(win)
  check('清单打开', s.pop, JSON.stringify(s.rows))
  check('列出 4 行', s.rows.length === 4, String(s.rows.length))
  check('工作区外的那条被标出来', s.rows.find((r) => r.name === 'secret.ts')?.outside === true, JSON.stringify(s.rows))
  check('工作区外的点不开', s.rows.find((r) => r.name === 'secret.ts')?.openDisabled === true)
  check('工作区内的可以点', s.rows.find((r) => r.name === 'index.ts')?.openDisabled === false)
  check('底部有「在 IDE 中审阅」', s.review.length > 0, s.review)

  console.log('\n[3] 点一行 → 打开 diff')
  check('点得到 index.ts', await clickRow(win, 'index.ts'))
  const opened = await waitFor(() => calls.openDiffs.length > 0)
  check('调用了 ide:open-diffs', opened, JSON.stringify(calls.openDiffs))
  check('cwd 是会话目录', calls.openDiffs[0]?.cwd === CWD, calls.openDiffs[0]?.cwd)
  check(
    '绝对路径换算成 rel',
    JSON.stringify(calls.openDiffs[0]?.rels) === JSON.stringify(['src/main/index.ts']),
    JSON.stringify(calls.openDiffs[0]?.rels)
  )
  await sleep(300)
  s = await state(win)
  check('看过的行打勾', s.rows.find((r) => r.name === 'index.ts')?.seen === true, JSON.stringify(s.rows))

  console.log('\n[4] 反斜杠 / 相对路径也能换算')
  await clickRow(win, 'App.tsx')
  await clickRow(win, 'notes.md')
  await sleep(400)
  check(
    '反斜杠绝对路径 → rel',
    JSON.stringify(calls.openDiffs.at(-2)?.rels) === JSON.stringify(['src/renderer/src/App.tsx']),
    JSON.stringify(calls.openDiffs.at(-2)?.rels)
  )
  check(
    '工作区相对路径原样可用',
    JSON.stringify(calls.openDiffs.at(-1)?.rels) === JSON.stringify(['docs/notes.md']),
    JSON.stringify(calls.openDiffs.at(-1)?.rels)
  )

  console.log('\n[5] 一次审阅全部（工作区外的被跳过）')
  calls.openDiffs.length = 0
  await js(win, `document.querySelector('.cfpop__review')?.click()`)
  const all = await waitFor(() => calls.openDiffs.length > 0)
  check('调用了一次', all && calls.openDiffs.length === 1, JSON.stringify(calls.openDiffs))
  check(
    '三个工作区内的文件都在，且顺序稳定',
    JSON.stringify(calls.openDiffs[0]?.rels) ===
      JSON.stringify(['src/main/index.ts', 'src/renderer/src/App.tsx', 'docs/notes.md']),
    JSON.stringify(calls.openDiffs[0]?.rels)
  )

  console.log('\n[6] 还原：悬停按钮 + 二次确认')
  await sleep(300)
  s = await state(win)
  check('Git 仓库里出现还原入口', s.rows.filter((r) => r.undo).length === 3, JSON.stringify(s.rows))
  check('工作区外的没有还原入口', s.rows.find((r) => r.name === 'secret.ts')?.undo === false)

  check('点得下 index.ts 的还原', await clickUndo(win, 'index.ts'))
  await sleep(250)
  s = await state(win)
  check('第一次点只进确认态，不调接口', s.rows.some((r) => r.confirm) && calls.discard.length === 0, JSON.stringify(s.rows))

  console.log('\n[7] 取消确认')
  await js(
    win,
    `(() => {
       const row = document.querySelector('.cfpop .cfrow.is-confirm');
       const btns = row ? [...row.querySelectorAll('.cfrow__btn')] : [];
       btns.at(-1)?.click();
     })()`
  )
  await sleep(250)
  s = await state(win)
  check('确认态消失', !s.rows.some((r) => r.confirm))
  check('仍然没有调用接口', calls.discard.length === 0)

  console.log('\n[8] 确认还原')
  await clickUndo(win, 'index.ts')
  await sleep(200)
  await js(win, `document.querySelector('.cfrow.is-confirm .cfrow__btn.is-danger')?.click()`)
  const reverted = await waitFor(() => calls.discard.length > 0)
  check('调用了 vcs:discard', reverted, JSON.stringify(calls.discard))
  check('带上了 rel 路径', JSON.stringify(calls.discard[0]?.paths) === JSON.stringify(['src/main/index.ts']), JSON.stringify(calls.discard[0]))
  check('允许删掉未跟踪文件', calls.discard[0]?.includeUntracked === true)
  await sleep(400)
  s = await state(win)
  check('该行变成「已还原」', s.rows.find((r) => r.name === 'index.ts')?.reverted === true, JSON.stringify(s.rows))
  check('已还原的行不再有按钮', s.rows.find((r) => r.name === 'index.ts')?.undo === false)

  console.log('\n[9] 还原失败：保留原状并提示')
  discardResult = { ok: false, error: { code: 'conflict', message: '文件被占用' } }
  await clickUndo(win, 'App.tsx')
  await sleep(200)
  await js(win, `document.querySelector('.cfrow.is-confirm .cfrow__btn.is-danger')?.click()`)
  await waitFor(() => calls.discard.length > 1)
  await sleep(400)
  s = await state(win)
  check('失败的行不标「已还原」', s.rows.find((r) => r.name === 'App.tsx')?.reverted === false, JSON.stringify(s.rows))
  check('还原入口还在，可以重试', s.rows.find((r) => r.name === 'App.tsx')?.undo === true)
  check(
    '顶部提示里有失败原因',
    await js(win, `document.querySelector('.notice')?.textContent?.includes('文件被占用') ?? false`)
  )

  console.log('\n[10] 不是仓库：没有还原入口，diff 仍然能看')
  hasRepo = false
  // 换一个工作区重新挂载，让探测重新跑
  await js(win, `document.querySelector('.cfbtn')?.click()`)
  await sleep(200)
  win.webContents.reload()
  await sleep(2200)
  await js(win, `document.querySelector('.session__main')?.click()`)
  await waitFor(async () => (await state(win)).button === '4')
  await openPop(win)
  await sleep(300)
  s = await state(win)
  check('没有还原入口', s.rows.every((r) => !r.undo), JSON.stringify(s.rows))
  calls.openDiffs.length = 0
  check('diff 仍然可以打开', await clickRow(win, 'notes.md'))
  await waitFor(() => calls.openDiffs.length > 0)
  check('调用成功', calls.openDiffs.length === 1, JSON.stringify(calls.openDiffs))

  console.log('\n[11] IDE 端：首屏 query / reveal 打开一整批 diff')
  await verifyIdeSide()

  if (failed > 0) {
    console.log(`\n${failed} check(s) failed`)
    app.exit(1)
  } else {
    console.log('\nall checks passed')
    app.exit(0)
  }
})

/**
 * IDE 窗口接收端。
 *
 * 主窗口把 `diff=1` + `more=[...]` 放在首屏 query 里（窗口还没开时），
 * 窗口已经开着时走 `ide:reveal`。两条路径都要能一次开出整批 diff 页签，
 * 且**焦点落在第一个**而不是最后插入的那个。
 */
async function verifyIdeSide() {
  const ide = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    frame: false,
    backgroundColor: '#191919',
    webPreferences: {
      preload: path.join(__dirname, '..', 'out', 'preload', 'index.js'),
      sandbox: false
    }
  })

  const query = new URLSearchParams({
    view: 'ide',
    cwd: CWD,
    file: 'src/main/index.ts',
    diff: '1',
    more: JSON.stringify(['src/renderer/src/App.tsx', 'docs/notes.md'])
  })
  await ide.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'index.html'), {
    query: Object.fromEntries(query)
  })
  await sleep(2400)

  const tabs = () =>
    js(
      ide,
      `(() => {
         const all = [...document.querySelectorAll('.ide-tab')];
         return {
           titles: all.map((t) => t.querySelector('.ide-tab-title')?.textContent || ''),
           active: document.querySelector('.ide-tab.on .ide-tab-title')?.textContent || '',
           diffHead: !!document.querySelector('.ide-diffhead'),
           crumb: document.querySelector('.ide-crumb-path')?.textContent || ''
         };
       })()`
    )

  const opened = await waitFor(async () => (await tabs()).titles.length === 3)
  let s = await tabs()
  check('一次开出 3 个 diff 页签', opened, JSON.stringify(s.titles))
  check('页签标题带 (diff) 后缀', s.titles.every((t) => t.includes('(diff)')), JSON.stringify(s.titles))
  check('焦点在第一个文件上', s.active.startsWith('index.ts'), s.active)
  check('真的渲染出了 diff', s.diffHead, JSON.stringify(s))

  // 已经开着的窗口走 reveal：同一批再来一次不应该重复插入
  const sent = await js(
    ide,
    `(() => {
       const api = window.api;
       if (!api?.ide?.onReveal) return false;
       return true;
     })()`
  )
  check('IDE 订阅了 reveal', sent)

  // 模拟主进程发一条 reveal（preload 把 IPC 事件转成订阅回调）
  ide.webContents.send('ide:reveal', {
    rel: 'docs/notes.md',
    diff: true,
    more: ['src/main/index.ts']
  })
  await sleep(800)
  s = await tabs()
  check('reveal 不重复插入已有页签', s.titles.length === 3, JSON.stringify(s.titles))
  check('reveal 把焦点切到目标文件', s.active.startsWith('notes.md'), s.active)

  ide.destroy()
}
