import type { AgentEvent } from '@shared/events'
import type { LocalizedText } from '@shared/i18n'

/**
 * 后台会话的待审批请求。
 *
 * 侧栏只认 **CLI 自己的 session id**（就是会话行的 id），所以这里按
 * `providerSessionId` 存。请求由各自的 ChatController 收：它对一条会话
 * 同时知道 live id 和 CLI id，答复时也能就地清掉 —— 不必再往主进程加
 * 一条查询通道。
 *
 * 这里只存**原始数据**（命令原文、preview 标题），展示文案由 Sidebar
 * 在渲染时按当前语言拼 —— 否则切换语言后跑马灯会停在旧语言。
 */
export type PendingApproval =
  | { kind: 'question'; text: string }
  | {
      kind: 'permission'
      danger: boolean
      /** 命令类请求的原文（第一行、已压缩空白） */
      command?: string
      /** 编辑 / 新建 / 工具调用类的标题，主进程可能给 LocalizedText */
      title?: LocalizedText
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

function sameApproval(a: PendingApproval, b: PendingApproval): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'question') return b.kind === 'question' && a.text === b.text
  if (b.kind !== 'permission') return false
  return (
    a.danger === b.danger &&
    a.command === b.command &&
    JSON.stringify(a.title) === JSON.stringify(b.title)
  )
}

/** 同步一条会话的待审批状态；null = 已经答复或不再等待 */
export function setPendingApproval(id: string | null, next: PendingApproval | null): void {
  if (!id) return
  if (next) {
    const prev = pending.get(id)
    if (prev && sameApproval(prev, next)) return
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
 * 把一条阻塞请求压成结构化数据。
 *
 * 命令保留原文（模型给的），标题保留 LocalizedText —— 展示时再翻译。
 */
export function approvalFromEvent(e: PendingEvent): PendingApproval {
  if (e.t === 'question_request') {
    const q = e.questions[0]
    return { kind: 'question', text: clip(q ? q.header || q.question : '', 40) }
  }

  const p = e.preview
  if (p.kind === 'command') {
    const cmd = (p.command ?? '').split('\n')[0].replace(/\s+/g, ' ').trim()
    return { kind: 'permission', danger: p.danger === true, command: cmd || undefined }
  }
  return { kind: 'permission', danger: false, title: p.title }
}
