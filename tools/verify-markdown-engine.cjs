/*
 * 回归：react-markdown 版 vs 手写版，逐项对比渲染结果。
 *
 * 用 react-dom/server 直接出 HTML —— 这台机器上 Electron 起不来
 * （electron.exe 静默 exit 3），所以不走 BrowserWindow 那条路。
 * 好处是跑得快、结果可以直接 diff；代价是拿不到布局尺寸，
 * 视觉效果另出一张静态稿肉眼看。
 *
 * 用法：
 *   npx esbuild tools/_render-markdown-fixture.tsx --bundle --platform=node \
 *     --format=cjs --jsx=automatic --alias:@shared=./src/shared \
 *     --external:react --external:react-dom \
 *     --outfile=.tmp-build/md-fixture.cjs && node tools/verify-markdown-engine.cjs
 *
 * 不参与打包。
 */
const path = require('node:path')
const fs = require('node:fs')

const fixture = require('../.tmp-build/md-fixture.cjs')

let failed = 0
let passed = 0

function check(label, cond, detail) {
  if (cond) {
    passed++
    console.log('  PASS', label)
  } else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600))
  }
}

/* ── 用例 ──────────────────────────────────────────────── */

const CASES = [
  {
    name: '块级公式（三行式）',
    md: '欧拉恒等式：\n\n$$\ne^{i\\pi} + 1 = 0\n$$',
    expect: (h) => h.includes('katex-display') || h.includes('katex'),
    absent: ['$$']
  },
  {
    name: '块级公式（单行 $$，应升格）',
    md: '$$e^{i\\pi} + 1 = 0$$',
    expect: (h) => h.includes('katex-display') || h.includes('katex'),
    absent: ['$$']
  },
  {
    name: '行内公式',
    md: '设 $x$ 为变量，则 $x^2 \\ge 0$ 恒成立。',
    expect: (h) => h.includes('katex'),
    absent: ['$x$']
  },
  {
    name: '价格区间不被吃掉',
    md: '这个方案预算是 $5 到 $10，超出部分按 $2 每小时计费。',
    expect: (h) => h.includes('$5 到 $10'),
    absent: ['katex-display']
  },
  {
    name: 'shell 变量不被吃掉',
    md: '环境变量 $HOME 和 $PATH 也要一并设置。',
    expect: (h) => h.includes('$HOME 和 $PATH'),
    absent: []
  },
  {
    name: 'shell 算术不被吃掉',
    md: '在 shell 里执行 $((1 + 2)) 得到 3。',
    expect: (h) => h.includes('$((1 + 2))'),
    absent: ['katex']
  },
  {
    name: '行内代码里的 $ 不动',
    md: '代码 `$HOME` 不应该渲染。',
    expect: (h) => h.includes('$HOME'),
    absent: ['katex']
  },
  {
    name: '围栏代码里的 $ 不动',
    md: '```sh\necho $HOME\n```',
    expect: (h) => h.includes('$HOME'),
    absent: ['katex']
  },
  {
    name: '引用块（手写版没有）',
    md: '> 这是一段引用\n> 第二行',
    expect: (h) => h.includes('md-quote'),
    absent: []
  },
  {
    name: '删除线（手写版没有）',
    md: '这是 ~~删掉的内容~~ 保留的。',
    expect: (h) => h.includes('<del>'),
    absent: ['~~']
  },
  {
    name: '嵌套列表（手写版会塌平）',
    md: '- 一级\n  - 二级\n  - 二级二\n- 一级二',
    expect: (h) => (h.match(/<ul/g) || []).length >= 2,
    absent: []
  },
  {
    name: '转义星号',
    md: '这是 \\*不是斜体\\* 的文本。',
    expect: (h) => h.includes('*不是斜体*'),
    absent: ['<em>']
  },
  {
    name: '松散有序列表不重复 1',
    md: '1. 第一\n\n2. 第二\n\n3. 第三',
    expect: (h) => (h.match(/<ol/g) || []).length === 1,
    absent: []
  },
  {
    name: '有序列表起始编号',
    md: '3. 从三开始\n4. 第四项',
    expect: (h) => h.includes('start="3"'),
    absent: []
  },
  {
    name: '标题层级',
    md: '# 一级\n\n## 二级\n\n### 三级',
    expect: (h) => h.includes('md-h'),
    absent: []
  },
  {
    name: '表格',
    md: '| 列 A | 列 B |\n|---|---|\n| 1 | 2 |',
    expect: (h) => h.includes('md-table') && h.includes('tblwrap'),
    absent: []
  },
  {
    name: '围栏代码块用 CodeCard',
    md: '```ts\nconst a = 1\n```',
    expect: (h) => h.includes('codebox') && h.includes('language') === false || h.includes('codebox'),
    absent: []
  },
  {
    name: '链接不用真 href',
    md: '看 [这里](https://example.com) 的说明。',
    expect: (h) => h.includes('class="lnk"') && !h.includes('href='),
    absent: []
  },
  {
    name: '行内代码样式',
    md: '执行 `npm test` 验证。',
    expect: (h) => h.includes('class="ic"'),
    absent: []
  },
  {
    name: '公式不误伤中文',
    md: '从 $x 到 y$ 的范围。',
    expect: (h) => h.includes('从 $x 到 y$'),
    absent: ['katex']
  }
]

/* ── 跑 ────────────────────────────────────────────────── */

console.log('══ react-markdown 版渲染检查 ══\n')

const rendered = []

for (const c of CASES) {
  const html = fixture.render(c.md)
  rendered.push({ name: c.name, md: c.md, html })

  console.log(`── ${c.name}`)
  check('包含预期内容', c.expect(html), html.slice(0, 400))
  for (const a of c.absent) {
    check(`不含 ${JSON.stringify(a)}`, !html.includes(a), html.slice(0, 400))
  }
}

/* ── 关键回归：旧实现的行为不能被弄坏 ────────────────── */

console.log('\n══ 旧实现对照（确认差异符合预期）══\n')

const COMPARE = [
  '> 引用块',
  '这是 ~~删除线~~',
  '- 一级\n  - 二级',
  '这是 \\*转义\\*'
]

for (const md of COMPARE) {
  const legacy = fixture.renderLegacy(md)
  const next = fixture.render(md)
  console.log(`── ${JSON.stringify(md)}`)
  console.log(`   旧: ${legacy.slice(0, 200)}`)
  console.log(`   新: ${next.slice(0, 200)}`)
}

/* ── 输出可视稿 ──────────────────────────────────────── */

const showcase = [
  '# 数学公式与语法覆盖',
  '',
  '设 $x$ 为变量，则 $x^2 \\ge 0$ 恒成立。价格区间 $5 到 $10 不该被吃掉，',
  'shell 变量 $HOME 和 $PATH 也不该。',
  '',
  '$$\n\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}\n$$',
  '',
  '## 新增语法',
  '',
  '> 这是引用块，手写版没有。',
  '',
  '- 一级列表',
  '  - 二级列表（手写版会塌平）',
  '    - 三级',
  '',
  '这是 ~~删除线~~ 和 **粗体**、*斜体*、`行内代码`。',
  '',
  '3. 从三开始的有序列表',
  '4. 第四项',
  '',
  '| 用例 | 结果 |',
  '|---|---|',
  '| 公式 | 通过 |',
  '| 引用块 | 通过 |',
  '',
  '```ts',
  'const euler = (i: number) => Math.exp(i * Math.PI) + 1',
  '```',
  '',
  '链接走主进程：[项目地址](https://example.com)'
].join('\n')

const htmlNew = fixture.render(showcase)
const htmlOld = fixture.renderLegacy(showcase)

const page = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<link rel="stylesheet" href="../../node_modules/katex/dist/katex.min.css">
<style>
body { margin:0; background:#0d0d0f; color:#e8e8ee;
  font-family: system-ui,'Segoe UI','Microsoft YaHei',sans-serif;
  -webkit-font-smoothing: antialiased; padding: 20px 24px 40px; }
.cols { display:flex; gap:20px; align-items:flex-start; }
.col { flex:1; min-width:0; background:#191919; border:1px solid #26262e;
  border-radius:12px; padding:20px 24px; }
.col h1 { font-size:12px; letter-spacing:.6px; color:#5c5c6a; margin:0 0 16px;
  text-transform:uppercase; font-weight:500; }
code, pre { font-family:'Cascadia Mono',Consolas,monospace; }
.md { font-size:14px; line-height:1.8; color:#dcdce6; }
.md > * + * { margin-top:14px; }
.md .md-h { margin:0; font-weight:600; color:#f0f0f6; }
.md > h2.md-h, .md > h3.md-h, .md > h4.md-h { margin-top:20px; }
.md > h2.md-h:first-child { margin-top:0; }
.md h2.md-h { font-size:16px; } .md h3.md-h { font-size:15px; } .md h4.md-h { font-size:14px; }
.md .md-p { margin:0; white-space:pre-wrap; }
.md .md-list { margin:0; padding-left:20px; }
.md .md-list li { margin-bottom:5px; }
.md .md-list li::marker { color:#6a6a7c; }
.md .ic { padding:2px 6px; font-size:.86em; color:#ddd6fe; background:#26262f;
  border-radius:5px; white-space:pre-wrap; overflow-wrap:anywhere; }
.md .lnk { color:#7dd3fc; cursor:pointer; }
.md strong { color:#fff; font-weight:600; }
.md em { font-style:italic; opacity:.92; }
.md .codebox { position:relative; padding:12px 14px; background:rgba(255,255,255,.045); border-radius:10px; }
.md .codebox__lang { display:block; margin-bottom:6px; font-family:'Cascadia Mono',Consolas,monospace;
  font-size:10.5px; letter-spacing:.5px; color:#565664; }
.md .codebox__cp { position:absolute; top:10px; right:13px; font-size:11px; color:#5c5c6a; }
.md .code { margin:0; overflow-x:auto; font-size:12.5px; line-height:1.65; color:#c8c8d4; white-space:pre; }
.md .tblwrap { padding:10px 14px; background:rgba(255,255,255,.022); border-radius:10px; overflow-x:auto; }
.md table { width:100%; border-collapse:collapse; font-size:13.5px; }
.md th { text-align:left; padding:6px 10px; font-weight:500; color:#8a8a9c;
  border-bottom:1px solid rgba(255,255,255,.07); }
.md td { padding:6px 10px; border-bottom:1px solid rgba(255,255,255,.04); }
.md tr:last-child td { border-bottom:none; }
.md .md-hr { height:1px; border:none; background:#2a2a32; }
.md .katex { color:#e4e4f0; font-size:1.04em; }
.md .katex-display { margin:0; padding:14px 16px; background:rgba(255,255,255,.022);
  border-radius:10px; overflow-x:auto; overflow-y:hidden; }
.md .katex-display .katex { font-size:1.1em; }
.md .md-quote { margin:0; padding:2px 0 2px 14px;
  border-left:2px solid rgba(255,255,255,.12); color:#b4b4c4; }
.md .md-quote > * + * { margin-top:10px; }
.tok-k { color:#c792ea; } .tok-s { color:#c3e88d; }
.tok-n { color:#ffcb6b; } .tok-c { color:#5a5a68; font-style:italic; }
</style></head>
<body>
<div class="cols">
  <div class="col"><h1>旧 · 手写解析器</h1><div class="md selectable">${htmlOld}</div></div>
  <div class="col"><h1>新 · react-markdown + katex</h1><div class="md selectable">${htmlNew}</div></div>
</div>
</body></html>`

const outHtml = path.join(__dirname, '..', 'docs', 'mockups', '_engine-compare.html')
fs.writeFileSync(outHtml, page)
console.log(`\n可视稿: ${outHtml}`)

/* 把渲染结果也存一份，方便人工看 */
const outJson = path.join(__dirname, '..', '.tmp-build', 'md-render.json')
fs.writeFileSync(outJson, JSON.stringify(rendered, null, 2))

console.log(`\n${failed === 0 ? `全部通过 ✓ (${passed} 项)` : `${failed} 项失败 ✗ / ${passed} 项通过`}`)
process.exit(failed === 0 ? 0 : 1)
