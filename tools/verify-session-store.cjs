/*
 * 回归：会话记录的异步读取与只读尾部。
 *
 * 覆盖：
 *   1. 小文件完整回放；
 *   2. 超过 4MB 的文件只读尾部，仍然补齐最后 MAX_RECORDS 条；
 *   3. 同一份文件第二次打开命中回放缓存（返回同一个数组）；
 *   4. 文件追加后缓存失效，能读到新记录；
 *   5. listStoredSessions 异步扫描能拿到 cwd / 标题。
 *
 * 用法（见 package.json 的 verify:session-store）：
 *   node tools/verify-session-store.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/* 先把 HOME 指到临时目录 —— session-store 的 ROOT() 依赖 os.homedir() */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-store-'))
process.env.USERPROFILE = home
process.env.HOME = home

const { listStoredSessions, readTranscript, searchStoredSessions } = require(
  '../.tmp-build/session-store-probe.cjs'
)

let failed = 0
let passed = 0
const check = (label, cond, detail) => {
  if (cond) {
    passed++
    console.log('  PASS', label)
  } else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500))
  }
}

const projectDir = path.join(home, '.claude', 'projects', '-tmp-test-project')
fs.mkdirSync(projectDir, { recursive: true })

const cwd = path.join(home, 'workspace')
const record = (i, text, pad = 0) =>
  JSON.stringify({
    type: 'user',
    cwd,
    timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    message: { role: 'user', content: text },
    // 撑大文件，逼读取走"先读尾再往前扩"的路径
    pad: pad > 0 ? 'x'.repeat(pad) : undefined
  })

;(async () => {
  console.log('══ 会话记录读取检查 ══\n')

  /* 1. 小文件 */
  const smallId = '11111111-1111-1111-1111-111111111111'
  const smallFile = path.join(projectDir, `${smallId}.jsonl`)
  fs.writeFileSync(
    smallFile,
    [record(0, 'small one'), record(1, 'small two'), record(2, 'small three')].join('\n') + '\n'
  )

  const small = await readTranscript(cwd, smallId)
  check(
    '小文件完整回放',
    small.filter((e) => e.t === 'user_message').map((e) => e.text).join('|') ===
      'small one|small two|small three',
    small.map((e) => e.t)
  )

  /* 2. 大文件：25001 条、约 15MB */
  const bigId = '22222222-2222-2222-2222-222222222222'
  const bigFile = path.join(projectDir, `${bigId}.jsonl`)
  const TOTAL = 25_001
  const lines = []
  for (let i = 0; i < TOTAL; i++) lines.push(record(i, `msg ${i}`, 480))
  fs.writeFileSync(bigFile, lines.join('\n') + '\n')
  check('测试文件确实超过尾部起步大小', fs.statSync(bigFile).size > 4 * 1024 * 1024)

  const big = await readTranscript(cwd, bigId)
  const bigTexts = big.filter((e) => e.t === 'user_message').map((e) => e.text)
  check('大文件只回放最后 20000 条', bigTexts.length === 20_000, bigTexts.length)
  check('大文件起点正确', bigTexts[0] === 'msg 5001', bigTexts[0])
  check('大文件终点正确', bigTexts[bigTexts.length - 1] === 'msg 25000', bigTexts.at(-1))

  /* 3. 回放缓存 */
  const again = await readTranscript(cwd, bigId)
  check('第二次打开命中缓存', again === big)

  /* 4. 追加后缓存失效 */
  fs.appendFileSync(bigFile, record(TOTAL, `msg ${TOTAL}`, 480) + '\n')
  const grown = await readTranscript(cwd, bigId)
  const grownTexts = grown.filter((e) => e.t === 'user_message').map((e) => e.text)
  check('追加后仍然是最后 20000 条', grownTexts.length === 20_000, grownTexts.length)
  check('追加后能看到新记录', grownTexts.at(-1) === 'msg 25001', grownTexts.at(-1))
  check('追加后不再复用旧数组', grown !== big)

  /* 5. 会话列表 */
  const list = await listStoredSessions()
  const smallRow = list.find((s) => s.id === smallId)
  const bigRow = list.find((s) => s.id === bigId)
  check('列表能扫到小会话', !!smallRow)
  check('列表能扫到大文件', !!bigRow)
  check('列表标题取首条用户消息', smallRow?.title === 'small one', smallRow?.title)
  check('列表 cwd 正确', smallRow?.cwd === cwd, smallRow?.cwd)

  /* 6. 搜索也能正常工作（复用异步 readTranscript） */
  const search = await searchStoredSessions('small two')
  check(
    '搜索命中并带出片段',
    search.hits.some((h) => h.id === smallId),
    search.hits.map((h) => h.id)
  )

  fs.rmSync(home, { recursive: true, force: true })
  console.log(`\n${failed === 0 ? `全部通过 ✓ (${passed} 项)` : `${failed} 项失败 ✗ / ${passed} 项通过`}`)
  process.exit(failed === 0 ? 0 : 1)
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
