/*
 * IDE 工作区搜索 / 全部替换的纯 Node 验证。
 * 运行前先打包：
 *   npx esbuild src/main/ide-fs.ts --bundle --platform=node --format=cjs \
 *     --outfile=tools/_ide-fs.cjs
 *   node tools/verify-ide-search.cjs
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { searchCode, replaceInWorkspace } = require('./_ide-fs.cjs')

let failed = 0
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}${detail === undefined ? '' : `\n    ${JSON.stringify(detail)}`}`)
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-search-'))

function put(rel, text) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}
function putBytes(rel, buf) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, buf)
}
function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}
function resetFixtures() {
  put('src/a.ts', 'foo Foo foobar\nfoo\n')
  put('src/b.ts', 'foo\r\nfoo foo\r\n')
  put('docs/readme.md', 'foo\n')
  put('node_modules/x.js', 'foo\n')
  put('tools/_bundle.cjs', 'foo\n')
  putBytes('bin.dat', Buffer.from([0x00, 0x66, 0x6f, 0x6f]))
  putBytes('latin1.txt', Buffer.from([0xff, 0xfe, 0x66, 0x6f, 0x6f]))
  put('astral.txt', '😀foo\n')
  putBytes('big.txt', Buffer.concat([Buffer.alloc(1024 * 1024 + 1, 0x20), Buffer.from('foo')]))
}
function matchesOf(data) {
  return data.files.reduce((n, f) => n + f.matches.length, 0)
}
function fileOf(data, rel) {
  return data.files.find((f) => f.rel === rel)
}
async function search(opts) {
  return searchCode({ cwd: root, query: 'foo', ...opts })
}

async function run() {
  resetFixtures()

  /* ── 搜索 ───────────────────────────────────────────── */

  const base = await search({})
  check('默认搜索返回 ok', base.ok === true, base)
  check('默认是大小写不敏感的字面量，一处一行都算', matchesOf(base.data) === 9, matchesOf(base.data))
  check(
    '同一行多处都会返回（src/a.ts 第一行 3 处）',
    fileOf(base.data, 'src/a.ts').matches.filter((m) => m.line === 1).length === 3,
    fileOf(base.data, 'src/a.ts')
  )
  check('忽略 node_modules', !fileOf(base.data, 'node_modules/x.js'))
  check('忽略 tools/_*.cjs', !fileOf(base.data, 'tools/_bundle.cjs'))
  check('跳过含 NUL 的文件', !fileOf(base.data, 'bin.dat'))
  check('跳过非 UTF-8 文件', !fileOf(base.data, 'latin1.txt'))
  check('跳过超过 1 MB 的文件', !fileOf(base.data, 'big.txt'))

  const snippets = base.data.files.flatMap((f) => f.matches)
  check(
    '片段偏移能切回命中原文',
    snippets.every((m) => m.text.slice(m.offset, m.offset + m.length).toLowerCase() === 'foo'),
    snippets.filter((m) => m.text.slice(m.offset, m.offset + m.length).toLowerCase() !== 'foo')
  )

  const astral = fileOf(base.data, 'astral.txt').matches[0]
  check(
    'astral 字符前的 column 按 UTF-16 计算',
    astral.line === 1 && astral.column === 3 && astral.length === 3,
    astral
  )

  const sensitive = await search({ options: { caseSensitive: true } })
  check('caseSensitive 排除 Foo', matchesOf(sensitive.data) === 8, matchesOf(sensitive.data))

  const whole = await search({ options: { wholeWord: true } })
  check('wholeWord 排除 foobar', matchesOf(whole.data) === 8, matchesOf(whole.data))

  const regex = await search({ options: { regex: true }, query: 'f(o+)' })
  check(
    '正则命中长度正确',
    regex.ok && regex.data.files[0].matches[0].length === 3,
    regex.ok && regex.data.files[0].matches[0]
  )

  const longGlob = await search({ options: { include: ['x'.repeat(513)] } })
  check(
    '超长 glob 返回 invalid-glob',
    longGlob.ok === false && longGlob.code === 'invalid-glob',
    longGlob
  )

  const badRegex = await search({ options: { regex: true }, query: '[' })
  check(
    '非法正则返回 invalid-regex',
    badRegex.ok === false && badRegex.code === 'invalid-regex',
    badRegex
  )

  const anchor = await search({ options: { regex: true }, query: '^' })
  check(
    '零长度正则不会死循环，也不产生结果',
    anchor.ok === true && matchesOf(anchor.data) === 0,
    anchor.ok && matchesOf(anchor.data)
  )

  const included = await search({ options: { include: ['src/**'] } })
  check(
    'include glob 只保留 src/**',
    included.ok &&
      included.data.files.length === 2 &&
      included.data.files.every((f) => f.rel.startsWith('src/')),
    included.ok && included.data.files.map((f) => f.rel)
  )

  const excluded = await search({ options: { exclude: ['**/*.md'] } })
  check(
    'exclude glob 去掉 Markdown',
    excluded.ok && !fileOf(excluded.data, 'docs/readme.md'),
    excluded.ok && excluded.data.files.map((f) => f.rel)
  )

  const brace = await search({ options: { include: ['{src,docs}/**'] } })
  check(
    'brace glob 生效',
    brace.ok && brace.data.files.length === 3,
    brace.ok && brace.data.files.map((f) => f.rel)
  )

  /* ── 替换：字面量 ───────────────────────────────────── */

  resetFixtures()
  const literal = await replaceInWorkspace({
    cwd: root,
    query: 'foo',
    replacement: 'bar'
  })
  check('字面量替换返回 ok', literal.ok === true, literal)
  check('字面量替换覆盖全部 9 处', literal.data.totals.replacements === 9, literal.data.totals)
  check('字面量替换改动 4 个文件', literal.data.totals.filesChanged === 4, literal.data.totals)
  check('替换不区分大小写，Foo 也变 bar', read('src/a.ts') === 'bar bar barbar\nbar\n', read('src/a.ts'))
  check('替换保留 CRLF', read('src/b.ts') === 'bar\r\nbar bar\r\n', JSON.stringify(read('src/b.ts')))
  check('node_modules 不被替换', read('node_modules/x.js') === 'foo\n', read('node_modules/x.js'))
  check('大文件不被替换', fs.statSync(path.join(root, 'big.txt')).size > 1024 * 1024)
  check('替换统计二进制文件', literal.data.totals.filesSkippedBinary >= 2, literal.data.totals)
  check('替换统计大文件', literal.data.totals.filesSkippedLarge >= 1, literal.data.totals)

  const after = await searchCode({ cwd: root, query: 'bar' })
  check(
    '替换后搜索立即看到新内容（缓存已重置）',
    after.ok && after.data.matchCount > 0,
    after.ok && after.data.matchCount
  )

  /* ── 替换：正则 / 字面量 $1 ─────────────────────────── */

  resetFixtures()
  const regexReplace = await replaceInWorkspace({
    cwd: root,
    query: 'f(o+)',
    replacement: 'F$1',
    options: { regex: true }
  })
  check('正则替换返回 ok', regexReplace.ok === true, regexReplace)
  check('正则捕获组展开 $1', read('src/a.ts').startsWith('Foo Foo Foobar'), read('src/a.ts'))

  resetFixtures()
  const literalDollar = await replaceInWorkspace({
    cwd: root,
    query: 'foo',
    replacement: '$1',
    options: { caseSensitive: true }
  })
  check('字面量模式不展开 $1', literalDollar.ok && read('src/a.ts').startsWith('$1 Foo'), read('src/a.ts'))

  /* ── 脏文件 / 中止 ──────────────────────────────────── */

  resetFixtures()
  const dirty = await replaceInWorkspace({
    cwd: root,
    query: 'foo',
    replacement: 'bar',
    dirtyRels: ['src/a.ts']
  })
  check('脏文件被跳过', dirty.ok && dirty.data.totals.filesSkippedDirty === 1, dirty)
  check('脏文件磁盘内容不变', read('src/a.ts') === 'foo Foo foobar\nfoo\n', read('src/a.ts'))
  check(
    '跳过项出现在结果里',
    dirty.ok && dirty.data.files.some((f) => f.rel === 'src/a.ts' && f.status === 'skipped'),
    dirty.ok && dirty.data.files
  )

  resetFixtures()
  const aborted = await replaceInWorkspace({
    cwd: root,
    query: 'foo',
    replacement: 'bar',
    maxReplacements: 1
  })
  check('超过匹配上限时中止', aborted.ok && aborted.data.aborted === true, aborted)
  check('中止时一处都没写', read('src/a.ts') === 'foo Foo foobar\nfoo\n', read('src/a.ts'))
  check('中止时 replacements 为 0', aborted.ok && aborted.data.totals.replacements === 0, aborted)

  /* ── 参数错误 ───────────────────────────────────────── */

  const badQuery = await replaceInWorkspace({ cwd: root, query: '[', replacement: 'x', options: { regex: true } })
  check(
    '非法正则的替换请求返回 invalid-regex',
    badQuery.ok === false && badQuery.code === 'invalid-regex',
    badQuery
  )

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
}

run()
  .catch((err) => {
    console.error(err)
    failed++
  })
  .finally(() => {
    fs.rmSync(root, { recursive: true, force: true })
    process.exit(failed === 0 ? 0 : 1)
  })
