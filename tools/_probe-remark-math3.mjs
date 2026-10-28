/*
 * 第三轮探针：验证「解析后按原文位置还原误判」这条路。
 *
 * 前两轮确认：
 *   - 单行 $$...$$ 被吃掉成 INLINE_MATH，不是 BLOCK_MATH
 *   - 默认规则会把 $5 到 $10 / $HOME 和 $PATH 吃成行内公式
 *   - singleDollarTextMath:false 连正常的 $x$ 一起杀，太粗
 *
 * 所以思路是：让 remark-math 照常解析，再写一个插件遍历 inlineMath 节点，
 * 用 node.position 取回原文，判定「这看着不像公式」就换回文本。
 * 这里验证 position 拿得到原文，以及启发式规则的判定结果。
 */
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import { visit } from 'unist-util-visit'

const CJK = /[　-〿一-鿿＀-￯]/

/**
 * 判定一个 inlineMath 节点是不是误判。
 * 返回 null 表示接受，返回原因字符串表示要还原成文本。
 */
function rejectReason(value, raw) {
  const isDouble = raw.startsWith('$$')

  // 单行 $$...$$ 被 remark 当成了行内 —— 这个要保留，按块级渲染
  if (isDouble) return null

  // 内容里出现中文/全角字符，基本不可能是公式
  if (CJK.test(value)) return 'CJK'

  // 定界符紧贴空白：`$ 5` 或 `5 $` 不是公式
  if (/^\s/.test(value) || /\s$/.test(value)) return 'edge-space'

  // 像个环境变量名：全大写字母数字下划线
  if (/^[A-Z_][A-Z0-9_]*$/.test(value)) return 'env-var'

  // 含空白但没有任何 LaTeX 特征 —— 多半是「$a 到 b$」这种散文
  const hasTex = /[\\^_{}=+\-*/<>]/.test(value)
  if (/\s/.test(value) && !hasTex) return 'prose-space'

  return null
}

const CASES = [
  ['正常行内', '设 $x$ 为变量。'],
  ['正常行内（复杂）', '这是 $e^{i\\theta} = \\cos\\theta$ 的公式。'],
  ['含空格的真公式', '结果 $a = b + c$ 成立。'],
  ['含空格无符号', '范围 $a b$ 内。'],
  ['价格区间', '这个方案预算是 $5 到 $10。'],
  ['单个价格', '总共 $5 块。'],
  ['shell 变量', '环境变量 $HOME 和 $PATH 也要一并设置。'],
  ['单个环境变量', '把 $PATH 加上。'],
  ['shell 算术', '在 shell 里执行 $((1 + 2)) 得到 3。'],
  ['中文夹心', '从 $x 到 y$ 的范围。'],
  ['两个变量', '变量写作 $a$ 和 $b$。'],
  ['单行双美元（应保留）', '$$e^{i\\pi} + 1 = 0$$'],
  ['单行双美元带文字', '公式：$$E = mc^2$$ 就这样。'],
  ['下标', '变量 $a_1$ 和 $b_2$。'],
  ['乘号', '公式 $a \\cdot b$ 里含乘号。'],
  ['百分号', '增长了 $5\\%$。'],
  ['dirname 风格', '路径 $HOME/bin 下。']
]

const proc = unified().use(remarkParse).use(remarkGfm).use(remarkMath).freeze()

function walk(node, out = []) {
  if (node.type === 'inlineMath') {
    out.push({ kind: 'math', value: node.value, pos: node.position })
    return out
  }
  if (node.type === 'math') {
    out.push({ kind: 'block-math', value: node.value, pos: node.position })
    return out
  }
  if (node.type === 'text') {
    out.push({ kind: 'text', value: node.value })
    return out
  }
  for (const k of node.children || []) walk(k, out)
  return out
}

/* 用 position 的 offset 从原文切出原始片段（含定界符） */
function rawSlice(pos, src) {
  if (!pos || pos.start.offset == null || pos.end.offset == null) return ''
  return src.slice(pos.start.offset, pos.end.offset)
}

let rejected = 0
let accepted = 0

for (const [label, md] of CASES) {
  const tree = proc.parse(md)
  const nodes = walk(tree)
  console.log(`\n── ${label}`)
  console.log(`   输入: ${JSON.stringify(md)}`)
  for (const n of nodes) {
    if (n.kind === 'text') {
      console.log(`   text: ${JSON.stringify(n.value)}`)
      continue
    }
    if (n.kind === 'block-math') {
      console.log(`   BLOCK_MATH: ${JSON.stringify(n.value)}`)
      continue
    }
    const raw = rawSlice(n.pos, md)
    const reason = rejectReason(n.value, raw)
    if (reason) {
      rejected++
      console.log(`   inlineMath(${JSON.stringify(n.value)}) raw=${JSON.stringify(raw)} → 还原 [${reason}]`)
    } else {
      accepted++
      console.log(`   inlineMath(${JSON.stringify(n.value)}) raw=${JSON.stringify(raw)} → 保留`)
    }
  }
}

console.log(`\n\n保留 ${accepted} 个，还原 ${rejected} 个。`)
