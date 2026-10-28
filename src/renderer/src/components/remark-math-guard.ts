/**
 * remark 插件：修正 remark-math 在真实对话里的两类误判。
 *
 * ── 为什么要这个 ─────────────────────────────────────────
 * remark-math 默认把「任意一对 $」都当成行内公式。实测（tools/_probe-remark-math.mjs）：
 *
 *   $5 到 $10        → inlineMath("5 到 ")     价格区间被吃掉
 *   $HOME 和 $PATH   → inlineMath("HOME 和 ")  shell 变量被吃掉
 *   $((1 + 2))       → 正常（有括号保护）
 *
 * 这个客户端是 Claude Code 的桌面壳，对话里 $VAR 出现频率很高，不能不管。
 * 而 singleDollarTextMath:false 会把正常的 $x$ 一并杀掉，太粗。
 *
 * ── 做法 ────────────────────────────────────────────────
 * 让 remark-math 照常解析，再按节点 position 取回原文逐条判定。
 * 判定为「不像公式」的，把节点换成纯文本节点，定界符原样保留。
 *
 * 另外 remark-math 把**单行** `$$...$$` 也解析成行内公式（块级必须写成
 * $$\n...\n$$ 三行式）。这里按原文开头是不是 `$$` 把它升格成块级。
 */
import type { Plugin } from 'unified'
import type { Root, PhrasingContent, Text } from 'mdast'

/** 中文、日文假名、全角标点 —— 公式里基本不会出现 */
const CJK = /[　-〿぀-ヿ一-鿿＀-￯]/

/** 环境变量名：全大写字母 / 数字 / 下划线，且不是纯数字（$5$ 这种其实像公式） */
const ENV_VAR = /^[A-Z_][A-Z0-9_]*$/

/** LaTeX 里常见的结构字符，用来区分「真公式」和「夹着空格的散文」 */
const TEX_MARK = /[\\^_{}=+\-*/<>()[\]]/

interface Positioned {
  position?: {
    start: { offset?: number | null }
    end: { offset?: number | null }
  }
}

/** 取回节点在原文里的完整片段（含定界符）；拿不到时返回空串 */
function rawSlice(node: Positioned, src: string): string {
  const p = node.position
  if (!p || p.start.offset == null || p.end.offset == null) return ''
  return src.slice(p.start.offset, p.end.offset)
}

/**
 * 判定一个行内 math 节点是不是误判。
 * 返回 null 表示接受，返回字符串表示要还原成文本（值只是给测试看的原因）。
 */
export function rejectionReason(value: string, raw: string): string | null {
  if (!raw.startsWith('$')) return null
  // $$...$$ 永远保留 —— 它是块级公式，调用方会升格
  if (raw.startsWith('$$')) return null

  if (CJK.test(value)) return 'cjk'
  if (ENV_VAR.test(value)) return 'env-var'
  // 定界符紧贴空白：`$ 5` / `5 $` 不是公式
  if (/^\s/.test(value) || /\s$/.test(value)) return 'edge-space'
  // 有空格却没有任何 LaTeX 结构字符 —— 「$a b$」这种更像散文
  if (/\s/.test(value) && !TEX_MARK.test(value)) return 'prose'

  return null
}

/**
 * 把一个 math 节点还原成文本节点。
 *
 * `raw` 是原文片段；拿不到时退回用 `$` + value + `$` 重建，
 * 保证内容不丢（位置信息缺失只发生在手工构造的树上）。
 */
function toText(value: string, raw: string): Text {
  return { type: 'text', value: raw || `$${value}$` }
}

const MATH_PLUGIN: Plugin<[], Root> = () => (tree, file) => {
  const src = String(file.value ?? '')

  const walk = (node: Root | PhrasingContent | any): void => {
    const kids = node.children as any[] | undefined
    if (!kids) return

    for (let i = 0; i < kids.length; i++) {
      const child = kids[i]

      if (child.type === 'inlineMath') {
        const raw = rawSlice(child, src)

        // 单行 $$...$$：remark-math 给了 math-inline，但内容块级呈现
        if (raw.startsWith('$$')) {
          child.data = {
            hName: 'code',
            hProperties: { className: ['language-math', 'math-display'] },
            hChildren: [{ type: 'text', value: child.value }]
          }
          continue
        }

        const reason = rejectionReason(child.value, raw)
        if (reason) kids[i] = toText(child.value, raw)
        continue
      }

      // blockquote / list / emphasis 这类容器要递归下去
      if (child.children) walk(child)
    }
  }

  walk(tree)
}

export default MATH_PLUGIN
