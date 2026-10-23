import type { AgentEvent } from '@shared/events'

/**
 * 后台会话的待审批请求。
 *
 * 侧栏只认 **CLI 自己的 session id**（就是会话行的 id），所以这里按
 * `providerSessionId` 存。请求由各自的 ChatController 收：它对一条会话
 * 同时知道 live id 和 CLI id，答复时也能就地清掉 —— 不必再往主进程加
 * 一条查询通道。
 */
export interface PendingApproval {
  kind: 'permission' | 'question'
  /** 跑马灯里「待审批 ·」后面那句话 */
  text: string
}

type PendingEvent = Extract<
  AgentEvent,
  { t: 'permission_request' | 'question_request' }
>

const pending = new Map<string, PendingApproval>()
const listeners = new Set<(all: ReadonlyMap<string, PendingApproval>) => void>()

/** 每次变更发一份新快照：订阅方直接 setState，不用自己复制一遍 */
function emit(): void {
  if (listeners.size === 0) return
  const snap = new Map(pending)
  for (const cb of listeners) cb(snap)
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** 同步一条会话的待审批状态；null = 已经答复或不再等待 */
export function setPendingApproval(id: string | null, next: PendingApproval | null): void {
  if (!id) return
  if (next) {
    const prev = pending.get(id)
    if (prev && prev.kind === next.kind && prev.text === next.text) return
    pending.set(id, next)
  } else if (!pending.delete(id)) {
    return
  }
  emit()
}

export function clearPendingApproval(id: string | null): void {
  setPendingApproval(id, null)
}

export function subscribePendingApprovals(
  cb: (all: ReadonlyMap<string, PendingApproval>) => void
): () => void {
  listeners.add(cb)
  cb(new Map(pending))
  return () => {
    listeners.delete(cb)
  }
}

/**
 * 把一条阻塞请求压成一行能滚的话。
 *
 * 标题本身早就被截断了，跑马灯的内容要回答「它在等什么」：
 * 命令给命令原文，改文件给「编辑 xxx」，提问给那题的短标签。
 */
export function approvalFromEvent(e: PendingEvent): PendingApproval {
  if (e.t === 'question_request') {
    const q = e.questions[0]
    return { kind: 'question', text: clip(q ? q.header || q.question : '回答问题', 40) }
  }

  const p = e.preview
  if (p.kind === 'command') {
    const cmd = (p.command ?? '').split('\n')[0].replace(/\s+/g, ' ').trim()
    const what = cmd ? `允许运行 ${clip(cmd, 48)}` : '允许运行命令'
    return { kind: 'permission', text: p.danger ? `危险操作 · ${what}` : what }
  }
  // 编辑 / 新建 / 使用 Tool —— preview.title 本来就是动词开头的短语
  return { kind: 'permission', text: clip(`允许${p.title}`, 56) }
}
