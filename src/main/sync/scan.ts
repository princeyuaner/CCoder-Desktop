import { statSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SyncConfig } from '../../shared/sync'
import { syncable, syncableDir } from './filters'

/** 一个文件在某一侧的 (大小, mtime)。mtime 用毫秒；同一毫秒内的两次写靠内容比对兜底。 */
export interface FileStamp {
  size: number
  mtimeMs: number
}

export interface ScanResult {
  files: Map<string, FileStamp>
  /** 进入过的目录数（含根）。给界面「已监听 N 个目录」用。 */
  dirs: number
  /**
   * 读不到的目录 / 文件条目数。**大于 0 时这一轮不能做镜像删除**：
   * 否则一个暂时没权限的子目录会被当成「本地已删」，把目标端的整棵子树删掉。
   */
  errors: number
}

/** 同步版只给「复制完立刻取一次」这种少量调用用。 */
export function stampOfSync(path: string): FileStamp | null {
  try {
    const st = statSync(path)
    if (!st.isFile()) return null
    return { size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

export function sameStamp(a: FileStamp | undefined, b: FileStamp | undefined): boolean {
  return !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs
}

/**
 * 扫一棵树，应用与源端**同一套**过滤规则（垃圾目录不下探、排除项跳过）。
 * 符号链接 / 目录 / 读不到的文件一律跳过 —— 目标端从基线里找不到它们，
 * 因而永远不会被删。
 */
export async function scanTree(root: string, cfg: SyncConfig): Promise<ScanResult> {
  const files = new Map<string, FileStamp>()
  let dirs = 0
  let errors = 0

  const walk = async (dir: string, relDir: string): Promise<void> => {
    dirs++
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      errors++
      return
    }

    await Promise.all(
      entries.map(async (entry) => {
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (!syncableDir(rel, cfg)) return
          await walk(join(dir, entry.name), rel)
          return
        }
        if (!entry.isFile()) return
        if (!syncable(rel, cfg)) return
        try {
          const st = await stat(join(dir, entry.name))
          if (!st.isFile()) return
          files.set(rel, { size: st.size, mtimeMs: st.mtimeMs })
        } catch {
          // 读不到就当不存在；下一轮巡检会再试。
          // 但计数会让本轮跳过镜像删除，防止把「读不到」误判成「已删」。
          errors++
        }
      })
    )
  }

  await walk(root, '')
  return { files, dirs, errors }
}
