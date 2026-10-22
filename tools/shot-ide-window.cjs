/*
 * 开发辅助：把 docs/mockups/ide-window.html 的两个桌面场景截成 1680×1050。
 * 用法：node node_modules/electron/cli.js tools/shot-ide-window.cjs
 * 不参与打包。
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('allow-file-access-from-files')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BASE = 'file:///' + path.join(__dirname, '..', 'docs', 'mockups', 'ide-window.html').replace(/\\/g, '/')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1680,
    height: 1050,
    useContentSize: true,
    show: true,
    frame: false,
    backgroundColor: '#08080b',
    webPreferences: { sandbox: false }
  })
  win.setContentSize(1680, 1050)

  const jobs = [
    ['1', 'ide-window.png'],
    ['2', 'ide-window-max.png']
  ]
  for (const [v, name] of jobs) {
    await win.loadURL(`${BASE}?v=${v}`)
    await sleep(900)
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1680, height: 1050 })
    const out = path.join(__dirname, '..', 'docs', 'mockups', name)
    fs.writeFileSync(out, img.toPNG())
    console.log('wrote', out, img.getSize().width + 'x' + img.getSize().height)
  }
  app.quit()
})
