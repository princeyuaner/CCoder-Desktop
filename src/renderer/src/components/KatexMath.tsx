/**
 * 单个公式的渲染组件。
 *
 * ── 为什么要单独抽出来 ──────────────────────────────────
 * KaTeX 排版一个中等公式约 0.4 ms、输出 258 个元素。流式输出时每帧都会
 * 重新渲染整条消息，如果公式跟着 React 树一起重建，这部分成本会乘上
 * 帧数 —— 实测占公式密集内容的 94%。
 *
 * 这里是唯一能真正把成本降下来的位置：useMemo 依赖 [tex, display, ready]，
 * 只要公式本身没变，**连 KaTeX 都不调用**，直接复用上次的 HTML。
 * 依赖 rehype-math-to-tag 把公式折叠成单个元素。
 *
 * ── 为什么要延迟加载 ────────────────────────────────────
 * 聊天包里绝大多数会话一个公式都没有，而 katex 本身约 270KB。这里改成
 * 动态 import：首屏先空闲预取，真正出现公式时通常已经就绪；万一还没到，
 * 先显示 TeX 源码，加载完成后自动补排版。
 *
 * ── 安全 ────────────────────────────────────────────────
 * 这是本项目唯一使用 dangerouslySetInnerHTML 的地方。输入是 TeX 源码，
 * 由 KaTeX 的 parser 处理：
 *   - KaTeX 默认 trust:false，\href / \url / \includegraphics 都不执行
 *   - 排版失败时走 catch，退化成 <code> 显示源码，不注入任何 HTML
 * 渲染层没有别的路径把模型输出直接塞进 DOM。
 */
import { useEffect, useMemo, useState } from 'react'

type KatexApi = (typeof import('katex'))['default']

let katex: KatexApi | null = null
let loading: Promise<void> | null = null
/** 等待 KaTeX 就绪的组件；加载完成后统一唤醒 */
const waiters = new Set<() => void>()

/** 预取 KaTeX。测试夹具在 SSR 前也会先 await 它。 */
export function preloadKatex(): Promise<void> {
  if (katex) return Promise.resolve()
  if (!loading) {
    loading = import('katex')
      .then((mod) => {
        katex = mod.default
        for (const wake of waiters) wake()
        waiters.clear()
      })
      .catch(() => {
        // 加载失败就继续显示源码；下次遇到公式再重试
        loading = null
      })
  }
  return loading
}

/* 首屏空闲时预取：等到真有公式时一般已经加载完，不会闪源码 */
if (typeof window !== 'undefined') {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => void preloadKatex())
  } else {
    window.setTimeout(() => void preloadKatex(), 1500)
  }
}

/** 缓存上限：超长会话里公式种类有限，400 条足够，防止无限增长 */
const CACHE_LIMIT = 400
const htmlCache = new Map<string, string>()

function renderTex(tex: string, displayMode: boolean): string | null {
  if (!katex) return null

  const key = `${displayMode ? 'd' : 'i'}\u0000${tex}`
  const hit = htmlCache.get(key)
  if (hit !== undefined) return hit

  try {
    const html = katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      strict: false,
      // 不做 MathML 分支：深色主题下它本来就被 CSS 隐藏，
      // 但流式渲染里仍要为它构建一整套 DOM。见 CHANGELOG/性能基准。
      output: 'html'
    })
    if (htmlCache.size >= CACHE_LIMIT) {
      const first = htmlCache.keys().next().value
      if (first !== undefined) htmlCache.delete(first)
    }
    htmlCache.set(key, html)
    return html
  } catch {
    return null
  }
}

export interface MathProps {
  tex?: string
  display?: string | boolean
}

export function KatexMath({ tex = '', display }: MathProps): JSX.Element {
  const displayMode = display === true || display === 'true'

  /*
   * ready 只用来触发「KaTeX 刚到货」这一次重渲染。
   * 必须进 useMemo 的依赖：否则加载前算出的 null 会被缓存到同一个 tex 上，
   * 加载完成也不会重新排版。
   */
  const [ready, setReady] = useState(katex !== null)
  useEffect(() => {
    if (katex) {
      setReady(true)
      return
    }
    let alive = true
    const wake = (): void => {
      if (alive) setReady(true)
    }
    waiters.add(wake)
    void preloadKatex()
    return () => {
      alive = false
      waiters.delete(wake)
    }
  }, [])

  /*
   * 模块级缓存 + useMemo 双保险：
   * 模块级缓存跨组件实例生效（同一条消息里重复的公式只排版一次），
   * useMemo 保证同一个组件重渲染时不重新查表 —— 看似多余，但流式场景下
   * 这个组件每帧都要 render 一次，省掉 Map 查找和字符串拼接。
   */
  const html = useMemo(() => renderTex(tex, displayMode), [tex, displayMode, ready])

  if (html == null) {
    // 还没加载完就显示源码；加载完仍失败才是真的排版失败
    return (
      <code className="ic" title={ready ? '公式渲染失败' : undefined}>
        {displayMode ? `$$${tex}$$` : `$${tex}$`}
      </code>
    )
  }

  return (
    <span
      className={displayMode ? 'katex-slot katex-slot--block' : 'katex-slot'}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
