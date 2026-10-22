/*
 * 工作区文件检索的 headless 验证。
 * 运行前由 package.json 的 verify:files 用 esbuild 把 workspace-search.ts
 * 打成 tools/_workspace-search.cjs。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { searchWorkspaceFiles, resetWorkspaceSearchCache } = require('./_workspace-search.cjs')

let failed = 0
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}${detail ? `\n    ${detail}` : ''}`)
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-files-'))

function put(rel, text = '// fixture') {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, text, 'utf8')
}

put('src/main.ts')
put('src/deep/useChat.ts')
put('src/deep/useSettings.ts')
put('src/deep/useSessions.ts')
put('src/components/Composer.tsx')
put('README.md', '# fixture')
put('docs/guide.md', '# guide')
put('node_modules/pkg/index.js')
put('out/build.js')
put('dist/bundle.js')
put('build/out.js')
put('.git/config')
put('.claude/settings.json')
put('.idea/workspace.xml')
put('.env', 'SECRET=1')
put('logs/app.log')
put('tools/_generated.cjs')
put('secrets/server.pem')

const isIgnored = (p) =>
  /(^|\/)(node_modules|out|dist|build|\.git|\.claude|\.idea|logs)(\/|$)/.test(p) ||
  /(^|\/)\.env$/.test(p) ||
  /\.(log|pem|cjs)$/.test(p)

async function main() {
  console.log('[1] 基本检索 / 排序')
  const chat = await searchWorkspaceFiles(root, 'useChat')
  check('能用文件名找到 useChat.ts', chat.some((f) => f.path === 'src/deep/useChat.ts'))
  check('结果里第一条就是 useChat.ts', chat[0]?.path === 'src/deep/useChat.ts', JSON.stringify(chat))
  check('不返回被忽略的目录', chat.every((f) => !isIgnored(f.path)), JSON.stringify(chat))

  const composer = await searchWorkspaceFiles(root, 'Composer')
  check('能找到 Composer.tsx', composer.some((f) => f.path === 'src/components/Composer.tsx'))

  console.log('[2] 大小写 / 路径分隔符')
  const upper = await searchWorkspaceFiles(root, 'USECHAT')
  check('检索大小写不敏感', upper.some((f) => f.path === 'src/deep/useChat.ts'))
  const all = await searchWorkspaceFiles(root, '', 100)
  check('结果统一使用正斜杠', all.every((f) => !f.path.includes('\\')), JSON.stringify(all))
  check('空查询只返回文件', all.every((f) => f.kind === 'file'), JSON.stringify(all))

  console.log('[3] 忽略规则')
  for (const q of ['node_modules', '.env', 'app.log', 'server.pem', '_generated']) {
    const hits = await searchWorkspaceFiles(root, q)
    check(`不返回 ${q}`, hits.length === 0, JSON.stringify(hits))
  }

  console.log('[4] 入参与边界')
  const relCwd = await searchWorkspaceFiles('src', 'main')
  check('相对 cwd 直接返回空', relCwd.length === 0)
  const missing = await searchWorkspaceFiles(path.join(root, 'not-exist'), 'main')
  check('不存在的 cwd 返回空', missing.length === 0)
  const limited = await searchWorkspaceFiles(root, '', 1)
  check('limit 生效', limited.length === 1, JSON.stringify(limited))
  const dirs = await searchWorkspaceFiles(root, 'deep')
  check('目录也能被检索到', dirs.some((f) => f.path === 'src/deep' && f.kind === 'dir'), JSON.stringify(dirs))
  const backslash = await searchWorkspaceFiles(root, 'src\\deep')
  check(
    '反斜杠查询也能命中',
    backslash.some((f) => f.path.startsWith('src/deep/')),
    JSON.stringify(backslash)
  )

  console.log('[5] 缓存与耗时')
  const t0 = Date.now()
  const first = await searchWorkspaceFiles(root, 'useSettings')
  const t1 = Date.now()
  const second = await searchWorkspaceFiles(root, 'useSettings')
  const t2 = Date.now()
  check('两次结果一致', JSON.stringify(first) === JSON.stringify(second))
  check('扫描没有明显卡死（< 5s）', t1 - t0 < 5000 && t2 - t1 < 5000, `${t1 - t0}ms / ${t2 - t1}ms`)
  check('缓存命中后很快', t2 - t1 <= Math.max(50, t1 - t0), `${t1 - t0}ms / ${t2 - t1}ms`)

  resetWorkspaceSearchCache()

  fs.rmSync(root, { recursive: true, force: true })
  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  fs.rmSync(root, { recursive: true, force: true })
  process.exit(2)
})
