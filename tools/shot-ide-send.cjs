/*
 * 设计稿：IDE → 聊天。把真实的 IDE / 聊天界面跑起来，再注入尚未实现的
 * 「发送到聊天」UI，截成效果图。只用于评审，不参与打包。
 *
 * 产物：
 *   docs/mockups/ide-send-selection.png  — 选中一段代码 + 发送弹层
 *   docs/mockups/ide-send-file.png       — 整文件发送（文件树 / 面包屑两个入口）
 *   docs/mockups/ide-send-chat.png       — 聊天输入框接收代码引用
 *
 * 用法：npx electron tools/shot-ide-send.cjs
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'docs', 'mockups')
const SID = 'mock-session'
const FILE = 'src/renderer/src/components/Transcript.tsx'
const FILE2 = 'src/renderer/src/App.tsx'

const IGNORE = new Set([
  'node_modules', '.git', 'out', 'release', 'dist', 'build', '.codegraph',
  '.idea', '.claude', 'logs', 'coverage'
])

const LANG = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript React', '.js': 'JavaScript',
  '.jsx': 'JavaScript React', '.json': 'JSON', '.css': 'CSS', '.md': 'Markdown',
  '.html': 'HTML', '.yml': 'YAML', '.yaml': 'YAML'
}

const settings = {
  permissionMode: 'standard',
  defaultCwd: ROOT,
  openedCwds: [ROOT],
  theme: 'dark',
  uiZoom: 1,
  chatFontSize: 14,
  uiFont: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
  monoFont: "'Cascadia Mono', 'JetBrains Mono', Consolas, monospace",
  showTimestamps: false,
  thinkingOpen: false,
  toolDetail: 'full',
  sendKey: 'enter',
  clis: {
    claude: {
      enabled: true,
      activeChannelId: 'demo',
      channels: [{
        id: 'demo',
        name: 'DeepSeek 中转',
        kind: 'anthropic',
        baseUrl: 'https://api.deepseek.com/anthropic',
        model: 'deepseek-v4.1-flash[1m]',
        smallFastModel: '',
        authMode: 'token',
        authToken: 'sk-xxxxxxxxxxxxxxxxxxxx',
        extraEnv: []
      }],
      effort: 'medium'
    },
    codex: { enabled: false, activeChannelId: null, channels: [], effort: 'medium' }
  }
}

const now = Date.now()
const stored = [
  { id: 's1', cwd: ROOT, title: '修复登录流程', updatedAt: now - 4 * 60_000, cli: 'claude' },
  { id: 's2', cwd: ROOT, title: 'IDE 选中代码发送到聊天', updatedAt: now - 52 * 60_000, cli: 'claude' },
  { id: 's3', cwd: ROOT, title: '转写区工具卡的文件名可点', updatedAt: now - 27 * 60 * 60_000, cli: 'claude' }
]

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
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
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

ipcMain.handle('win:is-maximized', () => false)
ipcMain.handle('settings:get', () => settings)
ipcMain.handle('settings:save', (_e, s) => s)
ipcMain.handle('sessions:list', () => stored)
ipcMain.handle('sessions:transcript', () => [])
ipcMain.handle('sessions:pick-dir', () => null)
ipcMain.handle('sessions:delete', () => ({ ok: true }))
ipcMain.handle('session:start', () => SID)
ipcMain.handle('session:send', () => ({ ok: true }))
ipcMain.handle('session:running', () => [])
ipcMain.handle('channel:test', () => ({ ok: true, message: 'pong', latencyMs: 120 }))
ipcMain.handle('workspace:search-files', () => [])
ipcMain.handle('ide:open', () => undefined)
ipcMain.handle('ide:open-file', () => ({ ok: true }))
ipcMain.handle('ide:list-dir', (_e, cwd, rel) => listDir(cwd, rel))
ipcMain.handle('ide:read-file', (_e, cwd, rel) => readText(cwd, rel))
ipcMain.handle('ide:read-image', () => {
  throw new Error('not used in this mockup')
})
ipcMain.handle('ide:search-code', () => [])
ipcMain.handle('ide:git-status', () => ({
  repo: true,
  branch: 'main',
  files: [
    { rel: FILE, name: 'Transcript.tsx', status: 'M' },
    { rel: FILE2, name: 'App.tsx', status: 'M' },
    { rel: 'src/renderer/src/notice.ts', name: 'notice.ts', status: 'A' }
  ]
}))
ipcMain.handle('ide:git-diff', () => ({ repo: true, diff: '' }))
ipcMain.handle('vcs:detect', () => ({
  ok: true,
  data: { repo: null, available: { git: true, svn: false }, reason: 'no-repo' }
}))
ipcMain.handle('vcs:status', () => ({
  ok: false,
  error: { code: 'no-repo', message: 'not a repo' }
}))

// 关掉 IDE 窗口时别让 Electron 顺手退出（默认没有 window-all-closed 监听会退）
app.on('window-all-closed', () => {})

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function newWindow(width, height) {
  const win = new BrowserWindow({
    width,
    height,
    show: true,
    frame: false,
    backgroundColor: '#191919',
    webPreferences: {
      preload: path.join(ROOT, 'out', 'preload', 'index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  // 截图窗口别抢用户焦点太久，但 capturePage 需要真实绘制
  win.setAlwaysOnTop(true)
  return win
}

async function injectCss(win, css) {
  await win.webContents.executeJavaScript(`(() => {
    const s = document.createElement('style')
    s.textContent = ${JSON.stringify(css)}
    document.head.appendChild(s)
  })()`)
}

async function capture(win, name) {
  await wait(350)
  const img = await win.capturePage()
  fs.writeFileSync(path.join(OUT, name), img.toPNG())
  console.log('wrote', path.join(OUT, name))
}

/* ── 注入样式（与 ide.css / chat.css 的色板一致） ───────── */

const MOCK_CSS = `
.ide-line.mock-sel { background: rgba(138, 180, 248, .13) !important; }
.ide-line.mock-sel .ide-ln { color: #8ab4f8 !important; }
.ide-line.mock-sel .ide-src { color: #e6eaf2; }
.ide-line.mock-sel.mock-sel-start { box-shadow: inset 2px 0 0 #8ab4f8; }

.mock-selbar {
  position: absolute; z-index: 70; display: flex; align-items: center; gap: 2px;
  padding: 4px; background: #252528; border: 1px solid #3c3c43; border-radius: 9px;
  box-shadow: 0 14px 34px rgba(0,0,0,.55), 0 2px 8px rgba(0,0,0,.35);
  font-size: 11.5px; user-select: none;
}
.mock-selbar__count { padding: 0 6px; color: #8a8a94; font-size: 10.5px; white-space: nowrap; }
.mock-selbar__sep { width: 1px; height: 14px; margin: 0 2px; background: #3a3a41; }
.mock-selbar button {
  display: flex; align-items: center; gap: 5px; height: 27px; padding: 0 9px;
  color: #c6c6cf; border-radius: 6px; white-space: nowrap; cursor: pointer;
}
.mock-selbar button:hover { background: #303035; color: #fff; }
.mock-selbar button.is-primary { color: #191919; background: #e8e8e8; font-weight: 600; }
.mock-selbar button.is-primary:hover { background: #fff; color: #111; }
.mock-ico { width: 12px; height: 12px; flex: none; }

.mock-pop {
  position: absolute; z-index: 71; width: 452px; overflow: hidden;
  background: #242427; border: 1px solid #3a3a41; border-radius: 12px;
  box-shadow: 0 24px 64px rgba(0,0,0,.66), 0 0 0 1px rgba(255,255,255,.02);
  font-size: 12px; user-select: none;
}
.mock-pop__head { display: flex; align-items: center; padding: 11px 13px 10px; border-bottom: 1px solid #33333a; }
.mock-pop__title { font-weight: 600; color: #dedee6; letter-spacing: .01em; }
.mock-pop__esc { margin-left: auto; padding: 1px 6px; font-size: 9.5px; color: #70707a; border: 1px solid #3a3a41; border-radius: 4px; }
.mock-sec { padding: 10px 12px; }
.mock-sec + .mock-sec { border-top: 1px solid #2e2e34; }
.mock-label { margin-bottom: 6px; font-size: 9.5px; font-weight: 600; letter-spacing: .1em; color: #6c6c76; }
.mock-target {
  display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 10px;
  background: #1d1d20; border: 1px solid #34343b; border-radius: 8px;
}
.mock-target__dot { width: 6px; height: 6px; border-radius: 50%; background: #7fbf7f; box-shadow: 0 0 0 3px rgba(127,191,127,.12); }
.mock-target__name { color: #e6e6ec; }
.mock-target__meta { margin-left: auto; font-size: 10px; color: #787882; }
.mock-caretsym { margin-left: 4px; color: #7a7a84; font-size: 10px; }

.mock-file { display: flex; align-items: center; gap: 8px; }
.mock-file__ico {
  display: grid; place-items: center; width: 20px; height: 20px; flex: none;
  font-family: var(--font-mono); font-size: 8.5px; color: #8ab4f8;
  background: rgba(138,180,248,.1); border-radius: 5px;
}
.mock-file__name { color: #e4e4ea; }
.mock-range {
  margin-left: auto; padding: 1px 7px; font-family: var(--font-mono);
  font-size: 10px; color: #9cc4fa; background: rgba(138,180,248,.09);
  border: 1px solid rgba(138,180,248,.2); border-radius: 5px;
}
.mock-path { margin: 5px 0 0 28px; font-family: var(--font-mono); font-size: 10px; color: #6f6f79; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mock-pre {
  margin: 8px 0 0; padding: 8px 10px; overflow: hidden;
  font-family: var(--font-mono); font-size: 10.5px; line-height: 1.6;
  color: #a9a9b5; white-space: pre; background: #1a1a1d;
  border: 1px solid #2e2e35; border-radius: 7px;
}
.mock-pre .k { color: #c792ea; }
.mock-pre .s { color: #a5d6a7; }
.mock-pre .c { color: #6b6b73; font-style: italic; }
.mock-pop__foot {
  display: flex; align-items: center; gap: 10px; padding: 9px 12px;
  background: #212124; border-top: 1px solid #33333a;
}
.mock-hint { font-size: 10.5px; color: #74747e; }
.mock-send {
  margin-left: auto; display: flex; align-items: center; gap: 5px;
  height: 28px; padding: 0 13px; font-weight: 600; font-size: 11.5px;
  color: #191919; background: #e8e8e8; border-radius: 7px; cursor: pointer;
}
.mock-send:hover { background: #fff; }

/* 面包屑上的常驻入口 */
.mock-crumb-act {
  display: flex; align-items: center; gap: 5px; height: 20px; padding: 0 8px;
  font-size: 10.5px; color: #a9c6ee; background: rgba(138,180,248,.08);
  border: 1px solid rgba(138,180,248,.17); border-radius: 5px; cursor: pointer;
}
.mock-crumb-act:hover { background: rgba(138,180,248,.14); color: #cfe3ff; }

/* 资源管理器里，文件行的悬停动作 */
.ide-tree { position: relative; }
.ide-trow.mock-hover { background: #1f1f1f; }
.mock-tree-act {
  display: grid; place-items: center; width: 19px; height: 18px; margin-left: auto; flex: none;
  color: #9cc4fa; background: rgba(138,180,248,.1); border-radius: 4px;
}
.mock-tip {
  position: absolute; z-index: 72; padding: 4px 8px; font-size: 10.5px; color: #e2e2e8;
  background: #2a2a2e; border: 1px solid #3a3a41; border-radius: 5px;
  box-shadow: 0 8px 20px rgba(0,0,0,.4); white-space: nowrap;
}
.mock-tip::after {
  content: ''; position: absolute; left: 50%; bottom: -4px; width: 7px; height: 7px;
  margin-left: -3px; background: #2a2a2e; border-right: 1px solid #3a3a41;
  border-bottom: 1px solid #3a3a41; transform: rotate(45deg);
}
`

/* ── 场景 1：选中代码 ─────────────────────────────────── */

const PLANE = `<svg class="mock-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.4 8.1 13.4 3.4 10.7 13.3 8 9.1z"/><path d="M8 9.1l5.4-5.7"/></svg>`

const SELBAR = `
<div class="mock-selbar">
  <span class="mock-selbar__count">已选 13 行</span>
  <span class="mock-selbar__sep"></span>
  <button>复制</button>
  <button class="is-primary">${PLANE}发送到聊天</button>
</div>`

const SELPOP = `
<div class="mock-pop">
  <div class="mock-pop__head">
    <span class="mock-pop__title">发送到聊天</span>
    <span class="mock-pop__esc">Esc</span>
  </div>
  <div class="mock-sec">
    <div class="mock-label">目标会话</div>
    <div class="mock-target">
      <span class="mock-target__dot"></span>
      <span class="mock-target__name">修复登录流程</span>
      <span class="mock-target__meta">CCoder · 同工作区</span>
      <span class="mock-caretsym">▾</span>
    </div>
  </div>
  <div class="mock-sec">
    <div class="mock-file">
      <span class="mock-file__ico">&lt;/&gt;</span>
      <span class="mock-file__name">Transcript.tsx</span>
      <span class="mock-range">L464–476</span>
    </div>
    <div class="mock-path">src/renderer/src/components/Transcript.tsx · 13 行</div>
    <pre class="mock-pre"><span class="k">const</span> expandable = toolDetail === <span class="s">'full'</span> &amp;&amp; hasBody
<span class="k">const</span> showMeta = toolDetail === <span class="s">'full'</span>
<span class="c">// 这一段会作为代码引用附在消息里</span></pre>
  </div>
  <div class="mock-pop__foot">
    <span class="mock-hint">代码会随消息一起发给模型</span>
    <button class="mock-send">${PLANE}发送</button>
  </div>
</div>`

function sceneSelection(selbarHtml, selpopHtml, plane) {
  const content = document.querySelector('.ide-content')
  if (!content) return 'no .ide-content'
  const host = content.querySelector('.ide-monaco')
  const editor = host && host.__ccoderEditor
  const monaco = host && host.__ccoderMonaco
  if (editor && monaco) {
    const model = editor.getModel()
    editor.focus()
    editor.setSelection(
      new monaco.Selection(464, 1, 476, model.getLineMaxColumn(476))
    )
    editor.revealLineInCenter(470)
  }

  const crumb = document.querySelector('.ide-crumb-right')
  if (crumb) {
    crumb.insertAdjacentHTML(
      'afterbegin',
      `<button class="mock-crumb-act">${plane}发送选区</button>`
    )
  }

  content.insertAdjacentHTML('beforeend', selbarHtml)
  content.insertAdjacentHTML('beforeend', selpopHtml)

  const c = content.getBoundingClientRect()
  const bar = content.querySelector('.mock-selbar')
  const pop = content.querySelector('.mock-pop')
  const barW = bar.offsetWidth
  const popW = pop.offsetWidth
  const barTop = Math.min(c.height - 150, 300)
  bar.style.left = `${Math.max(12, c.width - barW - 26)}px`
  bar.style.top = `${barTop}px`
  pop.style.left = `${Math.max(12, c.width - popW - 26)}px`
  pop.style.top = `${barTop + bar.offsetHeight + 8}px`
  return { contentH: c.height, barTop, popH: pop.offsetHeight }
}

/* ── 场景 2：整文件发送 ───────────────────────────────── */

const FILEPOP = `
<div class="mock-pop" style="width: 388px">
  <div class="mock-pop__head">
    <span class="mock-pop__title">发送文件到聊天</span>
    <span class="mock-pop__esc">Esc</span>
  </div>
  <div class="mock-sec">
    <div class="mock-label">目标会话</div>
    <div class="mock-target">
      <span class="mock-target__dot"></span>
      <span class="mock-target__name">修复登录流程</span>
      <span class="mock-target__meta">CCoder · 同工作区</span>
      <span class="mock-caretsym">▾</span>
    </div>
  </div>
  <div class="mock-sec">
    <div class="mock-file">
      <span class="mock-file__ico">&lt;/&gt;</span>
      <span class="mock-file__name">App.tsx</span>
      <span class="mock-range">全文 · 218 行</span>
    </div>
    <div class="mock-path">src/renderer/src/App.tsx</div>
  </div>
  <div class="mock-pop__foot">
    <span class="mock-hint">整份文件作为引用附加到输入框</span>
    <button class="mock-send">${PLANE}发送</button>
  </div>
</div>`

function sceneFile(filePopHtml, plane) {
  const crumb = document.querySelector('.ide-crumb-right')
  if (crumb) {
    crumb.insertAdjacentHTML(
      'afterbegin',
      `<button class="mock-crumb-act">${plane}发送文件</button>`
    )
  }

  const row = [...document.querySelectorAll('.ide-trow.is-file')].find(
    (r) => r.getAttribute('title') === 'src/renderer/src/App.tsx'
  )
  if (row) {
    row.classList.add('mock-hover')
    row.insertAdjacentHTML(
      'beforeend',
      `<span class="mock-tree-act" title="发送到聊天">${plane}</span>`
    )
    const rr = row.getBoundingClientRect()
    const tree = document.querySelector('.ide-tree').getBoundingClientRect()
    const tip = document.createElement('div')
    tip.className = 'mock-tip'
    tip.textContent = '发送到聊天'
    tip.style.left = `${rr.right - tree.left - 78}px`
    tip.style.top = `${rr.top - tree.top - 25}px`
    document.querySelector('.ide-tree').appendChild(tip)
  }

  const content = document.querySelector('.ide-content')
  content.insertAdjacentHTML('beforeend', filePopHtml)
  const pop = content.querySelector('.mock-pop')
  const c = content.getBoundingClientRect()
  const btn = document.querySelector('.mock-crumb-act')
  pop.style.right = btn
    ? `${Math.max(8, c.right - btn.getBoundingClientRect().right)}px`
    : '24px'
  pop.style.top = '8px'
  return !!row
}

/* ── 场景 3：聊天输入框接收 ───────────────────────────── */

const CHAT_CSS = `
.mock-refs {
  display: flex; flex-direction: column; gap: 7px;
  padding: 0 4px 10px;
}
.mock-ref {
  overflow: hidden; background: #1d1d20; border: 1px solid #34343b;
  border-radius: 9px;
}
.mock-ref.is-open { border-color: rgba(138,180,248,.26); }
.mock-ref__head {
  display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px;
}
.mock-ref__ico {
  display: grid; place-items: center; width: 19px; height: 19px; flex: none;
  font-family: var(--font-mono); font-size: 8px; color: #8ab4f8;
  background: rgba(138,180,248,.1); border-radius: 5px;
}
.mock-ref__name { font-size: 12px; color: #e2e2e8; }
.mock-ref__path { font-family: var(--font-mono); font-size: 10px; color: #6f6f79; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mock-ref__range {
  font-family: var(--font-mono); font-size: 10px; color: #9cc4fa;
  background: rgba(138,180,248,.09); border: 1px solid rgba(138,180,248,.2);
  padding: 1px 6px; border-radius: 5px; margin-left: auto;
}
.mock-ref__tag {
  font-size: 9.5px; color: #7f9cc4; background: rgba(138,180,248,.07);
  border: 1px solid rgba(138,180,248,.14); padding: 1px 5px; border-radius: 4px;
}
.mock-ref__x { display: grid; place-items: center; width: 18px; height: 18px; color: #7a7a84; border-radius: 4px; cursor: pointer; }
.mock-ref__x:hover { background: #34343b; color: #ddd; }
.mock-ref__code {
  margin: 0; padding: 7px 10px 8px 37px; font-family: var(--font-mono);
  font-size: 10.5px; line-height: 1.55; color: #9d9daa; white-space: pre;
  background: #19191c; border-top: 1px solid #2c2c33;
  overflow: hidden;
}
.mock-ref.is-file { display: flex; align-items: center; }
.mock-ref.is-file .mock-ref__head { flex: 1; height: 32px; }
.mock-ref__more { margin-left: 2px; font-size: 10px; color: #6f6f79; }
`

const REFS = `
<div class="mock-refs">
  <div class="mock-ref is-open">
    <div class="mock-ref__head">
      <span class="mock-ref__ico">&lt;/&gt;</span>
      <span class="mock-ref__name">Transcript.tsx</span>
      <span class="mock-ref__range">L464–476</span>
      <span class="mock-ref__tag">来自 IDE</span>
      <button class="mock-ref__x" title="移除">×</button>
    </div>
    <pre class="mock-ref__code">const expandable = toolDetail === 'full' &amp;&amp; hasBody
const showMeta = toolDetail === 'full'
// 选区会作为代码引用随这条消息一起发出</pre>
  </div>
  <div class="mock-ref is-file">
    <div class="mock-ref__head">
      <span class="mock-ref__ico">&lt;/&gt;</span>
      <span class="mock-ref__name">App.tsx</span>
      <span class="mock-ref__range">全文 · 218 行</span>
      <span class="mock-ref__tag">来自 IDE</span>
      <button class="mock-ref__x" title="移除">×</button>
    </div>
  </div>
</div>`

function sceneChat(refsHtml) {
  const box = document.querySelector('.composer__box')
  const ta = document.querySelector('.composer__input')
  if (!box || !ta) return false
  ta.insertAdjacentHTML('beforebegin', refsHtml)

  const draft = '这两处逻辑可以合并吗？顺便看看选区里的 memo 比较还能不能再收一收。'
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value'
  ).set
  setter.call(ta, draft)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  ta.focus()
  ta.setSelectionRange(draft.length, draft.length)

  // 输入框有内容，发送键应该是可用态（直接改 class 省得等 React 状态）
  const send = document.querySelector('.send')
  if (send) {
    send.classList.remove('is-stop')
    send.classList.add('is-ready')
    send.removeAttribute('disabled')
  }
  return true
}

/* ── 跑场景 ───────────────────────────────────────────── */

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })

  const ide = newWindow(1360, 860)
  ide.setPosition(80, 40)

  // 场景 1
  await ide.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'), {
    query: { view: 'ide', cwd: ROOT, file: FILE, line: '464' }
  })
  await wait(1500)
  await injectCss(ide, MOCK_CSS)
  const s1 = await ide.webContents.executeJavaScript(
    `(${sceneSelection.toString()})(${JSON.stringify(SELBAR)}, ${JSON.stringify(SELPOP)}, ${JSON.stringify(PLANE)})`
  )
  console.log('scene1', s1)
  await capture(ide, 'ide-send-selection.png')

  // 场景 2（重新加载，清掉上一场景的注入）
  await ide.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'), {
    query: { view: 'ide', cwd: ROOT, file: FILE2 }
  })
  await wait(1200)

  // 展开 src / renderer / src 三层，露出 App.tsx
  for (const rel of ['src', 'src/renderer', 'src/renderer/src']) {
    await ide.webContents.executeJavaScript(`(() => {
      const el = [...document.querySelectorAll('.ide-trow.is-dir')]
        .find((r) => r.getAttribute('title') === ${JSON.stringify(rel)})
      if (el) el.click()
    })()`)
    await wait(450)
  }
  await injectCss(ide, MOCK_CSS)
  const s2 = await ide.webContents.executeJavaScript(
    `(${sceneFile.toString()})(${JSON.stringify(FILEPOP)}, ${JSON.stringify(PLANE)})`
  )
  console.log('scene2', s2)
  await capture(ide, 'ide-send-file.png')
  ide.destroy()

  // 场景 3
  const chat = newWindow(1360, 860)
  chat.setPosition(120, 70)
  await chat.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  await wait(1500)

  const sendEvent = (event) =>
    chat.webContents.send('session:event', { sessionId: SID, event })
  chat.webContents.send('session:status', {
    sessionId: SID,
    status: 'idle',
    providerSessionId: 'prov-1'
  })
  sendEvent({
    t: 'session_started',
    sessionId: 'prov-1',
    provider: 'claude',
    model: 'deepseek-v4.1-flash[1m]',
    cwd: ROOT,
    tools: [],
    permissionMode: 'standard'
  })
  sendEvent({ t: 'user_message', text: '修复登录流程', at: new Date().toISOString() })
  sendEvent({
    t: 'text_delta',
    text: '我先看一下工具卡的渲染逻辑。选区里的 `expandable` / `showMeta` 现在各算各的，可以抽一层。'
  })
  sendEvent({ t: 'turn_end', durationMs: 3200, usage: { inputTokens: 4200, outputTokens: 180, cacheReadTokens: 0, cacheCreationTokens: 0 }, steps: 1 })
  await wait(800)

  await injectCss(chat, CHAT_CSS)
  const ok = await chat.webContents.executeJavaScript(
    `(${sceneChat.toString()})(${JSON.stringify(REFS)})`
  )
  console.log('scene3', ok)
  await capture(chat, 'ide-send-chat.png')

  chat.destroy()
  app.exit(0)
})
