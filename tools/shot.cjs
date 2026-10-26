/*
 * 开发辅助：把已构建的渲染层截图，用于核对视觉。
 * 用法：electron tools/shot.cjs <输出.png> [依次点击的选择器...]
 * 选择器按顺序点，每次点完等一会儿 —— 需要先展开菜单再点菜单项的场景用得上。
 * 不参与打包，随时可删。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const out = process.argv[2] || path.join(__dirname, '..', 'shot.png')
const clickSelectors = process.argv.slice(3)
const lang = process.env.SHOT_LANG === 'en' ? 'en' : 'zh'
const L = (zh, en) => (lang === 'en' ? en : zh)

const ch = (id, name, baseUrl, model, authMode) => ({
  id,
  name,
  kind: 'anthropic',
  baseUrl,
  model,
  smallFastModel: '',
  authMode,
  authToken: 'sk-xxxxxxxxxxxxxxxxxxxx',
  extraEnv: []
})

// 截图环境没有真正的主进程，给几个桩让页面能渲染出来
const DEMO = {
  permissionMode: 'standard',
  defaultCwd: 'C:/proj/ccoder-demo',
  openedCwds: ['C:/proj/ccoder-demo'],
  language: lang,
  // 外观 / 对话 / 输入的默认值 —— 截图桩也要给全，否则设置页拿不到这些字段
  theme: process.env.SHOT_THEME || 'dark',
  uiZoom: 1,
  chatFontSize: 14,
  uiFont: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
  monoFont: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
  showTimestamps: false,
  thinkingOpen: false,
  toolDetail: 'full',
  sendKey: 'enter',
  clis: {
    claude: {
      enabled: true,
      activeChannelId: 'demo-1',
      channels: [
        ch('demo-1', L('DeepSeek 中转', 'DeepSeek Relay'), 'https://api.deepseek.com/anthropic', 'deepseek-chat', 'token'),
        ch('demo-2', L('公司网关', 'Company Gateway'), 'https://gw.corp.internal/anthropic', 'claude-sonnet-4-5', 'key')
      ]
    },
    codex: {
      enabled: false,
      activeChannelId: 'demo-x1',
      channels: [ch('demo-x1', L('OpenAI 中转', 'OpenAI Relay'), 'https://api.openai.com/v1', 'gpt-5-codex', 'token')]
    },
    dsh: {
      enabled: true,
      activeChannelId: null,
      channels: [],
      effort: 'medium',
      authMode: 'official',
      officialModel: 'deepseek-flash'
    }
  }
}

let saveCount = 0
ipcMain.handle('locale:info', () => ({
  systemLocale: lang === 'en' ? 'en-US' : 'zh-CN',
  resolved: lang
}))
ipcMain.handle('win:is-maximized', () => false)
ipcMain.handle('settings:get', () => DEMO)
ipcMain.handle('settings:save', (_e, s) => {
  saveCount += 1
  return s
})
// 让页面有个能跑的会话桩，不然启动时弹「主进程没有响应」
ipcMain.handle('sessions:list', () => [])
ipcMain.handle('sessions:meta', () => ({}))
ipcMain.handle('sessions:set-meta', () => ({}))
ipcMain.handle('sessions:transcript', () => [])
ipcMain.handle('sessions:pick-dir', () => null)
ipcMain.handle('sessions:delete', () => ({ ok: true }))
ipcMain.handle('session:running', () => null)
ipcMain.handle('session:start', () => 'demo-session')
ipcMain.handle('session:send', () => ({ ok: true }))
ipcMain.handle('session:reconfigure', () => undefined)
ipcMain.on('session:interrupt', () => undefined)
ipcMain.on('session:stop', () => undefined)
ipcMain.on('session:respond-permission', () => undefined)
// 截图用的更新状态：版本号与 package.json 一致，检查时间设成 2 分钟前
const UPD_STATE = {
  phase: 'up-to-date',
  currentVersion: '1.0.4',
  version: '1.0.4',
  checkedAt: Date.now() - 2 * 60 * 1000
}
ipcMain.handle('updater:status', () => UPD_STATE)
ipcMain.handle('updater:check', () => UPD_STATE)
ipcMain.handle('updater:download', () => UPD_STATE)
ipcMain.handle('claude:auth-status', () => ({
  installed: true,
  path: 'C:\\Users\\CY\\AppData\\Roaming\\npm\\claude.cmd',
  version: '2.1.303 (Claude Code)',
  loggedIn: true,
  authMethod: 'oauth_token',
  apiProvider: 'firstParty',
  checkedAt: Date.now()
}))
ipcMain.handle('claude:auth-login-state', () => ({
  phase: 'idle',
  url: null,
  running: false,
  output: ''
}))
ipcMain.handle('channel:test', () => ({
  ok: true,
  message: 'pong',
  latencyMs: 412
}))
ipcMain.handle('codex:status', () => ({
  installed: false,
  path: 'codex',
  version: '',
  appServerOk: false,
  account: null,
  permissionProfiles: [],
  checkedAt: Date.now()
}))
ipcMain.handle('dsh:status', () => ({
  installed: true,
  path: 'C:\\Users\\CY\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
  node: 'C:\\Program Files\\nodejs\\node.exe',
  nodeOk: true,
  version: '0.2.1-rc.2',
  home: 'C:\\Users\\CY\\.dsh',
  checkedAt: Date.now()
}))

/* MCP：截图桩。结构与真实 mcp:list 返回值一致，只用于视觉验收。 */
const MCP_SOURCE = {
  claude: 'C:\\Users\\CY\\.claude.json',
  codex: 'C:\\Users\\CY\\.codex\\config.toml',
  dsh: 'C:\\Users\\CY\\.dsh\\profiles\\acp\\cordis.patch.yml'
}
const mcpServer = (cli, o) => ({
  id: `${cli}-${o.name}`,
  cli,
  name: o.name,
  transport: o.transport || 'stdio',
  command: o.command || '',
  args: o.args || [],
  env: o.env || [],
  url: o.url || '',
  headers: o.headers || [],
  workingDir: o.workingDir || '',
  enabled: o.status !== 'disabled',
  enabledControl: o.enabledControl || 'native',
  enabledBy: o.enabledBy,
  scope: o.scope || 'global',
  cwd: o.cwd || '',
  source: {
    file: MCP_SOURCE[cli],
    scope: o.scope || 'global',
    format: cli === 'codex' ? 'toml' : cli === 'dsh' ? 'yaml' : 'jsonc'
  },
  supported: true,
  readOnly: !!o.readOnly,
  readOnlyReason: o.readOnlyReason,
  hasSecrets: !!o.hasSecrets,
  secretKeys: o.secretKeys || [],
  nativeExtras: o.nativeExtras || [],
  approvalState: o.approvalState,
  status: o.status,
  error: o.error || '',
  latencyMs: o.latencyMs || 0,
  checkedAt: o.status === 'untested' ? 0 : Date.now() - 120000,
  tools: o.tools || [],
  resources: o.resources || [],
  prompts: o.prompts || []
})
const DEMO_MCP = {
  claude: [
    mcpServer('claude', {
      name: 'github',
      description: '仓库、Issue 与 Pull Request',
      transport: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      status: 'connected',
      latencyMs: 142,
      scope: 'project',
      tools: [
        { name: 'search_repositories', description: '搜索仓库、代码与议题' },
        { name: 'get_file_contents', description: '读取仓库中的文件内容' },
        { name: 'list_issues', description: '按状态与标签筛选 Issue' },
        { name: 'get_pull_request', description: '查看 PR 详情、变更与评论' },
        { name: 'create_pull_request', description: '创建 PR 并填写描述' },
        { name: 'create_issue', description: '在指定仓库中新建 Issue' }
      ],
      resources: [
        { uri: 'repo://ccoder/ccoder-desktop/README.md', name: 'README.md', description: '', mimeType: 'text/markdown' }
      ],
      prompts: [{ name: 'summarize_pull_request', description: '总结 PR 改动并生成 review 提纲' }]
    }),
    mcpServer('claude', {
      name: 'filesystem',
      description: '本机文件与目录访问',
      transport: 'stdio',
      command: 'npx -y @modelcontextprotocol/server-filesystem C:\\Projects',
      status: 'untested'
    }),
    mcpServer('claude', {
      name: 'playwright',
      description: '浏览器自动化与页面快照',
      transport: 'stdio',
      command: 'npx -y @playwright/mcp@latest',
      status: 'error',
      error: 'spawn npx ENOENT: 请检查 Node.js 与 npx 是否在 PATH 中。',
      scope: 'project'
    })
  ],
  codex: [
    mcpServer('codex', {
      name: 'context7',
      description: '最新版库文档与代码示例',
      transport: 'http',
      url: 'https://mcp.context7.com/mcp',
      status: 'connected',
      latencyMs: 210,
      tools: [
        { name: 'resolve-library-id', description: '把库名解析成 Context7 文档 ID' },
        { name: 'get-library-docs', description: '读取指定版本的文档与示例' }
      ]
    }),
    mcpServer('codex', {
      name: 'sentry',
      description: '错误追踪与 Issue 查询',
      transport: 'http',
      url: 'https://mcp.sentry.dev/mcp',
      status: 'error',
      error: 'HTTP 401：OAuth 访问令牌已过期。请在 Codex CLI 中重新登录 Sentry MCP 服务。'
    })
  ],
  dsh: [
    mcpServer('dsh', {
      name: 'fetch',
      description: '网页抓取与正文提取',
      transport: 'http',
      url: 'https://mcp.fetch.example/v1',
      status: 'connected',
      latencyMs: 128,
      scope: 'home',
      tools: [
        { name: 'fetch_url', description: '抓取网页并返回 Markdown' },
        { name: 'extract_markdown', description: '提取正文并清理导航栏' },
        { name: 'crawl_site', description: '按深度抓取站点页面' },
        { name: 'take_snapshot', description: '保存页面快照供后续引用' }
      ]
    })
  ]
}
const mcpList = (cli, dshHome) => ({
  cli,
  cwd: DEMO.defaultCwd,
  servers: DEMO_MCP[cli] || [],
  configFiles: [
    {
      path: MCP_SOURCE[cli],
      scopes: cli === 'claude' ? ['user', 'local'] : cli === 'dsh' ? ['home'] : ['global'],
      format: cli === 'codex' ? 'toml' : cli === 'dsh' ? 'yaml' : 'jsonc',
      exists: true,
      readOnly: false
    }
  ],
  dshHome: cli === 'dsh' ? dshHome || 'C:\\Users\\CY\\.dsh' : undefined,
  legacyCount: 0
})
ipcMain.handle('mcp:list', (_e, cli, _cwd, dshHome) => mcpList(cli, dshHome))
ipcMain.handle('mcp:test-all', (_e, cli, _cwd, dshHome) => mcpList(cli, dshHome))
ipcMain.handle('mcp:test', () => ({
  ok: true,
  status: 'connected',
  error: '',
  latencyMs: 96,
  checkedAt: Date.now(),
  tools: [{ name: 'demo_tool', description: 'Demo tool' }],
  resources: [],
  prompts: []
}))
ipcMain.handle('mcp:save', (_e, cli, _server, _cwd, dshHome) => ({ ok: true, list: mcpList(cli, dshHome) }))
ipcMain.handle('mcp:remove', (_e, cli, _id, _cwd, dshHome) => ({ ok: true, list: mcpList(cli, dshHome) }))
ipcMain.handle('mcp:set-enabled', (_e, cli, _id, _enabled, _cwd, dshHome) => ({ ok: true, list: mcpList(cli, dshHome) }))
ipcMain.handle('mcp:dsh-homes', () => [
  { path: 'C:\\Users\\CY\\.dsh', label: '', kind: 'shared', active: true, exists: true },
  { path: 'C:\\Users\\CY\\AppData\\Roaming\\coder-desktop\\dsh-homes\\demo', label: 'Demo', kind: 'channel', active: false, exists: false }
])
ipcMain.handle('mcp:open-config', () => ({ ok: true }))
ipcMain.handle('mcp:reveal-config', () => ({ ok: true }))
ipcMain.handle('mcp:open-backups', () => ({ ok: true }))
ipcMain.handle('mcp:migration', () => ({
  count: 0,
  legacyPath: 'C:\\Users\\CY\\AppData\\Roaming\\coder-desktop\\mcp-servers.json',
  entries: [],
  defaultDshHome: 'C:\\Users\\CY\\.dsh'
}))
ipcMain.handle('mcp:migrate', () => ({
  ok: true,
  migrated: 0,
  skipped: 0,
  conflicts: 0,
  failed: []
}))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    show: process.env.SHOT_HIDE !== '1',
    frame: false,
    backgroundColor: '#191919',
    webPreferences: {
      preload: path.join(__dirname, '..', 'out', 'preload', 'index.js'),
      sandbox: false
    }
  })

  // 调试用：把渲染层最早期的异常连同 stack 打出来，否则只看到压缩后的报错行号
  win.webContents.on('did-start-loading', () => {
    win.webContents
      .executeJavaScript(`
        window.addEventListener('error', (e) => {
          console.log('EARLY_ERR', e.message, e.filename, e.lineno, e.colno, '\\n' + (e.error && e.error.stack))
        })
        window.addEventListener('unhandledrejection', (e) => {
          console.log('EARLY_REJ', '\\n' + ((e.reason && e.reason.stack) || e.reason))
        })
      `)
      .catch(() => {})
  })
  win.webContents.on('console-message', (_e, _level, message) => {
    if (/EARLY_|TypeError|Uncaught/.test(message)) console.log('[renderer]', message)
  })

  await win.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'index.html'))
  await new Promise((r) => setTimeout(r, 1200))

  for (const sel of clickSelectors) {
    const hit = await win.webContents.executeJavaScript(
      `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.click(); return !!el })()`
    )
    if (!hit) console.log('[warn] 没找到选择器:', sel)
    await new Promise((r) => setTimeout(r, 700))
  }

  if (process.env.SHOT_DEBUG) {
    const info = await win.webContents.executeJavaScript(`(() => ({
      url: location.href,
      nav: !!document.querySelector('.settings__nav'),
      settingsTitle: document.querySelector('.settings__title')?.textContent || '',
      mainClass: document.querySelector('main')?.className || '',
      cliNav: [...document.querySelectorAll('.settings__navitem')].map((b) => b.textContent)
    }))()`)
    console.log('DEBUG', JSON.stringify(info))
  }

  if (process.env.SHOT_AUTOSAVE) {
    const flush = process.env.SHOT_AUTOSAVE === 'flush'
    const r = await win.webContents.executeJavaScript(`(async () => {
      const el = document.querySelector('.settings__content select');
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      set.call(el, 'light');
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (${flush}) {
        // 改完立刻返回：防抖还没到点，靠离开时的兜底落盘
        document.querySelector('.settings__head .btn--ghost')?.click();
        await new Promise((r) => setTimeout(r, 900));
        return { status: '(已返回)', theme: document.documentElement.dataset.theme };
      }
      await new Promise((r) => setTimeout(r, 1000));
      return {
        status: document.querySelector('.settings__head-right .saved-flash')?.textContent ?? '',
        theme: document.documentElement.dataset.theme
      };
    })()`)
    console.log('AUTOSAVE', JSON.stringify(r), 'saves =', saveCount)
  }

  if (process.env.SHOT_SCROLL === 'bottom') {
    await win.webContents.executeJavaScript(
      `document.querySelector('.settings__content')?.scrollTo(0, 1e9)`
    )
    await new Promise((r) => setTimeout(r, 300))
  }

  console.log('capturing', out)
  const img = await win.webContents.capturePage()
  fs.writeFileSync(out, img.toPNG())
  console.log('wrote', out)
  app.exit(0)
})
