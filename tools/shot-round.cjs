/*
 * 开发辅助：核对本轮新增的四条交互（消息动作 / 会话内查找 / 跑完提醒入口 /
 * 文本文件附件）。不参与打包，随时可删。
 *
 * 用法（参数用环境变量，避免 electron 自己的 --no-sandbox 混进 argv）：
 *   SHOT_OUT=out.png SHOT_MODE=find    electron --no-sandbox tools/shot-round.cjs
 *   SHOT_MODE: find | hover | drop | settings
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const out =
  process.env.SHOT_OUT || path.join(__dirname, '..', '.tmp-build', 'round.png')
const mode = process.env.SHOT_MODE || 'find'
const SID = 'demo-session'
const CWD = 'C:/proj/ccoder'

const ch = (id, name, baseUrl, model) => ({
  id,
  name,
  kind: 'anthropic',
  baseUrl,
  model,
  smallFastModel: '',
  authMode: 'token',
  authToken: 'sk-xxxxxxxxxxxxxxxxxxxx',
  extraEnv: [],
  models: []
})

const DEMO = {
  language: 'zh',
  permissionMode: 'standard',
  defaultCwd: CWD,
  openedCwds: [CWD],
  theme: process.env.SHOT_THEME || 'dark',
  uiZoom: 1,
  chatFontSize: 14,
  uiFont: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
  monoFont: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
  showTimestamps: true,
  thinkingOpen: false,
  toolDetail: 'full',
  sendKey: 'enter',
  notifyOnDone: true,
  editor: {},
  keybindings: {},
  lsp: { enabled: false },
  cliUpdate: { autoCheck: false, tagInNav: false },
  clis: {
    claude: {
      enabled: true,
      activeChannelId: 'demo-1',
      channels: [ch('demo-1', 'DeepSeek 中转', 'https://api.deepseek.com/anthropic', 'deepseek-chat')],
      effort: 'medium',
      authMode: 'channel',
      officialModel: ''
    },
    codex: {
      enabled: false,
      activeChannelId: null,
      channels: [],
      effort: 'medium',
      authMode: 'channel',
      officialModel: ''
    },
    dsh: {
      enabled: false,
      activeChannelId: null,
      channels: [],
      effort: 'medium',
      authMode: 'official',
      officialModel: ''
    }
  }
}

ipcMain.handle('win:is-maximized', () => false)
ipcMain.handle('settings:get', () => DEMO)
ipcMain.handle('settings:save', (_e, s) => s)
ipcMain.handle('channel:test', () => ({ ok: true, message: 'pong', latencyMs: 412 }))
ipcMain.handle('session:start', () => SID)
const sentInputs = []
ipcMain.handle('session:send', (_e, id, input) => {
  sentInputs.push(input)
  return { ok: true }
})
ipcMain.handle('session:command', () => ({ ok: false }))
ipcMain.handle('session:reconfigure', () => undefined)
ipcMain.handle('session:running', () => [])
ipcMain.handle('locale:info', () => ({ systemLocale: 'zh-CN', resolved: 'zh' }))
ipcMain.handle('updater:status', () => ({ phase: 'idle' }))
ipcMain.handle('mcp:migration', () => ({ count: 0 }))
ipcMain.handle('vcs:detect', () => ({ kind: null }))
ipcMain.handle('vcs:worktree-map', () => ({}))
ipcMain.on('session:interrupt', () => undefined)
ipcMain.on('session:stop', () => undefined)
ipcMain.on('session:respond-permission', () => undefined)
ipcMain.handle('sessions:list', () => [])
ipcMain.handle('sessions:transcript', () => [])
ipcMain.handle('sessions:pick-dir', () => null)
ipcMain.handle('sessions:delete', () => ({ ok: true }))
ipcMain.handle('sessions:meta', () => ({}))
ipcMain.handle('sessions:search', () => ({
  hits: [],
  truncated: false,
  scanned: 0,
  offset: 0,
  nextOffset: 0,
  done: true,
  total: 0
}))
ipcMain.on('chat:report-active', () => undefined)
ipcMain.on('chat:notify-done', (_e, p) => console.log('NOTIFY', JSON.stringify(p)))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    show: true,
    frame: false,
    backgroundColor: DEMO.theme === 'light' ? '#f6f6f7' : '#191919',
    webPreferences: {
      preload: path.join(__dirname, '..', 'out', 'preload', 'index.js'),
      sandbox: false
    }
  })

  await win.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'index.html'))
  await new Promise((r) => setTimeout(r, 1200))

  const send = (event) => win.webContents.send('session:event', { sessionId: SID, event })
  const status = (s) =>
    win.webContents.send('session:status', {
      sessionId: SID,
      status: s,
      providerSessionId: 'claude-demo'
    })

  status('running')
  send({
    t: 'session_started',
    sessionId: 'claude-demo',
    provider: 'claude',
    model: 'deepseek-v4.1-flash[1m]',
    cwd: CWD,
    tools: [],
    permissionMode: 'standard'
  })

  // 带 IDE 引用的用户消息 —— 覆盖「复制 / 编辑」要处理的两种正文
  send({
    t: 'user_message',
    text:
      '帮我看看这段代码，重点确认缓存命中率算得对不对。\n\n' +
      '<ide_reference path="src/renderer/src/components/format.ts" lines="38-45" lang="ts">\n' +
      '```ts\n' +
      'export function totalTokens(u: Usage): number {\n' +
      '  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens\n' +
      '}\n' +
      '```\n' +
      '</ide_reference>',
    at: new Date().toISOString()
  })
  send({
    t: 'text_delta',
    text:
      '看过了，`totalTokens` 把四项加起来是对的，但要注意：\n\n' +
      '1. **缓存命中率**的分母应该是输入侧三项，不是四项全加；\n' +
      '2. 一轮里多次工具往返时，`usage` 是累计值，用它算比例会偏高。\n\n' +
      '上下文占用请用 `contextUsage`（最后一次请求的四项），那个才是准的。'
  })
  send({
    t: 'tool_call',
    id: 't1',
    name: 'Read',
    input: { file_path: `${CWD}/src/renderer/src/components/format.ts` }
  })
  send({ t: 'tool_result', id: 't1', status: 'ok', content: 'export function totalTokens...' })
  send({
    t: 'turn_end',
    durationMs: 4200,
    steps: 1,
    usage: {
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 800,
      cacheCreationTokens: 120,
      tokensPerSecond: 81,
      contextPercent: 3,
      contextTokens: 128000
    }
  })
  status('idle')

  send({
    t: 'user_message',
    text: '那按你说的改一下，缓存命中率只按输入侧算。',
    at: new Date().toISOString()
  })
  send({ t: 'text_delta', text: '好，我把 `cacheHitRate` 的分母收窄到输入三项' })
  send({ t: 'text_delta', text: '，并补了一条注释说明为什么不含输出。' })
  send({
    t: 'turn_end',
    durationMs: 1800,
    steps: 0,
    usage: {
      inputTokens: 900,
      outputTokens: 60,
      cacheReadTokens: 600,
      cacheCreationTokens: 40,
      contextTokens: 131000
    }
  })
  status('idle')

  await new Promise((r) => setTimeout(r, 900))

  if (mode === 'find') {
    const r = await win.webContents.executeJavaScript(`(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))
      await new Promise((x) => setTimeout(x, 250))
      const input = document.querySelector('.findbar__input')
      if (!input) return 'no-findbar'
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(input, '缓存')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      const samples = []
      for (let i = 0; i < 8; i++) {
        await new Promise((x) => setTimeout(x, 100))
        samples.push(document.querySelector('.findbar__count')?.textContent)
      }
      const first = document.querySelector('.findbar__count')?.textContent
      // Enter 跳到下一处
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise((x) => setTimeout(x, 120))
      const second = document.querySelector('.findbar__count')?.textContent
      // Shift+Enter 回到上一处
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
      await new Promise((x) => setTimeout(x, 120))
      const third = document.querySelector('.findbar__count')?.textContent
      // 全部跳完之后再按一次，应回到第一处
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise((x) => setTimeout(x, 120))
      const wrapped = document.querySelector('.findbar__count')?.textContent
      // 截图里要留着查找条，所以 Esc 放到最后一步（见 closeFind 标记）
      window.__findInput = input
      return {
        samples,
        first,
        second,
        third,
        wrapped,
        closed: !!document.querySelector('.findbar')
      }
    })()`)
    console.log('FIND', JSON.stringify(r))
  }

  if (mode === 'hover') {
    const r = await win.webContents.executeJavaScript(`(async () => {
      const rows = document.querySelectorAll('.tl__row--me')
      const last = rows[rows.length - 1]
      if (!last) return 'no-row'
      const acts = last.querySelector('.tl__meactions')
      return {
        rows: rows.length,
        buttons: acts ? acts.querySelectorAll('.tl__meact').length : 0,
        titles: acts ? [...acts.querySelectorAll('.tl__meact')].map((b) => b.title) : [],
        items: document.querySelectorAll('.tl__item[data-item-id]').length
      }
    })()`)
    console.log('HOVER', JSON.stringify(r))
    // 截图时让工具条可见（合成 hover 不触发 CSS :hover）
    await win.webContents.executeJavaScript(
      `document.querySelectorAll('.tl__meactions').forEach((e) => { e.style.opacity = '1' })`
    )
  }

  if (mode === 'drop') {
    const r = await win.webContents.executeJavaScript(`(async () => {
      const box = document.querySelector('.composer__box')
      if (!box) return 'no-box'
      const file = new File(['export const a = 1\\nexport const b = 2\\n'], 'sample.ts', { type: 'text/plain' })
      const dt = new DataTransfer()
      dt.items.add(file)
      box.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
      await new Promise((x) => setTimeout(x, 120))
      const dragging = box.classList.contains('is-dragging')
      const dropHint = !!document.querySelector('.composer__drop')
      box.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
      await new Promise((x) => setTimeout(x, 500))
      return {
        dragging,
        dropHint,
        refCards: document.querySelectorAll('.composer__ref').length,
        tag: document.querySelector('.composer__ref-tag')?.textContent ?? '',
        path: document.querySelector('.composer__ref-path')?.textContent ?? '',
        sendReady: !!document.querySelector('.send.is-ready')
      }
    })()`)
    console.log('DROP', JSON.stringify(r))
  }

  if (mode === 'retry') {
    const r = await win.webContents.executeJavaScript(`(async () => {
      const rows = document.querySelectorAll('.tl__row--me')
      const last = rows[rows.length - 1]
      const btns = [...last.querySelectorAll('.tl__meact')]
      const retry = btns.find((b) => (b.getAttribute('aria-label') || '') === '重发这条消息')
      if (!retry) return { error: 'no-retry-button', titles: btns.map((b) => b.title) }
      retry.click()
      await new Promise((x) => setTimeout(x, 400))
      return {
        clicked: true,
        rowsAfter: document.querySelectorAll('.tl__row--me').length
      }
    })()`)
    console.log('RETRY', JSON.stringify(r))
    await new Promise((x) => setTimeout(x, 800))
    console.log('SENT', JSON.stringify(sentInputs.map((x) => ({ text: String(x.text).slice(0, 40), images: x.images?.length ?? 0 }))))
    // 编辑：把最后一条消息放回输入框
    const e = await win.webContents.executeJavaScript(`(async () => {
      // 先在输入框里留一段草稿，验证「编辑」是替换而不是追加
      const ta0 = document.querySelector('.composer__input')
      const setv = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setv.call(ta0, '一段无关的草稿')
      ta0.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((x) => setTimeout(x, 150))
      const rows = document.querySelectorAll('.tl__row--me')
      const first = rows[0]
      const edit = [...first.querySelectorAll('.tl__meact')].find((b) => (b.getAttribute('aria-label') || '') === '编辑并重发')
      if (!edit) return { error: 'no-edit-button' }
      edit.click()
      await new Promise((x) => setTimeout(x, 400))
      const ta = document.querySelector('.composer__input')
      return {
        text: ta?.value ?? '',
        refCards: document.querySelectorAll('.composer__ref').length,
        refPath: document.querySelector('.composer__ref-path')?.textContent ?? ''
      }
    })()`)
    console.log('EDIT', JSON.stringify(e))
  }

  if (mode === 'notify') {
    // 再跑一轮，看主进程收到什么（窗口是聚焦的、且正开着这条会话 → 应当不弹）
    send({ t: 'user_message', text: '再来一轮，验证提醒。', at: new Date().toISOString() })
    send({ t: 'text_delta', text: '好的。' })
    send({ t: 'turn_end', durationMs: 900, steps: 0, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 } })
    status('idle')
    await new Promise((x) => setTimeout(x, 700))
    // 再把窗口挪到后台，模拟"用户在看别的窗口"
    win.blur()
    send({ t: 'user_message', text: '后台那一轮。', at: new Date().toISOString() })
    send({ t: 'text_delta', text: '跑完了。' })
    send({ t: 'turn_end', durationMs: 800, steps: 0, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 } })
    status('idle')
    await new Promise((x) => setTimeout(x, 700))
    const focused = win.isFocused()
    console.log('NOTIFY_MODE focused=', focused)
  }

  if (mode === 'settings') {
    const r = await win.webContents.executeJavaScript(`(async () => {
      const btn = document.querySelector('.sidebar__settings') ??
        [...document.querySelectorAll('button')].find((b) => (b.title || '').includes('设置'))
      if (!btn) return 'no-settings-button'
      btn.click()
      await new Promise((x) => setTimeout(x, 600))
      // 切到「通用」：跑完提醒那颗开关在那儿
      const general = [...document.querySelectorAll('.settings__navitem')].find((e) =>
        e.textContent.includes('通用')
      )
      if (general) general.click()
      await new Promise((x) => setTimeout(x, 600))
      const box = [...document.querySelectorAll('.field')].find((f) =>
        (f.textContent || '').includes('跑完提醒')
      )
      box?.scrollIntoView({ block: 'center' })
      await new Promise((x) => setTimeout(x, 300))
      return {
        labels: [...document.querySelectorAll('.field__label')].map((e) => e.textContent),
        notify: box ? box.textContent : null
      }
    })()`)
    console.log('SETTINGS', JSON.stringify(r))
  }

  await new Promise((r) => setTimeout(r, 500))
  const img = await win.webContents.capturePage()
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, img.toPNG())
  console.log('saved', out)
  app.quit()
})
