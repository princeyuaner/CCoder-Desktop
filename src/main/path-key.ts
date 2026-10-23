import { resolve } from 'node:path'

/**
 * 路径身份键：绝对化、统一正斜杠、去尾斜杠；Windows 上折叠大小写。
 *
 * 只用于“这两个路径是不是同一个目录 / 谁在谁里面”这类判断，
 * 不要拿它去读盘 —— 真正的路径仍用原始字符串。
 */
export function pathKey(p: string): string {
  const n = resolve(p).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? n.toLowerCase() : n
}

/** child 是否等于 parent 或位于 parent 内。 */
export function isSameOrInside(child: string, parent: string): boolean {
  const parentKey = pathKey(parent)
  const childKey = pathKey(child)
  return childKey === parentKey || childKey.startsWith(`${parentKey}/`)
}
