/*
 * 把 docs/mockups 下的静态稿渲染成 PNG。
 * 用法：electron tools/shot-mock.cjs <html> <输出.png> [variant]
 * 窗口按文档实际尺寸自适应，所以四联图那种超宽页也能整张截下来。
 * 不参与打包，随时可删。
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const html = path.resolve(process.argv[2])
const out = path.resolve(process.argv[3])
const variant = process.argv[4] || 'a'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900,
    height: 900,
    show: false,
    backgroundColor: '#191919',
    webPreferences: { offscreen: false }
  })

  await win.loadFile(html, { query: { v: variant } })
  await sleep(500)

  // 先把窗口缩到最小再量：scrollWidth 至少等于视口宽，窗口还大的话量出来的是视口。
  // 但顶栏那种撑满视口的 sticky 元素在 80px 下会折成一列、把页面撑得老高，
  // 所以宽度可以用 CCODER_MOCK_W 指定一个正常值。
  win.setContentSize(Number(process.env.CCODER_MOCK_W) || 80, 80)
  await sleep(200)
  const size = await win.webContents.executeJavaScript(
    `({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })`
  )
  win.setContentSize(Math.ceil(size.w), Math.ceil(size.h))
  await sleep(400)

  const img = await win.webContents.capturePage()
  fs.writeFileSync(out, img.toPNG())
  console.log(`wrote ${out}  (${img.getSize().width}x${img.getSize().height})`)
  app.quit()
})
