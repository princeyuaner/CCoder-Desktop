/*
 * 截图：可编辑 IDE、新建文件输入条、重命名弹层。
 * 先 npx electron-vite build，再：
 *   node node_modules/electron/cli.js tools/shot-ide-edit.cjs
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
app.commandLine.appendSwitch('force-device-scale-factor', '1')

const ide = require('./_ide-fs.cjs')
const { openIdeWindow, authorizeVcsSender } = require('./_ide-window.cjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-edit-shot-'))
const ws = path.join(base, 'acme-console')

function put(rel, text) {
  const full = path.join(ws, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, text)
}

put(
  'src/main.ts',
  `import { createServer } from './server'
import { loadConfig } from './config'

async function boot(): Promise<void> {
  const config = await loadConfig()
  const server = createServer(config)

  server.on('request', (req) => {
    console.log('[acme]', req.method, req.url)
  })

  await server.listen(config.port)
  console.log(\`listening on :\${config.port}\`)
}

boot().catch((err) => {
  console.error('boot failed', err)
  process.exit(1)
})
`
)
put('src/server.ts', `export function createServer(config: unknown) {\n  return { config }\n}\n`)
put('src/config.ts', `export async function loadConfig() {\n  return { port: 3000 }\n}\n`)
put('README.md', '# Acme Console\n\nA tiny demo workspace for the CCoder IDE.\n')
put('package.json', '{\n  "name": "acme-console",\n  "private": true\n}\n')

let failed = 0
function allow(e, cwd) {
  return typeof cwd === 'string' && authorizeVcsSender(e.sender.id, cwd)
}

const THEME = process.env.IDE_THEME || 'contrast'
const SUFFIX = process.env.IDE_THEME ? `-${THEME}` : ''

function register() {
  ipcMain.handle('settings:get', () => ({
    theme: THEME,
    uiZoom: 1,
    chatFontSize: 14,
    uiFont: '',
    monoFont: ''
  }))
  ipcMain.handle('win:is-maximized', () => false)
  ipcMain.handle('vcs:detect', (_e, cwd) =>
    allow(_e, cwd) ? { ok: true, data: { repo: null } } : { ok: false, error: { message: 'forbidden' } }
  )
  ipcMain.handle('ide:list-dir', (e, cwd, rel) =>
    allow(e, cwd) ? ide.listDir(cwd, rel) : []
  )
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
  ipcMain.on('ide:dirty', () => {})
  ipcMain.on('ide:confirm-close', () => {})
}

async function shot(win, name) {
  const img = await win.webContents.capturePage()
  const out = path.join(ROOT, 'docs', 'mockups', name)
  fs.writeFileSync(out, img.toPNG())
  console.log('wrote', out, img.getSize().width + 'x' + img.getSize().height)
}

app.whenReady().then(async () => {
  register()
  openIdeWindow(ws)
  await sleep(1400)
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return app.exit(1)
  win.setContentSize(1440, 900)
  await sleep(400)

  await win.webContents.executeJavaScript(`(() => {
    const dir = [...document.querySelectorAll('.ide-trow.is-dir')]
      .find((r) => r.textContent.trim() === 'src')
    dir?.click()
  })()`)
  await sleep(600)
  await win.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.ide-trow.is-file')]
      .find((r) => r.textContent.includes('main.ts'))
    row?.click()
  })()`)
  await sleep(900)
  await win.webContents.executeJavaScript(`(() => {
    const h = document.querySelector('.ide-monaco')
    const e = h && h.__ccoderEditor
    const m = h && h.__ccoderMonaco
    if (!e || !m) return
    e.setSelection(new m.Selection(4, 1, 6, 22))
    e.focus()
  })()`)
  await sleep(400)
  await shot(win, `impl-ide-edit${SUFFIX}.png`)

  await win.webContents.executeJavaScript(
    `document.querySelector('.ide-side-actions button[title="新建文件"]').click()`
  )
  await sleep(300)
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.ide-createpath input')
    if (!input) return
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(input, 'src/router.ts')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await sleep(400)
  await shot(win, `impl-ide-new-file${SUFFIX}.png`)

  await win.webContents.executeJavaScript(`
    document.querySelector('.ide-createbar button[type="button"]')?.click()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
  `)
  await sleep(400)
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.ide-dialog-input')
    if (!input) return
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(input, 'src/entry.ts')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await sleep(400)
  await shot(win, `impl-ide-rename${SUFFIX}.png`)

  win.destroy()
  try {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {}
  app.exit(failed === 0 ? 0 : 1)
})
