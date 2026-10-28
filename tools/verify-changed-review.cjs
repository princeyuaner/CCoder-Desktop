/*
 * 「本轮改动审阅」的纯逻辑校验。
 *
 * 这条链路的关键在**路径换算**：各家 CLI 给的路径不统一（Claude / Codex
 * 是绝对路径、DSH 偶发相对路径），而 IDE 的 diff 页签只认工作区相对路径。
 * 算错的表现是「点了行没反应」或「打开了一个空 diff」—— 界面上不报错，
 * 最难查。这里把 `workspaceRel` / `normalizeReviewRels` 的边界全部断言一遍。
 *
 * 用法：
 *   npx esbuild src/shared/path.ts --bundle --platform=node --format=cjs \
 *     --alias:@shared=./src/shared --outfile=.tmp-build/path.cjs
 *   npx esbuild src/shared/ide.ts --bundle --platform=node --format=cjs \
 *     --alias:@shared=./src/shared --outfile=.tmp-build/ide.cjs
 *   node tools/verify-changed-review.cjs
 */
const { workspaceRel } = require('../.tmp-build/path.cjs')
const { normalizeReviewRels } = require('../.tmp-build/ide.cjs')

let failed = 0
function check(label, cond, detail) {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400))
  }
}

console.log('\n[1] workspaceRel：绝对路径 → 工作区相对路径')
{
  const cwd = 'C:/proj'
  check('普通文件', workspaceRel(cwd, 'C:/proj/src/app.ts') === 'src/app.ts', workspaceRel(cwd, 'C:/proj/src/app.ts'))
  check('反斜杠两种混用', workspaceRel(cwd, 'C:\\proj\\src\\app.ts') === 'src/app.ts', workspaceRel(cwd, 'C:\\proj\\src\\app.ts'))
  check('cwd 反斜杠 / 文件正斜杠', workspaceRel('C:\\proj', 'C:/proj/src/app.ts') === 'src/app.ts', workspaceRel('C:\\proj', 'C:/proj/src/app.ts'))
  check('Windows 大小写不敏感', workspaceRel('C:/Proj', 'c:/proj/SRC/App.ts') === 'SRC/App.ts', workspaceRel('C:/Proj', 'c:/proj/SRC/App.ts'))
  check('保留原始大小写', workspaceRel('C:/proj', 'C:/proj/Src/App.ts') === 'Src/App.ts', workspaceRel('C:/proj', 'C:/proj/Src/App.ts'))
  check('cwd 末尾带斜杠', workspaceRel('C:/proj/', 'C:/proj/src/app.ts') === 'src/app.ts', workspaceRel('C:/proj/', 'C:/proj/src/app.ts'))
  check('深一层目录', workspaceRel(cwd, 'C:/proj/a/b/c.ts') === 'a/b/c.ts', workspaceRel(cwd, 'C:/proj/a/b/c.ts'))
}

console.log('\n[2] workspaceRel：不该换算的情况')
{
  const cwd = 'C:/proj'
  check('工作区外', workspaceRel(cwd, 'C:/other/app.ts') === null, workspaceRel(cwd, 'C:/other/app.ts'))
  check('只是前缀相同的兄弟目录', workspaceRel(cwd, 'C:/proj-other/app.ts') === null, workspaceRel(cwd, 'C:/proj-other/app.ts'))
  check('本身就是相对路径', workspaceRel(cwd, 'src/app.ts') === null, workspaceRel(cwd, 'src/app.ts'))
  check('空 cwd', workspaceRel('', 'C:/proj/src/app.ts') === null)
  check('空路径', workspaceRel(cwd, '') === null)
  check('cwd 自己', workspaceRel(cwd, 'C:/proj') === '')
  check('POSIX 工作区外', workspaceRel('/home/u/p', '/home/u/other/a.ts') === null, workspaceRel('/home/u/p', '/home/u/other/a.ts'))
  check('POSIX 工作区内', workspaceRel('/home/u/p', '/home/u/p/src/a.ts') === 'src/a.ts', workspaceRel('/home/u/p', '/home/u/p/src/a.ts'))
  check('POSIX 大小写敏感', workspaceRel('/home/u/P', '/home/u/p/a.ts') === null, workspaceRel('/home/u/P', '/home/u/p/a.ts'))
}

console.log('\n[3] normalizeReviewRels：收敛非法 / 重复')
{
  const got = normalizeReviewRels(['src/a.ts', 'src\\b.ts', './src/c.ts', 'src//d.ts'])
  check('反斜杠转正斜杠', got.includes('src/b.ts'), got)
  check('去掉 ./ 前缀', got.includes('src/c.ts'), got)
  check('折叠多余分隔符', got.includes('src/d.ts'), got)
  check('普通路径原样保留', got.includes('src/a.ts'), got)

  const bad = normalizeReviewRels([
    'C:/proj/src/a.ts',
    '../../etc/passwd',
    'src/../secret.ts',
    '/src/rooted.ts',
    '/',
    '',
    null,
    42
  ])
  check('盘符绝对路径被拒', !bad.some((x) => /^[a-zA-Z]:/.test(x)), bad)
  check('.. 段被拒', !bad.some((x) => x.includes('..')), bad)
  check('以 / 开头的路径被拒（盘根相对语义不唯一）', !bad.includes('src/rooted.ts'), bad)
  check('非字符串被忽略', bad.every((x) => typeof x === 'string'), bad)
  check('空段从结果里消失', bad.every((x) => !x.includes('//')), bad)

  const dup = normalizeReviewRels(['src/a.ts', 'src/a.ts', 'src/a.ts'])
  check('精确去重', dup.length === 1, dup)

  const casePair = normalizeReviewRels(['src/A.ts', 'src/a.ts'])
  check('POSIX 上大小写不同是两个文件，不去重', casePair.length === 2, casePair)

  check('非数组 → 空', normalizeReviewRels(null).length === 0)
  check('非数组 → 空（对象）', normalizeReviewRels({ rel: 'a' }).length === 0)
}

console.log('\n[4] 端到端：CLI 路径 → IDE rel')
{
  // Claude / Codex：绝对路径
  const rel = workspaceRel('D:/work/site', 'D:/work/site/src/pages/index.tsx')
  const [clean] = normalizeReviewRels([rel ?? 'D:/work/site/src/pages/index.tsx'])
  check('绝对路径一路走通', clean === 'src/pages/index.tsx', clean)

  // DSH：相对路径，workspaceRel 换算不出来，但本身就能当 rel
  const rel2 = workspaceRel('D:/work/site', 'src/lib/x.ts')
  const [clean2] = normalizeReviewRels([rel2 ?? 'src/lib/x.ts'])
  check('相对路径兜底成 rel', clean2 === 'src/lib/x.ts', clean2)

  // 工作区外的绝对路径：两道路都拒绝，最终得到 null
  const rel3 = workspaceRel('D:/work/site', 'D:/elsewhere/x.ts')
  const out3 = normalizeReviewRels([rel3 ?? 'D:/elsewhere/x.ts'])
  check('工作区外最终得到空', out3.length === 0, out3)
}

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
