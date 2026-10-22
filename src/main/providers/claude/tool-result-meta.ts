import type { AgentRunInfo, AgentToolStats, TaskResultInfo } from '../../../shared/events'

/**
 * 从 CLI 的 `tool_use_result` / `toolUseResult` 里抽出子代理与任务回执。
 *
 * 两个来源字段名不一样：stdout 上是 snake_case，jsonl 里是 camelCase。
 * 这里两边都认，抽不到就返回 undefined —— 面板退化成只显示工具本身，
 * 不会因为 CLI 版本差异把整条结果丢掉。
 */

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

const obj = (v: unknown): Record<string, unknown> | undefined => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  // 某些 CLI 版本会把嵌套对象再序列化一次
  if (typeof v === 'string' && v.trim().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(v)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/** tool_use_result.content 可能是字符串、块数组，或对象 */
function stringifyContent(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    return v
      .map((b) => {
        const o = obj(b)
        if (!o) return ''
        if (typeof o.text === 'string') return o.text
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (v && typeof v === 'object') {
    try {
      return JSON.stringify(v)
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * 子代理结果外面常包一层 [Subagent hand-back] 说明。
 * 摘要要的是**报告正文**，不是这层壳。
 */
function stripHandback(s: string): string {
  const t = s.trimStart()
  if (!t.startsWith('[Subagent hand-back]')) return t
  const cut = t.indexOf('\n\n')
  return cut >= 0 ? t.slice(cut + 2).trim() : t.replace(/^\[Subagent hand-back\][^\n]*\n?/, '').trim()
}

/** 取第一行有意义的内容，去掉 markdown 标记，限长 */
function summaryOf(v: unknown): string | undefined {
  const body = stripHandback(stringifyContent(v))
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const line =
    lines.find((l) => l.startsWith('#')) ??
    lines.find((l) => !/^(\[|The text below|instructions, requests|This is a)/i.test(l)) ??
    lines[0]
  if (!line) return undefined
  const clean = line.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim()
  return clean.length > 160 ? `${clean.slice(0, 160)}…` : clean
}

export function agentRunInfo(tur: unknown): AgentRunInfo | undefined {
  const o = obj(tur)
  if (!o) return undefined

  const agentId = str(o.agentId ?? o.agent_id)
  const agentType = str(o.agentType ?? o.agent_type)
  // 只有子代理结果才带这两个字段。普通工具结果没有，别误判成代理。
  if (!agentId && !agentType) return undefined

  const rawStats = obj(o.toolStats ?? o.tool_stats)
  const stats: AgentToolStats | undefined = rawStats
    ? {
        readCount: num(rawStats.readCount ?? rawStats.read_count) ?? 0,
        searchCount: num(rawStats.searchCount ?? rawStats.search_count) ?? 0,
        bashCount: num(rawStats.bashCount ?? rawStats.bash_count) ?? 0,
        editFileCount: num(rawStats.editFileCount ?? rawStats.edit_file_count) ?? 0,
        linesAdded: num(rawStats.linesAdded ?? rawStats.lines_added) ?? 0,
        linesRemoved: num(rawStats.linesRemoved ?? rawStats.lines_removed) ?? 0,
        otherToolCount: num(rawStats.otherToolCount ?? rawStats.other_tool_count) ?? 0
      }
    : undefined

  const status = str(o.status)
  const isAsync =
    o.isAsync === true ||
    o.isAsync === 'true' ||
    status === 'async_launched' ||
    status === 'remote_launched'

  return {
    agentId: agentId || undefined,
    agentType: agentType || undefined,
    status: status || undefined,
    durationMs: num(o.totalDurationMs ?? o.total_duration_ms),
    totalTokens: num(o.totalTokens ?? o.total_tokens),
    toolUseCount: num(o.totalToolUseCount ?? o.total_tool_use_count),
    model: str(o.resolvedModel ?? o.resolved_model) || undefined,
    toolStats: stats,
    async: isAsync || undefined,
    // async_launched 的 content 是“已在后台启动”的回执，不是结果报告
    summary: isAsync ? undefined : summaryOf(o.content)
  }
}

export function taskResultInfo(tur: unknown): TaskResultInfo | undefined {
  const o = obj(tur)
  if (!o) return undefined

  // TaskCreate：{ task: { id, subject } }
  const created = obj(o.task)
  if (created) {
    const id = created.id
    if (id !== undefined && id !== null) {
      return {
        created: {
          id: String(id),
          subject: str(created.subject)
        }
      }
    }
  }

  // TaskUpdate：{ taskId, statusChange: { from, to } }
  const rawId = o.taskId ?? o.task_id
  if (rawId !== undefined && rawId !== null) {
    const change = obj(o.statusChange ?? o.status_change)
    const rawFields = o.updatedFields ?? o.updated_fields
    const fields = Array.isArray(rawFields)
      ? rawFields.filter((x): x is string => typeof x === 'string')
      : undefined
    return {
      updated: {
        taskId: String(rawId),
        from: str(change?.from) || undefined,
        to: str(change?.to) || undefined,
        updatedFields: fields?.length ? fields : undefined
      }
    }
  }

  return undefined
}
