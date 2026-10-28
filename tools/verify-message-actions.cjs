/*
 * 「编辑并重发 / 复制消息 / 拖入文件」的纯逻辑校验。
 *
 * 这三条都靠 ideRef.ts 的解析 / 重组：把它们做错的表现是「引用的代码丢了」
 * 或者「输入框里冒出一堆 <ide_reference> 标签」—— 界面上很难一眼看出是
 * 编码层的问题。这里直接对着编解码往返断言。
 *
 * 用法：npx esbuild src/renderer/src/ideRef.ts --bundle --platform=node \
 *         --format=cjs --alias:@shared=./src/shared --outfile=tools/_ide-ref.cjs
 *       node tools/verify-message-actions.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

// ideRef 会 import './i18n'（要一个 window 才能在 Node 里跑）
global.window = global.window || {
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
}

const { formatIdeRef, composeIdeMessage, parseIdeRefs, draftFromUserText, userMessagePlainText } =
  require('./_ide-ref.cjs')

let failed = 0
function check(label, cond, detail) {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400))
  }
}

const CWD = 'C:/proj'
const ref = {
  id: 'r1',
  kind: 'selection',
  rel: 'src/app.ts',
  path: 'C:/proj/src/app.ts',
  name: 'app.ts',
  startLine: 10,
  endLine: 12,
  lang: 'ts',
  code: 'const a = 1\nconst b = 2\nconst c = 3',
  totalLines: 40,
  cwd: CWD
}

console.log('\n[1] 正文编解码往返')
{
  const body = composeIdeMessage('帮我看看这段', [ref])
  check('正文含用户原话', body.startsWith('帮我看看这段'))
  const parsed = parseIdeRefs(body)
  check('原话解析回来', parsed.text === '帮我看看这段', parsed.text)
  check('引用数量', parsed.refs.length === 1, parsed.refs.length)
  check('引用路径', parsed.refs[0].rel === 'src/app.ts', parsed.refs[0].rel)
  check('引用行号', parsed.refs[0].lines === '10-12', parsed.refs[0].lines)
  check('引用代码完整', parsed.refs[0].code === ref.code, parsed.refs[0].code)
}

console.log('\n[2] 编辑重发：正文 → 草稿')
{
  const body = composeIdeMessage('改一下这边', [ref])
  const draft = draftFromUserText(body, CWD)
  check('草稿原话', draft.text === '改一下这边', draft.text)
  check('草稿引用 1 条', draft.refs.length === 1, draft.refs.length)
  check('kind = selection', draft.refs[0].kind === 'selection', draft.refs[0].kind)
  check('绝对路径重建', draft.refs[0].path === 'C:/proj/src/app.ts', draft.refs[0].path)
  check('文件名重建', draft.refs[0].name === 'app.ts', draft.refs[0].name)
  check('起始行', draft.refs[0].startLine === 10, draft.refs[0].startLine)
  check('结束行', draft.refs[0].endLine === 12, draft.refs[0].endLine)
  check('语言', draft.refs[0].lang === 'ts', draft.refs[0].lang)
  check('代码', draft.refs[0].code === ref.code, draft.refs[0].code)
  // 关键：草稿再发一次，编出来的正文要和原来一致（除了围栏长度可能变化）
  const again = composeIdeMessage(draft.text, draft.refs)
  check('再发一次仍是同一条引用', parseIdeRefs(again).refs.length === 1)
  check('代码没被正文吞掉', parseIdeRefs(again).refs[0].code === ref.code)
}

console.log('\n[3] 整文件引用')
{
  const whole = { ...ref, kind: 'file', startLine: undefined, endLine: undefined }
  const body = composeIdeMessage('', [whole])
  const draft = draftFromUserText(body, CWD)
  check('空原话走默认引导语', draft.text.length > 0, draft.text)
  check('整文件 kind = file', draft.refs[0].kind === 'file', draft.refs[0].kind)
  check('整文件不带行号', draft.refs[0].startLine === undefined, draft.refs[0].startLine)
}

console.log('\n[4] 复制消息：引用转 Markdown')
{
  const body = composeIdeMessage('看看吧', [ref])
  const text = userMessagePlainText(body)
  check('不含 ide_reference 标签', !text.includes('<ide_reference'), text.slice(0, 80))
  check('含围栏代码块', text.includes('```'), text.slice(0, 120))
  check('含路径', text.includes('src/app.ts'))
  check('含代码', text.includes('const b = 2'))
  check('没有引用时原样返回', userMessagePlainText('就一句话') === '就一句话')
}

console.log('\n[5] 代码里带反引号不会截断围栏')
{
  const tricky = { ...ref, code: 'const s = `a`\nconst t = ```' }
  const body = composeIdeMessage('看', [tricky])
  const parsed = parseIdeRefs(body)
  check('围栏没被内容撞断', parsed.refs.length === 1, parsed.refs.length)
  check('代码原样', parsed.refs[0].code === tricky.code, parsed.refs[0].code)
}

console.log('\n[6] 文件附件读取（fileAttach）')
{
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'src', 'fileAttach.ts'),
    'utf8'
  )
  // 结构断言：这几条错了会静默丢内容，界面看不出来
  check('图片扩展名交给图片通道', /IMAGE_EXT\.test\(name\)/.test(src))
  check('二进制扩展名被跳过', /BINARY_EXT\.test\(name\)/.test(src))
  check('NUL 探测当二进制', /bytes\[i\] === 0/.test(src))
  check('有单文件字节上限', /MAX_BYTES = \d+ \* 1024/.test(src))
  check('有行数上限', /MAX_LINES = \d+/.test(src))
  check('截断会标记 truncated', /truncated: true/.test(src))
  check('来源标成 file', /origin: 'file'/.test(src))
  check('CRLF 归一成 LF', /replace\(\/\\r\\n\?\/g, '\\n'\)/.test(src))
}

console.log('\n[7] 会话内查找的分词边界')
{
  // useFind 里 itemText 的取舍：这些类型必须有文本，否则搜不到
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'useFind.ts'), 'utf8')
  for (const kind of ["case 'user'", "case 'text'", "case 'thinking'", "case 'tool'", "case 'error'"]) {
    check(`${kind} 参与查找`, src.includes(kind), kind)
  }
  check('工具输出进查找', /it\.content/.test(src))
  check('单条上限', /MAX_PER_ITEM = \d+/.test(src))
  check('总量上限', /MAX_TOTAL = \d+/.test(src))
}

if (failed > 0) {
  console.log(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
