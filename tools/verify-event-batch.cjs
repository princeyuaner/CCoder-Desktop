/*
 * 回归：流式增量合并器。
 *
 * 覆盖：
 *   1. 相邻同类 delta 合并成一条；
 *   2. 中间换了类型不合并，保持原顺序；
 *   3. 非增量事件到达前先 flush 同一会话；
 *   4. 不同会话互不干扰；
 *   5. 定时器会自动 flush；
 *   6. 状态事件前的 flush 不会带出别的会话的增量。
 *
 * 用法（见 package.json 的 verify:event-batch）：
 *   node tools/verify-event-batch.cjs
 */
const { SessionEventBatcher } = require('../.tmp-build/session-event-batcher.cjs')

let failed = 0
let passed = 0
const check = (label, cond, detail) => {
  if (cond) {
    passed++
    console.log('  PASS', label)
  } else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400))
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const delta = (t, text) => ({ t, text })
const p = (sessionId, event) => ({ sessionId, event })

;(async () => {
  console.log('══ 流式增量合并检查 ══\n')

  /* 1. 相邻同类合并 */
  {
    const out = []
    const b = new SessionEventBatcher((x) => out.push(x), 1000)
    b.push(p('a', delta('text_delta', 'he')))
    b.push(p('a', delta('text_delta', 'llo')))
    check('定时器前不发送', out.length === 0)
    b.flush('a')
    check(
      '相邻 text_delta 合并',
      out.length === 1 && out[0].event.t === 'text_delta' && out[0].event.text === 'hello',
      out
    )
  }

  /* 2. 类型切换不合并，顺序保留 */
  {
    const out = []
    const b = new SessionEventBatcher((x) => out.push(x), 1000)
    b.push(p('a', delta('text_delta', 'A')))
    b.push(p('a', delta('thinking_delta', 'B')))
    b.push(p('a', delta('text_delta', 'C')))
    b.flush()
    check(
      '类型切换按原顺序输出',
      out.map((x) => `${x.event.t}:${x.event.text}`).join(',') ===
        'text_delta:A,thinking_delta:B,text_delta:C',
      out.map((x) => `${x.event.t}:${x.event.text}`)
    )
  }

  /* 3. 非增量事件先 flush 同一会话 */
  {
    const out = []
    const b = new SessionEventBatcher((x) => out.push(x), 1000)
    b.push(p('a', delta('text_delta', 'tail')))
    b.push(p('a', { t: 'tool_call', id: 't1', name: 'Read', input: {} }))
    check(
      '非增量事件前先送正文',
      out.length === 2 && out[0].event.t === 'text_delta' && out[1].event.t === 'tool_call',
      out
    )
    check('flush 后没有残留', b.pending.size === 0)
  }

  /* 4. 不同会话互不干扰 */
  {
    const out = []
    const b = new SessionEventBatcher((x) => out.push(x), 1000)
    b.push(p('a', delta('text_delta', 'A')))
    b.push(p('b', delta('text_delta', 'B')))
    b.flush('a')
    check('只 flush 指定会话', out.length === 1 && out[0].sessionId === 'a', out)
    b.flush('b')
    check('另一个会话随后送出', out.length === 2 && out[1].sessionId === 'b', out)
  }

  /* 5. 定时器自动 flush */
  {
    const out = []
    const b = new SessionEventBatcher((x) => out.push(x), 20)
    b.push(p('a', delta('text_delta', 'auto')))
    await sleep(60)
    check(
      '定时器自动送出',
      out.length === 1 && out[0].event.text === 'auto',
      out
    )
  }

  /* 6. 状态前 flush 不带出别的会话 */
  {
    const out = []
    const b = new SessionEventBatcher((x) => out.push(x), 1000)
    b.push(p('a', delta('text_delta', 'A')))
    b.push(p('b', delta('text_delta', 'B')))
    b.flush('a')
    b.flush('a')
    check('重复 flush 不重复发送', out.length === 1, out)
    check('别的会话仍挂起', b.pending.has('b'))
  }

  console.log(`\n${failed === 0 ? `全部通过 ✓ (${passed} 项)` : `${failed} 项失败 ✗ / ${passed} 项通过`}`)
  process.exit(failed === 0 ? 0 : 1)
})()
