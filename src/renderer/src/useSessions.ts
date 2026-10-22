import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { baseName } from '@shared/path'
import type { StoredSession } from '@shared/session'

export interface WorkspaceView {
  cwd: string
  name: string
  sessions: StoredSession[]
}

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
 * 第一次发送之后 CLI 立刻就会写盘，一轮跑完我们就把列表拉一次。
 */
export function useSessions(): {
  workspaces: WorkspaceView[]
  loading: boolean
  /** 正在跑的会话 —— 键是 **CLI 自己的 session id**，就是会话行的 id */
  running: Set<string>
  refresh: () => Promise<void>
} {
  const [sessions, setSessions] = useState<StoredSession[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState<Set<string>>(() => new Set())
  const lastAt = useRef(0)
  const inFlight = useRef<Promise<void> | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (!window.api?.sessions) {
      setLoading(false)
      return
    }
    // 已经在拉了就复用它 —— 否则连续切换会话会叠出好几个并发扫描
    if (inFlight.current) return inFlight.current
    const p = (async () => {
      try {
        setSessions(await window.api!.sessions.list())
      } catch {
        // 读不到就当没有，不该让界面挂掉
      }
      setLoading(false)
      lastAt.current = Date.now()
    })().finally(() => {
      inFlight.current = null
    })
    inFlight.current = p
    return p
  }, [])

  const refreshSoon = useCallback((): void => {
    if (Date.now() - lastAt.current < THROTTLE_MS) return
    void refresh()
  }, [refresh])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /**
   * 一轮跑完就刷一次 —— 这是"新会话该出现在侧栏了"的时刻。
   *
   * CLI 其实在收到第一条消息时就落盘了，但要等这一轮结束，文件里才既有
   * 用户那句话（当标题用）、又写完了一整轮。提前刷只会得到一条「(无标题)」。
   */
  useEffect(() => {
    const off = window.api?.session.onEvent((p) => {
      if (p.event.t === 'turn_end') refreshSoon()
    })
    return off
  }, [refreshSoon])

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

  const workspaces = useMemo(() => {
    const byCwd = new Map<string, StoredSession[]>()
    for (const s of sessions) {
      const list = byCwd.get(s.cwd)
      if (list) list.push(s)
      else byCwd.set(s.cwd, [s])
    }
    const out: WorkspaceView[] = []
    for (const [cwd, list] of byCwd) {
      out.push({ cwd, name: baseName(cwd), sessions: list })
    }
    // 组内已是时间倒序，组间按最新一条排
    out.sort((a, b) => (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0))
    return out
  }, [sessions])

  return { workspaces, loading, running, refresh }
}
