import type { AgentEvent, PermissionOption, Question } from '../../../shared/events'
import { buildPreview } from '../permission-preview'
import { msg, t } from '../../i18n'

/**
 * 控制协议的解析。抽成纯函数是为了**测得动** ——
 * 挂在会话类里就只能靠真跑一次 CLI 才能覆盖，而真实请求会重试 10 次、
 * 单次要 4 秒，测试成本高到没人愿意跑。
 */

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export type ControlOutcome =
  /** 认识这条请求，转成一条要上抛的事件 */
  | { action: 'event'; event: AgentEvent }
  /** 不认识，得回一条 error 回执，否则 CLI 会一直等 */
  | { action: 'unsupported'; requestId: string; subtype: string }

function permissionOptions(tool: string): PermissionOption[] {
  return [
    { value: 'allow', label: msg('permission.allowOption') },
    { value: 'allow-always', label: msg('permission.allowAlwaysOption', { tool }) },
    { value: 'deny', label: msg('permission.denyOption'), danger: true }
  ]
}

/**
 * CLI 的 AskUserQuestion 输入 → 界面能直接渲染的形状。
 *
 * 这里**必须**做防御性归一化：input 来自子进程，字段缺失/类型不对时
 * 不能让整个会话崩掉。一道题至少要有一个问题和两个选项才有得选，
 * 不满足就丢掉 —— 全丢完之后上层会退回普通审批，至少还能放行/拒绝。
 */
export function normalizeQuestions(input: unknown): Question[] {
  const o = obj(input)
  const raw = Array.isArray(o.questions) ? o.questions : []
  const out: Question[] = []

  for (const item of raw.slice(0, 4)) {
    const q = obj(item)
    const question = str(q.question).trim()
    if (!question) continue

    const options = (Array.isArray(q.options) ? q.options : [])
      .map((v) => obj(v))
      .map((v) => {
        const preview = str(v.preview)
        return {
          label: str(v.label).trim(),
          description: str(v.description).trim(),
          ...(preview ? { preview } : {})
        }
      })
      .filter((v) => v.label)
      .slice(0, 4)
    if (options.length < 2) continue

    out.push({
      question,
      header: str(q.header).trim() || t('preview.questionFallback'),
      options,
      multiSelect: q.multiSelect === true
    })
  }

  return out
}

/**
 * 把 CLI 发来的 control_request 翻译成事件。
 * 不是 control_request 就返回 null，调用方按普通事件处理。
 */
export function parseControlRequest(
  raw: Record<string, unknown>,
  cwd: string
): ControlOutcome | null {
  if (raw.type !== 'control_request') return null

  const requestId = str(raw.request_id)
  const req = obj(raw.request)
  const subtype = str(req.subtype)

  if (subtype === 'can_use_tool') {
    const tool = str(req.tool_name)
    const input = req.input

    // 提问不是审批：allow/deny 只能放行工具，答不了题。
    // 单独上抛，答案会作为 updatedInput.answers 回去。
    if (tool === 'AskUserQuestion') {
      const questions = normalizeQuestions(input)
      if (questions.length > 0) {
        return {
          action: 'event',
          event: {
            t: 'question_request',
            id: requestId,
            tool: 'AskUserQuestion',
            input,
            questions
          }
        }
      }
    }

    return {
      action: 'event',
      event: {
        t: 'permission_request',
        id: requestId,
        tool,
        input,
        preview: buildPreview(tool, input, cwd),
        options: permissionOptions(tool)
      }
    }
  }

  return { action: 'unsupported', requestId, subtype }
}
