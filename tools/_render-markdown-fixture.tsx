/**
 * 回归夹具：把两个 Markdown 实现都渲染成 HTML 字符串。
 *
 * 打包成 CJS 给 verify-markdown-engine.cjs 用。不走 Electron —— 这台机器
 * 上 electron.exe 起不来，SSR 足够验证解析和 DOM 结构。
 *
 * 只做验证，不参与打包。
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { RichText } from '../src/renderer/src/components/rich'
import { RichMarkdown } from '../src/renderer/src/components/RichMarkdown'

/*
 * KaTeX 现在是动态 import。SSR 不会跑 useEffect，所以夹具在渲染前
 * 先把它预取好；测试脚本会 await 这个函数一次。
 */
export { preloadKatex } from '../src/renderer/src/components/KatexMath'

/** 新版：react-markdown + katex */
export function render(md: string): string {
  return renderToStaticMarkup(<RichMarkdown text={md} />)
}

/** 新版 · 流式中：尾部代码块应跳过着色，前面的块保持高亮 */
export function renderStreaming(md: string): string {
  return renderToStaticMarkup(<RichMarkdown text={md} streaming />)
}

/** 旧版：手写解析器 */
export function renderLegacy(md: string): string {
  return renderToStaticMarkup(<RichText text={md} />)
}
