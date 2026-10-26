/**
 * 路径工具。**只做字符串处理，不碰 fs** —— 渲染进程也要用。
 *
 * Windows 路径两种分隔符都可能出现：CLI 写回来的通常已经是正斜杠，
 * 用户用目录选择器选出来的是反斜杠。任何切分都必须同时认出来。
 * 之前 Composer 里有一份只认 `/` 的副本，Windows 路径切不开，
 * 界面上把整条路径当成了文件名 —— 所以这类东西只留一份。
 */

function segments(p: string): string[] {
  return p.split(/[\\/]/).filter(Boolean)
}

/** 路径最后一段：项目名 / 文件名 */
export function baseName(p: string): string {
  const parts = segments(p)
  return parts[parts.length - 1] || p
}

/** 文件路径的父目录，统一用 `/` 连接 */
export function dirName(p: string): string {
  const parts = segments(p)
  parts.pop()
  return parts.join('/')
}

/**
 * 路径身份键：统一分隔符、去尾斜杠，Windows 盘符路径折叠大小写。
 *
 * 只用于 Map / Record 查找，**不要拿它去读盘** —— 真正的路径仍用原字符串。
 * 会话里记的 cwd 是 CLI 写回来的反斜杠形式，而从 git worktree list / 目录
 * 选择器拿到的是正斜杠形式；直接拿两种写法互相查表永远查不到。
 */
export function cwdKey(p: string): string {
  const n = p.replace(/\\/g, '/').replace(/\/+$/, '')
  // 盘符 C:/ 和 UNC //server 在 Windows 上大小写不敏感
  return /^[a-zA-Z]:/.test(n) || n.startsWith('//') ? n.toLowerCase() : n
}

/**
 * 父目录的短形式 —— 折叠行只有这么点地方。
 * 两层以内原样显示（src/main）；更深的只留最后一层（…/components）。
 */
export function shortDir(dir: string): string {
  const parts = segments(dir)
  if (parts.length === 0) return ''
  if (parts.length <= 2) return parts.join('/')
  return `…/${parts[parts.length - 1]}`
}
