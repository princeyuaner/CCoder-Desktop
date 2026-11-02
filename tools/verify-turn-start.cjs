/*
 * 回归：CLI 自己接着跑的新一轮要正确标记「轮开始」。
 *
 * 后台任务跑完时 CLI 会注入 task-notification 并继续跑模型，宿主没有调用
 * send()，`busy` 还是 false。SessionManager.onEvent 需要靠模型活动事件
 * 认领这一轮；task_* 事件不能当成依据（上一轮结束后它们还会继续到达）。
 *
 * 不接真实 CLI：直接对没发过消息的 Live 调 onEvent，检查 busy / 事件 / 状态。
 *
 * 用法（见 package.json 的 verify:turn-start）：
 *   node tools/verify-turn-start.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { SessionManager } = require('../.tmp-build/session-manager.cjs')

const settings = () => ({
  clis: {
    claude: {
      enabled: true,
      activeChannelId: null,
      channels: [],
      effort: 'medium',
      authMode: 'official',
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
  },
  language: 'zh',
  permissionMode: 'standard',
  defaultCwd: '',
  openedCwds: [],
  theme: 'contrast',
  uiZoom: 1,
  chatFontSize: 14,
  uiFont: '',
  monoFont: '',
  showTimestamps: false,
  thinkingOpen: false,
  toolDetail: 'full',
  sendKey: 'enter',
  notifyOnDone: false,
  editor: {},
  keybindings: {},
  lsp: { enabled: true },
  cliUpdate: { autoCheck: false, tagInNav: false }
})

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-turn-'))
const events = []
const statuses = []
const manager = new SessionManager(
  () => settings(),
  (p) => events.push(p),
  (p) => statuses.push(p)
)

let failed = 0
const check = (label, cond, detail) => {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400))
  }
}

const id = manager.start({ cli: 'claude', cwd, permissionMode: 'standard' })
const live = manager.live.get(id)
if (!live) {
  console.error('无法创建 Live')
  process.exit(1)
}

const turnStarts = () => events.filter((e) => e.event.t === 'turn_started').length
const lastStatus = () => statuses.at(-1)?.status
const lastEvent = () => events.at(-1)?.event

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond, ms = 3000) {
  const started = Date.now()
  while (Date.now() - started < ms) {
    if (cond()) return true
    await sleep(10)
  }
  return false
}

;(async () => {
  console.log('══ 轮开始认领检查 ══\n')

  /* 1. 后台任务事件不能触发新一轮 */
  manager.onEvent(live, { t: 'task_notification', taskId: 't1' })
  manager.onEvent(live, { t: 'task_started', taskId: 't1' })
  manager.onEvent(live, { t: 'task_progress', taskId: 't1' })
  check('task_* 不触发轮开始', live.busy === false && turnStarts() === 0)

  /* 2. 模型活动事件触发新一轮 */
  manager.onEvent(live, { t: 'text_delta', text: 'hello' })
  check('text_delta 触发轮开始', live.busy === true && turnStarts() === 1)
  check('状态推成 running', lastStatus() === 'running', lastStatus())
  check(
    '轮开始事件已下发',
    lastEvent()?.t === 'text_delta' || events.some((e) => e.event.t === 'turn_started')
  )

  /* 3. busy 期间再来活动事件，不能重复开轮 */
  manager.onEvent(live, { t: 'tool_result', toolId: 'x', content: 'ok' })
  check('busy 期间不重复开轮', turnStarts() === 1)

  /* 4. 轮结束后回到 idle（轮末磁盘对比现在是异步的，等它落定） */
  manager.onEvent(live, { t: 'turn_end' })
  const settled = await waitFor(() => live.busy === false && lastStatus() === 'idle')
  check('turn_end 后回到空闲', settled, { busy: live.busy, status: lastStatus() })

  /* 5. 后台任务通知之后 CLI 自己续跑：迟到的活动事件要认领新一轮 */
  manager.onEvent(live, { t: 'task_notification', taskId: 't2' })
  check('续跑前的 task_notification 不单独开轮', live.busy === false && turnStarts() === 1)
  manager.onEvent(live, { t: 'thinking_delta', text: 'thinking' })
  check('续跑的 thinking_delta 认领新一轮', live.busy === true && turnStarts() === 2)

  /* 6. 轮前快照期间打断：消息还没交给 CLI，不能再发出去 */
  const sent = []
  live.busy = false
  live.interrupted = false
  live.session = {
    send: (input) => sent.push(input),
    interrupt: () => {},
    dispose: () => {},
    respondPermission: () => {},
    respondQuestion: () => {},
    command: () => ({ ok: false })
  }
  // 人为拉长快照窗口，模拟大仓库
  const realSnapshot = manager.snapshotForTurn.bind(manager)
  manager.snapshotForTurn = async (s) => {
    await sleep(60)
    return realSnapshot(s)
  }
  const pending = manager.startTurn(live, { text: 'cancel me' }, false)
  manager.interrupt(id)
  const aborted = await pending
  check('快照期间打断后不再发送', aborted === 'aborted' && sent.length === 0, { aborted, sent })
  check('打断后回到空闲', live.busy === false && lastStatus() === 'idle', live.busy)
  manager.snapshotForTurn = realSnapshot

  // 等异步快照收尾再删目录（Windows 上 git 可能还占着句柄）
  await waitFor(() => live.prep === null)
  fs.rmSync(cwd, { recursive: true, force: true })

  console.log(`\n${failed === 0 ? '全部通过 ✓' : `${failed} 项失败 ✗`}`)
  process.exit(failed === 0 ? 0 : 1)
})()
