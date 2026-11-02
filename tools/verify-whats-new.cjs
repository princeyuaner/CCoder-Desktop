/*
 * 发版前校验：当前版本必须有更新说明。
 *
 * 更新公告按 package.json 的版本精确匹配 WHATS_NEW_RELEASES；漏写时应用
 * 只是静默不弹 —— 没有类型错误，构建也不会失败。这个脚本把「静默」变成
 * CI 上的红灯。
 *
 * 用法（见 package.json 的 verify:whats-new）：
 *   npm run verify:whats-new
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const { WHATS_NEW_RELEASES, whatsNewFor } = require(
  path.join(root, '.tmp-build', 'whats-new.cjs')
)

let failed = 0
let passed = 0
const check = (label, cond, detail) => {
  if (cond) {
    passed++
    console.log('  PASS', label)
  } else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : String(detail))
  }
}

const hasText = (t) =>
  Boolean(
    t &&
      typeof t.zh === 'string' &&
      t.zh.trim() &&
      typeof t.en === 'string' &&
      t.en.trim()
  )

const versionParts = (v) => v.split('.').map((n) => Number(n))
const isNewer = (a, b) => {
  const x = versionParts(a)
  const y = versionParts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  }
  return false
}

console.log('══ 更新说明检查 ══\n')

check(
  `package.json 的 ${pkg.version} 有对应说明`,
  Boolean(whatsNewFor(pkg.version)),
  '在 WHATS_NEW_RELEASES 最前面补一条，version 必须和 package.json 一致'
)

const seen = new Set()
let previous = null
for (const release of WHATS_NEW_RELEASES) {
  const v = release.version
  check(`版本 ${v} 是 x.y.z 且不重复`, /^\d+\.\d+\.\d+$/.test(v) && !seen.has(v), v)
  seen.add(v)

  check(`${v} 的日期是 YYYY-MM-DD`, /^\d{4}-\d{2}-\d{2}$/.test(release.date), release.date)
  check(
    `${v} 的重点是完整的中英文`,
    hasText(release.highlight?.title) && hasText(release.highlight?.desc),
    release.highlight?.title?.zh
  )

  const items = (release.sections ?? []).flatMap((s) => s.items ?? [])
  check(`${v} 至少有一条更新`, items.length > 0, String(items.length))
  check(
    `${v} 的条目都是完整的中英文`,
    items.every((item) => hasText(item.title) && hasText(item.desc)),
    items.find((item) => !hasText(item.title) || !hasText(item.desc))?.title?.zh
  )

  // 新版本永远加在最前面：读代码和发版时不用翻到最后确认。
  if (previous) {
    check(`${previous} 排在 ${v} 前面（新版本在上）`, isNewer(previous, v), `${previous} < ${v}`)
  }
  previous = v
}

console.log(`\n${failed === 0 ? `全部通过 ✓ (${passed} 项)` : `${failed} 项失败 ✗ / ${passed} 项通过`}`)
process.exit(failed === 0 ? 0 : 1)
