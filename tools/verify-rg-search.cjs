#!/usr/bin/env node
'use strict'

/**
 * ripgrep 搜索 / 文件列表 / 回退的验证。
 *
 * 先构建：
 *   npx esbuild src/main/rg-path.ts --bundle --platform=node --format=cjs --outfile=tools/_rg-path.cjs
 *   npx esbuild src/main/rg-files.ts --bundle --platform=node --format=cjs --outfile=tools/_rg-files.cjs
 *   npx esbuild src/main/rg-search.ts --bundle --platform=node --format=cjs --outfile=tools/_rg-search.cjs
 *   npx esbuild src/main/ide-search-service.ts --bundle --platform=node --format=cjs --outfile=tools/_ide-search-service.cjs
 *   npx esbuild src/main/ide-fs.ts --bundle --platform=node --format=cjs --outfile=tools/_ide-fs.cjs
 *
 * 然后：
 *   node tools/verify-rg-search.cjs
 */

const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')

const { listFilesWithRg } = require('./_rg-files.cjs')
const { runRgSearch } = require('./_rg-search.cjs')
const { compileSearch, compileGlobs } = require('./_ide-search.cjs')
const {
  startIdeSearch,
  cancelIdeSearch,
  resetIdeSearchService
} = require('./_ide-search-service.cjs')
const { searchCode } = require('./_ide-fs.cjs')
const { resetRgPathState } = require('./_rg-path.cjs')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ✗ ${name}`)
    console.log(`    ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : err}`)
  }
}

function section(name) {
  console.log(`\n${name}`)
}

const root = mkdtempSync(join(tmpdir(), 'ccoder-rg-verify-'))

function write(rel, body) {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, body)
}

write('.gitignore', 'ignored.txt\nignored-dir/\n')
write('.ignore', 'ignored-by-ignore.txt\n')
write('ignored.txt', 'foo\n')
write('ignored-by-ignore.txt', 'foo\n')
write('ignored-dir/inside.txt', 'foo\n')
write('node_modules/x.js', 'foo\n')
write('.env', 'foo\n')
write('secret.pem', 'foo\n')
write('cert.p8', 'foo\n')
write('keystore.jks', 'foo\n')
write('desktop.ini', 'foo\n')
write('tools/_temp.cjs', 'foo\n')
write('.git/config', 'foo\n')
write('.svn/entries', 'foo\n')
write('_svn/entries', 'foo\n')
write('.hg/store/data', 'foo\n')
write('.bzr/branch/format', 'foo\n')
write('CVS/Entries', 'foo\n')
write('.output/server/index.mjs', 'foo\n')
write('.svelte-kit/output/client.js', 'foo\n')
write('.terraform/terraform.tfstate', 'foo\n')
write('.ruff_cache/content', 'foo\n')
write('pkg.egg-info/PKG-INFO', 'foo\n')
write('.tmp/scratch.txt', 'foo\n')
write('.hidden.ts', 'foo\n')
write('src/a.ts', 'const xfoo = 1\nconst foo = 2\nFOO bar\n')
write('src/b.ts', 'foo_bar\n中foo\nfoo\n')
write('src/crlf.txt', 'foo\r\nbar foo\r\n')
write('src/meta.txt', 'literal .* and foo\n')
write('src/word.txt', 'xfoo foo 中foo foo_bar FOO\n')
write('src/unicode.txt', '世界 foo\n😀 foo\n')
write('中文目录/文件.txt', 'foo\n')
write('space dir/a b.txt', 'foo\n')
write('src/bin.dat', Buffer.from([0, 1, 2, 0, 0x66, 0x6f, 0x6f]))
write('src/invalid.txt', Buffer.from([0xff, 0xfe, 0x66, 0x6f, 0x6f]))
write('src/big.txt', 'foo '.repeat(300_000))
for (let i = 0; i < 25; i++) {
  write(`batch/b${String(i).padStart(2, '0')}.txt`, `batchmarker ${i}\n`)
}
for (let i = 0; i < 55; i++) {
  write(`many/m${String(i).padStart(2, '0')}.txt`, `manyneedle ${i}\n`)
}
write('cap.txt', 'capneedle '.repeat(250))

async function collectLiteral(query, options = {}) {
  const search = compileSearch(query, options)
  const globs = compileGlobs(options)
  const batches = []
  const done = await new Promise((resolveDone) => {
    runRgSearch({
      cwd: root,
      search,
      globs,
      onBatch: (files, stats) => batches.push({ files, stats }),
      onDone: (stats) => resolveDone(stats),
      onError: (e) => resolveDone({ error: e })
    })
  })
  const files = batches.flatMap((b) => b.files)
  return { batches, files, done }
}

function byRel(files) {
  return [...files]
    .map((f) => `${f.rel}:${f.matches.length}`)
    .sort((a, b) => a.localeCompare(b))
}

async function main() {
  const stagedRg = resolve(__dirname, '..', 'build', 'rg', process.platform === 'win32' ? 'rg.exe' : 'rg')
  process.env.CCODER_RG_PATH = stagedRg
  resetRgPathState()

  section('[1] rg 路径')
  await test('CCODER_RG_PATH 优先', () => {
    const { resolveRgPath } = require('./_rg-path.cjs')
    assert.equal(resolveRgPath(), stagedRg)
  })
  await test('找不到时返回 null', () => {
    const { resolveRgPath, resetRgPathState: reset } = require('./_rg-path.cjs')
    const oldCwd = process.cwd()
    const oldPath = process.env.PATH
    const oldOverride = process.env.CCODER_RG_PATH
    process.chdir(root)
    process.env.PATH = ''
    delete process.env.CCODER_RG_PATH
    reset()
    try {
      assert.equal(resolveRgPath(), null)
    } finally {
      process.chdir(oldCwd)
      process.env.PATH = oldPath
      process.env.CCODER_RG_PATH = oldOverride
      reset()
    }
  })

  section('[2] rg --files')
  await test('遵循 .gitignore / .ignore', async () => {
    const r = await listFilesWithRg(root)
    assert.equal(r.ok, true)
    const paths = r.files.map((f) => f.path)
    assert.ok(!paths.includes('ignored.txt'))
    assert.ok(!paths.includes('ignored-by-ignore.txt'))
    assert.ok(!paths.includes('ignored-dir/inside.txt'))
  })
  await test('包含隐藏文件，但不扫 .git', async () => {
    const r = await listFilesWithRg(root)
    const paths = r.files.map((f) => f.path)
    assert.ok(paths.includes('.hidden.ts'))
    assert.ok(!paths.some((p) => p.startsWith('.git/')))
    for (const prefix of [
      '.svn/',
      '_svn/',
      '.hg/',
      '.bzr/',
      'CVS/',
      '.output/',
      '.svelte-kit/',
      '.terraform/',
      '.ruff_cache/',
      'pkg.egg-info/',
      '.tmp/'
    ]) {
      assert.ok(!paths.some((p) => p.startsWith(prefix)), prefix)
    }
  })
  await test('固定忽略表仍生效', async () => {
    const r = await listFilesWithRg(root)
    const paths = r.files.map((f) => f.path)
    assert.ok(!paths.some((p) => p.startsWith('node_modules/')))
    assert.ok(!paths.includes('.env'))
    assert.ok(!paths.includes('secret.pem'))
    assert.ok(!paths.includes('cert.p8'))
    assert.ok(!paths.includes('keystore.jks'))
    assert.ok(!paths.includes('desktop.ini'))
    assert.ok(!paths.includes('tools/_temp.cjs'))
  })
  await test('反推祖先目录', async () => {
    const r = await listFilesWithRg(root)
    const dirs = r.files.filter((f) => f.kind === 'dir').map((f) => f.path)
    assert.ok(dirs.includes('src'))
    assert.ok(dirs.includes('batch'))
    assert.ok(dirs.includes('中文目录'))
    assert.ok(dirs.includes('space dir'))
  })
  await test('非 ASCII / 带空格路径正确', async () => {
    const r = await listFilesWithRg(root)
    const paths = r.files.map((f) => f.path)
    assert.ok(paths.includes('中文目录/文件.txt'))
    assert.ok(paths.includes('space dir/a b.txt'))
    const { files } = await collectLiteral('foo', { caseSensitive: true })
    assert.ok(files.some((f) => f.rel === '中文目录/文件.txt'))
    assert.ok(files.some((f) => f.rel === 'space dir/a b.txt'))
  })
  await test('条目上限会截断', async () => {
    const r = await listFilesWithRg(root, { maxEntries: 3 })
    assert.equal(r.ok, true)
    assert.equal(r.truncated, true)
    assert.ok(r.files.length >= 1)
  })

  section('[3] 字面量搜索')
  await test('默认大小写不敏感，忽略规则与二进制/超大文件', async () => {
    const { files, done } = await collectLiteral('foo')
    assert.ok(done && !done.error)
    const map = byRel(files)
    assert.ok(map.includes('src/a.ts:3'))
    assert.ok(map.includes('src/b.ts:3'))
    assert.ok(!map.some((x) => x.startsWith('big.txt')))
    assert.ok(!map.some((x) => x.startsWith('src/bin.dat')))
    assert.ok(!map.some((x) => x.startsWith('src/invalid.txt')))
    assert.ok(!map.some((x) => x.startsWith('ignored.txt')))
    assert.ok(!map.some((x) => x === 'cert.p8:1'))
    assert.ok(!map.some((x) => x === 'keystore.jks:1'))
    assert.ok(!map.some((x) => x === 'desktop.ini:1'))
    for (const prefix of [
      '.svn/',
      '_svn/',
      '.hg/',
      '.bzr/',
      'CVS/',
      '.output/',
      '.svelte-kit/',
      '.terraform/',
      '.ruff_cache/',
      'pkg.egg-info/',
      '.tmp/'
    ]) {
      assert.ok(!map.some((x) => x.startsWith(prefix)), prefix)
    }
  })
  await test('caseSensitive 排除 FOO', async () => {
    const { files } = await collectLiteral('foo', { caseSensitive: true })
    const a = files.find((f) => f.rel === 'src/a.ts')
    assert.equal(a.matches.length, 2)
  })
  await test('正则元字符按字面量处理', async () => {
    const { files } = await collectLiteral('.*', { caseSensitive: true })
    const meta = files.find((f) => f.rel === 'src/meta.txt')
    assert.ok(meta)
    assert.equal(meta.matches.length, 1)
    assert.equal(meta.matches[0].text.slice(meta.matches[0].offset, meta.matches[0].offset + 2), '.*')
  })
  await test('全字匹配使用 ASCII 边界', async () => {
    const { files } = await collectLiteral('foo', { wholeWord: true, caseSensitive: true })
    const word = files.find((f) => f.rel === 'src/word.txt')
    assert.ok(word)
    assert.equal(word.matches.length, 2)
    assert.deepEqual(word.matches.map((m) => m.column), [6, 11])
  })
  await test('CRLF 片段不包含 \\r', async () => {
    const { files } = await collectLiteral('foo')
    const crlf = files.find((f) => f.rel === 'src/crlf.txt')
    assert.ok(crlf)
    for (const m of crlf.matches) assert.ok(!m.text.includes('\r'))
  })
  await test('CJK / emoji 的 column 按 UTF-16', async () => {
    const { files } = await collectLiteral('foo', { caseSensitive: true })
    const uni = files.find((f) => f.rel === 'src/unicode.txt')
    assert.ok(uni)
    assert.deepEqual(
      uni.matches.map((m) => [m.line, m.column, m.length]),
      [
        [1, 4, 3],
        [2, 4, 3]
      ]
    )
  })

  section('[4] 流式 / 限额 / 取消')
  await test('结果分多批推送', async () => {
    const { batches, done } = await collectLiteral('batchmarker', { caseSensitive: true })
    assert.ok(done && !done.error)
    assert.ok(batches.length >= 2, `batches=${batches.length}`)
    assert.equal(done.matchCount, 25)
  })
  await test('命中 200 处后截断', async () => {
    const { files, done } = await collectLiteral('capneedle', { caseSensitive: true })
    assert.equal(done.matchCount, 200)
    assert.equal(done.truncated, true)
    assert.equal(files.reduce((n, f) => n + f.matches.length, 0), 200)
  })
  await test('命中文件数超过 50 后截断', async () => {
    const { files, done } = await collectLiteral('manyneedle', { caseSensitive: true })
    assert.equal(done.truncated, true)
    assert.ok(files.length <= 50)
  })
  await test('取消后不再回调 done', async () => {
    const controller = new AbortController()
    const events = []
    const search = compileSearch('foo', {})
    let doneCalled = false
    runRgSearch({
      cwd: root,
      search,
      globs: compileGlobs({}),
      signal: controller.signal,
      onBatch: (files) => events.push(files),
      onDone: () => {
        doneCalled = true
      },
      onError: () => {
        doneCalled = true
      }
    })
    controller.abort()
    await wait(250)
    assert.equal(doneCalled, false)
  })

  section('[5] 服务层 / 回退')
  await test('字面量走 rg，正则走内置引擎', async () => {
    const a = await startIdeSearch({
      senderId: 1,
      req: { cwd: root, query: 'foo', options: {}, requestId: 'r1' },
      send: () => undefined
    })
    assert.equal(a.ok, true)
    assert.equal(a.data.mode, 'rg')
    cancelIdeSearch(1, 'r1')

    const b = await startIdeSearch({
      senderId: 2,
      req: { cwd: root, query: 'f.o', options: { regex: true }, requestId: 'r2' },
      send: () => undefined
    })
    assert.equal(b.ok, true)
    assert.equal(b.data.mode, 'js')
    cancelIdeSearch(2, 'r2')
  })
  await test('校验期间取消不会启动搜索', async () => {
    const events = []
    const pending = startIdeSearch({
      senderId: 4,
      req: { cwd: root, query: 'foo', options: {}, requestId: 'r4' },
      send: (e) => events.push(e)
    })
    // 此时 startIdeSearch 已经登记了活动项，正在 await fs.stat
    cancelIdeSearch(4, 'r4')
    const result = await pending
    await wait(250)
    assert.equal(result.ok, true)
    assert.deepEqual(events, [])
  })
  await test('rg 不可用时回退且结果一致', async () => {
    const expected = await searchCode({ cwd: root, query: 'foo', options: {} })
    assert.equal(expected.ok, true)

    const oldCwd = process.cwd()
    const oldPath = process.env.PATH
    const oldOverride = process.env.CCODER_RG_PATH
    process.chdir(root)
    process.env.PATH = ''
    delete process.env.CCODER_RG_PATH
    resetRgPathState()
    resetIdeSearchService()

    const events = []
    try {
      const start = await startIdeSearch({
        senderId: 3,
        req: { cwd: root, query: 'foo', options: {}, requestId: 'r3' },
        send: (e) => events.push(e)
      })
      assert.equal(start.ok, true)
      assert.equal(start.data.mode, 'js')
      assert.equal(start.data.fallback, true)
      await wait(600)
    } finally {
      process.chdir(oldCwd)
      process.env.PATH = oldPath
      process.env.CCODER_RG_PATH = oldOverride
      resetRgPathState()
      resetIdeSearchService()
    }

    const done = events.find((e) => e.type === 'done')
    assert.ok(done)
    assert.equal(done.fallback, true)
    assert.equal(done.matchCount, expected.data.matchCount)
    const files = events.filter((e) => e.type === 'batch').flatMap((e) => e.files)
    assert.deepEqual(byRel(files), byRel(expected.data.files))
  })

  section('[6] 与内置 JS 搜索的一致性')
  await test('字面量结果一致', async () => {
    const expected = await searchCode({ cwd: root, query: 'foo', options: { caseSensitive: true } })
    const { files } = await collectLiteral('foo', { caseSensitive: true })
    assert.equal(expected.ok, true)
    assert.deepEqual(byRel(files), byRel(expected.data.files))
  })
  await test('全字匹配结果一致', async () => {
    const expected = await searchCode({
      cwd: root,
      query: 'foo',
      options: { wholeWord: true, caseSensitive: true }
    })
    const { files } = await collectLiteral('foo', { wholeWord: true, caseSensitive: true })
    assert.equal(expected.ok, true)
    assert.deepEqual(byRel(files), byRel(expected.data.files))
  })

  console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}（${passed} passed）`)
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => {
    delete process.env.CCODER_RG_PATH
    setTimeout(() => rmSync(root, { recursive: true, force: true }), 100)
  })
