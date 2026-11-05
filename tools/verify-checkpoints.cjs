/*
 * 文件检查点（shadow git）：
 *   1. 每轮能拍到工作区 tree，元数据按会话持久化；
 *   2. 预览能正确区分「新增 / 删除 / 修改」；
 *   3. 恢复能找回删除的文件、改回修改的文件、删掉新增的文件；
 *   4. 恢复前自动备份，且备份本身可以再恢复回来；
 *   5. 忽略目录 / 敏感文件不进入快照；
 *   6. 新会话在拿到 provider id 后能把 live 记录合并到稳定键；
 *   7. 不同会话之间互不可见。
 *
 * 用法（先 npx esbuild 打包，见 package.json 的 verify:checkpoints）：
 *   node tools/verify-checkpoints.cjs
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { CheckpointStore } = require('../.tmp-build/checkpoints.cjs')

let n = 0
const test = async (name, fn) => {
  await fn()
  n++
  console.log(`  ok ${name}`)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-checkpoints-'))
const ws = path.join(root, 'ws')
const base = path.join(root, 'store')

function write(rel, body) {
  const full = path.join(ws, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, body)
}

function read(rel) {
  try {
    return fs.readFileSync(path.join(ws, rel), 'utf8')
  } catch {
    return null
  }
}

async function main() {
  fs.mkdirSync(ws, { recursive: true })
  write('src/a.txt', 'one\n')
  write('src/b.txt', 'two\n')
  write('node_modules/pkg/index.js', 'dep v1\n')
  write('.env', 'TOKEN=v1\n')
  write('.gitignore', 'ignored.txt\n')
  write('ignored.txt', 'ignored v1\n')

  const store = new CheckpointStore(base)
  const live = 'live-1'
  const cli = 'claude'
  const provider = 'provider-1'

  console.log('capture / list')
  const first = await store.capture({
    liveId: live,
    cli,
    cwd: ws,
    providerId: provider,
    prompt: 'first turn'
  })
  assert.ok(first, 'capture returns an entry')
  assert.equal(first.turn, 1)
  assert.equal(first.kind, 'turn')

  write('src/a.txt', 'ONE changed\n')
  fs.unlinkSync(path.join(ws, 'src/b.txt'))
  write('src/c.txt', 'new file\n')
  write('node_modules/pkg/index.js', 'dep v2\n')
  write('.env', 'TOKEN=v2\n')
  write('ignored.txt', 'ignored v2\n')

  const second = await store.capture({
    liveId: live,
    cli,
    cwd: ws,
    providerId: provider,
    prompt: 'second turn'
  })
  assert.ok(second)
  assert.equal(second.turn, 2)

  await test('list 按时间倒序，轮次连续', async () => {
    const r = await store.list(live)
    assert.equal(r.ok, true)
    assert.equal(r.checkpoints.length, 2)
    assert.equal(r.checkpoints[0].id, second.id)
    assert.equal(r.checkpoints[1].id, first.id)
    assert.equal(r.checkpoints[1].prompt, 'first turn')
  })

  await test('不同 live 会话互不可见', async () => {
    const r = await store.list('other-live')
    assert.equal(r.checkpoints.length, 0)
  })

  await test('预览区分新增 / 删除 / 修改', async () => {
    const p = await store.preview(live, first.id)
    assert.equal(p.ok, true)
    assert.equal(p.total, 3)
    const byPath = Object.fromEntries(p.files.map((f) => [f.path, f.status]))
    assert.equal(byPath['src/a.txt'], 'modified')
    assert.equal(byPath['src/b.txt'], 'deleted')
    assert.equal(byPath['src/c.txt'], 'added')
    // 忽略目录 / 敏感文件不应出现
    assert.equal(byPath['node_modules/pkg/index.js'], undefined)
    assert.equal(byPath['.env'], undefined)
    // 用户自己的 .gitignore 同样生效（工作区不是 Git 仓库也要尊重）
    assert.equal(byPath['ignored.txt'], undefined)
  })

  let backupId = null
  await test('恢复：改回、找回、删除新增', async () => {
    const r = await store.restore(live, first.id)
    assert.equal(r.ok, true)
    assert.equal(r.restored, 2)
    assert.equal(r.deleted, 1)
    assert.ok(r.backupId)
    backupId = r.backupId
    assert.equal(read('src/a.txt'), 'one\n')
    assert.equal(read('src/b.txt'), 'two\n')
    assert.equal(read('src/c.txt'), null)
    // 忽略文件保持恢复前的状态，不被快照覆盖
    assert.equal(read('node_modules/pkg/index.js'), 'dep v2\n')
    assert.equal(read('.env'), 'TOKEN=v2\n')
    assert.equal(read('ignored.txt'), 'ignored v2\n')
  })

  await test('恢复前备份可以再恢复回去', async () => {
    const r = await store.restore(live, backupId)
    assert.equal(r.ok, true)
    assert.equal(read('src/a.txt'), 'ONE changed\n')
    assert.equal(read('src/b.txt'), null)
    assert.equal(read('src/c.txt'), 'new file\n')
  })

  await test('恢复后索引与工作区一致，预览为空', async () => {
    const target = await store.capture({
      liveId: live,
      cli,
      cwd: ws,
      providerId: provider,
      prompt: 'third turn'
    })
    const p = await store.preview(live, target.id)
    assert.equal(p.ok, true)
    assert.equal(p.files.length, 0)
  })

  console.log('bind / 持久化')
  const live2 = 'live-new'
  const firstNew = await store.capture({
    liveId: live2,
    cli,
    cwd: ws,
    providerId: null,
    prompt: 'new session turn'
  })
  assert.ok(firstNew)

  await test('provider id 绑定后仍能按 live / provider 查到', async () => {
    await store.bind(live2, cli, ws, 'provider-new')
    const a = await store.list(live2)
    assert.equal(a.checkpoints.length, 1)
    // 模拟应用重启：新 store、新 live，用 provider 记录接回
    const store2 = new CheckpointStore(base)
    const live3 = 'live-after-restart'
    await store2.bind(live3, cli, ws, 'provider-new')
    const b = await store2.list(live3)
    assert.equal(b.checkpoints.length, 1)
    assert.equal(b.checkpoints[0].id, firstNew.id)
  })

  await test('bind 后新捕获的检查点继续递增轮次', async () => {
    const next = await store.capture({
      liveId: live2,
      cli,
      cwd: ws,
      providerId: 'provider-new',
      prompt: 'after bind'
    })
    assert.ok(next)
    assert.equal(next.turn, 2)
  })

  await test('删除会话后检查点记录消失', async () => {
    await store.forgetProvider('provider-new')
    const store3 = new CheckpointStore(base)
    await store3.bind('live-x', cli, ws, 'provider-new')
    const r = await store3.list('live-x')
    assert.equal(r.checkpoints.length, 0)
  })

  console.log(`\n${n} 项检查全部通过`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // Windows 上可能还有 git 子进程没完全退出
    }
  })
