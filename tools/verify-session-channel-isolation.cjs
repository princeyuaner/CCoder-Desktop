/*
 * 会话级渠道隔离：A 工作区的对话切了渠道，B 工作区的对话不能跟着换。
 *
 * 不接真实 CLI —— 只建 Live（还没发消息，所以不会 spawn），检查
 * SessionManager 记在每条 Live 上的凭据解析。覆盖：
 *   1. 两条同时开的会话各用各的渠道；
 *   2. 改一条会话的渠道只影响它自己；
 *   3. 设置页改默认渠道时，显式选过的会话不跟、没选过的会话跟；
 *   4. 设置页删掉某条会话正在用的渠道后，它回落到默认渠道；
 *   5. 打开已有会话时带上 session-meta 里的渠道。
 *
 * 用法（先 npx esbuild 打包，见 package.json 的 verify:session-channel）：
 *   node tools/verify-session-channel-isolation.cjs
 */
const { SessionManager } = require('../.tmp-build/session-manager.cjs')

const ch = (id, name, model) => ({
  id,
  name,
  kind: 'anthropic',
  baseUrl: `https://${id}.test/anthropic`,
  model,
  models: [],
  smallFastModel: '',
  authMode: 'token',
  authToken: `sk-${id}`,
  extraEnv: []
})

const settings = (patch = {}) => {
  const base = {
    clis: {
      claude: {
        enabled: true,
        activeChannelId: 'ch-a',
        channels: [ch('ch-a', 'A', 'model-a'), ch('ch-b', 'B', 'model-b')],
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
  }
  return { ...base, ...patch }
}

let current = settings()
const events = []
const statuses = []
const manager = new SessionManager(
  () => current,
  (p) => events.push(p),
  (p) => statuses.push(p)
)

let failed = 0
const check = (label, cond, detail) => {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/*
 * authFor 是私有的，但断言的是"下一条消息会走哪个渠道"。这里直接读
 * Live（start 返回的 id 能从 manager 的私有 map 间接验证），改用行为面：
 * 通过 send 的报错 / 无报错太依赖进程，所以借 status 以外的私有字段。
 * 私有字段在 CJS 打包后仍是普通属性，读得到。
 */
const liveOf = (id) => manager.live.get(id)
const channelOf = (id) => {
  const s = liveOf(id)
  if (!s) return null
  if (s.authMode === 'official') return null
  const id2 = s.channelId
  return current.clis[s.cli].channels.find((c) => c.id === id2) ?? null
}

const start = (cwd, extra = {}) =>
  manager.start({ cli: 'claude', cwd, permissionMode: 'standard', ...extra })

console.log('\n[1] 两条会话各用各的渠道')
const a = start('C:\\work\\A', { channelId: 'ch-a', authMode: 'channel' })
const b = start('C:\\work\\B', { channelId: 'ch-b', authMode: 'channel' })
check('A 用 ch-a', channelOf(a)?.id === 'ch-a', channelOf(a)?.id)
check('B 用 ch-b', channelOf(b)?.id === 'ch-b', channelOf(b)?.id)

console.log('\n[2] 改 A 的渠道只影响 A')
manager.reconfigure(a, { authMode: 'channel', channelId: 'ch-b' })
check('A 变成 ch-b', channelOf(a)?.id === 'ch-b', channelOf(a)?.id)
check('B 仍是 ch-b（未被波及）', channelOf(b)?.id === 'ch-b', channelOf(b)?.id)
check('设置里的默认渠道没被改写', current.clis.claude.activeChannelId === 'ch-a')

console.log('\n[3] 设置页改默认渠道')
const followed = start('C:\\work\\C') // 没显式选过 → 跟随默认
const explicit = start('C:\\work\\D', { authMode: 'channel', channelId: 'ch-a' })
check('C 初始跟随 ch-a', channelOf(followed)?.id === 'ch-a', channelOf(followed)?.id)

const before = current
current = settings({
  clis: {
    ...current.clis,
    claude: { ...current.clis.claude, activeChannelId: 'ch-b' }
  }
})
manager.settingsChanged(before, current)
check('C（跟随默认）跟到 ch-b', channelOf(followed)?.id === 'ch-b', channelOf(followed)?.id)
check('D（显式选过）仍留在 ch-a', channelOf(explicit)?.id === 'ch-a', channelOf(explicit)?.id)
check('A（显式选过）仍留在 ch-b', channelOf(a)?.id === 'ch-b', channelOf(a)?.id)

console.log('\n[4] 默认渠道被删掉')
const before2 = current
current = settings({
  clis: {
    ...current.clis,
    claude: {
      ...current.clis.claude,
      channels: [ch('ch-a', 'A', 'model-a')],
      activeChannelId: 'ch-a'
    }
  }
})
manager.settingsChanged(before2, current)
check('C（原用 ch-b，已删除）回落到 ch-a', channelOf(followed)?.id === 'ch-a', channelOf(followed)?.id)
check('D 仍用 ch-a', channelOf(explicit)?.id === 'ch-a', channelOf(explicit)?.id)

console.log('\n[5] 打开已有会话时带上自己那份渠道')
// 上一步把 ch-b 删了 —— 先加回来，这一步验的是"会话记的渠道优先"
const before3 = current
current = settings()
manager.settingsChanged(before3, current)
const stored = start('C:\\work\\E', {
  resumeId: 'sess-e',
  authMode: 'channel',
  channelId: 'ch-b'
})
check('E 用 ch-b（会话自己记的）', channelOf(stored)?.id === 'ch-b', channelOf(stored)?.id)
check('E 不跟随默认值', liveOf(stored)?.followsDefaultAuth === false)

console.log('\n[5b] 记下的渠道已不存在 → 回落到默认渠道')
const stale = start('C:\\work\\G', {
  resumeId: 'sess-g',
  authMode: 'channel',
  channelId: 'ch-deleted'
})
check('G 回落到默认 ch-a', channelOf(stale)?.id === 'ch-a', channelOf(stale)?.id)

console.log('\n[6] 官方登录来源同样按会话隔离')
const off = start('C:\\work\\F', { authMode: 'official' })
check('F 是 official', liveOf(off)?.authMode === 'official', liveOf(off)?.authMode)
check('F 没有渠道', channelOf(off) === null)
check('D 仍是 channel', liveOf(explicit)?.authMode === 'channel', liveOf(explicit)?.authMode)

console.log(`\n${failed === 0 ? '渠道隔离验证通过 ✓' : `${failed} 项失败 ✗`}`)
process.exit(failed === 0 ? 0 : 1)
