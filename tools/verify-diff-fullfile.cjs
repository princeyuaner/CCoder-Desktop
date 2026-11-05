/*
 * 整文件 diff 行模型回归测试。
 *
 * 用法：
 *   npx esbuild src/renderer/src/ide/diff.ts --bundle --platform=node --format=cjs --outfile=tools/_diff-fullfile.cjs
 *   node tools/verify-diff-fullfile.cjs
 *
 * 不碰仓库工作区：每个用例在系统临时目录里建一个一次性 git 仓库，
 * 用真实 `git diff` 输出验证 parseDiff + buildFullFile 的对齐。
 * 不参与打包。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { parseDiff, buildFullFile, splitFileLines, toUnifiedRows } = require('./_diff-fullfile.cjs')

const tempDirs = []
process.on('exit', () => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // 临时目录清理失败不影响测试结果
    }
  }
})

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function repoFixture(before, after, name = 'file.txt') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-diff-'))
  tempDirs.push(dir)
  sh(dir, 'git', ['init', '-q'])
  sh(dir, 'git', ['config', 'user.email', 'verify@example.com'])
  sh(dir, 'git', ['config', 'user.name', 'verify'])
  sh(dir, 'git', ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(dir, name), before)
  sh(dir, 'git', ['add', name])
  sh(dir, 'git', ['commit', '-q', '-m', 'base'])
  fs.writeFileSync(path.join(dir, name), after)
  const diff = sh(dir, 'git', ['diff', '--no-color', '--unified=3', '--', name])
  return diff
}

function check(before, after, label) {
  const diff = repoFixture(before, after)
  const hunks = parseDiff(diff)
  const model = buildFullFile(before, after, hunks)
  const leftLines = splitFileLines(before)
  const rightLines = splitFileLines(after)

  assert.deepEqual(
    model.rows.filter((r) => r.left).map((r) => r.left.text),
    leftLines,
    `${label}: left side should reproduce the whole before file`
  )
  assert.deepEqual(
    model.rows.filter((r) => r.right).map((r) => r.right.text),
    rightLines,
    `${label}: right side should reproduce the whole after file`
  )

  let lno = 0
  let rno = 0
  for (const row of model.rows) {
    if (row.left) assert.equal(row.left.no, ++lno, `${label}: left line numbers`)
    if (row.right) assert.equal(row.right.no, ++rno, `${label}: right line numbers`)
    if (row.kind === 'change') assert.ok(row.left && row.right, `${label}: change shape`)
    if (row.kind === 'add') assert.ok(!row.left && row.right, `${label}: add shape`)
    if (row.kind === 'del') assert.ok(row.left && !row.right, `${label}: del shape`)
    if (row.kind === 'ctx') {
      assert.equal(row.left.text, row.right.text, `${label}: context text`)
      assert.equal(row.change, null, `${label}: context change index`)
    }
  }

  const groups = new Map()
  for (const row of model.rows) {
    if (row.change == null) continue
    if (!groups.has(row.change)) groups.set(row.change, [])
    groups.get(row.change).push(row)
  }
  assert.equal(groups.size, model.changes.length, `${label}: change count`)
  for (const change of model.changes) {
    const rows = groups.get(change.index)
    assert.equal(change.added, rows.filter((r) => r.kind !== 'del').length)
    assert.equal(change.removed, rows.filter((r) => r.kind !== 'add').length)
  }

  const uni = toUnifiedRows(model.rows)
  const ctx = uni.filter((r) => r.kind === 'ctx').length
  assert.equal(uni.filter((r) => r.kind === 'del').length, leftLines.length - ctx)
  assert.equal(uni.filter((r) => r.kind === 'add').length, rightLines.length - ctx)

  return model
}

/* 修改 + 删除 + 插入，跨越多个 hunk */
{
  const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  const lines = before.split('\n')
  lines[1] = 'line 2 changed'
  lines.splice(10, 1)
  lines.splice(20, 0, 'inserted a', 'inserted b')
  const model = check(before, lines.join('\n'), 'mixed')
  assert.ok(model.changes.length >= 2, 'mixed: expected several change blocks')
}

/* 开头插入、末尾删除 */
{
  const before = 'a\nb\nc\n'
  const after = 'x\ny\na\nb\n'
  check(before, after, 'head/tail')
}

/* 新文件 */
check('', 'one\ntwo\nthree\n', 'new file')

/* 空文件删除全部内容 */
check('one\ntwo\n', '', 'deleted content')

/* CRLF 与没有末尾换行 */
check('a\r\nb\r\nc', 'a\r\nB\r\nc', 'crlf')

/* 分离的 hunk 各算一处差异 */
{
  const before = Array.from({ length: 60 }, (_, i) => `n${i + 1}`).join('\n') + '\n'
  const lines = before.split('\n')
  lines[2] = 'n3 changed'
  lines[30] = 'n31 changed'
  lines[55] = 'n56 changed'
  const model = check(before, lines.join('\n'), 'multi-hunk')
  assert.equal(model.changes.length, 3)
}

/* 所有行都变（全量替换） */
{
  const before = Array.from({ length: 20 }, (_, i) => `old ${i + 1}`).join('\n') + '\n'
  const after = Array.from({ length: 20 }, (_, i) => `new ${i + 1}`).join('\n') + '\n'
  const model = check(before, after, 'full replace')
  assert.equal(model.rows.length, 20)
  assert.ok(model.changes.length >= 1)
}

console.log('verify:diff-fullfile — all checks passed')
