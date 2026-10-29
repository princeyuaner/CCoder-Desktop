import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { DirCheckResult } from '../shared/add-dirs'
import { cwdKey, workspaceRel } from '../shared/path'

/**
 * 附加目录的磁盘侧校验。
 *
 * 分两层：
 *  - `sanitizeAddDirs`（shared）只做字符串清洗，配置可以保留已经不存在的目录；
 *  - 这里在真正启动 CLI 之前把不存在的 / 不是文件夹的过滤掉，别让
 *    `--add-dir` 拿着一个坏路径把进程拖崩。
 */

/** 启动前过滤：只保留当前磁盘上确实是文件夹的目录 */
export function existingAddDirs(dirs: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    let real: string
    try {
      real = realpathSync.native(dir)
      if (!statSync(real).isDirectory()) continue
    } catch {
      continue
    }
    const key = cwdKey(real)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(real)
  }
  return out
}

/** 把一条已存在的目录规范化；失败时返回 null（不参与去重） */
function canonicalOf(p: string): string | null {
  try {
    return realpathSync.native(p)
  } catch {
    return null
  }
}

/**
 * 校验用户要添加的一条目录。
 *
 * 只接受绝对路径；必须存在且是文件夹；不能在工作区里面（工作区本来就
 * 可访问，再加一次只是噪音）；不能和已有条目重复。返回的 `path` 是
 * realpath，符号链接会按真实目标去重。
 */
export function validateSessionDir(
  raw: string,
  cwd: string,
  existing: readonly string[]
): DirCheckResult {
  const dir = raw.trim()
  if (!dir || !isAbsolute(dir)) {
    return { ok: false, reason: 'notAbsolute', path: dir }
  }

  const real = canonicalOf(dir)
  if (!real) return { ok: false, reason: 'missing', path: dir }
  try {
    if (!statSync(real).isDirectory()) {
      return { ok: false, reason: 'notDirectory', path: real }
    }
  } catch {
    return { ok: false, reason: 'missing', path: dir }
  }

  if (workspaceRel(cwd, real) !== null) {
    return { ok: false, reason: 'inside', path: real }
  }

  const key = cwdKey(real)
  const duplicate = existing.some((p) => {
    const other = canonicalOf(p)
    return cwdKey(other ?? p) === key
  })
  if (duplicate) return { ok: false, reason: 'duplicate', path: real }

  return { ok: true, reason: 'ok', path: real }
}
