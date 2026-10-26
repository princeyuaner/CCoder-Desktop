/**
 * 「这条会话还有后台任务在跑吗」。
 *
 * 侧栏只认 **CLI 自己的 session id**（就是会话行的 id），所以这里按
 * `providerSessionId` 存。ChatController 同时知道 live id 和 CLI id，
 * 每次后台任务状态变化后就地同步 —— 和 pending-approvals 是同一套做法。
 *
 * 为什么不在主进程另开一条查询通道：后台任务事件本来就经过 controller，
 * 状态由渲染层的 run-state 归约；这里只保存「哪些任务还在跑」。
 *
 * 存任务 id 而不是布尔值：同一会话可能同时挂着几个后台任务，只有全部
 * 结束才算收工。
 */
const running = new Map<string, Set<string>>()
const listeners = new Set<(ids: ReadonlySet<string>) => void>()

function snapshot(): ReadonlySet<string> {
  return new Set(running.keys())
}

function emit(): void {
  if (listeners.size === 0) return
  const ids = snapshot()
  for (const cb of listeners) cb(ids)
}

function sameSet(a: Set<string> | undefined, b: Set<string>): boolean {
  if (!a || a.size !== b.size) return false
  for (const x of b) if (!a.has(x)) return false
  return true
}

/** taskIds 为空 = 这条会话已经没有在跑的后台任务 */
export function setBackgroundRunning(
  id: string | null,
  taskIds: readonly string[]
): void {
  if (!id) return
  const next = new Set(taskIds)
  const prev = running.get(id)

  if (next.size === 0) {
    if (!prev) return
    running.delete(id)
  } else {
    if (sameSet(prev, next)) return
    running.set(id, next)
  }
  emit()
}

/** 进程没了 / 控制器销毁：后台任务不可能还在跑 */
export function clearBackgroundRunning(id: string | null): void {
  setBackgroundRunning(id, [])
}

/** 订阅时会先回放一次当前快照，界面重挂载不会丢 */
export function subscribeBackgroundRunning(
  cb: (ids: ReadonlySet<string>) => void
): () => void {
  listeners.add(cb)
  cb(snapshot())
  return () => {
    listeners.delete(cb)
  }
}
