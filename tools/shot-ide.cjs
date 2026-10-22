/*
 * 开发辅助：把 docs/mockups/ide.html 的三个方案分别截成 1360×800 的图。
 * 用法：node node_modules/electron/cli.js tools/shot-ide.cjs
 * 不参与打包。
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('allow-file-access-from-files')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1360,
    height: 800,
    useContentSize: true,
    show: true,
    frame: false,
    backgroundColor: '#0d0d0f',
    webPreferences: { sandbox: false }
  })
  win.setContentSize(1360, 800)
  for (const v of [1, 2, 3]) {
    const url = 'file:///' + path.join(__dirname, '..', 'docs', 'mockups', 'ide.html').replace(/\\/g, '/') + '?v=' + v
    await win.loadURL(url)
    await sleep(900)
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1360, height: 800 })
    const out = path.join(__dirname, '..', 'docs', 'mockups', `ide-v${v}.png`)
    fs.writeFileSync(out, img.toPNG())
    const size = img.getSize()
    console.log(`wrote ${out} ${size.width}x${size.height}`)
  }
  app.quit()
})
