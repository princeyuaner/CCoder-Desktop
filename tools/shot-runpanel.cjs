/*
 * 开发辅助：塞一段带 TaskCreate / TaskUpdate / Agent 的事件流，
 * 截「右侧执行台」展开时的样子。用法：
 *   electron tools/shot-runpanel.cjs out.png
 * 不参与打包，随时可删。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const out = process.argv[2] || path.join(__dirname, '..', 'shot-runpanel.png')
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
  const status = (s) => win.webContents.send('session:status', { sessionId: SID, status: s })

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
  send({ t: 'user_message', text: '把会话校验收进一个中间件，token 过期时自动刷新；顺手把失败分支的测试补上。', at: new Date().toISOString() })
  send({ t: 'thinking_delta', text: '先看 middleware/auth.ts 和 session/store.ts，确认刷新逻辑现在挂在哪。' })

  const tasks = [
    { subject: '盘点现有会话校验入口', description: '找出散落在 handler 里的校验', activeForm: '正在盘点会话校验入口' },
    { subject: '拆出 requireSession 中间件', description: '收成一个入口', activeForm: '正在拆 requireSession' },
    { subject: '补齐刷新失败的测试', description: '覆盖过期、并发、失效 token', activeForm: '正在补测试' },
    { subject: '实现 single-flight 刷新', description: '防止并发重复刷新', activeForm: '正在修改 src/auth/store.ts' },
    { subject: '跑回归并检查错误码', description: '跑全量测试', activeForm: '正在跑回归' }
  ]

  tasks.forEach((task, i) => {
    const id = `tc${i}`
    send({ t: 'tool_call', id, name: 'TaskCreate', input: task })
    send({
      t: 'tool_result',
      id,
      status: 'ok',
      content: `Task #${i + 1} created successfully: ${task.subject}`,
      task: { created: { id: String(i + 1), subject: task.subject } }
    })
  })

  const update = (id, taskId, from, to) => {
    send({ t: 'tool_call', id, name: 'TaskUpdate', input: { taskId: String(taskId), status: to } })
    send({
      t: 'tool_result',
      id,
      status: 'ok',
      content: `Updated task #${taskId} status`,
      task: { updated: { taskId: String(taskId), from, to } }
    })
  }
  update('tu1', 1, 'pending', 'completed')
  update('tu2', 2, 'pending', 'completed')
  update('tu3', 3, 'pending', 'completed')
  update('tu4', 4, 'pending', 'in_progress')

  send({ t: 'tool_call', id: 'read1', name: 'Read', input: { file_path: 'C:/proj/ccoder/src/auth/middleware.ts' } })
  send({ t: 'tool_result', id: 'read1', status: 'ok', content: 'export function requireSession() { ... }' })

  send({
    t: 'tool_call',
    id: 'ag1',
    name: 'Agent',
    input: {
      description: '梳理 token 刷新调用点',
      subagent_type: 'Explore',
      prompt: '找出 refreshIfExpired 的所有调用点'
    }
  })
  send({
    t: 'tool_result',
    id: 'ag1',
    status: 'ok',
    content: '已定位 6 处调用点，其中 2 处缺少并发保护。',
    agent: {
      agentId: 'agent-demo-1',
      agentType: 'Explore',
      status: 'completed',
      durationMs: 72000,
      totalTokens: 33200,
      toolUseCount: 20,
      toolStats: {
        readCount: 11,
        searchCount: 4,
        bashCount: 4,
        editFileCount: 0,
        linesAdded: 0,
        linesRemoved: 0,
        otherToolCount: 1
      },
      summary: '已定位 6 处调用点，其中 2 处缺少并发保护。'
    }
  })

  send({ t: 'tool_call', id: 'edit1', name: 'Edit', input: { file_path: 'C:/proj/ccoder/src/auth/middleware.ts', old_string: 'a', new_string: 'b' } })
  send({ t: 'tool_result', id: 'edit1', status: 'ok', content: 'ok', stat: { added: 38, removed: 21 } })
  send({ t: 'file_change', path: 'C:/proj/ccoder/src/auth/middleware.ts', added: 38, removed: 21, source: 'agent' })

  send({
    t: 'tool_call',
    id: 'ag2',
    name: 'Agent',
    input: {
      description: '补 token 刷新的失败用例',
      subagent_type: 'general-purpose',
      prompt: '新增过期、并发刷新、失效 token 的测试'
    }
  })

  send({ t: 'text_delta', text: '中间件已经改好。刷新调用点比较多，我开了一个子代理并行梳理；这边继续改 store。' })
  send({ t: 'tool_call', id: 'edit2', name: 'Edit', input: { file_path: 'C:/proj/ccoder/src/auth/store.ts', old_string: 'a', new_string: 'b' } })
  send({ t: 'file_change', path: 'C:/proj/ccoder/src/auth/store.ts', added: 1, removed: 1, source: 'agent' })

  await new Promise((r) => setTimeout(r, 1200))

  if (process.env.SHOT_BACKGROUND) {
    // 先把上一轮那个前台代理收尾，截图里只留一个正在跑的后台代理
    send({
      t: 'tool_result',
      id: 'ag2',
      status: 'ok',
      content: '新增 4 个用例：过期、并发刷新、失效 token、刷新失败。',
      agent: {
        agentId: 'agent-demo-2',
        agentType: 'general-purpose',
        status: 'completed',
        durationMs: 48000,
        totalTokens: 21000,
        toolUseCount: 12,
        toolStats: {
          readCount: 5,
          searchCount: 2,
          bashCount: 3,
          editFileCount: 2,
          linesAdded: 82,
          linesRemoved: 0,
          otherToolCount: 0
        },
        summary: '新增 4 个用例：过期、并发刷新、失效 token、刷新失败。'
      }
    })
    // 模拟：Agent 以后台方式启动，主对话先结束，子代理继续跑
    send({ t: 'user_message', text: '后台跑一个代理梳理刷新调用点，先把主对话结束掉。', at: new Date().toISOString() })
    send({
      t: 'tool_call',
      id: 'bg1',
      name: 'Agent',
      input: {
        description: '梳理 token 刷新调用点',
        subagent_type: 'Explore',
        run_in_background: true,
        prompt: '找出 refreshIfExpired 的所有调用点'
      }
    })
    send({
      t: 'tool_result',
      id: 'bg1',
      status: 'ok',
      content: 'Async agent launched successfully.',
      agent: {
        agentId: 'task-bg1',
        agentType: 'Explore',
        status: 'async_launched',
        async: true
      }
    })
    send({
      t: 'task_started',
      taskId: 'task-bg1',
      toolUseId: 'bg1',
      description: '梳理 token 刷新调用点',
      agentType: 'Explore',
      isBackground: true
    })
    send({
      t: 'task_progress',
      taskId: 'task-bg1',
      toolUseId: 'bg1',
      agentType: 'Explore',
      totalTokens: 1234,
      toolUses: 5,
      durationMs: 45000,
      lastToolName: 'Read',
      summary: '正在读取 src/auth/store.ts'
    })
    send({ t: 'text_delta', text: '后台代理已经在跑，这一轮主对话先结束。' })
    send({
      t: 'turn_end',
      durationMs: 8000,
      steps: 1,
      usage: {
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        tokensPerSecond: 12,
        contextPercent: 4
      }
    })
    status('idle')
    await new Promise((r) => setTimeout(r, 900))

    if (process.env.SHOT_BACKGROUND_DONE) {
      send({
        t: 'task_notification',
        taskId: 'task-bg1',
        toolUseId: 'bg1',
        status: 'completed',
        summary: '已定位 6 处调用点，其中 2 处缺少并发保护。',
        totalTokens: 2000,
        toolUses: 8,
        durationMs: 72000
      })
      await new Promise((r) => setTimeout(r, 700))
    }
  }

  if (process.env.SHOT_SECOND_TURN) {
    send({ t: 'user_message', text: '继续：把并发保护的回归跑一遍。', at: new Date().toISOString() })
    send({ t: 'thinking_delta', text: '先收尾上一轮，再让一个新的子代理跑并发回归。' })
    update('tu5', 4, 'in_progress', 'completed')
    // 第二轮新建的任务应该出现在任务列表最上面
    send({
      t: 'tool_call',
      id: 'tc6',
      name: 'TaskCreate',
      input: {
        subject: '跑并发回归',
        description: '并发刷新 + 失败分支回归',
        activeForm: '正在跑并发回归'
      }
    })
    send({
      t: 'tool_result',
      id: 'tc6',
      status: 'ok',
      content: 'Task #6 created successfully: 跑并发回归',
      task: { created: { id: '6', subject: '跑并发回归' } }
    })
    update('tu6', 6, 'pending', 'in_progress')
    send({
      t: 'tool_call',
      id: 'ag3',
      name: 'Agent',
      input: {
        description: '跑并发刷新回归',
        subagent_type: 'general-purpose',
        prompt: '跑 token 刷新的并发回归并汇总失败用例'
      }
    })
    send({ t: 'text_delta', text: '上一轮的子代理结果都还在，这一轮新开的代理已经顶到最上面。' })
    await new Promise((r) => setTimeout(r, 900))
  }

  if (process.env.SHOT_MANY) {
    for (let i = 0; i < 24; i++) {
      const id = `many-task-${i}`
      const taskId = String(100 + i)
      const subject = `批量任务 ${i + 1}`
      send({
        t: 'tool_call',
        id,
        name: 'TaskCreate',
        input: { subject, description: subject, activeForm: `正在处理${subject}` }
      })
      send({
        t: 'tool_result',
        id,
        status: 'ok',
        content: `Task #${taskId} created successfully: ${subject}`,
        task: { created: { id: taskId, subject } }
      })
    }
    for (let i = 0; i < 10; i++) {
      send({
        t: 'tool_call',
        id: `many-agent-${i}`,
        name: 'Agent',
        input: {
          description: `并行子任务 ${i + 1}`,
          subagent_type: i % 2 ? 'Explore' : 'general-purpose',
          prompt: '演示滚动'
        }
      })
    }
    await new Promise((r) => setTimeout(r, 900))
  }

  if (process.env.SHOT_COLLAPSE) {
    await win.webContents.executeJavaScript(`document.querySelector('.chip--icon')?.click()`)
    await new Promise((r) => setTimeout(r, 500))
  }
  if (process.env.SHOT_TRACE) {
    await win.webContents.executeJavaScript(`document.querySelector('.runpanel__link')?.click()`)
    await new Promise((r) => setTimeout(r, 500))
  }

  const img = await win.webContents.capturePage()
  fs.writeFileSync(out, img.toPNG())
  console.log('wrote', out)
  app.quit()
})
