/**
 * Claude 工具输出的归一化与截断。
 *
 * 历史回放和实时流用同一套口径：`tool_result.content` 可能是字符串，
 * 也可能是块数组。放进 AgentEvent 之前统一成字符串，并**限制长度** ——
 * 一次 Read 大文件 / 跑测试的输出可能几 MB，原样跨 IPC、进 React state、
 * 进回放缓存，最后还要排版成 <pre>，代价全落在界面线程上。
 */
import { t } from '../../i18n'

/** 与 Codex 侧保持一致：20k 字符 ≈ 几百行，足够看报错与上下文 */
export const MAX_TOOL_OUTPUT = 20_000

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** tool_result 的 content 可能是字符串，也可能是块数组 */
export function stringifyContent(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    return v
      .map((b) => {
        const o = obj(b)
        if (!o) return ''
        return typeof o.text === 'string' ? o.text : `[${str(o.type) || 'block'}]`
      })
      .filter(Boolean)
      .join('\n')
  }
  return v == null ? '' : JSON.stringify(v)
}

/** 超长输出截断并标注；完整内容 CLI 也不再单独提供，留着只会拖慢界面 */
export function clipToolOutput(text: string): string {
  return text.length > MAX_TOOL_OUTPUT
    ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n${t('codex.outputTruncated')}`
    : text
}
