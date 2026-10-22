/*
 * 回归：工作区**之外**的文件也要能查看。
 *
 * 背景：工具卡里的路径可能指向临时目录（例如粘贴的截图 chat-sent.png）。
 * 以前 openFileInIde 只认工作区内的相对路径，这种文件直接报
 * 「这个文件不在当前工作区内，IDE 无法查看」——用户点开什么都看不到。
 * 现在改为以文件所在目录为根开一个只读 IDE 窗口，图片走 IDE 自带的查看器。
 *
 * 用法（先 npx electron-vite build）：
 *   esbuild src/main/ide-window.ts --bundle --platform=node --format=cjs \
 *     --external:electron --outfile=tools/_ide-window.cjs
 *   node node_modules/electron/cli.js tools/verify-open-external.cjs
 * 不参与打包。
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '..')
// ide-window 用 __dirname/../renderer 找页面；打包产物在 tools/ 下会指错，
// 所以这里显式把渲染入口指到 out/renderer。
process.env.ELECTRON_RENDERER_URL = pathToFileURL(
  path.join(ROOT, 'out', 'renderer', 'index.html')
).href

const { openFileInIde } = require('./_ide-window.cjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const norm = (s) => s.replace(/\\/g, '/')

// 1×1 透明 PNG —— 不依赖 docs/ 里那些随时可能被清掉的截图
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-ext-'))
const ws = path.join(base, 'ws')
const shots = path.join(base, 'shots')
fs.mkdirSync(ws, { recursive: true })
fs.mkdirSync(shots, { recursive: true })
fs.writeFileSync(path.join(shots, 'chat-sent.png'), PNG_1PX)

let failed = 0
function check(label, cond, detail) {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : JSON.stringify(detail))
  }
}

app.whenReady().then(async () => {
  console.log('\n[1] 工作区外的图片')
  const opened = openFileInIde(ws, path.join(shots, 'chat-sent.png'))
  check('不再拒绝', opened.ok === true, opened)
  await sleep(800)

  const wins = BrowserWindow.getAllWindows()
  check('开了一个 IDE 窗口', wins.length === 1, wins.length)
  const url = wins[0] ? decodeURIComponent(wins[0].webContents.getURL()) : ''
  check('根目录 = 文件所在目录', norm(url).includes(norm(shots)), url)
  check('目标文件 = chat-sent.png', url.includes('file=chat-sent.png'), url)

  console.log('\n[2] 不存在的文件')
  const missing = openFileInIde(ws, path.join(shots, 'nope.png'))
  check('明确报「文件不存在」', missing.ok === false && /文件不存在/.test(missing.message), missing)

  console.log('\n[3] 工作区内的文件不受影响')
  fs.writeFileSync(path.join(ws, 'a.txt'), 'hi')
  const inside = openFileInIde(ws, path.join(ws, 'a.txt'))
  check('照旧能打开', inside.ok === true, inside)
  await sleep(800)
  const urls = BrowserWindow.getAllWindows().map((w) =>
    norm(decodeURIComponent(w.webContents.getURL()))
  )
  check(
    '  仍是工作区窗口 + 相对路径',
    urls.some((u) => u.includes('a.txt') && u.includes(norm(ws))),
    urls
  )

  fs.rmSync(base, { recursive: true, force: true })
  console.log(`\n${failed === 0 ? '全部通过 ✓' : `${failed} 项失败 ✗`}`)
  app.exit(failed === 0 ? 0 : 1)
})
