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
import { useEffect, useMemo, useRef, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { CodeCard, openLinkedTarget } from './rich'
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

/*
 * 流式解析节流。
 *
 * remark/rehype 每次渲染都是**整段文本重新解析**，和文本长度线性相关。
 * 短回答保持 16ms（≈60fps）不影响观感；几千字以后按帧率换解析时间：
 * 用户看到的是光标在走，而不是整段 Markdown 每秒重排 60 次。
 */
const STREAM_INTERVAL_MS = 16
const MEDIUM_STREAM_INTERVAL_MS = 48
const LONG_STREAM_INTERVAL_MS = 100
const MEDIUM_CHARS = 6_000
const LONG_CHARS = 20_000

/* ── 代码块：围栏代码走 CodeCard，行内代码走 .ic ──────── */

/** recma 传过来的 props 里 code 的 class 形如 `language-ts` */
function langOf(className: unknown): string {
  const m = /language-([\w+#.-]+)/.exec(String(className ?? ''))
  return m ? m[1] : ''
}

export function RichMarkdown({
  text,
  cwd = '',
  streaming = false
}: {
  text: string
  cwd?: string
  streaming?: boolean
}): JSX.Element {
  /*
   * components 对象每次渲染都重建的话，react-markdown 会认为组件变了，
   * 整棵树重挂载 —— 流式输出时表现为闪烁和滚动位置丢失。
   * cwd 会变（切换会话），所以只按 cwd 缓存。
   *
   * text / streaming 每个 delta 都会变，不能进依赖；用 ref 把最新值带进
   * 这个稳定对象里，让 pre 能判断「哪个代码块还在增长」。
   */
  /*
   * 实际交给 Markdown 解析的文本。流式时按文本长度降频更新，
   * 非流式（历史回放 / 已收口）立即对齐。
   */
  const [shown, setShown] = useState(text)
  const latest = useRef(text)
  latest.current = text
  const shownAt = useRef(0)
  const throttleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!streaming) {
      if (throttleTimer.current !== null) {
        clearTimeout(throttleTimer.current)
        throttleTimer.current = null
      }
      shownAt.current = Date.now()
      setShown(text)
      return
    }
    const now = Date.now()
    const interval =
      text.length >= LONG_CHARS
        ? LONG_STREAM_INTERVAL_MS
        : text.length >= MEDIUM_CHARS
          ? MEDIUM_STREAM_INTERVAL_MS
          : STREAM_INTERVAL_MS
    const wait = Math.max(0, interval - (now - shownAt.current))
    if (wait === 0) {
      shownAt.current = now
      setShown(latest.current)
      return
    }
    // 已经有一次待执行的刷新就够了：它读的是 latest，不会落后
    if (throttleTimer.current !== null) return
    throttleTimer.current = setTimeout(() => {
      throttleTimer.current = null
      shownAt.current = Date.now()
      setShown(latest.current)
    }, wait)
  }, [text, streaming])

  useEffect(
    () => () => {
      if (throttleTimer.current !== null) clearTimeout(throttleTimer.current)
    },
    []
  )

  const streamingRef = useRef(streaming)
  const textEndRef = useRef(shown.length)
  streamingRef.current = streaming
  textEndRef.current = shown.length

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
      pre({ node, children }) {
        const child = Array.isArray(children) ? children[0] : children
        const props = (child as any)?.props ?? {}
        const cls = String(props.className ?? '')

        // 数学块：rehype-katex 已经渲染成 <span class="katex-display">，
        // 出现在 <pre> 里说明没被处理掉，原样放行不要包卡片
        if (/language-math/.test(cls)) return <>{children}</>

        const lang = langOf(cls)
        const code = String(props.children ?? '').replace(/\n$/, '')

        /*
         * 流式时只有尾部围栏块还在增长 —— 它的 mdast 位置一直顶到文本末尾。
         * 其余已完成块位置固定，着色结果由 CodeCard 的 useMemo 缓存。
         * 留 1 个字符余量，容忍结尾换行。
         */
        const end = node?.position?.end.offset
        const growing =
          streamingRef.current &&
          typeof end === 'number' &&
          textEndRef.current - end <= 1

        return <CodeCard lang={lang} code={code} streaming={growing} />
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

  /*
   * 元素也用 memo 固定住：`shown` 没变的那些帧，React 能直接复用同一个
   * element、跳过 Markdown 子树的重新解析。只做节流不做这一步的话，
   * 父组件每次 delta 重渲染仍然会让 react-markdown 全量 parse 一遍。
   */
  const body = useMemo(
    () => (
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
      >
        {shown}
      </Markdown>
    ),
    [shown, components]
  )

  return <div className="md selectable">{body}</div>
}
