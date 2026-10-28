/**
 * Markdown 渲染的入口 —— 在两种实现之间切换。
 *
 *   RichMarkdown  react-markdown + remark-gfm/math + rehype-katex（新）
 *   RichText      rich.tsx 的手写解析器（旧）
 *
 * 迁移期间两套并存。默认走新实现；要现场对比，在 DevTools 里执行
 *
 *   localStorage.setItem('ccoder.mdEngine', 'legacy')   // 切回手写版
 *   localStorage.removeItem('ccoder.mdEngine')          // 回到新版
 *
 * 然后刷新窗口。确认新版没回归后，删掉这个文件和 rich.tsx 里的旧实现。
 */
import { RichText } from './rich'
import { RichMarkdown } from './RichMarkdown'

const ENGINE_KEY = 'ccoder.mdEngine'

function useLegacy(): boolean {
  try {
    return localStorage.getItem(ENGINE_KEY) === 'legacy'
  } catch {
    // 隐私模式 / 存储被禁用时按默认处理
    return false
  }
}

export function MarkdownText(props: { text: string; cwd?: string }): JSX.Element {
  return useLegacy() ? <RichText {...props} /> : <RichMarkdown {...props} />
}
