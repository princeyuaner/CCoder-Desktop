import type { SyncConfig } from '../../shared/sync'
import { normalizeRelPath, syncable, syncableDir } from './filters'
import { sameStamp, type FileStamp } from './scan'

/** 基线表的一条：上次**已核实**的双方状态。 */
export interface FilePair {
  src: FileStamp
  dst: FileStamp
}

/** 为什么要复制。两个子原因分开是为了报告能讲人话。 */
export type CopyWhy = 'targetMissingOrSize' | 'contentDiffers'

/** 本地已删却**没删**目标端的原因。 */
export type KeptWhy = 'targetModified' | 'autoDeleteOff' | 'sourceIncomplete'

export interface CopyItem {
  rel: string
  why: CopyWhy
}

export interface KeptItem {
  rel: string
  why: KeptWhy
}

/** 一轮的计划。只描述要做什么，不做任何 I/O。 */
export interface ContentPlan {
  copies: CopyItem[]
  /** 候选删除（已过「仍在过滤范围内」，还没过 mayDelete 安全闸）。 */
  vanished: Map<string, FilePair>
  /** 双方状态都被核实过、可以直接写进新基线的。 */
  nextBaseline: Map<string, FilePair>
  unchangedCount: number
  firstFullReconcile: boolean
}

export interface ContentPlanArgs {
  srcNow: Map<string, FileStamp>
  baseline: Map<string, FilePair>
  /** null = 本轮不遍历目标端（事件轮）。 */
  dstNow: Map<string, FileStamp> | null
  scanDst: () => Promise<Map<string, FileStamp>>
  statDst: (rel: string) => Promise<FileStamp | null>
  compareMany: (rels: string[]) => Promise<Map<string, boolean>>
  cfg: SyncConfig
}

/**
 * 按内容核对本地与目标，产出一轮的计划。
 *
 * 判定顺序：
 *  - 两侧 (大小, mtime) 与基线逐位相同 → 跳过（稳态下绝大多数）
 *  - 目标缺失 / 大小不同 → 直接复制，不读内容
 *  - 大小相同但状态变过 → 才真读内容比对
 *  - 内容一致、只是 mtime 不同 → 不动，只把「已核实一致」记回基线
 *  - 基线里有、本地没了、且仍在过滤范围内 → 候选镜像删除
 *  - 基线里有、本地没了、但已落到过滤范围外 → 静静遗忘（用户改了配置）
 */
export async function contentPlan(args: ContentPlanArgs): Promise<ContentPlan> {
  const { srcNow, baseline, dstNow, scanDst, statDst, compareMany, cfg } = args
  const first = baseline.size === 0
  // 没有基线时「不遍历目标端」反而更慢（逐文件 stat vs 整树遍历），
  // 所以首次运行强制扫一遍目标端。
  const dst = dstNow ?? (first ? await scanDst() : null)

  const next = new Map<string, FilePair>()
  const copies: CopyItem[] = []
  /** 大小相同、状态变过 —— 必须读内容才能定夺的那批。 */
  const pairs: string[] = []
  /** 本轮问过的目标端状态。仅「不遍历目标端」时用得上。 */
  const asked = new Map<string, FileStamp>()

  for (const [rel, s] of srcNow) {
    const rec = baseline.get(rel)

    let d: FileStamp | null | undefined
    if (dst) {
      d = dst.get(rel)
    } else if (rec && sameStamp(rec.src, s)) {
      // 不遍历目标端，而本地这边与基线逐位相同 → 目标端沿用基线旧值，不碰网络。
      // 这正是「不遍历」的代价：目标端那份被人改过就发现不了（巡检会兜底）。
      next.set(rel, rec)
      continue
    } else {
      d = await statDst(rel)
      if (d) asked.set(rel, d)
    }

    if (d && rec && sameStamp(rec.src, s) && sameStamp(rec.dst, d)) {
      next.set(rel, rec) // 双方都没动过 —— 稳态下走这条
      continue
    }
    if (!d || d.size !== s.size) {
      // 目标缺失 / 大小不同 → 直接复制；大小都对不上就没必要读内容。
      copies.push({ rel, why: 'targetMissingOrSize' })
      continue
    }
    pairs.push(rel) // 大小相同但状态变过 → 读内容定夺
  }

  let same = next.size
  if (pairs.length > 0) {
    const verdict = await compareMany(pairs)
    for (const rel of pairs) {
      if (verdict.get(rel) !== true) {
        copies.push({ rel, why: 'contentDiffers' })
        continue
      }
      const s = srcNow.get(rel)
      if (!s) continue
      const d = dst ? dst.get(rel) : asked.get(rel)
      // 防御：进 pairs 的前提就是拿到过目标端状态；真为 null 就不记基线。
      if (!d) continue
      next.set(rel, { src: s, dst: d })
      same++
    }
  }

  const vanished = new Map<string, FilePair>()
  for (const [rel, rec] of baseline) {
    if (srcNow.has(rel)) continue
    // 历史条目落到过滤范围之外 = 用户改了范围 / 排除项，不是文件没了。
    // 静静遗忘，否则改一次排除项就会让目标端掉一批文件。
    if (!syncable(rel, cfg)) continue
    vanished.set(rel, rec)
  }

  return {
    copies,
    vanished,
    nextBaseline: next,
    unchangedCount: same,
    firstFullReconcile: first
  }
}

/**
 * 镜像删除的安全闸：目标端那份**还是我们同步过去的样子**吗。
 *
 * 判据是「目标端现在的 (大小, mtime) 与基线里记的目标端值逐位相同」。
 * 含义：自打复制过去之后，没有任何别的东西碰过它。目标端自己生成的
 * 文件从来不在基线里，因此永远不会被删。
 */
export function mayDelete(rec: FilePair, currentDst: FileStamp | null): boolean {
  return currentDst != null && sameStamp(rec.dst, currentDst)
}

/**
 * 把这次删掉的路径折算成「可能因此变空的父目录」列表（深的先删）。
 *
 * 三道收窄：只考虑本次删除涉及的父目录；范围根自己不删；过滤规则
 * 命中的目录不删。真正“是不是空的”由执行层判断。
 */
export function pruneCandidates(deletedRels: string[], cfg: SyncConfig): string[] {
  const level = new Set<string>()
  for (const rel of deletedRels) {
    const norm = normalizeRelPath(rel)
    let parent = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) : ''
    while (parent) {
      level.add(parent)
      parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : ''
    }
  }
  return [...level]
    .sort((a, b) => b.length - a.length)
    .filter(
      (rel) =>
        !cfg.syncRoots.includes(normalizeRelPath(rel)) && syncableDir(rel, cfg)
    )
}
