/*
 * 打包产物冒烟：直接从 release/win-unpacked/resources/app.asar 里加载
 * renderer + preload，确认 Monaco 和它的 worker 在 asar / file:// 下能工作。
 *
 *   node node_modules/electron/cli.js tools/verify-packaged-ide.cjs
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '..')
const APP = path.join(ROOT, 'release', 'win-unpacked', 'resources', 'app.asar', 'out')
const preload = path.join(APP, 'preload', 'index.js')
const renderer = path.join(APP, 'renderer', 'index.html')
const ide = require('./_ide-fs.cjs')

let failed = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok   ${label}`)
  else {
    failed++
    console.error(`  FAIL ${label}${detail === undefined ? '' : `\n       ${JSON.stringify(detail)}`}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-packaged-'))
const ws = path.join(base, 'ws')
fs.mkdirSync(ws)
fs.writeFileSync(path.join(ws, 'a.ts'), 'export const a = 1\n')

app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  ipcMain.handle('settings:get', () => ({
    theme: 'dark',
    uiZoom: 1,
    chatFontSize: 14,
    uiFont: '',
    monoFont: ''
  }))
  ipcMain.handle('win:is-maximized', () => false)
  ipcMain.handle('vcs:detect', () => ({ ok: true, data: { repo: null } }))
  ipcMain.handle('ide:list-dir', (_e, cwd, rel) => ide.listDir(cwd, rel))
  ipcMain.handle('ide:read-file', (_e, cwd, rel) => ide.readTextFile(cwd, rel))
  ipcMain.handle('ide:save-file', (_e, req) => ide.saveTextFile(req))
  ipcMain.handle('ide:create-entry', (_e, req) => ide.createEntry(req))
  ipcMain.handle('ide:rename-entry', (_e, req) => ide.renameEntry(req))
  ipcMain.handle('ide:delete-entry', (_e, req) => ide.deleteEntry(req))
  ipcMain.on('ide:dirty', () => {})

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    frame: false,
    webPreferences: {
      preload,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  await win.loadFile(renderer, { query: { view: 'ide', cwd: ws, file: 'a.ts' } })
  await sleep(1800)
  const state = await win.webContents.executeJavaScript(`(() => {
    const host = document.querySelector('.ide-monaco')
    const editor = host && host.__ccoderEditor
    const monaco = host && host.__ccoderMonaco
    return {
      editor: !!editor,
      value: editor ? editor.getModel().getValue() : '',
      lang: editor ? editor.getModel().getLanguageId() : '',
      workers: monaco ? monaco.languages.getLanguages().map((l) => l.id).filter((id) => id === 'typescript') : []
    }
  })()`)
  check('asar renderer 打开 Monaco', state.editor === true, state)
  check('asar 内文件内容正确', state.value === 'export const a = 1\n', state)
  check('asar 内语言注册正确', state.lang === 'typescript', state)

  const worker = await win.webContents.executeJavaScript(`
    document.querySelector('.ide-monaco').__ccoderMonaco.languages.typescript
      .getTypeScriptWorker()
      .then((w) => typeof w === 'function')
      .catch((e) => 'ERR ' + e.message)
  `)
  check('asar 内 TS worker 能启动', worker === true, worker)

  win.destroy()
  try {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {}
  console.log(`\n${failed === 0 ? '全部通过 ✓' : `${failed} 项失败 ✗`}`)
  app.exit(failed === 0 ? 0 : 1)
})
