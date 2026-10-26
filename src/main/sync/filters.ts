/**
 * 同步过滤三层：同步范围 / 用户排除项 / 内置噪音规则。
 *
 * 逐条移植 CCoder 版的语义（原参考实现 `sync_remote.py` 的
 * `in_scope` / `is_excluded` / `is_junk`）。全是纯函数，扫描、监听、删除
 * 三条路共用同一份判定 —— 否则会出现「排除项挡得住复制、却绕过去把目标端
 * 删了」这种漂移。
 *
 * 匹配一律小写：Windows 文件名本来就不区分大小写，而配置项是人手写的。
 * 归一只作用于「匹配」——真正落盘的相对路径保留扫描时的大小写。
 */

import type { SyncConfig } from '../../shared/sync'
import { SYNC_JUNK } from '../../shared/sync'

export type JunkRules = typeof SYNC_JUNK

/** 相对路径 / 配置模式的归一：`\` → `/`、去掉首尾 `/`、转小写。 */
export function normalizeRelPath(raw: string): string {
  return raw.replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '').toLowerCase()
}

/** 配置里逗号 / 空白分隔的列表 → 归一后的去重数组。 */
export function normalizePatternList(raw: string[]): string[] {
  const out: string[] = []
  for (const item of raw) {
    const n = normalizeRelPath(item)
    if (n && !out.includes(n)) out.push(n)
  }
  return out
}

/** 路径是否落在同步范围内。空范围 = 整个源目录。 */
export function inScope(rel: string, syncRoots: string[]): boolean {
  if (syncRoots.length === 0) return true
  const norm = normalizeRelPath(rel)
  if (!norm) return true
  return syncRoots.some((root) => norm === root || norm.startsWith(`${root}/`))
}

/**
 * 目录是否**可能**含有范围内的文件 —— 决定遍历时要不要下探。
 *
 * 与 inScope 的唯一差别：范围的祖先目录也返回 true。配置里写嵌套范围
 * （`trunk/defines`）时，遍历走到 `trunk` 不能被判成「不在范围内」。
 */
export function inScopeDir(rel: string, syncRoots: string[]): boolean {
  if (syncRoots.length === 0) return true
  const norm = normalizeRelPath(rel)
  if (!norm) return true
  return syncRoots.some(
    (root) => norm === root || norm.startsWith(`${root}/`) || root.startsWith(`${norm}/`)
  )
}

/**
 * 用户排除项。`true` = 该路径不参与复制 / 删除 / 对账。
 *
 *  - 含 `/` → 按相对路径匹配：等于该路径，或位于它之下；
 *  - 不含 `/` → 按任意一层路径分量匹配，支持 `*` / `?`；
 *  - 含 `/` 且带通配符 → 按整条相对路径做通配（星号可跨层）。
 */
export function isExcluded(rel: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false
  const norm = normalizeRelPath(rel)
  if (!norm) return false
  const parts = norm.split('/').filter(Boolean)
  for (const pat of patterns) {
    if (!pat) continue
    if (pat.includes('/') && (pat.includes('*') || pat.includes('?'))) {
      if (globMatch(norm, pat)) return true
    } else if (pat.includes('/')) {
      if (norm === pat || norm.startsWith(`${pat}/`)) return true
    } else if (parts.some((part) => globMatch(part, pat))) {
      return true
    }
  }
  return false
}

/**
 * 单层名字的通配匹配：`*` 任意串、`?` 恰好一个字符。
 * `[` 当作普通字符（排除项是手写的，不引入字符集语义）。
 * 双指针带回溯，避免 `*****a` 这类模式指数爆炸。
 */
export function globMatch(name: string, pattern: string): boolean {
  let n = 0
  let p = 0
  let star = -1
  let mark = 0
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === name[n])) {
      n++
      p++
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p
      p++
      mark = n
    } else if (star >= 0) {
      p = star + 1
      n = ++mark
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++
  return p === pattern.length
}

/** 目录名是不是内置垃圾 —— 遍历时据此剪枝（不下探）。 */
export function isJunkDir(name: string, rules: JunkRules = SYNC_JUNK): boolean {
  return (rules.dirNames as readonly string[]).includes(name.toLowerCase())
}

/**
 * 路径是不是内置垃圾：祖先目录名、叶子名、叶子后缀、叶子前缀，
 * 四条里中一条就是。
 *
 * 祖先目录名判的是 `parts[0..n-2]`，**不含叶子** —— 目录自身靠
 * isJunkDir 剪枝。所以 `isJunk('.git')` 为假、`isJunk('.git/x')` 为真。
 */
export function isJunk(rel: string, rules: JunkRules = SYNC_JUNK): boolean {
  const parts = normalizeRelPath(rel).split('/').filter(Boolean)
  if (parts.length === 0) return false
  if (parts.slice(0, -1).some((p) => isJunkDir(p, rules))) return true
  const name = parts[parts.length - 1]
  if ((rules.fileNames as readonly string[]).includes(name)) return true
  if ((rules.suffixes as readonly string[]).some((s) => name.endsWith(s))) return true
  return (rules.prefixes as readonly string[]).some((p) => name.startsWith(p))
}

/** 一条路径（文件或目录都适用）该不该被跳过。 */
export function isJunkEntry(
  rel: string,
  rules: JunkRules = SYNC_JUNK,
  isDirectory = false
): boolean {
  if (isDirectory) {
    const name = normalizeRelPath(rel).split('/').pop() ?? ''
    return isJunkDir(name, rules) || isJunk(`${rel}/_`, rules)
  }
  return isJunk(rel, rules)
}

/** 一条路径该不该参与同步 —— 三层过完的结论。 */
export function syncable(rel: string, cfg: SyncConfig): boolean {
  return (
    inScope(rel, cfg.syncRoots) &&
    !isExcluded(rel, cfg.exclude) &&
    !isJunk(rel)
  )
}

/** 同 syncable，但按目录判垃圾（`trunk/build` 这种目录自身名字就是垃圾）。 */
export function syncableDir(rel: string, cfg: SyncConfig): boolean {
  return (
    inScopeDir(rel, cfg.syncRoots) &&
    !isExcluded(rel, cfg.exclude) &&
    !isJunkEntry(rel, SYNC_JUNK, true)
  )
}
