import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { baseName } from '@shared/path'
import type { StoredSession } from '@shared/session'

export interface WorkspaceView {
  cwd: string
  name: string
  sessions: StoredSession[]
}

/**
 * 侧栏会话行的排序方式。
 *
 * - `created`：按会话创建时间，**运行中不会换位**（默认）
 * - `recent`：按最近活动（mtime），刚跑完一轮的会话会跳到顶部
 */
export type SessionSort = 'created' | 'recent'

const byCreated = (a: StoredSession, b: StoredSession): number =>
  b.createdAt - a.createdAt || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)

const byRecent = (a: StoredSession, b: StoredSession): number =>
  b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id)

/** 相对时间：刚刚 / N分钟 / N小时 / N天 / 日期 */
export function relTime(ms: number): string {
  const diff = Date.now() - ms
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min}分钟`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}天`
  const d = new Date(ms)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** 两次自动刷新之间至少隔这么久 —— 连着跑几轮时别把列表反复拉一遍 */
const THROTTLE_MS = 800

/**
 * 已有会话列表。数据来自 CLI 自己写的 ~/.claude/projects —— 我们只读。
 * 工作区就是 cwd：一个项目目录一组，和 CLI 的存储模型天然对齐。
 *
 * 注意这里**不会**凭空造出一条会话来：新建的会话在发第一条消息之前，
 * 磁盘上根本还没有那份 jsonl（CLI 是懒启动的），没得可读。
 * 第一次发送之后 CLI 会异步写盘：拿到 CLI 的 session id 就开始盯着索引，
 * 出现即停，机灵点的话用户还没等到这一轮结束就能在侧栏看到它。
 */
export function useSessions(): {
  workspaces: WorkspaceView[]
  loading: boolean
  /** 正在跑的会话 —— 键是 **CLI 自己的 session id**，就是会话行的 id */
  running: Set<string>
  /** 当前排序方式 */
  sort: SessionSort
  toggleSort: () => void
  refresh: () => Promise<StoredSession[]>
} {
  const [sessions, setSessions] = useState<StoredSession[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState<Set<string>>(() => new Set())
  // 默认按创建时间：运行中的会话写盘不会改变行序
  const [sort, setSort] = useState<SessionSort>('created')
  const lastAt = useRef(0)
  const inFlight = useRef<Promise<StoredSession[]> | null>(null)
  /** 防抖待执行的刷新（turn_end / focus 共用，保证最后一次事件一定会刷） */
  const soonTimer = useRef<number | null>(null)
  /** 正在等索引出现的 CLI session id → 重试计时器 */
  const watching = useRef(new Set<string>())
  const watchTimers = useRef<number[]>([])

  const refresh = useCallback(async (): Promise<StoredSession[]> => {
    if (!window.api?.sessions) {
      setLoading(false)
      return []
    }
    // 已经在拉了就复用它 —— 否则连续切换会话会叠出好几个并发扫描
    if (inFlight.current) return inFlight.current
    const p = (async () => {
      let next: StoredSession[] = []
      try {
        next = await window.api!.sessions.list()
        setSessions(next)
      } catch {
        // 读不到就当没有，不该让界面挂掉
      }
      setLoading(false)
      lastAt.current = Date.now()
      return next
    })().finally(() => {
      inFlight.current = null
    })
    inFlight.current = p
    return p
  }, [])

  /**
   * 事件触发的刷新：**防抖**而不是节流。
   *
   * 以前是「距上次刷新不足 800ms 就直接 return」—— 一次 turn_end 恰好落在
   * 这个窗口里就被永久丢掉了，新会话于是要等用户点一下侧栏（那里会强制
   * refresh）才出现。现在把这次刷新排到窗口末尾执行，事件再多也至少刷一次。
   */
  const refreshSoon = useCallback((): void => {
    if (soonTimer.current !== null) return
    const wait = Math.max(0, THROTTLE_MS - (Date.now() - lastAt.current))
    soonTimer.current = window.setTimeout(() => {
      soonTimer.current = null
      void refresh()
    }, wait)
  }, [refresh])

  /**
   * 新会话的 CLI id 拿到之后，盯到它真的出现在磁盘索引里为止。
   *
   * CLI 的 jsonl 是异步写的：session_started 到来时文件可能还没创建，
   * turn_end 时也可能刚好差半拍。按 350ms → 900ms → 2s → 4s 重试几次，
   * 命中就停 —— 新会话通常几百毫秒内就会出现在侧栏，不用等用户手动刷新。
   */
  const watchUntilListed = useCallback(
    (id: string, attempt = 0): void => {
      if (!id) return
      if (attempt === 0) {
        if (watching.current.has(id)) return
        watching.current.add(id)
      }
      const delays = [350, 900, 2000, 4000]
      void refresh().then((list) => {
        if (!watching.current.has(id)) return
        if (list.some((s) => s.id === id)) {
          watching.current.delete(id)
          return
        }
        if (attempt >= delays.length) {
          watching.current.delete(id)
          return
        }
        watchTimers.current.push(
          window.setTimeout(() => watchUntilListed(id, attempt + 1), delays[attempt])
        )
      })
    },
    [refresh]
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** 卸载时别让排队的刷新/重试打到已经卸载的组件上 */
  useEffect(() => {
    return () => {
      if (soonTimer.current !== null) window.clearTimeout(soonTimer.current)
      for (const t of watchTimers.current) window.clearTimeout(t)
      watchTimers.current = []
      watching.current.clear()
    }
  }, [])

  /**
   * 会话事件驱动的刷新。
   *
   * - session_started：CLI 自己的 id 已经有了，盯到它出现在索引里为止；
   * - turn_end：新会话此刻应该已经完整落盘，按常规再刷一次。
   */
  useEffect(() => {
    const off = window.api?.session.onEvent((p) => {
      if (p.event.t === 'session_started' && p.event.sessionId) {
        watchUntilListed(p.event.sessionId)
      } else if (p.event.t === 'turn_end') {
        refreshSoon()
      }
    })
    return off
  }, [refreshSoon, watchUntilListed])

  /** 切回窗口时也刷一次 —— 用户可能刚在终端里跑过 claude */
  useEffect(() => {
    window.addEventListener('focus', refreshSoon)
    return () => window.removeEventListener('focus', refreshSoon)
  }, [refreshSoon])

  /**
   * 「哪条会话在跑」。
   *
   * 侧栏要拿它给那一行显示运行中的图标动效，而侧栏只认 CLI 的 session id，
   * 所以认的是 `providerSessionId`（`sessionStatus` 里带的就是它）。
   *
   * 订阅之外还要**主动问一次**：界面重载（dev 热更新）之后，之前那些
   * 「已经在跑」的会话不会再发一遍状态，只靠事件会漏掉它们。
   */
  useEffect(() => {
    const api = window.api
    if (!api?.session) return
    let alive = true

    void api.session
      .running()
      .then((ids) => {
        if (alive) setRunning(new Set(ids))
      })
      .catch(() => undefined)

    const off = api.session.onStatus((p) => {
      const id = p.providerSessionId
      if (!id) return
      const isRunning = p.status === 'starting' || p.status === 'running'
      setRunning((prev) => {
        // 状态没变就别换引用 —— 这条事件每轮都会来几次，白重建 Set 会让整个侧栏重渲染
        if (isRunning === prev.has(id)) return prev
        const next = new Set(prev)
        if (isRunning) next.add(id)
        else next.delete(id)
        return next
      })
    })

    return () => {
      alive = false
      off()
    }
  }, [])

  const toggleSort = useCallback((): void => {
    setSort((s) => (s === 'created' ? 'recent' : 'created'))
  }, [])

  const workspaces = useMemo(() => {
    const byCwd = new Map<string, StoredSession[]>()
    for (const s of sessions) {
      const list = byCwd.get(s.cwd)
      if (list) list.push(s)
      else byCwd.set(s.cwd, [s])
    }
    const cmp = sort === 'created' ? byCreated : byRecent
    const out: WorkspaceView[] = []
    for (const [cwd, list] of byCwd) {
      // 组内显式排序 —— main 给的是创建时间序，切到「最近活动」时这里要重排
      list.sort(cmp)
      out.push({ cwd, name: baseName(cwd), sessions: list })
    }
    /*
     * 组间固定按「最近活动」排，不跟行序走。
     * 侧栏的工作区顺序由 settings.openedCwds 决定，这里的顺序只用于
     * 「所有工作区都关了，新会话该落到哪」的兜底 —— 那种场景下"最近动过"
     * 比"最新创建"更符合直觉。
     */
    const latest = (list: StoredSession[]): number =>
      list.reduce((m, s) => Math.max(m, s.updatedAt), 0)
    out.sort((a, b) => latest(b.sessions) - latest(a.sessions) || a.cwd.localeCompare(b.cwd))
    return out
  }, [sessions, sort])

  return { workspaces, loading, running, sort, toggleSort, refresh }
}
