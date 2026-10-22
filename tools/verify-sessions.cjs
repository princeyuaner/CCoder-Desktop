/*
 * 验证会话索引与历史回放 —— 直接读真实的 ~/.claude/projects。
 * 不碰网络，所以很快。
 * 用法：esbuild 打包 session-store 后 node tools/verify-sessions.cjs
 */
const { listStoredSessions, readTranscript } = require('./_session-store.cjs')

let failed = 0
function check(label, cond, detail) {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : String(detail).slice(0, 200))
  }
}

console.log('\n[1] 扫描会话索引')
const t0 = Date.now()
const list = listStoredSessions()
const ms = Date.now() - t0
console.log(`  扫到 ${list.length} 份会话，耗时 ${ms}ms`)

check('扫到了会话', list.length > 0, list.length)
check(`扫描在 5 秒内（实际 ${ms}ms）`, ms < 5000)
check('每条都有 id', list.every((s) => typeof s.id === 'string' && s.id.length > 0))
check('每条都有 cwd', list.every((s) => typeof s.cwd === 'string' && s.cwd.length > 0))
check('每条都有标题', list.every((s) => typeof s.title === 'string' && s.title.length > 0))
check(
  '按时间倒序',
  list.every((s, i) => i === 0 || list[i - 1].updatedAt >= s.updatedAt)
)
// 身份是 (cwd, id)：同一个 id 出现在两个项目目录下是合法的，不算重复
check(
  '(cwd,id) 无重复',
  new Set(list.map((s) => `${s.cwd}\u0000${s.id}`)).size === list.length,
  `${list.length} 条里有 ${list.length - new Set(list.map((s) => `${s.cwd}\u0000${s.id}`)).size} 条重复`
)
const dupIds = list.length - new Set(list.map((s) => s.id)).size
console.log(`  其中 ${dupIds} 条 id 跨工作区重复（合法，靠 cwd 区分）`)

const noTitle = list.filter((s) => s.title === '(无标题)').length
console.log(`  其中 ${noTitle} 条没抓到标题（无用户输入的空会话）`)

// 系统注入的内容（/clear 的 caveat、斜杠命令展开等）不该当标题
const injected = list.filter((s) =>
  /^<(local-command|command-name|command-message|command-args|system-reminder|user-prompt-submit-hook)/i.test(
    s.title
  )
)
check(
  '标题里没有系统注入的消息',
  injected.length === 0,
  injected.slice(0, 3).map((s) => s.title).join(' | ')
)

// 分组是否像样
const byCwd = new Map()
for (const s of list) byCwd.set(s.cwd, (byCwd.get(s.cwd) ?? 0) + 1)
console.log(`  分布在 ${byCwd.size} 个工作区`)
check('工作区数 > 1', byCwd.size > 1, byCwd.size)
const biggest = [...byCwd.entries()].sort((a, b) => b[1] - a[1])[0]
console.log(`  最大的工作区: ${biggest[0]} (${biggest[1]} 份)`)

console.log('\n[2] 历史回放')
// 挑一份内容最丰富的来测
const target = list.find((s) => s.title !== '(无标题)')
check('找到可测的会话', !!target, target?.id)

const events = readTranscript(target.cwd, target.id)
console.log(`  回放 ${events.length} 条事件`)
const types = {}
for (const e of events) types[e.t] = (types[e.t] ?? 0) + 1
console.log('  事件分布:', JSON.stringify(types))

check('回放出了事件', events.length > 0)
check('以 user_message 开头', events[0]?.t === 'user_message', events[0]?.t)
check('有文本', events.some((e) => e.t === 'text_delta'))
check('有 turn_end（轮次被封口）', events.some((e) => e.t === 'turn_end'))
check(
  'turn_end 数量 <= user_message 数量',
  types.turn_end <= types.user_message,
  `${types.turn_end} vs ${types.user_message}`
)
check('user_message 带时间戳', events.find((e) => e.t === 'user_message')?.at?.length > 0)
check(
  '没有未知事件类型',
  events.every((e) =>
    [
      'user_message',
      'text_delta',
      'thinking_delta',
      'tool_call',
      'tool_result',
      'turn_end',
      'task_started',
      'task_progress',
      'task_updated',
      'task_notification'
    ].includes(e.t)
  ),
  Object.keys(types).join(',')
)

// 工具调用与结果应当成对
const callIds = new Set(events.filter((e) => e.t === 'tool_call').map((e) => e.id))
const resultIds = new Set(events.filter((e) => e.t === 'tool_result').map((e) => e.id))
const orphans = [...resultIds].filter((id) => !callIds.has(id))
console.log(`  ${callIds.size} 次工具调用, ${resultIds.size} 条结果, ${orphans.length} 条结果没有对应调用`)
check('绝大多数结果能对上调用', orphans.length <= resultIds.size * 0.2, orphans.length)

console.log('\n[3] 边界')
check('不存在的 id 返回空数组', readTranscript('C:\\nope', 'no-such-session-id').length === 0)
// 同一个 id 换一个 cwd 去读，不该读到别人的内容
const otherCwd = [...byCwd.keys()].find((c) => c !== target.cwd)
check(
  '换错 cwd 读不到（身份含 cwd）',
  !otherCwd || readTranscript(otherCwd, target.id).length === 0 || otherCwd === target.cwd
)

console.log(`\n${failed === 0 ? '全部通过 ✓' : `${failed} 项失败 ✗`}`)
process.exit(failed === 0 ? 0 : 1)
