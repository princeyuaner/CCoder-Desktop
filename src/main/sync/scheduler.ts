import type { SyncConfig } from '../../shared/sync'

export type SyncReason = 'baseline' | 'retry' | 'event' | 'sweep' | 'manual'

export interface SyncTrigger {
  reason: SyncReason
  /** 是否遍历目标端（完整轮）。事件轮只对账本地侧 + 按需 stat。 */
  full: boolean
}

/**
 * 把一串文件事件合并成一轮一轮串行的同步。
 *
 * 两条设计不许动：
 *  1. 事件只当提示，不当任务 —— 收到事件时不记录「要同步哪些文件」，
 *     只记「该去看一眼了」。事件丢了 / 合并了都无害。
 *  2. 只有一个消费者 —— 只有这条 worker 会调 runRound，复制串行，于是
 *     同一时刻只有一个写者。
 *
 * 失败后退避 5→10→20→30→60 秒；失败项不写基线，下一轮自动重新发现。
 */
export class SyncScheduler {
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private busy = false
  private current: Promise<void> | null = null

  private lastEventAtMs = 0
  private firstEventAtMs: number | null = null
  private lastFullAtMs = 0
  private retryAtMs: number | null = null
  private streak = 0
  private baselinePending = true
  private settleActive = false
  private hintShown = false
  private pendingCount = 0
  private lastPoked: string | null = null
  private manualFull = false

  constructor(
    private readonly config: () => SyncConfig,
    private readonly runRound: (trigger: SyncTrigger) => Promise<boolean>,
    private readonly log: (line: string) => void = () => undefined,
    private readonly onBusy: (busy: boolean) => void = () => undefined,
    private readonly now: () => number = Date.now
  ) {}

  start(): void {
    if (this.stopped || this.timer || this.current) return
    this.log('[启动] 先跑一轮基线同步，把当前差异推过去')
    this.schedule(0)
  }

  /** 有文件被触碰。只记「该去看一眼了」，不记录待同步清单。 */
  poke(rel?: string | null): void {
    if (this.stopped) return
    this.pendingCount++
    this.lastEventAtMs = this.now()
    if (this.firstEventAtMs == null) this.firstEventAtMs = this.lastEventAtMs
    if (rel) this.lastPoked = rel
    // 有事件时提前叫醒等待中的循环；正在跑一轮的话结束后会重新算。
    if (!this.busy) this.schedule(10)
  }

  /** 手动「立即同步」：跳过静默期与退避，跑一轮完整核对。 */
  requestNow(): void {
    if (this.stopped) return
    this.manualFull = true
    if (!this.busy) this.schedule(0)
  }

  get isBusy(): boolean {
    return this.busy
  }

  /**
   * 停，并等在飞的那一轮跑完。复制到一半被掐掉会在目标端留个半截文件；
   * 它不在基线里，下一轮会覆盖回来 —— 但能等就等。
   */
  async stopAndJoin(timeoutMs: number): Promise<boolean> {
    this.stopped = true
    this.clearTimer()
    const current = this.current
    if (!current) return true
    let timer: NodeJS.Timeout | null = null
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    })
    const ok = await Promise.race([current.then(() => true as const), timeout])
    if (timer) clearTimeout(timer)
    return ok
  }

  // ---------------------------------------------------------------- 主循环

  private schedule(delayMs: number): void {
    if (this.stopped) return
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, Math.max(0, delayMs))
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.busy) return
    const step = this.step(this.now())
    if (!step.trigger) {
      // waitMs = null 表示无限等：等下一次 poke / requestNow 叫醒。
      if (step.waitMs != null) this.schedule(step.waitMs)
      return
    }
    await this.execute(step.trigger)
  }

  private async execute(trigger: SyncTrigger): Promise<void> {
    this.busy = true
    this.onBusy(true)
    let ok = false
    const run = (async (): Promise<void> => {
      try {
        ok = await this.runRound(trigger)
      } catch (e) {
        this.log(`[错误] 本轮同步异常：${reasonOf(e)}`)
        ok = false
      }
    })()
    this.current = run
    try {
      await run
    } finally {
      this.current = null
      this.busy = false
      this.onBusy(false)
      this.afterRound(trigger, ok)
      const delay = this.nextDelayAfterRound()
      if (delay != null) this.schedule(delay)
    }
  }

  /**
   * 决定下一步。顺序不可调换：
   *  1. 启动基线轮（完整轮）
   *  2. 手动触发（用户点了「立即同步」）
   *  3. 退避期先于事件判断 —— 否则退避形同虚设
   *  4. 有未处理事件 → 进静默期，等到安静为止（有硬上限）
   *  5. 静默期结束 → 跑一轮；巡检到期就顺手走完整轮
   *  6. 没事件 → 等巡检到期；兜底关了就一直等事件
   */
  private step(now: number): { trigger: SyncTrigger | null; waitMs: number | null } {
    const cfg = this.config()

    if (this.baselinePending) {
      this.baselinePending = false
      return { trigger: { reason: 'baseline', full: true }, waitMs: null }
    }

    if (this.manualFull) {
      this.manualFull = false
      return { trigger: { reason: 'manual', full: true }, waitMs: null }
    }

    if (this.retryAtMs != null) {
      if (now < this.retryAtMs) {
        return { trigger: null, waitMs: this.retryAtMs - now }
      }
      this.retryAtMs = null
      return { trigger: { reason: 'retry', full: false }, waitMs: null }
    }

    if (this.firstEventAtMs != null && !this.settleActive) {
      this.settleActive = true
      if (!this.hintShown) {
        this.hintShown = true
        this.log(
          '[提示] 文件被触碰 ≠ 内容改动：读文件、IDE 索引、构建产物都会产生事件。' +
            '是否真要同步由内容对账决定 —— 清单为空就代表本轮无事可做。'
        )
      }
      const sample = this.lastPoked ? `（最近：${this.lastPoked}）` : ''
      this.log(`[事件] ${this.pendingCount} 个路径被触碰${sample} → 开始检查`)
      this.pendingCount = 0
    }

    if (this.settleActive) {
      const idle = now - this.lastEventAtMs
      const span = now - (this.firstEventAtMs ?? this.lastEventAtMs)
      if (idle < cfg.settleMs && span < 20_000) {
        // 两个上限都要取：事件洪流（一次批量回滚之类）不能把一轮无限延后
        const wait = Math.min(cfg.settleMs - idle, 20_000 - span)
        return { trigger: null, waitMs: Math.max(1, wait) }
      }
      this.settleActive = false
      this.firstEventAtMs = null
      this.lastEventAtMs = 0
      // 静默期里巡检到期了 → 这一轮顺手走完整轮，不另开一轮
      const overdue = this.sweepOverdue(now, cfg)
      return {
        trigger: { reason: overdue ? 'sweep' : 'event', full: overdue },
        waitMs: null
      }
    }

    const dueIn = this.sweepDueInMs(now, cfg)
    if (dueIn == null) return { trigger: null, waitMs: null }
    if (dueIn <= 0) {
      this.log('[巡检] 定时兜底扫描（防事件遗漏）→ 开始检查')
      return { trigger: { reason: 'sweep', full: true }, waitMs: null }
    }
    return { trigger: null, waitMs: dueIn }
  }

  private afterRound(trigger: SyncTrigger, ok: boolean): void {
    if (trigger.full) this.lastFullAtMs = this.now()
    if (ok) {
      this.streak = 0
      return
    }
    const backoff = BACKOFF_MS[Math.min(this.streak, BACKOFF_MS.length - 1)]
    this.streak++
    // 退避期内不等事件：等事件的话，网络恢复了也要等下一个文件被碰才行。
    this.retryAtMs = this.now() + backoff
    this.log(`[退避] ${Math.round(backoff / 1000)} 秒后重试`)
  }

  /**
   * 一轮结束后立刻看下一步：有事件 / 手动请求就马上处理，否则按巡检等。
   * null = 兜底关闭且没有待处理事件 —— 不挂计时器，等 poke 叫醒。
   */
  private nextDelayAfterRound(): number | null {
    if (this.stopped) return null
    if (this.manualFull || this.firstEventAtMs != null) return 10
    if (this.retryAtMs != null) return Math.max(1, this.retryAtMs - this.now())
    const due = this.sweepDueInMs(this.now(), this.config())
    return due == null ? null : Math.max(1, due)
  }

  /**
   * 距下次必须做的完整轮还有多少毫秒；null = 兜底已关闭。
   *
   * 注意这是「距上次完整轮」的硬期限，不是「已经安静多久」：按后者写，
   * 每次事件都会把计时重置，事件一频繁巡检就被无限期饿死。
   */
  private sweepDueInMs(now: number, cfg: SyncConfig): number | null {
    if (cfg.sweepMs <= 0) return null
    return this.lastFullAtMs + cfg.sweepMs - now
  }

  private sweepOverdue(now: number, cfg: SyncConfig): boolean {
    const due = this.sweepDueInMs(now, cfg)
    return due != null && due <= 0
  }
}

/** 失败后的退避序列（毫秒）。到顶不再加。 */
const BACKOFF_MS = [5_000, 10_000, 20_000, 30_000, 60_000]

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
