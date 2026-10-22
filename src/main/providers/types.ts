import type { AgentEvent } from '../../shared/events'
import type { Channel, EffortLevel } from '../../shared/settings'
import type { PermissionDecision, QuestionAnswer, SessionSendInput } from '../../shared/session'

/**
 * provider 抽象。现在只有 claude 一家，但**接口先立起来** ——
 * 加 codex 时 UI 与 session-manager 一行不改，只多一个实现。
 *
 * 形态是"一个长驻会话"而不是"每轮一个进程"：因为要在工具执行**之前**
 * 拦下来问用户，就必须有一个活着的东西在对话中间接得住请求。
 */
export interface Provider {
  id: string
  /** 是否装了对应的 CLI */
  detect(): Promise<{ installed: boolean; path: string }>
  start(o: ProviderSessionOptions): ProviderSession
}

export interface ProviderSession {
  /** 发一轮用户消息（文本 + 可选图片） */
  send(input: SessionSendInput): void
  /** 答复一条审批请求 */
  respondPermission(requestId: string, decision: PermissionDecision): void
  /** 答复一次 AskUserQuestion（答案随 updatedInput 回传） */
  respondQuestion(requestId: string, answer: QuestionAnswer): void
  /** 打断当前这一轮 */
  interrupt(): void
  /** 收摊：关掉子进程 */
  dispose(): void
}

export interface ProviderSessionOptions {
  channel: Channel
  cwd: string
  model: string
  permissionMode: string
  /** 思考深度。'medium' 是 CLI 默认档，等价于不传 */
  effort: EffortLevel
  addDirs: string[]
  /** 接着哪条已有会话跑；null 表示全新 */
  resumeId: string | null
  onEvent: (e: AgentEvent) => void
  onExit: (code: number | null, stderr: string) => void
}
