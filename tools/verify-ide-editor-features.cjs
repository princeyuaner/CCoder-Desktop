/*
 * 验证本轮新增的编辑器能力：
 *   - .editorconfig → 缩进 / 换行 / 行尾空白 / 末尾空行
 *   - 符号面包屑 + sticky scroll
 *   - 语言模式切换、行尾切换
 *   - 未命名缓冲区 + Ctrl+N + Ctrl+S 另存为
 *
 * 只跑构建产物，不连真实 CLI：
 *   npm run build
 *   npx esbuild src/main/ide-editorconfig.ts --bundle --platform=node --format=cjs --outfile=tools/_ide-editorconfig.cjs
 *   node node_modules/electron/cli.js tools/verify-ide-editor-features.cjs
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const iconv = require('iconv-lite')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '..')
process.env.ELECTRON_RENDERER_URL = pathToFileURL(
  path.join(ROOT, 'out', 'renderer', 'index.html')
).href
process.env.CCODER_PRELOAD_PATH = path.join(ROOT, 'out', 'preload', 'index.js')
app.commandLine.appendSwitch('force-device-scale-factor', '1')

const ide = require('./_ide-fs.cjs')
const editorConfig = require('./_ide-editorconfig.cjs')
const { openIdeWindow, authorizeVcsSender } = require('./_ide-window.cjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// 不用系统临时目录 / mkdtemp：受限环境里 Electron 主进程可能没有写权限
const tmpRoot = path.join(ROOT, '.tmp-build')
const LOG = path.join(tmpRoot, 'ide-verify.log')
try {
  fs.mkdirSync(tmpRoot, { recursive: true })
  fs.writeFileSync(LOG, '')
} catch {}
function log(line) {
  console.log(line)
  try {
    fs.appendFileSync(LOG, `${line}\n`)
  } catch {}
}
process.on('uncaughtException', (err) => {
  log(`UNCAUGHT ${err && err.stack ? err.stack : err}`)
})
process.on('unhandledRejection', (err) => {
  log(`UNHANDLED ${err && err.stack ? err.stack : err}`)
})
const base = path.join(tmpRoot, `ide-verify-${Date.now()}`)
try {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
} catch {}
const ws = path.join(base, 'workspace')
try {
  fs.mkdirSync(ws, { recursive: true })
  log('prepared workspace')
} catch (err) {
  log(`PREPARE FAILED ${err && err.stack ? err.stack : err}`)
}
let failed = 0
/** 最近一次 settings:save 的载荷，供设置页用例断言 */
let lastSavedSettings = null

function put(rel, text) {
  const full = path.join(ws, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, text)
}

function putBytes(rel, bytes) {
  const full = path.join(ws, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, bytes)
}

function check(name, ok, detail) {
  if (ok) {
    log(`ok   ${name}`)
  } else {
    failed += 1
    log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

put(
  '.editorconfig',
  [
    'root = true',
    '',
    '[*.ts]',
    'indent_style = space',
    'indent_size = 4',
    'end_of_line = crlf',
    'insert_final_newline = true',
    'trim_trailing_whitespace = true',
    ''
  ].join('\n')
)
put(
  'src/app.ts',
  [
    'export class Greeter {',
    '  greet(name: string): string {',
    '    return `hello ${name}`',
    '  }',
    '}',
    '',
    'export function main(): void {',
    '  const greeter = new Greeter()',
    '  console.log(greeter.greet("world"))',
    '}',
    ''
  ].join('\n')
)
put('src/util.ts', 'export const answer = 42\n')
put('src/format.ts', 'export const untouched = 0\n')
put('src/script.py', 'def hello():\n    return 1\n')
put('src/copy-src.ts', 'export const copied = 1\n')
put('src/move-src.ts', 'export const moved = 1\n')
put('src/drag-src.ts', 'export const dragged = 1\n')
put('src/del-a.ts', 'export const a = 1\n')
put('src/del-b.ts', 'export const b = 1\n')
put('src/ignored-file.ts', 'export const ignored = 1\n')
put('dest/.keep', '')
put('node_modules/pkg/index.js', 'module.exports = 1\n')
put('.hidden.ts', 'export const hidden = 1\n')
put('README.md', '# test\n')
// 搜索 / 替换 / 撤销的固定素材
put('search/a.txt', 'needle one\nneedle two\n')
put('search/b.txt', 'needle three\n')
// GBK 编码的源文件：状态栏应自动显示 GBK，编码菜单可强制改写 / 恢复自动
const GBK_TEXT =
  '// ' +
  '中文编码测试，自动识别 GBK 与 UTF-8。'.repeat(12) +
  '\nexport const gbkValue = 1\n'
putBytes('src/gbk.txt', iconv.encode(GBK_TEXT, 'gb18030'))

function allow(e, cwd) {
  return typeof cwd === 'string' && authorizeVcsSender(e.sender.id, cwd)
}

function register() {
  ipcMain.handle('settings:get', () => ({
    language: 'zh',
    theme: 'dark',
    uiZoom: 1,
    chatFontSize: 14,
    uiFont: '',
    monoFont: '',
    showTimestamps: false,
    thinkingOpen: false,
    toolDetail: 'full',
    sendKey: 'enter',
    notifyOnDone: false,
    openedCwds: [ws],
    defaultCwd: ws,
    permissionMode: 'standard',
    editor: {
      fontSize: 13,
      tabSize: 2,
      insertSpaces: true,
      wordWrap: 'off',
      minimap: false,
      stickyScroll: true,
      formatOnSave: true,
      autoSave: 'off',
      autoSaveDelayMs: 1000,
      trimTrailingWhitespace: false,
      autoRevealInExplorer: false,
      languages: { python: { tabSize: 8, insertSpaces: true } }
    },
    keybindings: {},
    lsp: { enabled: false },
    cliUpdate: { autoCheck: false, tagInNav: false },
    clis: {}
  }))
  ipcMain.handle('settings:save', (_e, s) => {
    lastSavedSettings = s
    return s
  })
  ipcMain.handle('win:is-maximized', () => false)
  ipcMain.handle('vcs:detect', (e, cwd) =>
    allow(e, cwd)
      ? { ok: true, data: { repo: null } }
      : { ok: false, error: { message: 'forbidden' } }
  )
  ipcMain.handle('vcs:status', () => ({ ok: false, error: { message: 'no repo' } }))
  ipcMain.handle('ide:list-dir', (e, cwd, rel, options) =>
    allow(e, cwd) ? ide.listDir(cwd, rel, options) : []
  )
  ipcMain.handle('ide:read-file', (e, cwd, rel, encoding) =>
    allow(e, cwd)
      ? ide.readTextFileResult(cwd, rel, encoding)
      : Promise.resolve({ ok: false, code: 'forbidden', message: 'forbidden' })
  )
  ipcMain.handle('ide:read-image', () =>
    Promise.resolve({ ok: false, code: 'not-file', message: 'not used' })
  )
  ipcMain.handle('ide:search-code', () => [])
  ipcMain.handle('ide:search-start', async (e, req) => {
    if (!req || !allow(e, req.cwd)) {
      return { ok: false, code: 'forbidden', message: 'forbidden' }
    }
    const r = await ide.searchCode({
      cwd: req.cwd,
      query: req.query,
      options: req.options
    })
    if (!r.ok) return r
    const base = {
      requestId: req.requestId,
      matchCount: r.data.matchCount,
      scannedFiles: r.data.scannedFiles,
      truncated: r.data.truncated,
      fallback: false
    }
    e.sender.send('ide:search-event', {
      type: 'batch',
      ...base,
      files: r.data.files,
      reset: true
    })
    e.sender.send('ide:search-event', { type: 'done', ...base })
    return { ok: true, data: { mode: 'js', fallback: false } }
  })
  ipcMain.on('ide:search-cancel', () => {})
  ipcMain.handle('ide:save-file', (e, req) =>
    req && allow(e, req.cwd)
      ? ide.saveTextFile(req)
      : { ok: false, code: 'forbidden', message: 'forbidden' }
  )
  ipcMain.handle('ide:replace-in-workspace', (e, req) =>
    req && allow(e, req.cwd)
      ? ide.replaceInWorkspace(req)
      : { ok: false, code: 'forbidden', message: 'forbidden' }
  )
  ipcMain.handle('ide:undo-replace', (e, req) =>
    req && allow(e, req.cwd)
      ? ide.undoReplace(req)
      : { ok: false, code: 'forbidden', message: 'forbidden' }
  )
  ipcMain.handle('ide:create-entry', (e, req) =>
    req && allow(e, req.cwd)
      ? ide.createEntry(req)
      : { ok: false, code: 'forbidden', message: 'forbidden' }
  )
  ipcMain.handle('ide:rename-entry', (e, req) =>
    req && allow(e, req.cwd)
      ? ide.renameEntry(req)
      : { ok: false, code: 'forbidden', message: 'forbidden' }
  )
  ipcMain.handle('ide:delete-entry', (e, req) =>
    req && allow(e, req.cwd)
      ? ide.deleteEntry(req)
      : { ok: false, code: 'forbidden', message: 'forbidden' }
  )
  ipcMain.handle('ide:transfer-entries', (e, req) =>
    req && allow(e, req.cwd)
      ? ide.transferEntries(req)
      : { ok: false, code: 'forbidden', message: 'forbidden' }
  )
  ipcMain.handle('ide:editor-config', (e, cwd, rel) =>
    allow(e, cwd) ? editorConfig.editorConfigFor(cwd, rel) : {}
  )
  ipcMain.on('ide:dirty', () => {})
  ipcMain.on('ide:confirm-close', () => {})
}

async function evalJs(win, source) {
  return win.webContents.executeJavaScript(source, true)
}

async function waitFor(win, expression, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await evalJs(win, `(() => { try { return !!(${expression}) } catch { return false } })()`)
    if (ok) return true
    await sleep(100)
  }
  return false
}

/** 展开 src 并点击一个文件；用来切到别的语言 / 别的文件 */
async function openTreeFile(win, name) {
  const quoted = JSON.stringify(name)
  const visible = await evalJs(
    win,
    `!![...document.querySelectorAll('.ide-trow.is-file')].find((r) => r.textContent.includes(${quoted}))`
  )
  if (!visible) {
    await evalJs(
      win,
      `(() => {
        const dir = [...document.querySelectorAll('.ide-trow.is-dir')]
          .find((r) => r.textContent.trim() === 'src')
        dir?.click()
      })()`
    )
    await waitFor(
      win,
      `[...document.querySelectorAll('.ide-trow.is-file')].some((r) => r.textContent.includes(${quoted}))`
    )
  }
  await evalJs(
    win,
    `[...document.querySelectorAll('.ide-trow.is-file')]
      .find((r) => r.textContent.includes(${quoted}))?.click()`
  )
  return waitFor(
    win,
    `document.querySelector('.ide-status-rel')?.textContent.includes(${quoted})`
  )
}

app.whenReady().then(async () => {
  log('app ready')
  register()
  openIdeWindow(ws, { rel: 'src/app.ts' })
  await sleep(1500)
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.error('no window')
    return app.exit(1)
  }
  win.setContentSize(1440, 900)
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    log(`did-fail-load ${code} ${desc} ${url}`)
  )
  win.webContents.on('render-process-gone', (_e, details) =>
    log(`render-process-gone ${JSON.stringify(details)}`)
  )
  win.webContents.on('console-message', (_e, level, message, line, source) =>
    log(`console[${level}] ${source}:${line} ${message}`)
  )
  await sleep(700)
  log(`url=${win.webContents.getURL()}`)
  log(`dom=${(await evalJs(win, 'document.body.innerText.slice(0, 300)')).replace(/\n/g, ' | ')}`)

  const ready = await waitFor(win, `document.querySelector('.ide-monaco')?.__ccoderEditor`)
  check('editor mounted', ready)
  if (!ready) {
    log(
      `debug=${await evalJs(
        win,
        `JSON.stringify({
          app: !!document.querySelector('.ide-app'),
          tabs: document.querySelectorAll('.ide-tab').length,
          loading: document.querySelector('.ide-loading')?.textContent ?? '',
          notice: document.querySelector('.ide-notice')?.textContent ?? '',
          text: document.body.innerText.slice(0, 500)
        })`
      )}`
    )
    win.destroy()
    return app.exit(1)
  }

  // ── .editorconfig：缩进 + 换行 ──────────────────────────
  const configState = await evalJs(
    win,
    `(() => {
      const e = document.querySelector('.ide-monaco').__ccoderEditor
      const m = e.getModel()
      return {
        tabSize: m.getOptions().tabSize,
        insertSpaces: m.getOptions().insertSpaces,
        eol: e.getModel().getEOL(),
        status: document.querySelector('.ide-status')?.textContent ?? ''
      }
    })()`
  )
  check('.editorconfig indent_size=4', configState.tabSize === 4, JSON.stringify(configState))
  check('.editorconfig indent_style=space', configState.insertSpaces === true)
  // 磁盘是 LF，editorconfig 要求 CRLF → 缓冲区切换成 CRLF 并标记未保存
  // 缓冲区内部永远是 LF；由状态栏和保存时的 eol 决定落盘字节
  check('.editorconfig end_of_line=crlf applied', /CRLF/.test(configState.status), configState.status)

  // ── sticky scroll ───────────────────────────────────────
  const sticky = await evalJs(
    win,
    `(() => {
      const h = document.querySelector('.ide-monaco')
      const m = h.__ccoderMonaco
      const e = h.__ccoderEditor
      return e.getOption(m.editor.EditorOption.stickyScroll)
    })()`
  )
  check('sticky scroll enabled', sticky && sticky.enabled === true, JSON.stringify(sticky))

  // ── 符号面包屑 ──────────────────────────────────────────
  await evalJs(
    win,
    `(() => {
      const h = document.querySelector('.ide-monaco')
      const m = h.__ccoderMonaco
      h.__ccoderEditor.setPosition({ lineNumber: 3, column: 5 })
      h.__ccoderEditor.focus()
    })()`
  )
  const crumbs = await waitFor(win, `document.querySelectorAll('.ide-crumb-seg').length >= 2`, 4000)
  const crumbText = await evalJs(
    win,
    `[...document.querySelectorAll('.ide-crumb-seg')].map((x) => x.textContent.trim())`
  )
  check('symbol breadcrumbs show class/method', crumbs, JSON.stringify(crumbText))
  try {
    const shot = await win.webContents.capturePage()
    fs.writeFileSync(path.join(tmpRoot, 'ide-features.png'), shot.toPNG())
  } catch {}

  // ── 语言模式切换 ────────────────────────────────────────
  await evalJs(win, `document.querySelector('.ide-status-lang')?.click()`)
  await waitFor(win, `document.querySelector('.ide-lang-list button')`)
  const picked = await evalJs(
    win,
    `(() => {
      const buttons = [...document.querySelectorAll('.ide-lang-list button')]
      const target = buttons.find((b) => b.textContent.trim() === 'JSON')
      if (!target) return null
      target.click()
      return true
    })()`
  )
  await sleep(300)
  const langId = await evalJs(
    win,
    `document.querySelector('.ide-monaco').__ccoderEditor.getModel().getLanguageId()`
  )
  check('language mode switched to JSON', picked && langId === 'json', `lang=${langId}`)

  // 切回 TypeScript，避免影响后续保存
  await evalJs(win, `document.querySelector('.ide-status-lang')?.click()`)
  await waitFor(win, `document.querySelector('.ide-lang-list button')`)
  await evalJs(
    win,
    `[...document.querySelectorAll('.ide-lang-list button')].find((b) => b.textContent.trim() === 'TypeScript')?.click()`
  )
  await sleep(300)

  // ── 行尾切换 ────────────────────────────────────────────
  await evalJs(win, `document.querySelector('.ide-status-eol')?.click()`)
  await waitFor(win, `document.querySelector('.ide-eol')`)
  await evalJs(
    win,
    `[...document.querySelectorAll('.ide-eol button')].find((b) => b.textContent.includes('LF'))?.click()`
  )
  await sleep(250)
  const eolAfter = await evalJs(
    win,
    `document.querySelector('.ide-status-eol')?.textContent.trim()`
  )
  check('EOL switched to LF', eolAfter === 'LF', `status=${JSON.stringify(eolAfter)}`)

  // ── 按语言缩进 ──────────────────────────────────────────
  const pyOpen = await openTreeFile(win, 'script.py')
  check('python file opened from tree', pyOpen)
  await waitFor(win, `document.querySelector('.ide-monaco')?.__ccoderEditor`)
  const pyIndent = await evalJs(
    win,
    `(() => {
      const e = document.querySelector('.ide-monaco').__ccoderEditor
      const o = e.getModel().getOptions()
      return { tabSize: o.tabSize, insertSpaces: o.insertSpaces, lang: e.getModel().getLanguageId() }
    })()`
  )
  check(
    'per-language indent (python 8)',
    pyIndent.tabSize === 8 && pyIndent.insertSpaces === true,
    JSON.stringify(pyIndent)
  )

  // ── 保存时格式化 + editorconfig 写盘 ────────────────────
  const fmtOpen = await openTreeFile(win, 'format.ts')
  check('format-on-save file opened', fmtOpen)
  await waitFor(win, `document.querySelector('.ide-monaco')?.__ccoderEditor`)
  await evalJs(
    win,
    `document.querySelector('.ide-monaco').__ccoderEditor.setValue('export const  x=1   \\n')`
  )
  await sleep(300)
  await evalJs(
    win,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))`
  )
  await sleep(1200)
  const fmtRaw = fs.readFileSync(path.join(ws, 'src', 'format.ts'), 'utf8')
  check('format-on-save formatted the file', /const x = 1/.test(fmtRaw), JSON.stringify(fmtRaw))
  check('formatted save kept CRLF', fmtRaw.includes('\r\n'), JSON.stringify(fmtRaw))
  check('formatted save trimmed whitespace', !/[ \t]+\r?\n/.test(fmtRaw), JSON.stringify(fmtRaw))

  // ── 普通文件另存为（命令面板） ──────────────────────────
  await evalJs(
    win,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', ctrlKey: true, shiftKey: true, bubbles: true }))`
  )
  const paletteOpen = await waitFor(win, `document.querySelector('.ide-palette input')`, 3000)
  check('command palette opens', paletteOpen)
  if (paletteOpen) {
    await evalJs(
      win,
      `(() => {
        const input = document.querySelector('.ide-palette input')
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        set.call(input, '另存为')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()`
    )
    await sleep(200)
    await evalJs(
      win,
      `[...document.querySelectorAll('.ide-palette-row')]
        .find((r) => r.textContent.includes('另存为'))?.click()`
    )
    const asPrompt = await waitFor(win, `document.querySelector('.ide-dialog-input')`, 3000)
    check('Save As command opens prompt', asPrompt)
    if (asPrompt) {
      await evalJs(
        win,
        `(() => {
          const input = document.querySelector('.ide-dialog-input')
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
          set.call(input, 'src/format-copy.ts')
          input.dispatchEvent(new Event('input', { bubbles: true }))
          document.querySelector('.ide-dialog .is-primary')?.click()
        })()`
      )
      await sleep(900)
      check(
        'existing file Save As writes target',
        fs.existsSync(path.join(ws, 'src', 'format-copy.ts'))
      )
      const tabsText = await evalJs(
        win,
        `[...document.querySelectorAll('.ide-tab')].map((t) => t.textContent.trim()).join('|')`
      )
      check('existing file Save As switches tab', tabsText.includes('format-copy.ts'), tabsText)
    }
  }

  // ── 未命名缓冲区 + 另存为 ───────────────────────────────
  await evalJs(
    win,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }))`
  )
  const untitledOpen = await waitFor(
    win,
    `[...document.querySelectorAll('.ide-tab')].some((t) => /未命名|Untitled/.test(t.textContent))`,
    3000
  )
  check('Ctrl+N opens untitled buffer', untitledOpen)

  await evalJs(
    win,
    `(() => {
      const e = document.querySelector('.ide-monaco').__ccoderEditor
      e.setValue('export const two = 2   \\n')
    })()`
  )
  await sleep(300)
  await evalJs(
    win,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))`
  )
  const promptOpen = await waitFor(win, `document.querySelector('.ide-dialog-input')`, 3000)
  check('saving untitled opens Save As prompt', promptOpen)
  if (promptOpen) {
    await evalJs(
      win,
      `(() => {
        const input = document.querySelector('.ide-dialog-input')
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        set.call(input, 'src/untitled-save.ts')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        document.querySelector('.ide-dialog .is-primary')?.click()
      })()`
    )
    await sleep(900)
    const savedPath = path.join(ws, 'src', 'untitled-save.ts')
    const exists = fs.existsSync(savedPath)
    check('untitled buffer saved to disk', exists)
    if (exists) {
      const raw = fs.readFileSync(savedPath, 'utf8')
      check('editorconfig trimmed trailing whitespace', !/[ \t]+\r?\n/.test(raw), JSON.stringify(raw))
      check('editorconfig added final newline', raw.endsWith('\r\n') || raw.endsWith('\n'), JSON.stringify(raw))
      check('editorconfig wrote CRLF', raw.includes('\r\n'), JSON.stringify(raw))
    }
    const tabTitle = await evalJs(
      win,
      `[...document.querySelectorAll('.ide-tab')].map((t) => t.textContent.trim()).join('|')`
    )
    check('tab renamed after Save As', tabTitle.includes('untitled-save.ts'), tabTitle)
  }

  // ── 关闭页签释放 Monaco model ───────────────────────────
  await openTreeFile(win, 'script.py')
  await openTreeFile(win, 'format.ts')
  await waitFor(win, `document.querySelector('.ide-monaco')?.__ccoderMonaco`, 3000)
  await sleep(300)
  const modelsBeforeClose = await evalJs(
    win,
    `document.querySelector('.ide-monaco')?.__ccoderMonaco?.editor.getModels().length ?? -1`
  )
  await evalJs(win, `document.querySelector('.ide-tab.on .ide-tab-x')?.click()`)
  await sleep(300)
  const modelsAfterClose = await evalJs(
    win,
    `document.querySelector('.ide-monaco')?.__ccoderMonaco?.editor.getModels().length ?? -1`
  )
  check(
    'closing a tab disposes its Monaco model',
    modelsAfterClose === modelsBeforeClose - 1,
    `${modelsBeforeClose} -> ${modelsAfterClose}`
  )

  // ── 未保存草稿按文件落 localStorage ─────────────────────
  const editorHandleStored = await evalJs(
    win,
    `(() => {
      window.__verifyEditor = document.querySelector('.ide-monaco')?.__ccoderEditor
      return !!window.__verifyEditor
    })()`
  )
  // util.ts 此前没打开过，会走 loading 分支；编辑器实例必须原地保留
  await openTreeFile(win, 'util.ts')
  await waitFor(win, `document.querySelector('.ide-monaco')?.__ccoderEditor`, 3000)
  const sameEditor = await evalJs(
    win,
    `document.querySelector('.ide-monaco')?.__ccoderEditor === window.__verifyEditor`
  )
  check('editor instance survives opening a new file', editorHandleStored && sameEditor)

  const originalUtil = await evalJs(
    win,
    `document.querySelector('.ide-monaco').__ccoderEditor.getValue()`
  )
  await evalJs(
    win,
    `document.querySelector('.ide-monaco').__ccoderEditor.setValue(${JSON.stringify(
      `${originalUtil}// draft-check\n`
    )})`
  )
  await sleep(1000)
  const draftValues = await evalJs(
    win,
    `(() => {
      const out = []
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i)
        if (key && key.includes(':draft:') && key.endsWith('src/util.ts')) {
          out.push(localStorage.getItem(key))
        }
      }
      return out
    })()`
  )
  check(
    'draft saved per file',
    Array.isArray(draftValues) &&
      draftValues.some((v) => typeof v === 'string' && v.includes('draft-check')),
    JSON.stringify(draftValues)
  )

  await evalJs(
    win,
    `document.querySelector('.ide-monaco').__ccoderEditor.setValue(${JSON.stringify(originalUtil)})`
  )
  await sleep(1000)
  const draftLeft = await evalJs(
    win,
    `(() => {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i)
        if (key && key.includes(':draft:') && key.endsWith('src/util.ts')) return true
      }
      return false
    })()`
  )
  check('draft removed after returning to disk text', draftLeft === false)

  /* ── 资源管理器：隐藏 / 忽略 / 多选 / 复制粘贴 / 拖拽 ── */

  const rowExists = async (name) =>
    evalJs(
      win,
      `[...document.querySelectorAll('.ide-trow')].some((r) => r.textContent.trim() === ${JSON.stringify(name)})`
    )

  const clickRel = async (rel, mods = {}) => {
    await evalJs(
      win,
      `(() => {
        const row = document.querySelector('.ide-trow[data-rel="${rel}"]')
        if (!row) return false
        const init = {
          bubbles: true,
          cancelable: true,
          button: 0,
          ctrlKey: ${mods.ctrl ? 'true' : 'false'},
          shiftKey: ${mods.shift ? 'true' : 'false'}
        }
        row.dispatchEvent(new MouseEvent('mousedown', init))
        row.dispatchEvent(new MouseEvent('click', init))
        return true
      })()`
    )
  }

  const press = async (key, mods = {}) => {
    await evalJs(
      win,
      `window.dispatchEvent(new KeyboardEvent('keydown', {
        key: ${JSON.stringify(key)},
        bubbles: true,
        cancelable: true,
        ctrlKey: ${mods.ctrl ? 'true' : 'false'},
        shiftKey: ${mods.shift ? 'true' : 'false'}
      }))`
    )
  }

  const ensureDirOpen = async (rel) => {
    const state = await evalJs(
      win,
      `(() => {
        const row = document.querySelector('.ide-trow[data-rel="${rel}"]')
        if (!row) return 'missing'
        return row.nextElementSibling ? 'open' : 'closed'
      })()`
    )
    if (state === 'missing') return false
    if (state === 'closed') await clickRel(rel)
    return waitFor(
      win,
      `!!document.querySelector('.ide-trow[data-rel="${rel}"]')?.nextElementSibling`
    )
  }

  const fileOnDisk = (rel) => fs.existsSync(path.join(ws, rel))
  const waitFile = async (rel, exists, timeout = 5000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (fileOnDisk(rel) === exists) return true
      await sleep(100)
    }
    return false
  }

  // 隐藏点文件
  check('dotfile visible by default', await rowExists('.editorconfig'))
  await evalJs(win, `document.querySelector('[data-action="toggle-hidden"]')?.click()`)
  check(
    'hide dotfiles',
    await waitFor(
      win,
      `![...document.querySelectorAll('.ide-trow')].some((r) => r.textContent.trim() === '.editorconfig')`
    )
  )
  await evalJs(win, `document.querySelector('[data-action="toggle-hidden"]')?.click()`)
  check(
    'show dotfiles again',
    await waitFor(
      win,
      `[...document.querySelectorAll('.ide-trow')].some((r) => r.textContent.trim() === '.editorconfig')`
    )
  )

  // 忽略目录
  check('ignored dir hidden by default', !(await rowExists('node_modules')))
  await evalJs(win, `document.querySelector('[data-action="toggle-ignored"]')?.click()`)
  check(
    'show ignored dirs',
    await waitFor(
      win,
      `[...document.querySelectorAll('.ide-trow')].some((r) => r.textContent.trim() === 'node_modules')`
    )
  )
  await evalJs(win, `document.querySelector('[data-action="toggle-ignored"]')?.click()`)
  check(
    'hide ignored dirs again',
    await waitFor(
      win,
      `![...document.querySelectorAll('.ide-trow')].some((r) => r.textContent.trim() === 'node_modules')`
    )
  )

  // 自定义忽略规则
  check('src expanded', await ensureDirOpen('src'))
  check('custom-ignore target visible', await rowExists('ignored-file.ts'))
  await evalJs(win, `document.querySelector('[data-action="edit-ignore"]')?.click()`)
  const ignorePrompt = await waitFor(win, `document.querySelector('.ide-dialog-input')`, 3000)
  check('ignore rules prompt opens', ignorePrompt)
  if (ignorePrompt) {
    await evalJs(
      win,
      `(() => {
        const input = document.querySelector('.ide-dialog-input')
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        set.call(input, 'ignored-file.ts')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        document.querySelector('.ide-dialog .is-primary')?.click()
      })()`
    )
    check(
      'custom ignore hides file',
      await waitFor(
        win,
        `![...document.querySelectorAll('.ide-trow')].some((r) => r.textContent.trim() === 'ignored-file.ts')`
      )
    )
    // 换成一个不匹配的规则，恢复文件显示
    await evalJs(win, `document.querySelector('[data-action="edit-ignore"]')?.click()`)
    await waitFor(win, `document.querySelector('.ide-dialog-input')`, 3000)
    await evalJs(
      win,
      `(() => {
        const input = document.querySelector('.ide-dialog-input')
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        set.call(input, 'no-such-file.xyz')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        document.querySelector('.ide-dialog .is-primary')?.click()
      })()`
    )
    check(
      'clearing ignore restores file',
      await waitFor(
        win,
        `[...document.querySelectorAll('.ide-trow')].some((r) => r.textContent.trim() === 'ignored-file.ts')`
      )
    )
  }

  // 复制 / 粘贴
  check('dest folder visible', await ensureDirOpen('dest'))
  await clickRel('src/copy-src.ts')
  await sleep(150)
  await press('c', { ctrl: true })
  await sleep(150)
  await clickRel('dest')
  await sleep(150)
  await press('v', { ctrl: true })
  check('copy-paste creates file', await waitFile('dest/copy-src.ts', true))

  // 剪切 / 粘贴
  await clickRel('src/move-src.ts')
  await sleep(150)
  await press('x', { ctrl: true })
  await sleep(150)
  await clickRel('dest')
  await sleep(150)
  await press('v', { ctrl: true })
  check('cut-paste moves file', (await waitFile('dest/move-src.ts', true)) && (await waitFile('src/move-src.ts', false)))

  // 拖拽移动
  await clickRel('dest')
  await sleep(150)
  const dragged = await evalJs(
    win,
    `(() => {
      const src = [...document.querySelectorAll('.ide-trow')]
        .find((r) => r.dataset.rel === 'src/drag-src.ts')
      const dst = [...document.querySelectorAll('.ide-trow')]
        .find((r) => r.dataset.rel === 'dest')
      if (!src || !dst) return false
      const dt = new DataTransfer()
      const fire = (el, type) =>
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
      fire(src, 'dragstart')
      fire(dst, 'dragover')
      fire(dst, 'drop')
      fire(src, 'dragend')
      return true
    })()`
  )
  check('drag start/drop dispatched', dragged)
  check(
    'drag moves file',
    (await waitFile('dest/drag-src.ts', true)) && (await waitFile('src/drag-src.ts', false))
  )

  // 多选 + Delete
  await ensureDirOpen('src')
  await clickRel('src/del-a.ts')
  await sleep(100)
  await clickRel('src/del-b.ts', { ctrl: true })
  await sleep(150)
  const selectedCount = await evalJs(win, `document.querySelectorAll('.ide-trow.is-sel').length`)
  check('ctrl+click multi-select', selectedCount === 2, `selected=${selectedCount}`)
  await press('Delete')
  const deleteDialog = await waitFor(win, `document.querySelector('.ide-dialog .is-danger')`, 3000)
  check('multi delete asks for confirmation', deleteDialog)
  if (deleteDialog) {
    await evalJs(win, `document.querySelector('.ide-dialog .is-danger')?.click()`)
    check(
      'multi delete removes files',
      (await waitFile('src/del-a.ts', false)) && (await waitFile('src/del-b.ts', false))
    )
  }

  // 编码自动检测 + 手动改写 + 恢复自动
  await clickRel('src/gbk.txt')
  check(
    'GBK file opens',
    await waitFor(win, `document.querySelector('.ide-status-rel')?.textContent.includes('gbk.txt')`)
  )
  check(
    'status bar auto-detects GBK',
    await waitFor(
      win,
      `document.querySelector('.ide-status-encoding')?.textContent.trim() === 'GBK / GB18030'`
    )
  )
  const gbkValue = await evalJs(
    win,
    `document.querySelector('.ide-monaco').__ccoderEditor.getValue()`
  )
  check('GBK Chinese decoded correctly', gbkValue === GBK_TEXT, gbkValue.slice(0, 40))

  await evalJs(win, `document.querySelector('.ide-status-encoding')?.click()`)
  check('encoding menu opens', await waitFor(win, `document.querySelector('.ide-enc')`))
  check(
    'encoding menu marks auto mode',
    await waitFor(win, `document.querySelector('.ide-enc button[data-encoding="auto"] em')`)
  )
  await evalJs(
    win,
    `document.querySelector('.ide-enc button[data-encoding-section="reopen"][data-encoding="utf8"]')?.click()`
  )
  check(
    'manual reopen switches to UTF-8',
    await waitFor(
      win,
      `document.querySelector('.ide-status-encoding')?.textContent.trim() === 'UTF-8'`
    )
  )
  const misdecoded = await evalJs(
    win,
    `document.querySelector('.ide-monaco').__ccoderEditor.getValue()`
  )
  check('manual reopen actually re-decodes', misdecoded !== GBK_TEXT)

  await evalJs(win, `document.querySelector('.ide-status-encoding')?.click()`)
  check('encoding menu opens again', await waitFor(win, `document.querySelector('.ide-enc')`))
  await evalJs(win, `document.querySelector('.ide-enc button[data-encoding="auto"]')?.click()`)
  check(
    'returning to auto-detect restores GBK',
    await waitFor(
      win,
      `document.querySelector('.ide-status-encoding')?.textContent.trim() === 'GBK / GB18030'`
    )
  )
  const restored = await evalJs(
    win,
    `document.querySelector('.ide-monaco').__ccoderEditor.getValue()`
  )
  check('auto-detect restores decoded text', restored === GBK_TEXT, restored.slice(0, 40))

  // 搜索历史 / 结果折叠 / 替换预览 / 撤销
  const setInput = async (selector, value) =>
    evalJs(
      win,
      `(() => {
        const input = document.querySelector(${JSON.stringify(selector)})
        if (!input) return false
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        set.call(input, ${JSON.stringify(value)})
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`
    )

  await evalJs(win, `document.querySelectorAll('.ide-act')[1]?.click()`)
  check('search view opens', await waitFor(win, `document.querySelector('.ide-searchbox input')`))
  await setInput('.ide-searchbox input', 'needle')
  check(
    'search results grouped by file',
    await waitFor(win, `document.querySelectorAll('.ide-sfile').length >= 2`)
  )
  const searchSummary = await evalJs(
    win,
    `document.querySelector('.ide-searchsum-text')?.textContent ?? ''`
  )
  check('search summary counts two files', searchSummary.includes('2'), searchSummary)

  await evalJs(win, `document.querySelector('.ide-sfile .ide-sfhead')?.click()`)
  check(
    'file group collapses',
    await waitFor(
      win,
      `document.querySelector('.ide-sfile .ide-sfhead')?.getAttribute('aria-expanded') === 'false' &&
       document.querySelectorAll('.ide-sfile')[0].querySelectorAll('.ide-smatch').length === 0`
    )
  )
  await evalJs(win, `document.querySelector('.ide-scollapse-all')?.click()`)
  check(
    'collapse all results',
    await waitFor(
      win,
      `[...document.querySelectorAll('.ide-sfhead')].every((h) => h.getAttribute('aria-expanded') === 'false')`
    )
  )
  await evalJs(win, `document.querySelector('.ide-scollapse-all')?.click()`)
  check(
    'expand all results',
    await waitFor(
      win,
      `[...document.querySelectorAll('.ide-sfile')].every((f) => f.querySelectorAll('.ide-smatch').length > 0)`
    )
  )

  await evalJs(win, `document.querySelector('.ide-shistory-toggle')?.click()`)
  check('search history opens', await waitFor(win, `document.querySelector('.ide-shistory')`))
  check(
    'search history records query',
    await waitFor(
      win,
      `document.querySelector('.ide-shistory-main')?.textContent.includes('needle')`
    )
  )
  await evalJs(win, `document.querySelector('.ide-shistory-toggle')?.click()`)
  await setInput('.ide-searchbox input', 'zzz-no-match')
  await sleep(500)
  await evalJs(win, `document.querySelector('.ide-shistory-toggle')?.click()`)
  await waitFor(win, `document.querySelector('.ide-shistory')`)
  await evalJs(
    win,
    `[...document.querySelectorAll('.ide-shistory-main')]
      .find((b) => b.textContent.includes('needle'))?.click()`
  )
  const restoredQuery = await evalJs(
    win,
    `document.querySelector('.ide-searchbox input')?.value`
  )
  check('search history restores query', restoredQuery === 'needle', restoredQuery)
  await waitFor(win, `document.querySelectorAll('.ide-sfile').length >= 2`)

  await evalJs(win, `document.querySelector('.ide-sreplace-toggle')?.click()`)
  check(
    'replace row opens',
    await waitFor(win, `document.querySelector('.ide-searchbox--replace input')`)
  )
  await setInput('.ide-searchbox--replace input', 'pin')
  await evalJs(win, `document.querySelector('.ide-replaceall')?.click()`)
  check('replace preview opens', await waitFor(win, `document.querySelector('.ide-preview')`))
  const previewText = await evalJs(
    win,
    `document.querySelector('.ide-preview')?.textContent ?? ''`
  )
  check(
    'preview shows files, before and after',
    previewText.includes('search/a.txt') &&
      previewText.includes('needle') &&
      previewText.includes('pin'),
    previewText.slice(0, 160)
  )
  check(
    'preview does not write disk',
    fs.readFileSync(path.join(ws, 'search/a.txt'), 'utf8').includes('needle')
  )
  await evalJs(win, `document.querySelector('.ide-preview-cancel')?.click()`)
  check('preview cancels', await waitFor(win, `!document.querySelector('.ide-preview')`))

  await evalJs(win, `document.querySelector('.ide-replaceall')?.click()`)
  await waitFor(win, `document.querySelector('.ide-preview')`)
  await evalJs(win, `document.querySelector('.ide-preview-apply')?.click()`)
  await sleep(1000)
  check(
    'replace writes disk',
    fs.readFileSync(path.join(ws, 'search/a.txt'), 'utf8').includes('pin')
  )
  check('undo button appears', await waitFor(win, `document.querySelector('.ide-sundo')`))
  await evalJs(win, `document.querySelector('.ide-sundo')?.click()`)
  check(
    'undo asks for confirmation',
    await waitFor(win, `document.querySelector('.ide-dialog .is-danger')`)
  )
  await evalJs(win, `document.querySelector('.ide-dialog .is-danger')?.click()`)
  await sleep(1000)
  check(
    'undo restores disk',
    fs.readFileSync(path.join(ws, 'search/a.txt'), 'utf8').includes('needle')
  )

  // 外观设置：设置页渲染新控件，改动进入 settings:save
  await evalJs(
    win,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))`
  )
  check('settings dialog opens', await waitFor(win, `document.querySelector('.ide-settings')`))
  await evalJs(win, `document.getElementById('ide-settings-tab-editor')?.click()`)
  check(
    'editor settings tab opens',
    await waitFor(win, `document.querySelector('.ide-es')`)
  )
  const settingsText = await evalJs(
    win,
    `document.querySelector('.ide-settings__body')?.textContent ?? ''`
  )
  check(
    'appearance settings render',
    ['行高', '字体连字', '光标形状', '列标尺', '终端字号'].every((s) =>
      settingsText.includes(s)
    ),
    settingsText.slice(0, 200)
  )

  const selectByLabel = (label, value) =>
    evalJs(
      win,
      `(() => {
        const field = [...document.querySelectorAll('.ide-es__field')]
          .find((f) => f.querySelector('.ide-es__label')?.textContent === ${JSON.stringify(label)})
        const sel = field?.querySelector('select')
        if (!sel) return false
        const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
        set.call(sel, ${JSON.stringify(value)})
        sel.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`
    )
  const commitInputByLabel = async (label, value) => {
    const set = await evalJs(
      win,
      `(() => {
        const field = [...document.querySelectorAll('.ide-es__field')]
          .find((f) => f.querySelector('.ide-es__label')?.textContent === ${JSON.stringify(label)})
        const input = field?.querySelector('input')
        if (!input) return false
        input.focus()
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        set.call(input, ${JSON.stringify(value)})
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`
    )
    if (!set) return false
    // 等 React 把受控值刷一次，再模拟失焦（focusout 才是 React 的 onBlur）
    await sleep(80)
    return evalJs(
      win,
      `(() => {
        const field = [...document.querySelectorAll('.ide-es__field')]
          .find((f) => f.querySelector('.ide-es__label')?.textContent === ${JSON.stringify(label)})
        const input = field?.querySelector('input')
        if (!input) return false
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
        return true
      })()`
    )
  }

  await selectByLabel('行号', 'relative')
  await sleep(600)
  check(
    'line number setting saves',
    lastSavedSettings?.editor?.lineNumbers === 'relative',
    JSON.stringify(lastSavedSettings?.editor?.lineNumbers)
  )

  await commitInputByLabel('列标尺', '100')
  await sleep(600)
  check(
    'column ruler saves',
    lastSavedSettings?.editor?.rulers === 100,
    JSON.stringify(lastSavedSettings?.editor?.rulers)
  )
  const appliedRulers = await evalJs(
    win,
    `(() => {
      const host = document.querySelector('.ide-monaco')
      const ed = host?.__ccoderEditor
      const m = host?.__ccoderMonaco
      if (!ed || !m) return null
      return ed.getOption(m.editor.EditorOption.rulers)
    })()`
  )
  check(
    'column ruler applied to editor',
    Array.isArray(appliedRulers) && appliedRulers[0]?.column === 100,
    JSON.stringify(appliedRulers)
  )

  await commitInputByLabel('编辑器字体', 'Fira Code')
  await sleep(600)
  check(
    'font family keeps spaces',
    lastSavedSettings?.editor?.fontFamily === 'Fira Code',
    JSON.stringify(lastSavedSettings?.editor?.fontFamily)
  )

  await selectByLabel('终端字号', '14')
  await sleep(600)
  check(
    'terminal font size saves',
    lastSavedSettings?.editor?.terminalFontSize === 14,
    JSON.stringify(lastSavedSettings?.editor?.terminalFontSize)
  )

  win.destroy()
  try {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {}
  log(failed === 0 ? 'verify-ide-editor-features: ok' : `FAILED: ${failed}`)
  app.exit(failed === 0 ? 0 : 1)
}).catch((err) => {
  log(`FATAL ${err && err.stack ? err.stack : err}`)
  app.exit(2)
})
