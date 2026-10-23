/*
 * 开发辅助：生成 README 英文版用的 IDE 截图（英文界面 + 演示工作区）。
 * 用法：ELECTRON_DISABLE_SANDBOX=1 electron tools/shot-readme-ide.cjs
 * 输出：docs/screenshots/ide.en.png
 * 不参与打包。
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
// %TEMP% 在这个环境里不可写（沙箱返回 EPERM），演示工作区放到项目内
const base = path.join(ROOT, '.buildtmp', 'shot-ide', String(Date.now()))
const ws = path.join(base, 'ccoder-demo')
fs.mkdirSync(ws, { recursive: true })

function put(rel, text) {
  const full = path.join(ws, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, text)
}

put(
  'src/servers.ts',
  `import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { formatDuration } from './utils'

const ROOT = join(process.cwd(), 'public')

interface Route {
  method: 'GET' | 'POST'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): Promise<void>
}

export const routes: Route[] = [
  {
    method: 'GET',
    path: '/health',
    async handler(_req, res) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          uptime: formatDuration(process.uptime() * 1000),
          rss: process.memoryUsage().rss
        })
      )
    }
  },
  {
    method: 'GET',
    path: '/',
    async handler(_req, res) {
      const html = await readFile(join(ROOT, 'index.html'), 'utf8')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    }
  }
]
`
)
put(
  'src/utils.ts',
  `/** 毫秒 → 1h 2m 3s，用于 /health 的 uptime 字段 */
export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? \`\${h}h \${m}m \${s}s\` : m > 0 ? \`\${m}m \${s}s\` : \`\${s}s\`
}
`
)
put('src/index.ts', `import { routes } from './servers'\n\nexport { routes }\n`)
put('package.json', '{\n  "name": "ccoder-demo",\n  "private": true\n}\n')
put('README.md', '# ccoder-demo\n\nA tiny demo service for the CCoder screenshots.\n')
put('public/index.html', '<!doctype html>\n<h1>ccoder-demo</h1>\n')
put('styles/app.css', ':root {\n  color-scheme: dark;\n}\n')

let failed = 0
function allow(e, cwd) {
  return typeof cwd === 'string' && authorizeVcsSender(e.sender.id, cwd)
}

function register() {
  ipcMain.handle('locale:info', () => ({ systemLocale: 'en-US', resolved: 'en' }))
  ipcMain.handle('settings:get', () => ({
    language: 'en',
    theme: 'contrast',
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
  // 渲染层要的是 { ok, data } / { ok, message } 的结果对象，不是裸数据
  ipcMain.handle('ide:read-file', async (e, cwd, rel) => {
    if (!allow(e, cwd)) return { ok: false, code: 'forbidden', message: 'forbidden' }
    try {
      return { ok: true, data: await ide.readTextFile(cwd, rel) }
    } catch (err) {
      return { ok: false, code: 'io', message: err instanceof Error ? err.message : String(err) }
    }
  })
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

app.whenReady().then(async () => {
  register()
  openIdeWindow(ws)
  await sleep(1400)
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return app.exit(1)
  win.setContentSize(1280, 800)
  await sleep(400)

  // 等文件树真正渲染完再点，否则点击会落空
  async function waitFor(expr, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await win.webContents.executeJavaScript(expr)) return true
      await sleep(200)
    }
    return false
  }

  console.log('tree ready:', await waitFor(`!!document.querySelector('.ide-trow.is-dir')`))
  await win.webContents.executeJavaScript(`(() => {
    const dir = [...document.querySelectorAll('.ide-trow.is-dir')]
      .find((r) => r.getAttribute('title') === 'src' || r.textContent.trim().endsWith('src'))
    dir?.click()
  })()`)
  await sleep(800)
  console.log('file ready:', await waitFor(`!!document.querySelector('.ide-trow.is-file')`))
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.ide-trow.is-file')]
      .find((r) => r.getAttribute('title') === 'src/servers.ts' || r.textContent.includes('servers.ts'))
    row?.click()
    return !!row
  })()`)
  console.log('clicked file:', clicked)
  await sleep(1200)
  await win.webContents.executeJavaScript(`(() => {
    const h = document.querySelector('.ide-monaco')
    const e = h && h.__ccoderEditor
    const m = h && h.__ccoderMonaco
    if (!e || !m) return
    e.setSelection(new m.Selection(15, 1, 15, 20))
    e.focus()
  })()`)
  await sleep(500)

  const img = await win.webContents.capturePage()
  const out = path.join(ROOT, 'docs', 'screenshots', 'ide.en.png')
  fs.writeFileSync(out, img.toPNG())
  console.log('wrote', out, img.getSize().width + 'x' + img.getSize().height)

  win.destroy()
  try {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {}
  app.exit(failed === 0 ? 0 : 1)
})
