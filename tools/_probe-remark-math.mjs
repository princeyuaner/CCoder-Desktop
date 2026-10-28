/*
 * 验证 remark-math 的行内 $ 边界规则。
 *
 * 效果图里那张「误判对照」是我按推理标的，没有实测。这个脚本用真实的
 * 用例跑一遍解析，把每条输入被切成什么节点打出来。
 *
 * 只跑解析，不碰 React —— 目的只是确认规则，不是验证渲染。
 * 不参与打包，随时可删。
 */
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'

const CASES = [
  ['块级公式', '$$e^{i\\pi} + 1 = 0$$'],
  ['块级公式（带空行包围）', '前文\n\n$$\\int_0^1 x\\,dx$$\n\n后文'],
  ['行内公式：简单变量', '设 $x$ 为变量。'],
  ['行内公式：中等复杂', '这是 $e^{i\\theta} = \\cos\\theta$ 的公式。'],
  ['行内公式：紧贴文字', '值$x$值'],
  ['价格区间（美元符号）', '这个方案预算是 $5 到 $10，超出部分按 $2 每小时计费。'],
  ['价格：单个', '总共 $5 块。'],
  ['shell 变量 HOME', '环境变量 $HOME 和 $PATH 也要一并设置。'],
  ['shell 变量 PATH', '把 $PATH 加上。'],
  ['shell 算术', '在 shell 里执行 $((1 + 2)) 得到 3。'],
  ['两个字母变量', '变量写作 $a$ 和 $b$。'],
  ['疑似公式残留', '从 $x 到 y$ 的范围，两端都要包含。'],
  ['单个 $ 无配对', '只要一边 $ 没有配对。'],
  ['$ 后有空格', '价格 $ 5 元。'],
  ['$ 前有空格', '价格 5 $ 。'],
  ['转义的 \\$', '真的要花 \\$5 这么多。'],
  ['行内代码里的 $', '代码 `$HOME` 不应该渲染。'],
  ['行内代码里的公式', '代码 `$x$` 不应该渲染。'],
  ['围栏代码里的 $', '```\n$HOME\n$$x$$\n```'],
  ['数学里含下划线', '变量 $a_1$ 和 $b_2$。'],
  ['数学里含 \\*', '公式 $a * b$ 里含星号。'],
  ['跨行的两个 $', '从 $x\n到 y$ 的范围。'],
  ['只有一个 $', '价格是 $5。'],
  ['连续两个公式', '$a$ 和 $b$ 都是变量。'],
  ['公式后紧跟数字', '$a$5 是什么意思']
]

/** 把 mdast 压成一行可读的摘要 */
function summarize(node, out = []) {
  if (!node) return out
  const kids = node.children || []
  const push = (label) => out.push(label)

  switch (node.type) {
    case 'root':
      kids.forEach((k) => summarize(k, out))
      break
    case 'paragraph': {
      const inner = []
      kids.forEach((k) => summarize(k, inner))
      push(`p[${inner.join(' | ')}]`)
      break
    }
    case 'text':
      push(`text(${JSON.stringify(node.value)})`)
      break
    case 'inlineMath':
      push(`INLINE_MATH(${JSON.stringify(node.value)})`)
      break
    case 'math':
      push(`BLOCK_MATH(${JSON.stringify(node.value)})`)
      break
    case 'inlineCode':
      push(`inlineCode(${JSON.stringify(node.value)})`)
      break
    case 'code':
      push(`code(${JSON.stringify(node.value)})`)
      break
    case 'emphasis':
    case 'strong':
    case 'delete':
    case 'link': {
      const inner = []
      kids.forEach((k) => summarize(k, inner))
      push(`${node.type}[${inner.join(' | ')}]`)
      break
    }
    case 'list': {
      const items = kids.map((li) => {
        const inner = []
        ;(li.children || []).forEach((k) => summarize(k, inner))
        return `{${inner.join(' | ')}}`
      })
      push(`${node.ordered ? 'ol' : 'ul'}(${items.join(' ')})`)
      break
    }
    case 'heading': {
      const inner = []
      kids.forEach((k) => summarize(k, inner))
      push(`h${node.depth}[${inner.join(' | ')}]`)
      break
    }
    default:
      push(`${node.type}`)
  }
  return out
}

const proc = unified().use(remarkParse).use(remarkGfm).use(remarkMath).freeze()

let inlineOk = 0
let inlineTotal = 0

for (const [label, md] of CASES) {
  const tree = proc.parse(md)
  const lines = summarize(tree)
  console.log(`\n── ${label}`)
  console.log(`   输入: ${JSON.stringify(md)}`)
  for (const l of lines) console.log(`   输出: ${l}`)
  if (md.includes('$')) {
    inlineTotal++
    if (lines.some((l) => l.includes('INLINE_MATH') || l.includes('BLOCK_MATH'))) inlineOk++
  }
}

console.log(`\n\n共 ${CASES.length} 条用例，其中 ${inlineTotal} 条含 $，${inlineOk} 条产生了数学节点。`)
