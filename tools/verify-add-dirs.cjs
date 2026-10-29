/*
 * 会话级附加目录（Claude 的 --add-dir）：
 *   1. sanitizeAddDirs 只接受绝对路径、去重、限长；
 *   2. validateSessionDir 能区分不存在 / 不是目录 / 工作区内 / 重复；
 *   3. existingAddDirs 在启动前把不存在的目录过滤掉；
 *   4. session-meta-store 能存、能读、空列表会清掉。
 *
 * 用法（先 npx esbuild 打包，见 package.json 的 verify:add-dirs）：
 *   node tools/verify-add-dirs.cjs
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { sanitizeAddDirs, sameAddDirs } = require('../.tmp-build/add-dirs.cjs')
const { validateSessionDir, existingAddDirs } = require('../.tmp-build/session-dirs.cjs')
const { getSessionMeta, updateSessionMeta } = require('../.tmp-build/session-meta-store.cjs')

let n = 0
const test = (name, fn) => {
  fn()
  n++
  console.log(`  ok ${name}`)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-adddirs-'))
const ws = path.join(root, 'ws')
const extra = path.join(root, 'shared-lib')
const nested = path.join(ws, 'packages')
const file = path.join(root, 'file.txt')
fs.mkdirSync(ws)
fs.mkdirSync(extra)
fs.mkdirSync(nested)
fs.writeFileSync(file, 'x')

const real = (p) => fs.realpathSync.native(p)

try {
  console.log('sanitizeAddDirs')
  test('非数组 → 空', () => {
    assert.deepEqual(sanitizeAddDirs(null), [])
    assert.deepEqual(sanitizeAddDirs('x'), [])
  })
  test('只留绝对路径，去掉非字符串 / 相对路径', () => {
    assert.deepEqual(
      sanitizeAddDirs(['D:\\work\\a', 'relative', 42, '', '  C:\\data\\b  ']),
      ['D:\\work\\a', 'C:\\data\\b']
    )
  })
  test('分隔符 / 大小写不同也算同一条', () => {
    assert.deepEqual(sanitizeAddDirs(['D:\\work\\a', 'd:/WORK/A', '/tmp/x']), [
      'D:\\work\\a',
      '/tmp/x'
    ])
  })
  test('最多 20 条', () => {
    const many = Array.from({ length: 25 }, (_, i) => `D:\\dirs\\${i}`)
    assert.equal(sanitizeAddDirs(many).length, 20)
  })

  console.log('sameAddDirs')
  test('顺序无关、大小写不敏感', () => {
    assert.equal(sameAddDirs(['D:\\a', 'D:\\b'], ['d:/b', 'd:/a']), true)
    assert.equal(sameAddDirs(['D:\\a'], ['D:\\a', 'D:\\b']), false)
  })

  console.log('validateSessionDir')
  test('可用目录返回 realpath', () => {
    const r = validateSessionDir(extra, ws, [])
    assert.equal(r.ok, true)
    assert.equal(r.reason, 'ok')
    assert.equal(r.path, real(extra))
  })
  test('相对路径', () => {
    assert.equal(validateSessionDir('relative/dir', ws, []).reason, 'notAbsolute')
  })
  test('目录不存在', () => {
    assert.equal(validateSessionDir(path.join(root, 'missing'), ws, []).reason, 'missing')
  })
  test('文件不是目录', () => {
    assert.equal(validateSessionDir(file, ws, []).reason, 'notDirectory')
  })
  test('工作区内不需要重复添加', () => {
    assert.equal(validateSessionDir(nested, ws, []).reason, 'inside')
  })
  test('去重按 realpath / 大小写', () => {
    assert.equal(validateSessionDir(extra, ws, [extra]).reason, 'duplicate')
    // 大小写不敏感只适用于 Windows 盘符路径
    if (process.platform === 'win32') {
      assert.equal(validateSessionDir(extra, ws, [extra.toUpperCase()]).reason, 'duplicate')
    }
  })

  console.log('existingAddDirs')
  test('启动前过滤掉不存在的目录', () => {
    const out = existingAddDirs([extra, path.join(root, 'missing'), nested])
    assert.deepEqual(out, [real(extra), real(nested)])
  })

  console.log('session-meta-store')
  process.env.CCODER_TEST_USERDATA = path.join(root, 'userdata')
  const key = JSON.stringify(['claude', ws, 's1'])
  test('存附加目录', () => {
    updateSessionMeta({
      cli: 'claude',
      cwd: ws,
      id: 's1',
      patch: { addDirs: [extra, path.join(root, 'missing')] }
    })
    const meta = getSessionMeta()[key]
    assert.deepEqual(meta.addDirs, [extra, path.join(root, 'missing')])
  })
  test('和标题 / 模型共存', () => {
    updateSessionMeta({
      cli: 'claude',
      cwd: ws,
      id: 's1',
      patch: { title: 'demo', addDirs: [extra] }
    })
    const meta = getSessionMeta()[key]
    assert.equal(meta.title, 'demo')
    assert.deepEqual(meta.addDirs, [extra])
  })
  test('空列表会清掉字段；没有其它字段时整条元数据也删掉', () => {
    updateSessionMeta({ cli: 'claude', cwd: ws, id: 's1', patch: { title: '', addDirs: [] } })
    assert.equal(getSessionMeta()[key], undefined)
  })

  console.log(`\n${n} checks passed`)
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
