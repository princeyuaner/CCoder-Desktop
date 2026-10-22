/*
 * IDE 文件编辑能力的纯 Node 验证。
 * 运行前先打包：
 *   npx esbuild src/main/ide-fs.ts --bundle --platform=node --format=cjs \
 *     --outfile=tools/_ide-fs.cjs
 *   node tools/verify-ide-edit.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ide = require('./_ide-fs.cjs')

let failed = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok   ${label}`)
  else {
    failed++
    console.error(`  FAIL ${label}${detail === undefined ? '' : `\n       ${JSON.stringify(detail)}`}`)
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-edit-'))

function put(rel, content) {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
  return full
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

async function main() {
  put('src/a.ts', 'const a = 1\r\nconst b = 2\r\n')
  put('src/b.ts', 'export const b = 2\n')
  put('bin.dat', Buffer.from([0x41, 0, 0x42]))
  put('large.txt', 'x'.repeat(2 * 1024 * 1024 + 10))

  console.log('[1] 读取元数据')
  const a = await ide.readTextFile(root, 'src/a.ts')
  check('文本统一成 LF', a.text === 'const a = 1\nconst b = 2\n', a.text)
  check('识别 CRLF', a.eol === 'crlf', a.eol)
  check('返回 mtime', typeof a.mtimeMs === 'number' && a.mtimeMs > 0, a.mtimeMs)
  check('可编辑', a.editable === true, a)
  const bin = await ide.readTextFile(root, 'bin.dat')
  check('二进制不可编辑', bin.binary === true && bin.editable === false, bin)
  const big = await ide.readTextFile(root, 'large.txt')
  check('大文件被截断且不可编辑', big.truncated === true && big.editable === false, {
    truncated: big.truncated,
    editable: big.editable
  })

  console.log('[2] 保存 / 换行 / 冲突')
  const saved = await ide.saveTextFile({
    cwd: root,
    rel: 'src/a.ts',
    text: 'const a = 10\nconst b = 2\n',
    expectedMtimeMs: a.mtimeMs,
    eol: a.eol
  })
  check('保存成功', saved.ok === true, saved)
  check('保留 CRLF', read('src/a.ts') === 'const a = 10\r\nconst b = 2\r\n', JSON.stringify(read('src/a.ts')))
  check('保存后文本仍是 LF', saved.ok && saved.data.text.includes('a = 10\n'), saved)

  const before = saved.ok ? saved.data : await ide.readTextFile(root, 'src/a.ts')
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'outside\n')
  const later = new Date(Date.now() + 5000)
  fs.utimesSync(path.join(root, 'src/a.ts'), later, later)
  const conflict = await ide.saveTextFile({
    cwd: root,
    rel: 'src/a.ts',
    text: 'mine\n',
    expectedMtimeMs: before.mtimeMs,
    eol: 'lf'
  })
  check('外部修改触发 conflict', conflict.ok === false && conflict.code === 'conflict', conflict)
  const forced = await ide.saveTextFile({
    cwd: root,
    rel: 'src/a.ts',
    text: 'mine\n',
    expectedMtimeMs: before.mtimeMs,
    eol: 'lf',
    force: true
  })
  check('force 覆盖成功', forced.ok === true && read('src/a.ts') === 'mine\n', forced)

  fs.rmSync(path.join(root, 'src/a.ts'))
  const missing = await ide.saveTextFile({
    cwd: root,
    rel: 'src/a.ts',
    text: 'back\n',
    expectedMtimeMs: before.mtimeMs,
    eol: 'lf'
  })
  check('文件被删除返回 missing', missing.ok === false && missing.code === 'missing', missing)
  const recreated = await ide.saveTextFile({
    cwd: root,
    rel: 'src/a.ts',
    text: 'back\n',
    expectedMtimeMs: before.mtimeMs,
    eol: 'lf',
    force: true
  })
  check('force 重新创建', recreated.ok === true && read('src/a.ts') === 'back\n', recreated)

  console.log('[3] 路径与内容边界')
  const traversal = await ide.saveTextFile({ cwd: root, rel: '../escape.txt', text: 'x' })
  check('拒绝 ../', traversal.ok === false && traversal.code === 'invalid-path', traversal)
  const absolute = await ide.saveTextFile({ cwd: root, rel: path.join(root, 'x.txt'), text: 'x' })
  check('拒绝绝对路径', absolute.ok === false && absolute.code === 'invalid-path', absolute)
  const nul = await ide.saveTextFile({ cwd: root, rel: 'nul.txt', text: 'a\0b' })
  check('拒绝 NUL 内容', nul.ok === false && nul.code === 'binary', nul)

  console.log('[4] 新建')
  const file = await ide.createEntry({ cwd: root, rel: 'new/deep/hello.ts', kind: 'file' })
  check('递归新建文件', file.ok === true && fs.existsSync(path.join(root, 'new/deep/hello.ts')), file)
  check('新文件为空', read('new/deep/hello.ts') === '')
  const dir = await ide.createEntry({ cwd: root, rel: 'new/empty', kind: 'dir' })
  check('递归新建文件夹', dir.ok === true && fs.statSync(path.join(root, 'new/empty')).isDirectory(), dir)
  const again = await ide.createEntry({ cwd: root, rel: 'new/empty', kind: 'dir' })
  check('同名返回 exists', again.ok === false && again.code === 'exists', again)
  const outside = await ide.createEntry({ cwd: root, rel: '../outside-dir', kind: 'dir' })
  check('新建也拒绝越界', outside.ok === false && outside.code === 'invalid-path', outside)

  console.log('[5] 重命名')
  const renamed = await ide.renameEntry({
    cwd: root,
    rel: 'new/deep/hello.ts',
    to: 'new/deep/hi.ts'
  })
  check('重命名文件', renamed.ok === true && renamed.data.entry.rel === 'new/deep/hi.ts', renamed)
  check('旧路径消失', !fs.existsSync(path.join(root, 'new/deep/hello.ts')))
  check('新路径存在', fs.existsSync(path.join(root, 'new/deep/hi.ts')))
  const dirRename = await ide.renameEntry({ cwd: root, rel: 'new/deep', to: 'new/moved' })
  check('重命名文件夹', dirRename.ok === true && fs.existsSync(path.join(root, 'new/moved/hi.ts')), dirRename)
  const intoSelf = await ide.renameEntry({ cwd: root, rel: 'new/moved', to: 'new/moved/inner' })
  check('拒绝移进自己', intoSelf.ok === false && intoSelf.code === 'invalid-path', intoSelf)
  const collision = await ide.renameEntry({ cwd: root, rel: 'src/b.ts', to: 'new/moved/hi.ts' })
  check('目标已存在返回 exists', collision.ok === false && collision.code === 'exists', collision)

  console.log('[6] 删除')
  const deletedFile = await ide.deleteEntry({ cwd: root, rel: 'new/moved/hi.ts' })
  check('删除文件', deletedFile.ok === true && !fs.existsSync(path.join(root, 'new/moved/hi.ts')), deletedFile)
  const deletedDir = await ide.deleteEntry({ cwd: root, rel: 'new' })
  check('删除文件夹', deletedDir.ok === true && !fs.existsSync(path.join(root, 'new')), deletedDir)
  const rootDelete = await ide.deleteEntry({ cwd: root, rel: '' })
  check('拒绝删除工作区根', rootDelete.ok === false && rootDelete.code === 'invalid-path', rootDelete)
  const missingDelete = await ide.deleteEntry({ cwd: root, rel: 'nope.txt' })
  check('删除不存在返回 missing', missingDelete.ok === false && missingDelete.code === 'missing', missingDelete)

  fs.rmSync(root, { recursive: true, force: true })
  console.log(failed === 0 ? '\n全部通过 ✓' : `\n${failed} 项失败 ✗`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {}
  process.exit(2)
})
