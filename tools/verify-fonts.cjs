/*
 * 回归：本机字体的注册表名归一化。
 *
 * Windows 注册表里的字体名带格式 / 字重 / 点阵字号后缀，归一化错了会在
 * 设置页下拉里出现一堆重复项或乱码家族。这里用真实形状的样本覆盖。
 *
 * 用法：
 *   npx esbuild src/main/system-fonts.ts --bundle --platform=node \
 *     --format=cjs --outfile=.tmp-build/system-fonts.cjs && node tools/verify-fonts.cjs
 *
 * 不参与打包。
 */
const { normalizeFamilies } = require('../.tmp-build/system-fonts.cjs')

let failed = 0
let passed = 0

function check(label, cond, detail) {
  if (cond) {
    passed++
    console.log('  PASS', label)
  } else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const RAW = [
  'Arial (TrueType)',
  'Arial Bold (TrueType)',
  'Arial Bold Italic (TrueType)',
  'ARIAL (TrueType)',
  'Consolas (OpenType)',
  'Microsoft YaHei & Microsoft YaHei UI (TrueType)',
  'Courier 10,12,15 (120)',
  'MS Serif 8,10,12,14,18,24 (120)',
  'Segoe UI Emoji (TrueType)',
  'Segoe UI Symbol (TrueType)',
  'Apple Color Emoji (TrueType)',
  'Noto Color Emoji (TrueType)',
  'Marlett (TrueType)',
  '@SimSun (TrueType)',
  '  '
]

const got = normalizeFamilies(RAW)

console.log('══ 字体名归一化检查 ══\n')
console.log('结果:', got.join(' | '), '\n')

check('保留普通家族', got.includes('Arial'))
check('字重归并回 Arial（大小写去重）', got.filter((n) => n.toLowerCase() === 'arial').length === 1)
check('保留 Consolas', got.includes('Consolas'))
check('& 分隔的两个家族都保留', got.includes('Microsoft YaHei') && got.includes('Microsoft YaHei UI'))
check('点阵字号列表被剥掉', got.includes('Courier') && !got.includes('Courier 10,12,15'))
check('多字号点阵字体被剥掉', got.includes('MS Serif'))
check('emoji 字体被过滤', !got.some((n) => /emoji|symbol/i.test(n)))
check('图标字体被过滤', !got.includes('Marlett'))
check('@ 开头的竖排家族被过滤', !got.some((n) => n.startsWith('@')))
check('不残留格式标注', !got.some((n) => /\((?:TrueType|OpenType|\d+)\)/.test(n)))
check('空白项被丢弃', !got.some((n) => !n.trim()))

/* 名字本身以数字结尾的普通字体不能被误伤 */
const numeric = normalizeFamilies(['Some Font 2 (TrueType)'])
check('数字结尾的家族名保留', numeric.includes('Some Font 2'), numeric)

const empty = normalizeFamilies([])
check('空输入返回空数组', Array.isArray(empty) && empty.length === 0)

console.log(`\n${failed === 0 ? `全部通过 ✓ (${passed} 项)` : `${failed} 项失败 ✗ / ${passed} 项通过`}`)
process.exit(failed === 0 ? 0 : 1)
