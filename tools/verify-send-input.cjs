/*
 * buildUserMessage 的结构验证。
 * 运行前由 package.json 的 verify:send 用 esbuild 把 adapter.ts 打成
 * tools/_adapter.cjs（与 verify:turn 共用同一个 bundle）。
 */
const assert = require('node:assert/strict')
const { buildUserMessage } = require('./_adapter.cjs')

const img = (data, mediaType = 'image/png') => ({
  id: 'i1',
  mediaType,
  data,
  name: 'shot.png'
})

let failed = 0
function check(label, fn) {
  try {
    fn()
    console.log(`  ✓ ${label}`)
  } catch (err) {
    failed++
    console.log(`  ✗ ${label}\n    ${err.message}`)
  }
}

check('纯文本 → text block', () => {
  const m = buildUserMessage({ text: '  hello  ' })
  assert.equal(m.type, 'user')
  assert.equal(m.message.role, 'user')
  assert.deepEqual(m.message.content, [{ type: 'text', text: 'hello' }])
})

check('纯图片 → image block', () => {
  const m = buildUserMessage({ text: '', images: [img('AAAA')] })
  assert.deepEqual(m.message.content, [
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' }
    }
  ])
})

check('文本 + 两张图片保持顺序', () => {
  const m = buildUserMessage({
    text: '看这两张',
    images: [img('AAA', 'image/png'), img('BBB', 'image/jpeg')]
  })
  assert.equal(m.message.content.length, 3)
  assert.equal(m.message.content[0].type, 'text')
  assert.equal(m.message.content[1].source.media_type, 'image/png')
  assert.equal(m.message.content[2].source.media_type, 'image/jpeg')
})

check('空 data 的图片被跳过', () => {
  const m = buildUserMessage({ text: 'x', images: [img('')] })
  assert.deepEqual(m.message.content, [{ type: 'text', text: 'x' }])
})

check('空白文本不产生空 text block', () => {
  const m = buildUserMessage({ text: '   ', images: [img('AAAA')] })
  assert.equal(m.message.content.length, 1)
  assert.equal(m.message.content[0].type, 'image')
})

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
