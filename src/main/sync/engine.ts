import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SyncConfig } from '../../shared/sync'
import { t } from '../i18n'
import { pathKey } from '../path-key'
import {
  sameBaseline,
  loadBaseline,
  saveBaseline
} from './baseline'
import {
  contentPlan,
  mayDelete,
  pruneCandidates,
  type FilePair,
  type KeptItem
} from './plan'
import { scanTree, stampOfSync } from './scan'
import { SyncError, type SyncTarget } from './target'
import type { FileStamp } from './scan'

/** 日志里每段最多列几条样本。 */
const SAMPLE_LIMIT = 10

export interface FailedItem {
  rel: string
  reason: string
}

/** 一轮报告。「计划 N」与「实际 M」分开记：只报实际上会掩盖中途掉线。 */
export interface RoundReport {
  plannedCopies: number
  plannedDeletes: number
  copied: number
  deleted: number
  /** 删除时目标端原本就不存在 —— 既不是成功也不是失败。 */
  absent: number
  failedCopies: FailedItem[]
  failedDeletes: FailedItem[]
  pruned: string[]
  kept: KeptItem[]
  unchanged: number
  firstFullReconcile: boolean
  copiedRel: string[]
  deletedRel: string[]
  costMs: number
  scannedDirs: number
  ok: boolean
  nothingToDo: boolean
}

/**
 * 一轮同步的编排。
 *
 * 复制串行（单写者）、删除深的先、只清真的空了的目录、基线落盘时失败项不记。
 * 报告分五段：待复制 / 待删除 / 跳过 / 提醒 / 失败 —— 用户问「我改的东西
 * 怎么没同步」时，答案一定在「跳过」或「提醒」里，而且必须写清原因。
 */
export class SyncEngine {
  private readonly srcKey: string

  constructor(
    private readonly srcRoot: string,
    private readonly target: SyncTarget,
    private readonly cfg: () => SyncConfig,
    private readonly baselinePath: string,
    private readonly log: (line: string) => void = () => undefined,
    private readonly now: () => number = Date.now
  ) {
    this.srcKey = pathKey(srcRoot)
  }

  async runRound(reconcileTarget: boolean): Promise<RoundReport> {
    const t0 = this.now()
    const conf = this.cfg()

    // 源目录在同步途中被卸载 / 删除时，scanTree 会得到空表，从而把目标端
    // 全部当成「本地已删」。这是最危险的一种误删，必须先挡住。
    try {
      const st = await stat(this.srcRoot)
      if (!st.isDirectory()) {
        throw new SyncError(t('sync.error.srcUnreachable', { path: this.srcRoot }))
      }
    } catch (e) {
      if (e instanceof SyncError) throw e
      throw new SyncError(t('sync.error.srcUnreachable', { path: this.srcRoot }))
    }

    await this.target.check()

    const srcScan = await scanTree(this.srcRoot, conf)
    const srcNow = srcScan.files
    const baseline = loadBaseline(this.baselinePath, this.srcKey, this.target.stateKey)
    const dstNow = reconcileTarget ? await this.target.scan() : null

    if (baseline.size === 0) {
      this.log(
        `[内容对账] 尚无基线（首次运行，或基线被删）：要对 ${srcNow.size} 个文件做一次全量核对，可能要一两分钟`
      )
    }

    const plan = await contentPlan({
      srcNow,
      baseline,
      dstNow,
      scanDst: () => this.target.scan(),
      statDst: (rel) => this.target.stat(rel),
      compareMany: (rels) =>
        this.target.compareMany(this.srcRoot, rels, (done, total) => {
          if (done === total || done % 256 === 0) {
            this.log(`[内容对账] 已比对 ${done}/${total} …`)
          }
        }),
      cfg: conf
    })

    // ---- 删除：先过安全闸，过不去的进「提醒」 ----
    const deletes: string[] = []
    const kept: KeptItem[] = []
    const next = new Map<string, FilePair>(plan.nextBaseline)
    if (srcScan.errors > 0) {
      // 源目录里有读不到的条目。此时「没扫到」不等于「本地已删」——
      // 把候选全部保留在基线里，这一轮不做任何镜像删除，下一轮重试。
      this.log(`[提醒] 源目录有 ${srcScan.errors} 个条目读取失败，本轮跳过镜像删除`)
      for (const [rel, rec] of plan.vanished) {
        // 基线要完整保留，界面只带一小批样本 —— 读不到一棵大树时不能把
        // 几万条路径全塞进快照和日志。
        next.set(rel, rec)
        if (kept.length < SAMPLE_LIMIT) kept.push({ rel, why: 'sourceIncomplete' })
      }
      if (plan.vanished.size > kept.length) {
        this.log(`  … 其余 ${plan.vanished.size - kept.length} 项提醒略`)
      }
    } else {
      for (const [rel, rec] of plan.vanished) {
        if (!conf.deleteMissing) {
          kept.push({ rel, why: 'autoDeleteOff' })
          continue
        }
        const current = await this.target.stat(rel)
        if (!current) continue // 目标端本来就没有，没什么可删的
        if (mayDelete(rec, current)) deletes.push(rel)
        else kept.push({ rel, why: 'targetModified' })
      }
    }

    this.logPending(plan.copies.map((c) => ({ rel: c.rel, why: c.why })), deletes)

    // ---- 复制：串行，单写者 ----
    let copied = 0
    const failedCopies: FailedItem[] = []
    const copiedRel: string[] = []
    for (const item of plan.copies) {
      try {
        await this.target.copyFrom(join(this.srcRoot, item.rel), item.rel)
        copied++
        copiedRel.push(item.rel)
      } catch (e) {
        failedCopies.push({ rel: item.rel, reason: reasonOf(e) })
      }
    }

    // ---- 删除：深的先 ----
    let deleted = 0
    let absent = 0
    const failedDeletes: FailedItem[] = []
    const deletedRel: string[] = []
    for (const rel of [...deletes].sort((a, b) => b.length - a.length)) {
      try {
        if (await this.target.remove(rel)) {
          deleted++
          deletedRel.push(rel)
        } else {
          absent++
        }
      } catch (e) {
        failedDeletes.push({ rel, reason: reasonOf(e) })
      }
    }

    // ---- 清空目录：只清因此变空的那些 ----
    const pruned = deletes.length > 0 ? await this.target.prune(pruneCandidates(deletes, conf)) : []

    // ---- 基线落盘 ----
    // 记的是复制完之后双方的真实状态。失败的项不记 / 删失败的留着旧记录，
    // 下一轮重新发现并重试。
    const failedRels = new Set<string>([
      ...failedCopies.map((f) => f.rel),
      ...failedDeletes.map((f) => f.rel)
    ])
    for (const rel of copiedRel) {
      if (failedRels.has(rel)) continue
      const s = stampOfSync(join(this.srcRoot, rel))
      const d: FileStamp | null = await this.target.stat(rel)
      if (s && d) next.set(rel, { src: s, dst: d })
    }
    for (const f of failedDeletes) {
      const old = plan.vanished.get(f.rel)
      if (old && !next.has(f.rel)) next.set(f.rel, old)
    }
    if (!sameBaseline(next, baseline)) {
      saveBaseline(this.baselinePath, this.srcKey, this.target.stateKey, next)
    }

    const report: RoundReport = {
      plannedCopies: plan.copies.length,
      plannedDeletes: deletes.length,
      copied,
      deleted,
      absent,
      failedCopies,
      failedDeletes,
      pruned,
      kept,
      unchanged: plan.unchangedCount,
      firstFullReconcile: plan.firstFullReconcile,
      copiedRel,
      deletedRel,
      costMs: this.now() - t0,
      scannedDirs: srcScan.dirs,
      ok: failedCopies.length + failedDeletes.length === 0,
      nothingToDo: plan.copies.length === 0 && deletes.length === 0
    }
    this.logResult(report)
    return report
  }

  private logPending(
    copies: { rel: string; why: 'targetMissingOrSize' | 'contentDiffers' }[],
    deletes: string[]
  ): void {
    this.log(`[待复制] ${copies.length} 个文件，[待删除] ${deletes.length} 项`)
    this.logSample(
      '复制',
      copies.map(
        (c) =>
          `(${c.why === 'contentDiffers' ? '内容不一样' : '目标端没有或大小不同'}) ${c.rel}`
      )
    )
    this.logSample('删除', deletes.map((rel) => `(本地已删) ${rel}`))
  }

  private logResult(r: RoundReport): void {
    if (r.nothingToDo) {
      this.log(`[完成] 没有需要同步的内容，目标端与本地一致（用时 ${r.costMs} ms）`)
      return
    }
    const prunedNote = r.pruned.length > 0 ? `，顺带清掉 ${r.pruned.length} 个空目录` : ''
    this.log(
      `[完成] 复制 ${r.copied}/${r.plannedCopies}，删除 ${r.deleted} 项` +
        `（${r.absent} 项目标端本不存在）${prunedNote}，失败 ${r.failedCopies.length + r.failedDeletes.length} 项` +
        `（用时 ${r.costMs} ms）`
    )
    const failedHead = [...r.failedCopies, ...r.failedDeletes].slice(0, SAMPLE_LIMIT)
    for (const f of failedHead) this.log(`  [失败] ${f.rel} — ${f.reason}`)
    const failedTotal = r.failedCopies.length + r.failedDeletes.length
    if (failedTotal > failedHead.length) {
      this.log(`  … 其余 ${failedTotal - failedHead.length} 项失败略`)
    }
    const keptHead = r.kept.slice(0, SAMPLE_LIMIT)
    for (const k of keptHead) {
      this.log(
        `  [提醒] ${k.rel} — ${
          k.why === 'targetModified'
            ? '目标端那份已被别处改动过，未删除'
            : k.why === 'autoDeleteOff'
              ? '镜像删除已关闭，未删除'
              : '源目录本轮读取不完整，未删除'
        }`
      )
    }
    if (r.kept.length > keptHead.length) {
      this.log(`  … 其余 ${r.kept.length - keptHead.length} 项提醒略`)
    }
  }

  /** 清单只列前几条：一次几百个文件时，全列出来会把日志和界面淹掉。 */
  private logSample(title: string, items: string[]): void {
    const head = items.slice(0, SAMPLE_LIMIT)
    for (const line of head) this.log(`  ${line}`)
    if (items.length > head.length) {
      this.log(`  … 其余 ${items.length - head.length} 个${title}略`)
    }
  }
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
