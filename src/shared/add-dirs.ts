import { cwdKey } from './path'

/**
 * 会话级附加目录（Claude Code 的 `--add-dir`）。
 *
 * 目录跟着 (cli, cwd, sessionId) 这条会话走，不写工作区、也不写 settings：
 * 同一个工作区里的两条会话完全可以需要不同的目录。
 */

/** 单条会话最多记这么多，挡住手写文件里的超长垃圾 */
export const MAX_ADD_DIRS = 20

/** 目录路径的展示上限；Windows 长路径也远小于这个量级 */
const MAX_PATH = 1024

/** 跨平台地判断「看起来是绝对路径」—— shared 里不能 import node:path */
function looksAbsolute(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('//') || p.startsWith('/')
}

/**
 * 清洗目录列表：去空、去重、限长。
 *
 * **不碰 fs**：目录可能被临时拔掉，配置仍然要保留（启动时再过滤）。
 * 真正「存不存在 / 是不是文件夹」的校验在 main/session-dirs.ts。
 */
export function sanitizeAddDirs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of raw) {
    if (typeof value !== 'string') continue
    const path = value.trim()
    if (!path || path.length > MAX_PATH || !looksAbsolute(path)) continue
    const key = cwdKey(path)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(path)
    if (out.length >= MAX_ADD_DIRS) break
  }
  return out
}

/** 两个目录列表是否是同一组（顺序无关，Windows 大小写不敏感） */
export function sameAddDirs(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const keys = new Set(a.map(cwdKey))
  return b.every((p) => keys.has(cwdKey(p)))
}

export type DirCheckReason =
  | 'ok'
  | 'notAbsolute'
  | 'missing'
  | 'notDirectory'
  | 'inside'
  | 'duplicate'

export interface DirCheckResult {
  ok: boolean
  reason: DirCheckReason
  /** 校验后的规范路径（存在时是 realpath，缺失时是用户输入的原样） */
  path: string
}

/** 最近使用的一条附加目录，带来源会话标题 */
export interface RecentAddDir {
  path: string
  title: string
}
