import type { AgentEvent } from '../../shared/events'
import type { Channel, EffortLevel } from '../../shared/settings'
import type { PermissionDecision, QuestionAnswer, SessionSendInput } from '../../shared/session'

/**
 * provider 抽象。claude 与 codex 各一个实现，UI 与 session-manager
 * 只认这一组接口 —— 加新 CLI 时只多一个 adapter。
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
  /**
   * 会话用的渠道；null = 走 CLI 自己的官方登录。
   *
   * Claude 的 official 模式就是 null —— 不注入任何 base URL / key。
   */
  channel: Channel | null
  cwd: string
  model: string
  permissionMode: string
  /** 思考深度。'medium' 是 CLI 默认档，等价于不传 */
  effort: EffortLevel
  addDirs: string[]
  /**
   * DeepSeek Harness 的 home。只有 dsh 适配器会读，其他 provider 忽略。
   *
   * dsh 不接受隐式的 `~/.dsh`，必须显式给一个目录；不传时 adapter 会用
   * 应用自己的 `userData/../dsh-home`（见 dsh/runner.ts 的 ensureDshHome）。
   */
  dshHome?: string
  /** 接着哪条已有会话跑；null 表示全新 */
  resumeId: string | null
  onEvent: (e: AgentEvent) => void
  onExit: (code: number | null, stderr: string) => void
}
