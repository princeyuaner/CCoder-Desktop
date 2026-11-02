/**
 * 流式增量的合并器。
 *
 * CLI 的 text_delta / thinking_delta 是按 token 级别的；如果每条都单独走
 * IPC + React 更新，一次长回复会产生上百次整段 Markdown 重新解析。这里按
 * 16ms（约 60fps）合并同一会话相邻的同类增量，再一次性发给渲染层。
 *
 * 顺序保证：
 * - 任何非增量事件到达时，先把同一会话挂起的增量 flush 掉再发；
 * - 状态事件（idle / exited）由调用方先 flush，保证最后一个字先于「空闲」；
 * - 不同会话互不影响。
 */
import type { AgentEvent } from '../shared/events'
import type { SessionEventPayload } from '../shared/session'

type Delta =
  | Extract<AgentEvent, { t: 'text_delta' }>
  | Extract<AgentEvent, { t: 'thinking_delta' }>

/** 16ms ≈ 60fps；再长会看出文字一段一段跳 */
const DEFAULT_FLUSH_MS = 16

export class SessionEventBatcher {
  private pending = new Map<string, Delta[]>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private emit: (p: SessionEventPayload) => void,
    private flushMs = DEFAULT_FLUSH_MS
  ) {}

  push(p: SessionEventPayload): void {
    const e = p.event
    if (e.t !== 'text_delta' && e.t !== 'thinking_delta') {
      this.flush(p.sessionId)
      this.emit(p)
      return
    }

    let list = this.pending.get(p.sessionId)
    if (!list) {
      list = []
      this.pending.set(p.sessionId, list)
    }

    // 相邻同类型直接拼字符串；中间换了类型就另起一条，保持原顺序
    const last = list[list.length - 1]
    if (last && last.t === e.t) last.text += e.text
    else list.push({ t: e.t, text: e.text })

    this.schedule()
  }

  /** 立刻发出某个会话（不传则全部）的挂起增量 */
  flush(sessionId?: string): void {
    if (sessionId !== undefined) {
      const list = this.pending.get(sessionId)
      if (list) {
        this.pending.delete(sessionId)
        for (const d of list) this.emit({ sessionId, event: d })
      }
    } else {
      for (const id of [...this.pending.keys()]) this.flush(id)
    }

    if (this.pending.size === 0 && this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private schedule(): void {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.flushMs)
    // 别让一个待发增量阻止进程退出
    this.timer.unref?.()
  }
}
