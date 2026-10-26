import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { Notification } from 'electron'
import { IPC } from '../../shared/ipc'
import {
  SYNC_BUBBLE_ROWS,
  SYNC_CHANGE_LIMIT,
  SYNC_FAILED_LIMIT,
  SYNC_KEPT_LIMIT,
  SYNC_LOG_LIMIT,
  type SyncChange,
  type SyncConfig,
  type SyncKeptItem,
  type SyncProblem,
  type SyncSnapshot,
  type SyncWorkspaceState
} from '../../shared/sync'
import { logMain } from '../crash-log'
import { t } from '../i18n'
import { pathKey } from '../path-key'
import { baselineFile } from './baseline'
import { configProblem, loadConfig, saveConfig } from './config-store'
import { SyncEngine, type RoundReport } from './engine'
import { syncHost } from './host'
import { acquirePair, releasePair } from './pair-registry'
import { SyncScheduler, type SyncTrigger } from './scheduler'
import { SyncWatcher } from './watcher'
import { LocalTarget, SyncError } from './target'

interface Runtime {
  structuralKey: string
  watcher: SyncWatcher
  scheduler: SyncScheduler
  target: LocalTarget
}

const RECONCILE_DEBOUNCE_MS = 400
const OCCUPIED_RETRY_MS = 60_000
const STOP_JOIN_MS = 30_000
/** 失败通知的重复间隔：一直失败时最多 5 分钟提醒一次，别刷屏。 */
const NOTIFY_REPEAT_MS = 300_000

/**
 * 正在显示的系统通知。Electron 的 Notification 如果只写
 * `new Notification(...).show()`，对象可能被 GC，点击回调就收不到；
 * 显式攥住，关闭后再释放。
 */
const activeNotifications = new Set<Notification>()

function emptySnapshot(): SyncSnapshot {
  return {
    run: 'disabled',
    problem: null,
    occupiedBy: null,
    busy: false,
    lastRoundAtMs: null,
    lastCostMs: null,
    copied: 0,
    deleted: 0,
    pruned: 0,
    unchanged: 0,
    failed: 0,
    plannedCopies: 0,
    plannedDeletes: 0,
    firstRun: false,
    watchedDirs: 0,
    hints: 0,
    error: null,
    copiedNames: [],
    deletedNames: [],
    changes: [],
    failedItems: [],
    keptItems: [],
    log: []
  }
}

/**
 * 一个工作区的同步生命周期。项目级（在 Electron 里就是每个 IDE 窗口一份）。
 *
 * 服务自己几乎不做判断 —— 判断都在纯函数（filters / plan / configProblem）里，
 * 这里只负责把看盘、调度、引擎、状态发布接起来，以及「什么时候不该跑」。
 */
export class SyncService {
  private config: SyncConfig
  private snapshot: SyncSnapshot = emptySnapshot()
  private runtime: Runtime | null = null
  private disposed = false

  private reconcileTimer: NodeJS.Timeout | null = null
  private occupiedTimer: NodeJS.Timeout | null = null
  private reconcileChain: Promise<void> = Promise.resolve()

  private logLines: string[] = []
  private roundStartedAt = 0

  private lastNotifiedAt = 0
  private lastFailureActive = false

  constructor(private readonly cwd: string) {
    this.config = loadConfig(cwd)
    this.snapshot = emptySnapshot()
    if (!this.config.enabled) {
      this.snapshot.run = 'disabled'
    }
  }

  get workspace(): string {
    return this.cwd
  }

  initialize(): void {
    this.scheduleReconcile(0)
  }

  getState(): SyncWorkspaceState {
    return {
      cwd: this.cwd,
      config: cloneConfig(this.config),
      snapshot: this.snapshot
    }
  }

  /** 设置页「改动即写」：先落盘，再防抖 reconcile。 */
  updateConfig(raw: SyncConfig): SyncWorkspaceState {
    this.config = saveConfig(this.cwd, raw)
    this.scheduleReconcile(RECONCILE_DEBOUNCE_MS)
    return this.getState()
  }

  /** 手动「立即同步」：跳过静默期与退避，跑一轮完整核对。 */
  syncNow(): { ok: boolean; message?: string } {
    if (!this.config.enabled) {
      return { ok: false, message: t('sync.error.notEnabled') }
    }
    if (!this.runtime) {
      return { ok: false, message: t('sync.error.notRunning') }
    }
    this.runtime.scheduler.requestNow()
    this.log('[手动] 已请求立即同步')
    return { ok: true }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer)
      this.reconcileTimer = null
    }
    if (this.occupiedTimer) {
      clearTimeout(this.occupiedTimer)
      this.occupiedTimer = null
    }
    await this.stopRuntime()
  }

  // ---------------------------------------------------------------- 调度

  private scheduleReconcile(delayMs: number): void {
    if (this.disposed) return
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer)
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null
      this.reconcileChain = this.reconcileChain
        .then(() => this.reconcile())
        .catch((e) => {
          this.log(`[错误] 配置应用失败：${reasonOf(e)}`)
          this.publish()
        })
    }, Math.max(0, delayMs))
  }

  private scheduleOccupiedRetry(): void {
    if (this.disposed || this.occupiedTimer) return
    this.occupiedTimer = setTimeout(() => {
      this.occupiedTimer = null
      this.scheduleReconcile(0)
    }, OCCUPIED_RETRY_MS)
  }

  private clearOccupiedRetry(): void {
    if (this.occupiedTimer) {
      clearTimeout(this.occupiedTimer)
      this.occupiedTimer = null
    }
  }

  // ---------------------------------------------------------------- 对账

  private async reconcile(): Promise<void> {
    if (this.disposed) return
    this.clearOccupiedRetry()

    const cfg = this.config
    if (!cfg.enabled) {
      await this.stopRuntime()
      if (this.disposed) return
      this.setSnapshot({
        run: 'disabled',
        problem: null,
        occupiedBy: null,
        busy: false,
        watchedDirs: 0,
        hints: 0,
        error: null
      })
      this.publish()
      return
    }

    const shape = configProblem(this.cwd, cfg)
    if (shape) {
      await this.stopRuntime()
      if (this.disposed) return
      this.setSnapshot({
        run: 'stopped',
        problem: shape,
        occupiedBy: null,
        busy: false,
        watchedDirs: 0,
        hints: 0,
        error: null
      })
      this.publish()
      return
    }

    const missing = await this.checkDirs(cfg)
    if (this.disposed) return
    if (missing) {
      await this.stopRuntime()
      if (this.disposed) return
      this.setSnapshot({
        run: 'stopped',
        problem: missing,
        occupiedBy: null,
        busy: false,
        watchedDirs: 0,
        hints: 0,
        error: null
      })
      this.publish()
      return
    }

    const key = structuralKey(cfg)
    if (this.runtime && this.runtime.structuralKey === key) {
      // 时长 / 镜像删除的改动当场生效（调度器与引擎每轮现读），不重建看盘。
      this.setSnapshot({
        run: this.snapshot.run === 'failed' ? 'failed' : 'running',
        problem: null,
        occupiedBy: null,
        error: null
      })
      this.publish()
      return
    }

    // 先停旧的（顺带释放占用），再按新配置从头来过。
    await this.stopRuntime()
    if (this.disposed) return

    const claim = acquirePair(this.cwd, cfg.src, cfg.dst)
    if (!claim.ok) {
      this.log(
        `[占用] 这一对目录已被另一个 IDE 窗口同步（${basename(claim.by)}）—— 本窗口不启动` +
          '（两个窗口同时同步会互相删掉对方刚写的文件）'
      )
      this.setSnapshot({
        run: 'occupied',
        problem: null,
        occupiedBy: basename(claim.by),
        busy: false,
        watchedDirs: 0,
        hints: 0,
        error: null
      })
      this.publish()
      this.scheduleOccupiedRetry()
      return
    }

    try {
      const target = new LocalTarget(cfg.dst, () => this.config)
      const engine = new SyncEngine(
        cfg.src,
        target,
        () => this.config,
        baselineFile(pathKey(cfg.src), target.stateKey),
        (line) => this.log(line)
      )
      const scheduler = new SyncScheduler(
        () => this.config,
        (trigger) => this.runRound(engine, trigger),
        (line) => this.log(line),
        (busy) => this.onBusy(busy)
      )
      const watcher = new SyncWatcher(
        cfg.src,
        () => this.config,
        (rel) => scheduler.poke(rel),
        (line) => this.log(line)
      )
      this.runtime = { structuralKey: key, watcher, scheduler, target }
      this.setSnapshot({
        run: 'running',
        problem: null,
        occupiedBy: null,
        busy: false,
        watchedDirs: 0,
        hints: 0,
        error: null
      })
      this.publish()
      watcher.start()
      scheduler.start()
    } catch (e) {
      releasePair(this.cwd)
      const message = reasonOf(e)
      this.log(`[错误] 同步启动失败：${message}`)
      this.setSnapshot({
        run: 'failed',
        problem: null,
        occupiedBy: null,
        busy: false,
        watchedDirs: 0,
        hints: 0,
        error: message
      })
      this.publish()
    }
  }

  private async checkDirs(cfg: SyncConfig): Promise<SyncProblem | null> {
    try {
      const st = await stat(cfg.src)
      if (!st.isDirectory()) return 'srcMissing'
    } catch {
      return 'srcMissing'
    }
    try {
      const st = await stat(cfg.dst)
      if (!st.isDirectory()) return 'dstMissing'
    } catch {
      return 'dstMissing'
    }
    return null
  }

  private async stopRuntime(): Promise<void> {
    const r = this.runtime
    this.runtime = null
    if (!r) {
      releasePair(this.cwd)
      return
    }
    r.watcher.stop()
    const joined = await r.scheduler.stopAndJoin(STOP_JOIN_MS)
    if (!joined) {
      this.log(`[停止] worker 没在 ${STOP_JOIN_MS / 1000} 秒内结束，先放它走`)
    }
    r.target.close()
    releasePair(this.cwd)
  }

  // ---------------------------------------------------------------- 一轮

  private async runRound(engine: SyncEngine, trigger: SyncTrigger): Promise<boolean> {
    if (trigger.reason === 'manual') this.log('[手动] 立即同步 → 开始检查')
    this.roundStartedAt = Date.now()
    try {
      const report = await engine.runRound(trigger.full)
      this.applyReport(report)
      return report.ok
    } catch (e) {
      const message = e instanceof SyncError ? e.message : reasonOf(e)
      const cost = Date.now() - this.roundStartedAt
      this.log(`[错误] ${message}`)
      this.log('[重试] 本轮未完成；监听继续，稍后自动重试')
      this.setSnapshot({
        run: 'failed',
        problem: null,
        occupiedBy: null,
        busy: false,
        lastRoundAtMs: Date.now(),
        lastCostMs: cost,
        error: message,
        failed: 0,
        failedItems: [],
        log: this.logSnapshot()
      })
      this.publish()
      this.notifyFailure(0, message)
      return false
    }
  }

  private applyReport(report: RoundReport): void {
    const failedItems = [
      ...report.failedCopies,
      ...report.failedDeletes
    ].slice(0, SYNC_FAILED_LIMIT)
    const keptItems: SyncKeptItem[] = report.kept.slice(0, SYNC_KEPT_LIMIT)
    const changes: SyncChange[] = []
    for (const rel of report.copiedRel) {
      changes.push({ rel, kind: 'copy' })
      if (changes.length >= SYNC_CHANGE_LIMIT) break
    }
    if (changes.length < SYNC_CHANGE_LIMIT) {
      for (const rel of report.deletedRel) {
        changes.push({ rel, kind: 'delete' })
        if (changes.length >= SYNC_CHANGE_LIMIT) break
      }
    }
    if (changes.length < SYNC_CHANGE_LIMIT) {
      for (const f of report.failedCopies) {
        changes.push({ rel: f.rel, kind: 'failed', reason: f.reason })
        if (changes.length >= SYNC_CHANGE_LIMIT) break
      }
      for (const f of report.failedDeletes) {
        changes.push({ rel: f.rel, kind: 'failed', reason: f.reason })
        if (changes.length >= SYNC_CHANGE_LIMIT) break
      }
    }
    if (changes.length < SYNC_CHANGE_LIMIT) {
      for (const k of report.kept) {
        changes.push({ rel: k.rel, kind: 'kept', why: k.why })
        if (changes.length >= SYNC_CHANGE_LIMIT) break
      }
    }

    const failed = report.failedCopies.length + report.failedDeletes.length
    this.setSnapshot({
      run: report.ok ? 'running' : 'failed',
      problem: null,
      occupiedBy: null,
      busy: false,
      lastRoundAtMs: Date.now(),
      lastCostMs: report.costMs,
      copied: report.copied,
      deleted: report.deleted,
      pruned: report.pruned.length,
      unchanged: report.unchanged,
      failed,
      plannedCopies: report.plannedCopies,
      plannedDeletes: report.plannedDeletes,
      firstRun: report.firstFullReconcile,
      watchedDirs: report.scannedDirs,
      hints: this.runtime?.watcher.hintCount ?? this.snapshot.hints,
      error: null,
      copiedNames: report.copiedRel.slice(0, SYNC_BUBBLE_ROWS),
      deletedNames: report.deletedRel.slice(0, SYNC_BUBBLE_ROWS),
      changes,
      failedItems,
      keptItems,
      log: this.logSnapshot()
    })
    this.publish()

    if (report.ok) {
      this.lastFailureActive = false
      this.lastNotifiedAt = 0
    } else {
      this.notifyFailure(failed, report.failedCopies[0]?.reason ?? report.failedDeletes[0]?.reason ?? '')
    }
  }

  private onBusy(busy: boolean): void {
    this.setSnapshot({ busy })
    this.publish()
  }

  // ---------------------------------------------------------------- 状态 / 日志 / 通知

  private setSnapshot(patch: Partial<SyncSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
  }

  private publish(): void {
    if (this.disposed) return
    syncHost().send(this.cwd, IPC.syncStatus, {
      cwd: this.cwd,
      snapshot: this.snapshot
    })
  }

  private log(line: string): void {
    const text = line.trim()
    if (!text) return
    this.logLines.push(text)
    while (this.logLines.length > SYNC_LOG_LIMIT) this.logLines.shift()
    this.setSnapshot({ log: this.logSnapshot() })
    if (/^\[(错误|启动|占用|监听|停止|手动)\]/u.test(text)) {
      logMain('sync', { workspace: this.cwd, line: text })
    }
  }

  /** 返回副本：渲染层不会改到服务内部的环形缓冲。 */
  private logSnapshot(): string[] {
    return [...this.logLines]
  }

  private notifyFailure(count: number, reason: string): void {
    if (this.disposed) return
    this.setSnapshot({ log: this.logSnapshot() })
    if (!Notification.isSupported()) {
      this.lastFailureActive = true
      return
    }
    const now = Date.now()
    if (this.lastFailureActive && now - this.lastNotifiedAt < NOTIFY_REPEAT_MS) {
      return
    }
    this.lastNotifiedAt = now
    this.lastFailureActive = true

    const workspace = basename(this.cwd)
    const title = t('sync.notify.title', { workspace })
    const body =
      count > 0
        ? t('sync.notify.body', { n: count, reason: truncate(reason, 140) })
        : t('sync.notify.bodyError', { reason: truncate(reason, 140) })
    try {
      const notification = new Notification({ title, body })
      activeNotifications.add(notification)
      const release = (): void => {
        activeNotifications.delete(notification)
      }
      notification.on('close', release)
      notification.on('click', () => {
        release()
        syncHost().focus(this.cwd, true)
      })
      notification.show()
      logMain('sync.notify', { workspace: this.cwd, count, reason })
    } catch (e) {
      logMain('sync.notify.failed', e)
    }
  }
}

function structuralKey(cfg: SyncConfig): string {
  return [
    pathKey(cfg.src),
    pathKey(cfg.dst),
    cfg.syncRoots.join(','),
    cfg.exclude.join(',')
  ].join('|')
}

function cloneConfig(cfg: SyncConfig): SyncConfig {
  return {
    ...cfg,
    syncRoots: [...cfg.syncRoots],
    exclude: [...cfg.exclude]
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
