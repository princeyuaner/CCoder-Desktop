/*
 * 验证子代理报告的归约：完整正文、失败原因、终态选择器。
 *
 * 用法：
 *   esbuild src/renderer/src/run-state.ts --bundle --platform=node --format=cjs \
 *     --alias:@shared=src/shared --outfile=tools/_run-state.cjs
 *   node tools/verify-agent-report.cjs
 *
 * 纯事件合成，不需要真实 CLI / 会话文件。不参与打包，随时可删。
 */
const assert = require('node:assert')
const {
  emptyRunState,
  reduceRun,
  finishedBackgroundAgents
} = require('./_run-state.cjs')

let failed = 0
function check(name, fn) {
  try {
    fn()
    console.log(`PASS ${name}`)
  } catch (e) {
    failed += 1
    console.log(`FAIL ${name}\n     ${e.message}`)
  }
}

function apply(state, events, live = true) {
  return events.reduce((acc, e) => reduceRun(acc, e, live), state)
}

const LONG_REPORT = [
  'Subagent finished the task.',
  '',
  '## Findings',
  '',
  '- first',
  '- second',
  '',
  '```ts',
  'const x = 1',
  '```',
  '',
  'Tail line for the report.'
].join('\n')

/* ── 前台子代理：完整正文 ─────────────────────────────────── */
const fgCall = {
  t: 'tool_call',
  id: 'fg1',
  name: 'Agent',
  input: { description: '检查登录流程', subagent_type: 'Explore', prompt: 'go' }
}
const fgResult = {
  t: 'tool_result',
  id: 'fg1',
  status: 'ok',
  content: LONG_REPORT,
  agent: {
    agentId: 'task-fg1',
    agentType: 'Explore',
    status: 'completed',
    durationMs: 1234,
    totalTokens: 100,
    toolUseCount: 3
  }
}

check('前台：完整报告保留、result 仍是短摘要', () => {
  const run = apply(emptyRunState(), [fgCall, fgResult])
  const a = run.agents[0]
  assert.equal(a.id, 'fg1')
  assert.equal(a.status, 'ok')
  assert.equal(a.report, LONG_REPORT)
  assert.ok(a.result && a.result.length <= 161, `result 过长: ${a.result && a.result.length}`)
  assert.equal(a.error, undefined)
  assert.equal(a.ms, 1234)
})

check('前台：超长报告按上限截断并留标记', () => {
  const huge = 'x'.repeat(25_000)
  const run = apply(emptyRunState(), [
    fgCall,
    { ...fgResult, content: huge }
  ])
  const a = run.agents[0]
  assert.ok(a.report.startsWith('x'.repeat(20_000)))
  assert.ok(a.report.includes('报告已截断'))
  assert.ok(a.report.includes('25000'))
})

/* ── 后台子代理：async 启动 → 通知 ───────────────────────── */
const bgCall = {
  t: 'tool_call',
  id: 'bg1',
  name: 'Agent',
  input: { description: '后台扫描依赖', subagent_type: 'Explore', run_in_background: true }
}
const bgLaunch = {
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
}
const bgStarted = {
  t: 'task_started',
  taskId: 'task-bg1',
  toolUseId: 'bg1',
  description: '后台扫描依赖',
  agentType: 'Explore',
  isBackground: true
}
const bgDone = {
  t: 'task_notification',
  taskId: 'task-bg1',
  toolUseId: 'bg1',
  status: 'completed',
  summary: LONG_REPORT,
  durationMs: 9000,
  totalTokens: 555,
  toolUses: 7,
  outputFile: 'C:\\tmp\\report.md'
}

check('后台：启动回执不算完成', () => {
  const run = apply(emptyRunState(), [bgCall, bgLaunch, bgStarted])
  const a = run.agents[0]
  assert.equal(a.status, 'running')
  assert.equal(a.isBackground, true)
  assert.equal(a.report, undefined)
})

check('后台：完成通知填 report / outputFile，诱饵摘要保持一行', () => {
  const run = apply(emptyRunState(), [bgCall, bgLaunch, bgStarted, bgDone])
  const a = run.agents[0]
  assert.equal(a.status, 'ok')
  assert.equal(a.report, LONG_REPORT)
  assert.ok(a.result && a.result.length <= 161)
  assert.equal(a.outputFile, 'C:\\tmp\\report.md')
  assert.equal(a.ms, 9000)
})

check('后台：reason 落到 error（失败）', () => {
  const run = apply(emptyRunState(), [
    bgCall,
    bgLaunch,
    bgStarted,
    { ...bgDone, status: 'failed', summary: 'handback text', reason: 'boom' }
  ])
  const a = run.agents[0]
  assert.equal(a.status, 'error')
  assert.equal(a.error, 'boom')
  assert.equal(a.report, 'handback text')
})

/* ── 终态选择器 ───────────────────────────────────────────── */
check('选择器：后台 running → ok 返回 1', () => {
  const prev = apply(emptyRunState(), [bgCall, bgLaunch, bgStarted])
  const next = reduceRun(prev, bgDone)
  assert.equal(finishedBackgroundAgents(prev, next).length, 1)
})

check('选择器：重复通知返回 0', () => {
  const running = apply(emptyRunState(), [bgCall, bgLaunch, bgStarted])
  const done = reduceRun(running, bgDone)
  const again = reduceRun(done, bgDone)
  assert.equal(finishedBackgroundAgents(done, again).length, 0)
  assert.equal(again.agents[0].report, LONG_REPORT)
})

check('选择器：前台终态不提醒', () => {
  const running = apply(emptyRunState(), [fgCall])
  const next = reduceRun(running, fgResult)
  assert.equal(finishedBackgroundAgents(running, next).length, 0)
})

/* ── task_updated 的失败原因 ─────────────────────────────── */
check('task_updated failed：error 单独存、result 不被覆盖', () => {
  const base = apply(emptyRunState(), [
    bgCall,
    bgLaunch,
    bgStarted,
    { ...bgDone, status: 'completed', summary: 'previous summary' }
  ])
  const next = reduceRun(base, {
    t: 'task_updated',
    taskId: 'task-bg1',
    status: 'failed',
    error: 'disk full'
  })
  const a = next.agents[0]
  assert.equal(a.status, 'error')
  assert.equal(a.error, 'disk full')
  assert.equal(a.result, 'previous summary')
})

/* ── 历史回放 ─────────────────────────────────────────────── */
check('历史回放（live=false）仍还原 report，且 startedAt=0', () => {
  const run = apply(emptyRunState(), [fgCall, fgResult], false)
  const a = run.agents[0]
  assert.equal(a.report, LONG_REPORT)
  assert.equal(a.startedAt, 0)
  assert.equal(a.ms, 1234)
})

if (failed > 0) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
