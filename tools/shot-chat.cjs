/*
 * 开发辅助：给对话页塞一段假事件流再截图，用来核对转写区在深/浅主题下的样子。
 * 用法：SHOT_THEME=light electron tools/shot-chat.cjs out.png
 * 不参与打包，随时可删。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const out = process.argv[2] || path.join(__dirname, '..', 'shot-chat-demo.png')
const SID = 'demo-session'

const ch = (id, name, baseUrl, model) => ({
  id,
  name,
  kind: 'anthropic',
  baseUrl,
  model,
  smallFastModel: '',
  authMode: 'token',
  authToken: 'sk-xxxxxxxxxxxxxxxxxxxx',
  extraEnv: []
})

const DEMO = {
  permissionMode: 'standard',
  defaultCwd: 'C:/proj/ccoder',
  openedCwds: ['C:/proj/ccoder'],
  theme: process.env.SHOT_THEME || 'dark',
  uiZoom: Number(process.env.SHOT_ZOOM || 1),
  chatFontSize: 14,
  uiFont: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
  monoFont: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
  showTimestamps: true,
  thinkingOpen: true,
  toolDetail: 'full',
  sendKey: process.env.SHOT_SEND_KEY || 'enter',
  clis: {
    claude: {
      enabled: true,
      activeChannelId: 'demo-1',
      channels: [ch('demo-1', 'DeepSeek 中转', 'https://api.deepseek.com/anthropic', 'deepseek-chat')],
      effort: 'medium'
    },
    codex: { enabled: false, activeChannelId: null, channels: [], effort: 'medium' }
  }
}

ipcMain.handle('win:is-maximized', () => false)
ipcMain.handle('settings:get', () => DEMO)
ipcMain.handle('settings:save', (_e, s) => s)
ipcMain.handle('channel:test', () => ({ ok: true, message: 'pong', latencyMs: 412 }))
ipcMain.handle('session:start', () => SID)
ipcMain.handle('session:send', () => ({ ok: true }))
ipcMain.handle('session:reconfigure', () => undefined)
ipcMain.on('session:interrupt', () => undefined)
ipcMain.on('session:stop', () => undefined)
ipcMain.on('session:respond-permission', () => undefined)
ipcMain.handle('sessions:list', () => [])
ipcMain.handle('sessions:transcript', () => [])
ipcMain.handle('sessions:pick-dir', () => null)
ipcMain.handle('sessions:delete', () => ({ ok: true }))

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
  await new Promise((r) => setTimeout(r, 1500))

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
    cwd: DEMO.defaultCwd,
    tools: [],
    permissionMode: 'standard'
  })
  send({ t: 'user_message', text: '帮我看看设置页还缺什么，顺便把浅色主题的转写区调一下。', at: new Date().toISOString() })
  send({ t: 'thinking_delta', text: '用户想要两件事：一是评估设置页的缺口，二是检查浅色主题下的可读性。先看设置页的结构，再对照现有能力列候选。' })
  send({ t: 'text_delta', text: '我先看一下当前的设置页和样式变量。\n\n重点会检查：\n\n- 深色写死的颜色\n- `--chat-font-size` 的继承链\n- 工具卡的展开逻辑\n\n' })
  send({ t: 'tool_call', id: 't1', name: 'Read', input: { file_path: 'C:/proj/ccoder/src/renderer/src/components/SettingsPage.tsx' } })
  send({ t: 'tool_result', id: 't1', status: 'ok', content: 'export function SettingsPage() { ... }' })
  send({ t: 'tool_call', id: 't2', name: 'Bash', input: { command: 'npm run typecheck', description: '运行类型检查' } })
  send({ t: 'tool_result', id: 't2', status: 'ok', content: 'typecheck:node ✓\ntypecheck:web ✓' })
  // 文件改动：给「本轮修改」那颗按钮喂数据（Edit 两条、Write 新建两条）
  send({ t: 'tool_call', id: 't3', name: 'Edit', input: { file_path: 'C:/proj/ccoder/src/auth/store.ts' } })
  send({
    t: 'tool_result',
    id: 't3',
    status: 'ok',
    content: 'The file src/auth/store.ts has been updated.',
    stat: { added: 38, removed: 12 }
  })
  send({ t: 'file_change', path: 'C:/proj/ccoder/src/auth/store.ts', added: 38, removed: 12, source: 'agent' })
  send({ t: 'tool_call', id: 't4', name: 'Write', input: { file_path: 'C:/proj/ccoder/src/auth/middleware.ts' } })
  send({
    t: 'tool_result',
    id: 't4',
    status: 'ok',
    content: 'File created successfully at: C:/proj/ccoder/src/auth/middleware.ts',
    stat: { added: 22, removed: 0 },
    created: true
  })
  send({ t: 'file_change', path: 'C:/proj/ccoder/src/auth/middleware.ts', added: 22, removed: 0, created: true, wrote: true, source: 'agent' })
  send({ t: 'tool_call', id: 't5', name: 'Edit', input: { file_path: 'C:/proj/ccoder/src/shared/types.ts' } })
  send({ t: 'tool_result', id: 't5', status: 'ok', content: 'updated', stat: { added: 7, removed: 3 } })
  send({ t: 'file_change', path: 'C:/proj/ccoder/src/shared/types.ts', added: 7, removed: 3, source: 'agent' })
  send({ t: 'tool_call', id: 't6', name: 'Write', input: { file_path: 'C:/proj/ccoder/src/auth/store.test.ts' } })
  send({
    t: 'tool_result',
    id: 't6',
    status: 'ok',
    content: 'File created successfully at: C:/proj/ccoder/src/auth/store.test.ts',
    stat: { added: 41, removed: 0 },
    created: true
  })
  send({ t: 'file_change', path: 'C:/proj/ccoder/src/auth/store.test.ts', added: 41, removed: 0, created: true, wrote: true, source: 'agent' })
  send({
    t: 'text_delta',
    text: '检查完了，浅色主题下主要需要处理三类地方：\n\n1. 深色背景上的半透明白色叠加\n2. 代码块与语法高亮\n3. 工具卡和图标的低对比度\n\n```ts\nconst theme: ThemeMode = "light"\nconst zoom = 1.1\n```\n\n另外 `--chat-font-size` 已经接到正文和输入框上了。'
  })
  send({
    t: 'turn_end',
    durationMs: 4200,
    steps: 2,
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

  await new Promise((r) => setTimeout(r, 900))

  if (process.env.SHOT_KEY_TEST) {
    const result = await win.webContents.executeJavaScript(`(async () => {
      const count = () => document.querySelectorAll('.tl__me').length;
      const before = count();
      const ta = document.querySelector('.composer__input');
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      const fire = (opts) => ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...opts }));
      const type = () => {
        set.call(ta, '快捷键测试');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      };
      type();
      fire({});
      await new Promise((r) => setTimeout(r, 120));
      const afterEnter = count();
      if (afterEnter === before) {
        fire({ ctrlKey: true });
        await new Promise((r) => setTimeout(r, 120));
      }
      return { before, afterEnter, afterCtrl: count() };
    })()`)
    console.log('KEYTEST', JSON.stringify(result))
  }

  if (process.env.SHOT_OPEN_FILES) {
    // 点开「本轮修改」那颗按钮，看弹层
    const r = await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.cfbtn'); if (!b) return 'no-button'; b.click(); return document.querySelectorAll('.cfrow').length })()`
    )
    console.log('FILES', r)
    await new Promise((r) => setTimeout(r, 400))
  }

  if (process.env.SHOT_SCROLL === 'top') {
    await win.webContents.executeJavaScript(
      `document.querySelector('.transcript').scrollTop = 0`
    )
    await new Promise((r) => setTimeout(r, 300))
  }
  const img = await win.webContents.capturePage()
  fs.writeFileSync(out, img.toPNG())
  console.log('wrote', out)
  app.quit()
})
