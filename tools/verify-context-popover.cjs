/*
 * 验证「点击上下文胶囊 → 详情浮层」。
 *
 * 不接真实 CLI：stub 掉 main 的 IPC，直接送带 contextUsage 的 turn_end。
 * 用法（先 npx electron-vite build）：
 *   node node_modules/electron/cli.js tools/verify-context-popover.cjs
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const SID = 'live-ctx'
const CWD = 'C:/Users/CY/Desktop/CCoder-Desktop'
const ch = (id, name, baseUrl, model) => ({
  id, name, kind: 'anthropic', baseUrl, model, smallFastModel: '',
  authMode: 'token', authToken: 'sk-xxxxxxxxxxxxxxxxxxxx', extraEnv: []
})
const DEMO = {
  permissionMode: 'standard', defaultCwd: CWD, openedCwds: [CWD], theme: 'dark', uiZoom: 1,
  chatFontSize: 14,
  uiFont: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
  monoFont: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
  showTimestamps: false, thinkingOpen: false, toolDetail: 'full', sendKey: 'enter',
  clis: {
    claude: {
      enabled: true, activeChannelId: 'demo-1',
      channels: [ch('demo-1', 'DeepSeek', 'https://api.deepseek.com/anthropic', 'deepseek-v4.1-flash[1m]')],
      effort: 'medium'
    },
    codex: { enabled: false, activeChannelId: null, channels: [], effort: 'medium' }
  }
}

ipcMain.handle('win:is-maximized', () => false)
ipcMain.handle('settings:get', () => DEMO)
ipcMain.handle('settings:save', (_e, s) => s)
ipcMain.handle('channel:test', () => ({ ok: true, message: 'pong', latencyMs: 1 }))
ipcMain.handle('sessions:list', () => [])
ipcMain.handle('sessions:transcript', () => [])
ipcMain.handle('sessions:delete', () => ({ ok: true }))
ipcMain.handle('sessions:pick-dir', () => null)
ipcMain.handle('session:running', () => [])
ipcMain.handle('session:start', () => SID)
ipcMain.handle('session:send', () => ({ ok: true }))
for (const name of ['session:stop', 'session:interrupt', 'session:reconfigure', 'session:respond-permission', 'session:respond-question']) {
  ipcMain.on(name, () => undefined)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
function check(label, cond, detail) {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : String(detail))
  }
}
const js = (w, code) => w.webContents.executeJavaScript(code)

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1360, height: 860, show: true, frame: false, backgroundColor: '#191919',
    webPreferences: { preload: path.join(__dirname, '..', 'out', 'preload', 'index.js'), sandbox: false }
  })
  await win.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'index.html'))
  await sleep(1500)

  const send = (event) => win.webContents.send('session:event', { sessionId: SID, event })
  send({
    t: 'session_started', sessionId: 'prov-ctx', provider: 'claude',
    model: 'deepseek-v4.1-flash[1m]', cwd: CWD, tools: [], permissionMode: 'standard'
  })
  send({ t: 'user_message', text: '把上下文胶囊做成可点击的，点开能看到具体构成。', at: new Date().toISOString() })
  send({ t: 'text_delta', text: '好，浮层放在胶囊正上方，右侧对齐。' })

  const turn = (contextTokens, breakdown, cumulative) => {
    send({
      t: 'turn_end',
      durationMs: 1200,
      steps: 1,
      usage: {
        inputTokens: cumulative.inputTokens,
        outputTokens: cumulative.outputTokens,
        cacheReadTokens: cumulative.cacheReadTokens,
        cacheCreationTokens: cumulative.cacheCreationTokens,
        tokensPerSecond: 42,
        contextPercent: Math.round((contextTokens / 1_000_000) * 100),
        contextTokens,
        contextUsage: breakdown
      }
    })
  }

  turn(213_200, {
    inputTokens: 38_600,
    outputTokens: 3_000,
    cacheReadTokens: 168_400,
    cacheCreationTokens: 3_200
  }, {
    inputTokens: 120_000,
    outputTokens: 9_000,
    cacheReadTokens: 500_000,
    cacheCreationTokens: 30_000
  })
  await sleep(500)

  console.log('\n[1] 点击胶囊展开')
  const chip = await js(win, `(() => {
    const b = document.querySelector('.ctxchip')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { text: b.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom }
  })()`)
  check('胶囊已渲染', !!chip, JSON.stringify(chip))
  check('胶囊显示 21%', /21%/.test(chip?.text || ''), chip?.text)
  await js(win, `document.querySelector('.ctxchip')?.click()`)
  await sleep(300)

  const pop = await js(win, `(() => {
    const p = document.querySelector('.ctxpop')
    if (!p) return null
    const r = p.getBoundingClientRect()
    const c = document.querySelector('.ctxchip').getBoundingClientRect()
    return {
      text: p.innerText,
      left: +r.left.toFixed(1), right: +r.right.toFixed(1),
      top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1),
      chipRight: +c.right.toFixed(1), chipTop: +c.top.toFixed(1)
    }
  })()`)
  check('浮层出现', !!pop)
  check('浮层右边缘与胶囊对齐', pop && Math.abs(pop.right - pop.chipRight) < 0.5, JSON.stringify(pop))
  check('浮层在胶囊上方', pop && pop.bottom <= pop.chipTop, JSON.stringify(pop))
  check('显示已用 / 上限', pop && pop.text.includes('213.2k') && pop.text.includes('1.0M'), pop?.text)
  check('显示剩余', pop && pop.text.includes('786.8k'), pop?.text)
  check('显示四项构成', pop && ['缓存读取', '输入', '缓存写入', '输出', '168.4k', '38.6k'].every((x) => pop.text.includes(x)), pop?.text)
  check('没有提前出现警告', pop && !pop.text.includes('/compact'), pop?.text)

  fs.writeFileSync(path.join(__dirname, '..', 'docs', 'mockups', 'ctx-live.png'), (await win.webContents.capturePage()).toPNG())

  console.log('\n[2] 接近上限 → 危险态 + /compact 提示')
  turn(911_200, {
    inputTokens: 160_000,
    outputTokens: 11_200,
    cacheReadTokens: 726_000,
    cacheCreationTokens: 14_000
  }, {
    inputTokens: 900_000,
    outputTokens: 20_000,
    cacheReadTokens: 2_000_000,
    cacheCreationTokens: 100_000
  })
  await sleep(500)
  const danger = await js(win, `(() => {
    const p = document.querySelector('.ctxpop')
    return p ? { text: p.innerText, danger: !!p.querySelector('.ctxpop__alert') } : null
  })()`)
  check('浮层仍在并更新为 91%', danger && danger.text.includes('91%'), danger?.text)
  check('出现危险提示', danger?.danger)
  check('提示里带 /compact', danger && danger.text.includes('/compact'), danger?.text)
  fs.writeFileSync(path.join(__dirname, '..', 'docs', 'mockups', 'ctx-live-danger.png'), (await win.webContents.capturePage()).toPNG())

  console.log('\n[3] 关闭交互')
  await js(win, `document.querySelector('.transcript')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  await sleep(200)
  check('点击外部收起', await js(win, `!document.querySelector('.ctxpop')`))

  await js(win, `document.querySelector('.ctxchip')?.click()`)
  await sleep(200)
  check('再次点击可展开', await js(win, `!!document.querySelector('.ctxpop')`))
  await js(win, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(200)
  check('Esc 收起', await js(win, `!document.querySelector('.ctxpop')`))

  console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}\n`)
  setTimeout(() => app.exit(failed === 0 ? 0 : 1), 200)
})
