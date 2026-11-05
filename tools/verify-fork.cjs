/*
 * 会话分叉的参数映射：
 *   1. Claude：--resume 存在时，fork 必须带 --fork-session；没有 resume 时忽略；
 *   2. Codex：fork + resume 走 thread/fork，普通 resume 走 thread/resume，
 *      全新会话走 thread/start；fork 没有源 id 时不能误发 thread/fork。
 *
 * 用法（先 npx esbuild 打包，见 package.json 的 verify:fork）：
 *   node tools/verify-fork.cjs
 */
const assert = require('node:assert/strict')

const { buildClaudeArgs } = require('../.tmp-build/claude-adapter.cjs')
const { codexThreadRequest } = require('../.tmp-build/codex-adapter.cjs')

let n = 0
const test = (name, fn) => {
  fn()
  n++
  console.log(`  ok ${name}`)
}

const base = {
  model: '',
  permissionMode: 'standard',
  addDirs: []
}

console.log('Claude --fork-session')
test('resume + fork → 同时带 --resume 与 --fork-session', () => {
  const args = buildClaudeArgs({ ...base, resumeId: 'abc', fork: true })
  assert.equal(args[args.indexOf('--resume') + 1], 'abc')
  assert.ok(args.includes('--fork-session'))
})
test('resume 不带 fork → 没有 --fork-session', () => {
  const args = buildClaudeArgs({ ...base, resumeId: 'abc' })
  assert.ok(args.includes('--resume'))
  assert.ok(!args.includes('--fork-session'))
})
test('全新会话即使 fork=true 也不能带 --fork-session', () => {
  const args = buildClaudeArgs({ ...base, fork: true })
  assert.ok(!args.includes('--fork-session'))
})

console.log('Codex thread/fork')
const params = { cwd: 'C:\\work', approvalPolicy: 'untrusted', permissions: ':read-only' }
test('resume + fork → thread/fork', () => {
  const r = codexThreadRequest('thread-1', true, params)
  assert.equal(r.method, 'thread/fork')
  assert.equal(r.params.threadId, 'thread-1')
  assert.equal(r.params.excludeTurns, true)
  assert.equal(r.params.cwd, params.cwd)
})
test('只 resume → thread/resume', () => {
  const r = codexThreadRequest('thread-1', false, params)
  assert.equal(r.method, 'thread/resume')
  assert.equal(r.params.threadId, 'thread-1')
})
test('全新会话 → thread/start', () => {
  const r = codexThreadRequest(null, false, params)
  assert.equal(r.method, 'thread/start')
  assert.equal(r.params.threadId, undefined)
})
test('没有源 id 的 fork 不能误发 thread/fork', () => {
  const r = codexThreadRequest(null, true, params)
  assert.equal(r.method, 'thread/start')
})

console.log(`\n${n} 项检查全部通过`)
