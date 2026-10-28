/*
 * 流式渲染性能基准：手写解析器 vs react-markdown + katex。
 *
 * ── 为什么这样测 ─────────────────────────────────────────
 * 应用里的真实负载是：每来一个 delta，用**完整累积文本**重新渲染一遍
 * （RichText 的 useMemo 依赖 text，RichMarkdown 同理）。所以最该关心的
 * 不是"渲染一篇长文要多久"，而是"一条长回答流完，累计花了多少"，
 * 以及这个成本随长度是线性还是超线性。
 *
 * 用 react-dom/server 的 renderToStaticMarkup：这台机器上 Electron 起不来，
 * 而 SSR 和客户端渲染走的是同一套解析 + React 元素树构建，成本量级一致。
 * 差别在 SSR 不做 diff —— 客户端会额外有 reconcile 开销，但那是**同一量级
 * 的两边**，对比结论仍然成立。绝对值不能直接当线上帧耗时看。
 *
 * 用法：
 *   npx esbuild tools/_render-markdown-fixture.tsx --bundle --platform=node \
 *     --format=cjs --jsx=automatic --alias:@shared=./src/shared \
 *     --external:react --external:react-dom --outfile=.tmp-build/md-fixture.cjs
 *   node tools/bench-markdown-stream.cjs
 *
 * 不参与打包。
 */
const { render, renderLegacy } = require('../.tmp-build/md-fixture.cjs')

const now = () => Number(process.hrtime.bigint()) / 1e6

/* ── 内容样本 ──────────────────────────────────────────── */

const PROSE = `
改动说明。这次主要做了三件事：把返回值改成读环境变量、拆分了 index 函数、
补了两个测试用例。原来的实现里返回值是写死的字符串，部署到不同环境都得改
代码，很容易漏。现在改成读 SERVICE_NAME，没设的时候回落到 hello，行为和
以前完全一致，所以老部署不会受影响。

顺带说明一下为什么没有直接用配置文件：这个服务要跑在多个容器里，配置项
通过编排平台注入，走环境变量是最省事的做法。配置文件还得考虑挂载路径和
热更新，收益不明显。
`

const CODE = `
\`\`\`python
import os
from flask import Flask

app = Flask(__name__)


def service_name() -> str:
    return os.environ.get("SERVICE_NAME", "hello")


@app.route("/")
def index():
    return service_name()
\`\`\`
`

const LIST = `
- 新增 \`SERVICE_NAME\` 环境变量
- 没设的时候回落到 \`"hello"\`，行为跟现在一样
- 顺带把 \`index()\` 拆成两个小函数
  - 一个是取名字的
  - 一个是挂路由的
`

const TABLE = `
| 用例 | 结果 |
|---|---|
| test_index_default | 通过 |
| test_index_custom | 通过 |
`

const MATH = `
设 $x$ 为待求积分，则 $I^2$ 可以写成二重积分：

$$
I^2 = \\iint_{\\mathbb{R}^2} e^{-(x^2+y^2)}\\,dx\\,dy = \\int_0^{2\\pi}\\!\\!\\int_0^{\\infty} e^{-r^2} r\\,dr\\,d\\theta
$$

换成极坐标后，面积元变成 $r\\,dr\\,d\\theta$，径向积分得到 $\\pi$。
`

const QUOTE = `
> 注意：这个改动改变了默认行为。
> 如果下游依赖写死的 hello，需要显式设置 SERVICE_NAME。
`

const FIXTURES = {
  '纯散文': [PROSE],
  '代码密集': [PROSE, CODE, PROSE, CODE],
  '列表表格': [PROSE, LIST, TABLE, LIST, TABLE],
  '公式密集': [MATH, MATH, MATH, MATH],
  '混合（最接近真实）': [PROSE, LIST, CODE, PROSE, TABLE, MATH, QUOTE]
}

function buildFixture(sections, repeat) {
  return Array.from({ length: repeat }, () => sections.join('\n')).join('\n')
}

/* ── 测量工具 ──────────────────────────────────────────── */

function measure(fn, iterations) {
  const times = []
  for (let i = 0; i < iterations; i++) {
    const t0 = now()
    fn()
    times.push(now() - t0)
  }
  times.sort((a, b) => a - b)
  const sum = times.reduce((a, b) => a + b, 0)
  return {
    mean: sum / times.length,
    median: times[Math.floor(times.length / 2)],
    p95: times[Math.min(times.length - 1, Math.floor(times.length * 0.95))],
    max: times[times.length - 1],
    total: sum
  }
}

function fmt(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`
  if (ms >= 10) return `${ms.toFixed(1)} ms`
  return `${ms.toFixed(2)} ms`
}

/** 预热：让 JIT 把解析和渲染路径编译好，避免第一轮全是解释执行 */
function warmup(text, rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    render(text)
    renderLegacy(text)
  }
}

/* ── 一轮测试 ──────────────────────────────────────────── */

function runCase(label, text, opts = {}) {
  const chunk = opts.chunk ?? 12
  const singleIters = opts.singleIters ?? 5
  const maxSteps = opts.maxSteps ?? 400

  const len = text.length
  const steps = Math.min(maxSteps, Math.ceil(len / chunk))
  // 保持覆盖率：最长文本按 maxSteps 采样时，把块放大，保证流完
  const stepSize = Math.ceil(len / steps)

  warmup(text.slice(0, Math.min(len, 800)))

  const once = {
    old: measure(() => renderLegacy(text), singleIters),
    new: measure(() => render(text), singleIters)
  }

  /* 流式：逐个前缀渲染，模拟真实 delta 到达 */
  const stream = { old: [], new: [] }
  for (let i = 1; i <= steps; i++) {
    const prefix = text.slice(0, Math.min(len, i * stepSize))
    let t0 = now()
    renderLegacy(prefix)
    stream.old.push(now() - t0)

    t0 = now()
    render(prefix)
    stream.new.push(now() - t0)
  }

  const sum = (arr) => arr.reduce((a, b) => a + b, 0)
  const sOld = sum(stream.old)
  const sNew = sum(stream.new)

  const sortedOld = [...stream.old].sort((a, b) => a - b)
  const sortedNew = [...stream.new].sort((a, b) => a - b)
  const p95 = (a) => a[Math.min(a.length - 1, Math.floor(a.length * 0.95))]

  console.log(`\n── ${label}  (${len.toLocaleString()} 字符)`)
  console.log(
    `   单次渲染   旧 ${fmt(once.old.median).padStart(9)}  新 ${fmt(once.new.median).padStart(9)}` +
      `   倍数 ${(once.new.median / once.old.median).toFixed(2)}x`
  )
  console.log(
    `   流式总计   旧 ${fmt(sOld).padStart(9)}  新 ${fmt(sNew).padStart(9)}` +
      `   倍数 ${(sNew / sOld).toFixed(2)}x   (${steps} 次渲染)`
  )
  console.log(
    `   单帧中位   旧 ${fmt(sortedOld[Math.floor(sortedOld.length / 2)]).padStart(9)}  ` +
      `新 ${fmt(sortedNew[Math.floor(sortedNew.length / 2)]).padStart(9)}`
  )
  console.log(
    `   单帧 p95   旧 ${fmt(p95(sortedOld)).padStart(9)}  新 ${fmt(p95(sortedNew)).padStart(9)}`
  )

  return {
    label,
    len,
    steps,
    onceOld: once.old.median,
    onceNew: once.new.median,
    streamOld: sOld,
    streamNew: sNew,
    p95New: p95(sortedNew)
  }
}

/* ── 主流程 ────────────────────────────────────────────── */

console.log('══ 流式渲染性能基准 ══')
console.log('每帧 = 用累积文本完整重渲染一次（和应用的 delta 处理一致）')
console.log('SSR 无 diff，绝对值偏乐观；倍数关系才是结论。')

const results = []

console.log('\n\n◤ 一、长度扩展性（混合内容）◢')
for (const repeat of [1, 3, 6, 12]) {
  const text = buildFixture(FIXTURES['混合（最接近真实）'], repeat)
  results.push(runCase(`混合 ×${repeat}`, text))
}

console.log('\n\n◤ 二、内容类型差异（等长 12 段）◢')
const byType = []
for (const [name, sections] of Object.entries(FIXTURES)) {
  const text = buildFixture(sections, name === '混合（最接近真实）' ? 1 : 3)
  byType.push(runCase(`${name}`, text))
}

console.log('\n\n◤ 三、块大小影响（同一篇，不同 delta 粒度）◢')
const mixedText = buildFixture(FIXTURES['混合（最接近真实）'], 4)
for (const chunk of [4, 12, 40]) {
  runCase(`delta=${chunk} 字符`, mixedText, { chunk, singleIters: 3 })
}

/* ── 结论 ──────────────────────────────────────────────── */

console.log('\n\n◤ 四、扩展性检查 ◢')
console.log('理想情况下长度翻倍、成本翻倍（线性）。超线性说明解析器有 O(n²) 风险。')
for (let i = 1; i < results.length; i++) {
  const a = results[i - 1]
  const b = results[i]
  const lenRatio = b.len / a.len
  const costRatio = b.onceNew / a.onceNew
  const verdict = costRatio > lenRatio * 1.6 ? '⚠ 超线性' : '✓ 线性'
  console.log(
    `   ${a.len.toString().padStart(6)} → ${b.len.toString().padStart(6)} 字符  ` +
      `长度 ${lenRatio.toFixed(1)}x  新版成本 ${costRatio.toFixed(1)}x  ${verdict}`
  )
}

console.log('\n\n◤ 五、相对旧版的整体开销 ◢')
const totalOld = results.reduce((s, r) => s + r.streamOld, 0)
const totalNew = results.reduce((s, r) => s + r.streamNew, 0)
console.log(`   流式累计   旧 ${fmt(totalOld)}   新 ${fmt(totalNew)}   倍数 ${(totalNew / totalOld).toFixed(2)}x`)
console.log(`   最慢单帧   新 ${fmt(Math.max(...byType.map((r) => r.p95New)))} (p95)`)
