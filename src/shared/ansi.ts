/**
 * 终端控制序列清理。
 *
 * CLI 的工具输出（npm / vite / tsc…）默认按 TTY 上色，文本里夹着
 * `\x1b[2m` 这类 ANSI 转义。我们把结果直接塞进 `<pre>`，浏览器不认这些
 * 字节，屏幕上就只剩下一堆 `[2m`、`[39m` —— 看起来像格式错乱。
 * 展示前统一抹掉，实时流和历史回放走同一处。
 */
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g

export function stripAnsi(s: string): string {
  // 绝大多数文本没有转义字节，避免每条结果都跑一次正则
  return s.includes('\x1b') ? s.replace(ANSI_RE, '') : s
}
