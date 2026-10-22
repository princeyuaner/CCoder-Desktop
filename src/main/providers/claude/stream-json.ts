import type {
  AgentEvent,
  PermissionMode,
  Usage,
  UsageBreakdown
} from '../../../shared/events'
import { isFileEditTool, statFromPatch, toolDisplay, toolFamily } from '../../../shared/tool'
import { agentRunInfo, taskResultInfo } from './tool-result-meta'
import { taskSystemEvent } from './task-events'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : []

/**
 * CLI 的权限模式名 → 我们自己的联合类型。
 *
 * 注意 `manual` → `standard`：同一个语义（每个动作都问），两边叫法不同。
 * adapter 里有一条方向相反的映射（standard → manual），两条要成对维护。
 * 不能靠"未知值兜底成 standard"来碰巧命中 —— 那样一旦 CLI 加新模式就悄悄错了。
 */
const CLI_TO_OURS: Record<string, PermissionMode> = {
  manual: 'standard',
  default: 'standard',
  standard: 'standard',
  acceptEdits: 'acceptEdits',
  auto: 'auto',
  plan: 'plan',
  dontAsk: 'dontAsk',
  bypassPermissions: 'bypassPermissions'
}

function normalizeMode(v: unknown): PermissionMode {
  return CLI_TO_OURS[str(v)] ?? 'standard'
}

/** tool_result 的 content 可能是字符串，也可能是块数组 */
function stringifyContent(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    return v
      .map((b) => {
        const o = obj(b)
        if (!o) return ''
        if (typeof o.text === 'string') return o.text
        return `[${str(o.type) || 'block'}]`
      })
      .filter(Boolean)
      .join('\n')
  }
  return v == null ? '' : JSON.stringify(v)
}

/**
 * 从未完成的 JSON 文本里抠一个**已经闭合**的字符串字段。
 *
 * 入参流到一半时不能 JSON.parse（右括号还没到），但 `"file_path"` 通常
 * 在开头就已经是完整字符串了。这里只认引号已闭合的值，反转义交给
 * JSON.parse —— 手写反转义在 Windows 路径的 `\\` 上很容易出错。
 */
function partialStringField(json: string, field: string): string | undefined {
  // 只认对象键的位置（`{` 或 `,` 之后）。正文里出现 `\"file_path\"` 这种
  // 文本时，前面是反斜杠，不会被误当成键。
  const re = new RegExp(`(?:^|[{,])\\s*"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
  const m = re.exec(json)
  if (!m) return undefined
  try {
    const v: unknown = JSON.parse(`"${m[1]}"`)
    return typeof v === 'string' && v ? v : undefined
  } catch {
    return undefined
  }
}

/**
 * `claude --output-format stream-json` 的 NDJSON 事件 → 归一化 AgentEvent。
 *
 * **有状态**，因为文本会来两遍：开了 `--include-partial-messages` 后，
 * 正文既以 content_block_delta 逐字流出，又在随后的 `assistant` 消息里
 * 完整出现一次。不去重就会看到每句话被写两遍。
 */
export class ClaudeStreamTranslator {
  /** 当前这条 assistant 消息是否已经有流式 delta 打过了 */
  private sawTextDelta = false
  /** 同上，但针对思考块。正文和思考各算各的，不能共用一个标记 */
  private sawThinkingDelta = false
  /**
   * 本轮最后一条 assistant 消息占用的上下文 token。
   *
   * 每来一条 assistant 消息就覆盖一次 —— 一轮里可能有多次工具往返，
   * 最后一次请求看到的才是"现在上下文里有多少"。
   */
  private lastContextTokens: number | null = null
  /** 与 lastContextTokens 同一条 assistant 消息的四项构成 */
  private lastContextUsage: UsageBreakdown | null = null
  /**
   * 编辑类 tool_use id → 文件路径 / 是否 Write / 按 input 估的行数。
   *
   * 回执（tool_result）里只有 patch，没有路径；路径在 tool_use 的 input 里。
   * 子代理的 tool_use 也要记 —— 它们的改动不进转写区，但要进「本轮修改」。
   */
  private editFiles = new Map<
    string,
    { path: string; wrote: boolean; estimate?: { added: number; removed: number } }
  >()
  /**
   * 正在流式生成的 tool_use 块，按 content block index 存。
   *
   * `--include-partial-messages` 下，入参是 `input_json_delta` 一段段来的；
   * `content_block_start` 只给 id / name。写大文件时这个阶段能持续几十秒，
   * 界面不能等 assistant 消息（完整 input）到了才画卡片。
   */
  private toolBlocks = new Map<
    number,
    { id: string; name: string; json: string; pathDone: boolean }
  >()

  translate(raw: Record<string, unknown>): AgentEvent[] {
    /*
     * 子代理的旁支消息不能混进主转写。
     * 历史回放按 isSidechain 过滤；实时流这边两个标记都认 —— 老版本给
     * isSidechain，SDK 的流式消息给 parent_tool_use_id。
     *
     * 但**不能整条丢掉**：子代理改的文件要算进「本轮修改」。所以只把
     * 正文/思考/工具卡过滤掉，assistant/user 里仍然抽 file_change。
     */
    const sidechain =
      raw.isSidechain === true || raw.parent_tool_use_id != null || raw.parentToolUseId != null

    switch (raw.type) {
      case 'system':
        return sidechain ? [] : this.system(raw)
      case 'stream_event':
        return sidechain ? [] : this.streamEvent(raw)
      case 'assistant':
        return this.assistant(raw, sidechain)
      case 'user':
        return this.user(raw, sidechain)
      case 'result':
        return sidechain ? [] : this.result(raw)
      default:
        return []
    }
  }

  private system(o: Record<string, unknown>): AgentEvent[] {
    // 子代理的后台进度 / 完成通知：执行台靠它们更新状态
    const task = taskSystemEvent(o)
    if (task) return [task]

    // 其余只关心 init。status / commands_changed（16KB 的命令表）/ api_retry
    // 一律丢弃 —— 尤其 commands_changed 绝不能原样转给渲染进程。
    if (o.subtype !== 'init') return []
    return [
      {
        t: 'session_started',
        sessionId: str(o.session_id),
        provider: 'claude',
        model: str(o.model),
        cwd: str(o.cwd),
        tools: Array.isArray(o.tools) ? o.tools.filter((x): x is string => typeof x === 'string') : [],
        permissionMode: normalizeMode(o.permissionMode)
      }
    ]
  }

  private streamEvent(o: Record<string, unknown>): AgentEvent[] {
    const ev = obj(o.event)
    if (!ev) return []

    switch (ev.type) {
      case 'message_start':
        // 块序号每条消息都从 0 重新开始：清掉上一条消息的残留，
        // 否则两次调用会拼进同一个槽里。
        this.toolBlocks.clear()
        return []

      case 'content_block_start': {
        const cb = obj(ev.content_block)
        if (!cb || cb.type !== 'tool_use') return []
        const id = str(cb.id)
        const name = str(cb.name)
        if (!id || !name) return []
        const index = typeof ev.index === 'number' ? ev.index : -1
        if (index >= 0) this.toolBlocks.set(index, { id, name, json: '', pathDone: false })
        // 卡片先出来；文件名、行数等入参流出来后再补
        return [{ t: 'tool_started', id, name }]
      }

      case 'content_block_delta': {
        const d = obj(ev.delta)
        if (!d) return []

        if (d.type === 'text_delta') {
          this.sawTextDelta = true
          return [{ t: 'text_delta', text: str(d.text) }]
        }
        if (d.type === 'thinking_delta') {
          this.sawThinkingDelta = true
          return [{ t: 'thinking_delta', text: str(d.thinking) }]
        }
        if (d.type === 'input_json_delta') {
          const index = typeof ev.index === 'number' ? ev.index : -1
          const slot = index >= 0 ? this.toolBlocks.get(index) : undefined
          const part = str(d.partial_json)
          if (!slot || !part || slot.pathDone) return []
          slot.json += part
          // 只在前 8KB 里找路径。再大还没见到，说明这个工具多半没有路径，
          // 或者字段排在正文后面 —— 每次 delta 都扫一遍全量文本会变成 O(n²)。
          if (slot.json.length > 8192) {
            slot.pathDone = true
            return []
          }
          const path =
            partialStringField(slot.json, 'file_path') ||
            partialStringField(slot.json, 'notebook_path')
          if (!path) return []
          slot.pathDone = true
          return [{ t: 'tool_started', id: slot.id, name: slot.name, path }]
        }
        return []
      }

      default:
        return []
    }
  }

  private assistant(o: Record<string, unknown>, sidechain: boolean): AgentEvent[] {
    const out: AgentEvent[] = []
    // 子代理的请求不进主会话的上下文统计
    if (!sidechain) {
      // assistant 消息自带本次 API 调用的 usage：输入 + 缓存 + 输出就是当前上下文
      const u = obj(obj(o.message)?.usage)
      if (u) {
        const breakdown: UsageBreakdown = {
          inputTokens: num(u.input_tokens),
          outputTokens: num(u.output_tokens),
          cacheReadTokens: num(u.cache_read_input_tokens),
          cacheCreationTokens: num(u.cache_creation_input_tokens)
        }
        const ctx =
          breakdown.inputTokens +
          breakdown.cacheReadTokens +
          breakdown.cacheCreationTokens +
          breakdown.outputTokens
        if (ctx > 0) {
          this.lastContextTokens = ctx
          this.lastContextUsage = breakdown
        }
      }
    }
    for (const b of arr(obj(o.message)?.content)) {
      if (b.type === 'text') {
        if (sidechain) continue
        // 已经有流式 delta 打过这段文本就不再重复输出
        if (!this.sawTextDelta) out.push({ t: 'text_delta', text: str(b.text) })
      } else if (b.type === 'thinking') {
        if (sidechain) continue
        // 兜底：渠道不吐 thinking_delta 时，思考只在这条 assistant 消息里出现一次。
        // 不接的话整段思考就被悄悄丢了 —— 界面上什么都不显示。
        if (!this.sawThinkingDelta) out.push({ t: 'thinking_delta', text: str(b.thinking) })
      } else if (b.type === 'tool_use') {
        const name = str(b.name)
        const id = str(b.id)
        // 编辑工具：记下路径，等回执里的 patch 到了再发 file_change。
        // 子代理的这一步必须做，否则它们的改动永远进不了修改清单。
        if (isFileEditTool(name)) {
          const d = toolDisplay(name, b.input)
          if (d.path) {
            this.editFiles.set(id, {
              path: d.path,
              wrote: toolFamily(name) === 'write',
              estimate: d.stat
            })
            // 防止异常长的会话把 map 撑爆
            if (this.editFiles.size > 1000) {
              const oldest = this.editFiles.keys().next().value
              if (oldest !== undefined) this.editFiles.delete(oldest)
            }
          }
        }
        if (!sidechain) out.push({ t: 'tool_call', id, name, input: b.input })
      }
    }
    this.sawTextDelta = false
    this.sawThinkingDelta = false
    return out
  }

  private user(o: Record<string, unknown>, sidechain: boolean): AgentEvent[] {
    const out: AgentEvent[] = []
    // stdout 上是 snake_case（tool_use_result）；jsonl 里是 camelCase。
    // 两个都认，将来 CLI 改回哪边都不会把增删行数悄悄丢掉。
    const tur = obj(o.tool_use_result) ?? obj(o.toolUseResult)
    const stat = statFromPatch(tur?.structuredPatch)
    // Write 新建文件时 CLI 会标 type: 'create'；覆盖已有文件没有这个字段。
    // 「新建」那枚标签只认它 —— 用工具名猜会把覆盖也标成新建
    const created = tur?.type === 'create'
    // 子代理统计 / 任务回执挂在整条 user 记录上，不属于某个 content block；
    // 一条记录通常只有一个 tool_result，直接附上去即可。
    const agent = agentRunInfo(tur)
    const task = taskResultInfo(tur)
    for (const b of arr(obj(o.message)?.content)) {
      if (b.type !== 'tool_result') continue
      const id = str(b.tool_use_id)

      // 编辑工具的回执 → 一条 file_change。路径来自前面 assistant 的 tool_use。
      const edit = this.editFiles.get(id)
      if (edit) {
        this.editFiles.delete(id)
        const precise = stat ?? edit.estimate
        out.push({
          t: 'file_change',
          path: edit.path,
          ...(precise ? { added: precise.added, removed: precise.removed } : {}),
          ...(created ? { created: true } : {}),
          wrote: edit.wrote,
          source: sidechain ? 'subagent' : 'agent'
        })
      }

      // 子代理的工具卡不进主转写；它自己的 agent/task 回执也不属于主会话
      if (sidechain) continue

      out.push({
        t: 'tool_result',
        id,
        status: b.is_error === true ? 'error' : 'ok',
        content: stringifyContent(b.content),
        ...(stat ? { stat } : {}),
        ...(created ? { created: true } : {}),
        ...(agent ? { agent } : {}),
        ...(task ? { task } : {})
      })
    }
    return out
  }

  private result(o: Record<string, unknown>): AgentEvent[] {
    const u = obj(o.usage) ?? {}
    const durationMs = num(o.duration_ms) || num(o.duration_api_ms)
    const outputTokens = num(u.output_tokens)

    // result 里的 usage 是一轮的累计值（每次工具调用都算一遍）；
    // 有最后一条 assistant 消息的 usage 时优先用它，那才是当前上下文。
    const prompt = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens)
    const fallbackCtx = prompt + outputTokens
    const contextTokens = this.lastContextTokens ?? (fallbackCtx > 0 ? fallbackCtx : undefined)
    // 没有 assistant 消息时（例如这一轮直接失败）退回累计值；有就用最后一次请求的构成
    const fallbackUsage: UsageBreakdown = {
      inputTokens: num(u.input_tokens),
      outputTokens,
      cacheReadTokens: num(u.cache_read_input_tokens),
      cacheCreationTokens: num(u.cache_creation_input_tokens)
    }
    const contextUsage = this.lastContextUsage ?? (fallbackCtx > 0 ? fallbackUsage : undefined)
    this.lastContextTokens = null
    this.lastContextUsage = null
    // 一轮结束了，没等到回执的编辑记录（被打断的调用）不再跨轮保留
    this.editFiles.clear()

    const usage: Usage = {
      inputTokens: num(u.input_tokens),
      outputTokens,
      cacheReadTokens: num(u.cache_read_input_tokens),
      cacheCreationTokens: num(u.cache_creation_input_tokens),
      tokensPerSecond:
        durationMs > 0 && outputTokens > 0
          ? Math.round(outputTokens / (durationMs / 1000))
          : undefined,
      contextPercent: undefined,
      contextTokens,
      ...(contextUsage ? { contextUsage } : {})
    }

    const out: AgentEvent[] = []

    // 失败时 CLI 会把原因放在 result 字段里（如 401 的原话），要让它浮上来
    if (o.is_error === true) {
      out.push({ t: 'error', message: str(o.result) || '本轮以错误结束', fatal: false })
    }

    // steps 由 session-manager 按本轮的 tool_call 数填，这里先给 0
    out.push({
      t: 'turn_end',
      durationMs,
      usage,
      costUsd: num(o.total_cost_usd) || undefined,
      steps: 0
    })
    return out
  }
}
