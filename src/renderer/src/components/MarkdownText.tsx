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

/**
 * 引擎开关只在页面加载时读一次。
 *
 * 流式输出时这个组件每 16ms 渲染一次，之前每次都同步读 localStorage ——
 * 没必要，而且切换开关本来就要求刷新窗口才生效。
 */
const USE_LEGACY = ((): boolean => {
  try {
    return localStorage.getItem(ENGINE_KEY) === 'legacy'
  } catch {
    // 隐私模式 / 存储被禁用时按默认处理
    return false
  }
})()

export function MarkdownText(props: {
  text: string
  cwd?: string
  /** 这条消息还在流式增长：尾部代码块先不着色 */
  streaming?: boolean
}): JSX.Element {
  return USE_LEGACY ? <RichText {...props} /> : <RichMarkdown {...props} />
}
