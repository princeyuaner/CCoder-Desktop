import type { AgentEvent } from '../../../shared/events'

/**
 * CLI 的 task_* system 事件 → 归一化 AgentEvent。
 *
 * 后台子代理不是「Agent 工具返回 = 完成」：
 *  - Agent 工具先回一条 `async_launched` 回执；
 *  - 之后 CLI 通过 task_started / task_progress / task_updated /
 *    task_notification 推送真正的进度和完成状态。
 *
 * 这里只做形状归一化，不认识任何业务字段；判断「这算不算子代理」放在
 * 下面几个 guard 里 —— 后台 shell / workflow 也会发 task_started，
 * 不能把它们塞进执行台的子代理区。
 */

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

function patchStatus(v: string): 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'paused' | undefined {
  switch (v) {
    case 'pending':
    case 'running':
    case 'completed':
    case 'failed':
    case 'killed':
    case 'paused':
      return v
    default:
      return undefined
  }
}

function notificationStatus(v: string): 'completed' | 'failed' | 'stopped' | undefined {
  switch (v) {
    case 'completed':
    case 'failed':
    case 'stopped':
      return v
    default:
      return undefined
  }
}

/** 一条 `system` 记录；不是 task_* 就返回 null */
export function taskSystemEvent(raw: Record<string, unknown>): AgentEvent | null {
  switch (str(raw.subtype)) {
    case 'task_started': {
      const taskId = str(raw.task_id)
      const toolUseId = str(raw.tool_use_id) || undefined
      const agentType = str(raw.subagent_type) || undefined
      // 后台 shell / workflow 没有 tool_use_id / subagent_type，不进子代理区
      if (!taskId || (!toolUseId && !agentType && str(raw.task_type) !== 'local_agent')) return null
      return {
        t: 'task_started',
        taskId,
        toolUseId,
        description: str(raw.description) || agentType || '子代理',
        agentType,
        isBackground: raw.is_backgrounded === true ? true : undefined,
        skipTranscript: raw.skip_transcript === true ? true : undefined
      }
    }

    case 'task_progress': {
      const taskId = str(raw.task_id)
      const toolUseId = str(raw.tool_use_id) || undefined
      const agentType = str(raw.subagent_type) || undefined
      if (!taskId || (!toolUseId && !agentType)) return null
      const usage = obj(raw.usage)
      return {
        t: 'task_progress',
        taskId,
        toolUseId,
        description: str(raw.description) || undefined,
        agentType,
        totalTokens: num(usage?.total_tokens),
        toolUses: num(usage?.tool_uses),
        durationMs: num(usage?.duration_ms),
        lastToolName: str(raw.last_tool_name) || undefined,
        summary: str(raw.summary) || undefined
      }
    }

    case 'task_updated': {
      const taskId = str(raw.task_id)
      const patch = obj(raw.patch)
      if (!taskId || !patch) return null
      return {
        t: 'task_updated',
        taskId,
        status: patchStatus(str(patch.status)),
        description: str(patch.description) || undefined,
        endTime: num(patch.end_time),
        error: str(patch.error) || undefined,
        isBackground: patch.is_backgrounded === true ? true : undefined
      }
    }

    case 'task_notification': {
      const taskId = str(raw.task_id)
      const status = notificationStatus(str(raw.status))
      if (!taskId || !status) return null
      const usage = obj(raw.usage)
      // 有些子代理走 SubagentHandback：真正的报告在 handback_report 里，
      // summary 只是给模型看的 harness 备注。
      const report = obj(raw.handback_report)
      const reportText =
        str(report?.text) ||
        str(report?.content) ||
        (typeof raw.handback_report === 'string' ? raw.handback_report : '')
      return {
        t: 'task_notification',
        taskId,
        toolUseId: str(raw.tool_use_id) || undefined,
        status,
        summary: reportText || str(raw.summary),
        reason: str(raw.reason) || undefined,
        outputFile: str(raw.output_file) || undefined,
        totalTokens: num(usage?.total_tokens),
        toolUses: num(usage?.tool_uses),
        durationMs: num(usage?.duration_ms),
        skipTranscript: raw.skip_transcript === true ? true : undefined
      }
    }

    default:
      return null
  }
}

function tag(xml: string, name: string): string {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)
  return m ? m[1].trim() : ''
}

/**
 * 历史回放：jsonl 里的后台任务完成通知是一段 XML 文本，挂在
 * attachment / queue-operation 记录上。它没有结构化的 usage，只有 result。
 */
export function taskNotificationFromText(text: string): AgentEvent | null {
  const t = text.trimStart()
  if (!t.startsWith('<task-notification>')) return null
  const taskId = tag(t, 'task-id')
  const status = notificationStatus(tag(t, 'status'))
  if (!taskId || !status) return null
  return {
    t: 'task_notification',
    taskId,
    toolUseId: tag(t, 'tool-use-id') || undefined,
    status,
    // result 才是报告正文；summary 只是“Agent ... finished”
    summary: tag(t, 'result') || tag(t, 'summary'),
    outputFile: tag(t, 'output-file') || undefined
  }
}
