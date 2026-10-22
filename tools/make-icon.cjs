/*
 * 开发辅助：把品牌 SVG 渲染成 build/icon.png 和 build/icon.ico。
 * 用法：npx electron tools/make-icon.cjs
 *
 * Windows 的 .ico 里直接嵌 PNG 数据（Vista 起支持），
 * 多尺寸一次生成，任务栏/资源管理器/Alt+Tab 各取所需。
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// 与 src/renderer/src/components/Icons.tsx 的 IconBrand 保持一致
const BRAND_PATH =
  'M2 9.2c0-3.2 2.6-5.8 5.8-5.8 1.2 0 2.3.4 3.2 1 .5-.4 1.2-.6 1.9-.5l1.6.2-.9 1.5c.4.8.6 1.7.6 2.6 0 3.2-2.6 5.8-5.8 5.8-1.6 0-3-.6-4.1-1.7-.3-.3-.6-.6-.8-1l-.6.2.3-1.2A5.7 5.7 0 0 1 2 9.2z'

const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256]
const OUT_DIR = path.join(__dirname, '..', 'build')

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; width: 512px; height: 512px; background: transparent; overflow: hidden; }
  svg { display: block; }
</style>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 16 16">
  <rect width="16" height="16" rx="3.5" fill="#191919"/>
  <path d="${BRAND_PATH}" fill="#f2f2f2"/>
  <circle cx="6.4" cy="8.2" r="0.75" fill="#191919"/>
</svg>`

/** 组装 ICO：6 字节 ICONDIR + 每张图 16 字节目录项 + PNG 数据 */
function buildIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)

  const dir = Buffer.alloc(images.length * 16)
  let offset = 6 + dir.length
  images.forEach(({ size, png }, i) => {
    const p = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, p) // width（0 表示 256）
    dir.writeUInt8(size >= 256 ? 0 : size, p + 1) // height
    dir.writeUInt8(0, p + 2) // palette
    dir.writeUInt8(0, p + 3) // reserved
    dir.writeUInt16LE(1, p + 4) // color planes
    dir.writeUInt16LE(32, p + 6) // bits per pixel
    dir.writeUInt32LE(png.length, p + 8)
    dir.writeUInt32LE(offset, p + 12)
    offset += png.length
  })

  return Buffer.concat([header, dir, ...images.map((i) => i.png)])
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true }
  })

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  // 等一帧，确保 SVG 已经画上去
  await new Promise((r) => setTimeout(r, 400))

  const shot = await win.webContents.capturePage()
  const base = shot.resize({ width: 512, height: 512, quality: 'best' })

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), base.toPNG())

  const images = ICON_SIZES.map((size) => ({
    size,
    png: base.resize({ width: size, height: size, quality: 'best' }).toPNG()
  }))
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), buildIco(images))

  // 校验一下透明角 —— 不透明的话 ICO 在 Windows 上会是一块黑方块
  const bmp = base.toBitmap()
  const stride = base.getSize().width * 4
  const alphaAt = (x, y) => bmp[y * stride + x * 4 + 3]
  console.log(
    `icon.ico written: ${images.length} sizes, corner alpha=${alphaAt(0, 0)} center alpha=${alphaAt(256, 256)}`
  )
  app.quit()
})
