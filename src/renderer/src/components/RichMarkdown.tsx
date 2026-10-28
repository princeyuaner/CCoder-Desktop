/**
 * 模型输出的 Markdown 渲染 —— react-markdown 版（方案 I）。
 *
 * 与 rich.tsx（手写解析器）并存，通过开关切换，便于对比和回滚。
 *
 * ── 为什么换 ─────────────────────────────────────────────
 * 手写解析器每缺一种语法都要改 parseBlocks + inlineNodes 两处，边界还得
 * 重新想一遍。已经缺的：引用块、删除线、嵌套列表、转义字符、数学公式。
 * react-markdown 走 mdast → hast → React 元素，**全程不经过 innerHTML**，
 * 和手写版的安全模型一致（XSS 面相同），所以当初"为了安全才手写"这条
 * 理由并不成立。
 *
 * ── 数学公式的两个坑 ────────────────────────────────────
 * remark-math 默认规则会把 `$5 到 $10`、`$HOME 和 $PATH` 吃成行内公式。
 * 详见 remark-math-guard.ts —— 那里按原文位置还原误判。
 */
import { useMemo } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { CodeCard, codeNodes, openLinkedTarget } from './rich'
import mathGuard from './remark-math-guard'
import rehypeMathToTag, { MATH_TAG } from './rehype-math-to-tag'
import { KatexMath, type MathProps } from './KatexMath'

const REMARK_PLUGINS = [remarkGfm, remarkMath, mathGuard]
/*
 * 公式折叠成单个自定义元素，由 KatexMath 组件内部缓存 KaTeX 输出。
 * 见 rehype-math-to-tag.ts 里的实测数据 —— 直接跑 rehype-katex 会让
 * 94% 的流式渲染时间花在重复构建公式的 React 元素上。
 */
const REHYPE_PLUGINS = [rehypeMathToTag] as unknown as NonNullable<
  React.ComponentProps<typeof Markdown>['rehypePlugins']
>

/* ── 代码块：围栏代码走 CodeCard，行内代码走 .ic ──────── */

/** recma 传过来的 props 里 code 的 class 形如 `language-ts` */
function langOf(className: unknown): string {
  const m = /language-([\w+#.-]+)/.exec(String(className ?? ''))
  return m ? m[1] : ''
}

export function RichMarkdown({ text, cwd = '' }: { text: string; cwd?: string }): JSX.Element {
  /*
   * components 对象每次渲染都重建的话，react-markdown 会认为组件变了，
   * 整棵树重挂载 —— 流式输出时表现为闪烁和滚动位置丢失。
   * cwd 会变（切换会话），所以只按 cwd 缓存。
   */
  const components = useMemo<Components>(
    () => ({
      /* 行内代码：围栏代码块在 pre 里被整体接管，不会走到这里 */
      code({ className, children, ...rest }) {
        return (
          <code className={className ? className : 'ic'} {...rest}>
            {children}
          </code>
        )
      },

      /* 围栏代码块容器：换成项目自己的卡片（带语言标签和复制按钮） */
      pre({ children }) {
        const child = Array.isArray(children) ? children[0] : children
        const props = (child as any)?.props ?? {}
        const cls = String(props.className ?? '')

        // 数学块：rehype-katex 已经渲染成 <span class="katex-display">，
        // 出现在 <pre> 里说明没被处理掉，原样放行不要包卡片
        if (/language-math/.test(cls)) return <>{children}</>

        const lang = langOf(cls)
        const code = String(props.children ?? '').replace(/\n$/, '')
        return <CodeCard lang={lang} code={code} />
      },

      /* 链接：不给 href，点击交给主进程（理由同 rich.tsx 的 openLinkedTarget） */
      a({ href, children }) {
        const target = String(href ?? '')
        return (
          <span
            className="lnk"
            role="link"
            tabIndex={0}
            title={target}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              // 拖选文字时也会触发 click；别让"复制一段话"变成打开链接
              if (window.getSelection()?.toString()) return
              openLinkedTarget(cwd, target)
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              openLinkedTarget(cwd, target)
            }}
          >
            {children}
          </span>
        )
      },

      /* 标题：现有 CSS 只认 h2/h3/h4 三档，h1 和更深的一并压进这三档 */
      h1({ children }) {
        return <h2 className="md-h">{children}</h2>
      },
      h2({ children }) {
        return <h2 className="md-h">{children}</h2>
      },
      h3({ children }) {
        return <h3 className="md-h">{children}</h3>
      },
      h4({ children }) {
        return <h4 className="md-h">{children}</h4>
      },

      /* 公式：rehype-math-to-tag 折叠出来的自定义标签 */
      [MATH_TAG](props: MathProps) {
        return <KatexMath tex={props.tex} display={props.display} />
      },

      p({ children }) {
        return <p className="md-p">{children}</p>
      },
      ul({ children }) {
        return <ul className="md-list">{children}</ul>
      },
      ol({ children, start }) {
        return (
          <ol className="md-list" start={start ?? undefined}>
            {children}
          </ol>
        )
      },
      table({ children }) {
        return (
          <div className="tblwrap">
            <table className="md-table">{children}</table>
          </div>
        )
      },
      hr() {
        return <hr className="md-hr" />
      },

      /* 引用块：手写版没有，这里补上 */
      blockquote({ children }) {
        return <blockquote className="md-quote">{children}</blockquote>
      },

      /* 图片：不直接加载外链（对话里的图片地址不可信），降级成链接文本 */
      img({ src, alt }) {
        return (
          <span className="lnk" role="link" tabIndex={0} title={String(src ?? '')}>
            [{String(alt ?? '图片')}]
          </span>
        )
      }
    }),
    [cwd]
  )

  return (
    <div className="md selectable">
      <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
        {text}
      </Markdown>
    </div>
  )
}

/* codeNodes 目前在 RichMarkdown 里用不到（CodeCard 内部自己调），
 * 导出是为了保留类型引用，避免打包器把 rich.tsx 的着色逻辑判成死代码。 */
void codeNodes
