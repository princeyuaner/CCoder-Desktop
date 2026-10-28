/**
 * 把公式折叠成单个自定义元素 —— 解决流式渲染里最贵的那部分成本。
 *
 * ── 问题 ────────────────────────────────────────────────
 * 实测（tools/_bench-where.mjs）：公式密集内容 8k 字、675 帧流式渲染时，
 * remark 解析只占总时间的 6%，**94% 花在把 hast 树转成 React 元素**。
 * 单个公式的 KaTeX 输出有 258 个嵌套元素，8 个公式就是 2000+ 节点，
 * 每一帧全部重新构建 —— 无论公式有没有变。
 *
 * 缓存 KaTeX 的 hast 节点只能省掉排版，省不掉这 94%。
 *
 * ── 做法 ────────────────────────────────────────────────
 * 这个插件把每个公式替换成一个自定义元素 `<katex-math tex="..." display>`，
 * react-markdown 的 components 映射会把它渲染成一个 React 组件。组件内部
 * 用 useMemo 缓存 KaTeX 的输出 DOM，只要 tex 和 display 不变就完全跳过
 * 重新解析和元素构建。
 *
 * 代价：公式的 DOM 由 KaTeX 生成的 HTML 字符串注入，而不是 React 元素树。
 * 这是本项目唯一用到 innerHTML 的地方 —— 输入是 TeX，KaTeX 自己的 parser
 * 会拒掉非法内容，且 `trust: false`（默认）禁用 \href / \includegraphics。
 * 见 rich.tsx 顶部关于 XSS 面的说明。
 */
import type { Root, Element } from 'hast'
import { toText } from 'hast-util-to-text'

/** 自定义标签名。react-markdown 会按 tagName 找 components 映射 */
export const MATH_TAG = 'katex-math'

function classesOf(el: Element): string[] {
  const c = el.properties?.className
  if (Array.isArray(c)) return c.map(String)
  if (typeof c === 'string') return (c as string).split(/\s+/)
  return []
}

export default function rehypeMathToTag() {
  return (tree: Root): void => {
    const visit = (node: any): void => {
      const kids: any[] | undefined = node.children
      if (!kids) return

      for (let i = 0; i < kids.length; i++) {
        const child = kids[i]
        if (child.type !== 'element') {
          if (child.children) visit(child)
          continue
        }

        // ── 块级：<pre><code class="language-math math-display"> ──
        if (child.tagName === 'pre' && Array.isArray(child.children)) {
          const code = child.children.find(
            (k: any) => k.type === 'element' && k.tagName === 'code'
          )
          if (code && classesOf(code).includes('language-math')) {
            const tex = toText(code, { whitespace: 'pre' }).trim()
            if (tex) {
              kids[i] = {
                type: 'element',
                tagName: MATH_TAG,
                properties: { tex, display: 'true' },
                children: []
              }
              continue
            }
          }
        }

        // ── 行内 ──
        const cls = classesOf(child)
        if (cls.includes('language-math') || cls.includes('math-inline')) {
          const display = cls.includes('math-display')
          const tex = toText(child, { whitespace: 'pre' }).trim()
          if (tex) {
            kids[i] = {
              type: 'element',
              tagName: MATH_TAG,
              properties: { tex, display: display ? 'true' : undefined },
              children: []
            }
            continue
          }
        }

        if (child.children) visit(child)
      }
    }

    visit(tree)
  }
}
