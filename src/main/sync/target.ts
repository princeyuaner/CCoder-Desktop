import { copyFile, mkdir, open, readdir, rmdir, stat, unlink, utimes } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SyncConfig } from '../../shared/sync'
import { t } from '../i18n'
import { pathKey } from '../path-key'
import { scanTree } from './scan'
import type { FileStamp } from './scan'

/** 目标端不可访问 / 前置检查没过。调用方把它当「这一轮失败」，退避后重试。 */
export class SyncError extends Error {}

/** 内容比对的并发度：瓶颈在往返延迟而不是带宽。 */
const COMPARE_WORKERS = 8
/** 候选数超过这个阈值才值得开并发。 */
const PARALLEL_THRESHOLD = 32

export interface SyncTarget {
  /** 内容基线的身份串。换目标端 → 基线作废 → 重做全量核对。 */
  readonly stateKey: string
  check(): Promise<void>
  scan(): Promise<Map<string, FileStamp>>
  stat(rel: string): Promise<FileStamp | null>
  compareMany(
    srcRoot: string,
    rels: string[],
    onProgress: (done: number, total: number) => void
  ): Promise<Map<string, boolean>>
  copyFrom(srcFile: string, rel: string): Promise<void>
  remove(rel: string): Promise<boolean>
  prune(rels: string[]): Promise<string[]>
  close(): void
}

/** 目标端 = 本地路径 / 映射网络盘。SSH 将来落在这里，引擎不需要改。 */
export class LocalTarget implements SyncTarget {
  readonly stateKey: string

  constructor(
    private readonly root: string,
    private readonly cfg: () => SyncConfig
  ) {
    this.stateKey = pathKey(root)
  }

  async check(): Promise<void> {
    try {
      const st = await stat(this.root)
      if (!st.isDirectory()) throw new SyncError(t('sync.error.dstUnreachable', { path: this.root }))
    } catch (e) {
      if (e instanceof SyncError) throw e
      throw new SyncError(t('sync.error.dstUnreachable', { path: this.root }))
    }
  }

  async scan(): Promise<Map<string, FileStamp>> {
    return (await scanTree(this.root, this.cfg())).files
  }

  async stat(rel: string): Promise<FileStamp | null> {
    try {
      const st = await stat(join(this.root, rel))
      return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null
    } catch {
      return null
    }
  }

  async compareMany(
    srcRoot: string,
    rels: string[],
    onProgress: (done: number, total: number) => void
  ): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>()
    if (rels.length < PARALLEL_THRESHOLD) {
      for (const rel of rels) {
        out.set(rel, await filesIdentical(join(srcRoot, rel), join(this.root, rel)))
      }
      onProgress(rels.length, rels.length)
      return out
    }

    let next = 0
    let done = 0
    const worker = async (): Promise<void> => {
      while (true) {
        const i = next++
        if (i >= rels.length) return
        const rel = rels[i]
        out.set(rel, await filesIdentical(join(srcRoot, rel), join(this.root, rel)))
        done++
        // 进度只在大批比对时上报，避免每文件一次 IPC / 日志
        if (done % 64 === 0) onProgress(done, rels.length)
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(COMPARE_WORKERS, rels.length) }, () => worker())
    )
    onProgress(rels.length, rels.length)
    return out
  }

  async copyFrom(srcFile: string, rel: string): Promise<void> {
    const dst = join(this.root, rel)
    await mkdir(dirname(dst), { recursive: true })

    let srcStat
    try {
      srcStat = await stat(srcFile)
    } catch (e) {
      throw new SyncError(t('sync.error.copyRead', { rel, reason: reasonOf(e) }))
    }

    await copyFile(srcFile, dst)
    // 保留 mtime：目标端那份的 mtime 等于源端的，镜像删除的安全闸才准。
    // 属性设置失败不算复制失败：内容已经过去了，下一轮会退回读内容比对。
    try {
      await utimes(dst, srcStat.atime, srcStat.mtime)
    } catch {
      // 忽略属性失败
    }

    // 网络盘上值得复核大小：写完就断的情况不罕见，而且它无声。
    try {
      const got = await stat(dst)
      if (got.size !== srcStat.size) {
        throw new SyncError(
          t('sync.error.copySizeMismatch', {
            rel,
            want: srcStat.size,
            got: got.size
          })
        )
      }
    } catch (e) {
      if (e instanceof SyncError) throw e
      throw new SyncError(t('sync.error.copyVerify', { rel, reason: reasonOf(e) }))
    }
  }

  async remove(rel: string): Promise<boolean> {
    try {
      const p = join(this.root, rel)
      const st = await stat(p)
      // 目标端在这个路径上变成了目录：不递归删，交给下一轮 / 人工处理。
      if (st.isDirectory()) {
        throw new SyncError(t('sync.error.deleteIsDir', { rel }))
      }
      await unlink(p)
      return true
    } catch (e) {
      if (e instanceof SyncError) throw e
      if (isMissing(e)) return false
      throw e
    }
  }

  async prune(rels: string[]): Promise<string[]> {
    const removed: string[] = []
    for (const rel of rels) {
      const dir = join(this.root, rel)
      try {
        const entries = await readdir(dir)
        // 只删确实是空的：目标端那些装着运行产物的目录绝不会被误伤
        if (entries.length === 0) {
          await rmdir(dir)
          removed.push(rel)
        }
      } catch {
        // 删不掉（被占用 / 权限）就算了，下一轮还会再看到它
      }
    }
    return removed
  }

  close(): void {
    // 本地目标无事可做
  }
}

/** 两个文件内容是否完全一致。分块读，遇到不同立刻返回。 */
async function filesIdentical(a: string, b: string): Promise<boolean> {
  let ha: Awaited<ReturnType<typeof open>> | null = null
  let hb: Awaited<ReturnType<typeof open>> | null = null
  try {
    const [sa, sb] = await Promise.all([stat(a), stat(b)])
    if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false
    if (sa.size === 0) return true

    ha = await open(a, 'r')
    hb = await open(b, 'r')
    const bufA = Buffer.allocUnsafe(1 << 20)
    const bufB = Buffer.allocUnsafe(1 << 20)
    let pos = 0
    let left = sa.size
    while (left > 0) {
      const want = Math.min(left, bufA.length)
      const [ra, rb] = await Promise.all([
        ha.read(bufA, 0, want, pos),
        hb.read(bufB, 0, want, pos)
      ])
      if (ra.bytesRead !== rb.bytesRead) return false
      if (ra.bytesRead === 0) return left === 0
      if (!bufA.subarray(0, ra.bytesRead).equals(bufB.subarray(0, rb.bytesRead))) {
        return false
      }
      pos += ra.bytesRead
      left -= ra.bytesRead
    }
    return true
  } catch {
    // 读不了就当不同 → 会走复制，让下一轮去处理真问题
    return false
  } finally {
    await ha?.close().catch(() => undefined)
    await hb?.close().catch(() => undefined)
  }
}

function isMissing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function reasonOf(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
