import type { AgentEvent, AgentRunInfo, ToolStatus } from '@shared/events'

/**
 * 「本轮执行台」的状态：任务清单 + 子代理 + 这一轮的步数/改动量。
 *
 * 为什么单独归约而不是从 `ChatItem[]` 反推：
 *  - 转写区是一条事件流，工具卡只保留展示需要的字段；任务 id、代理统计这些
 *    细节不适合再往 ChatItem 上堆。
 *  - 历史回放和实时走**同一个 reducer**：`events.reduce(reduceRun, emptyRunState())`，
 *    面板打开一条旧会话时看到的东西和它当时跑的时候是同一套逻辑算出来的。
 *
 * 所有时间戳在 `live=false` 时留 0/undefined —— 回放是一次性算完的，
 * 用 Date.now() 相减永远是 0，不如不显示，面板会退化成只显示状态和最终统计。
 */

export type RunTaskStatus = 'pending' | 'in_progress' | 'completed'
/** 子代理状态 = 工具状态 + 「被停止」。后台任务没有 denied，但可能被 TaskStop */
export type RunAgentStatus = ToolStatus | 'stopped'

export interface RunTask {
  id: string
  subject: string
  description?: string
  /** 进行中的动词形式，如「正在修改 src/auth/store.ts」 */
  activeForm?: string
  status: RunTaskStatus
  /** 进入 in_progress 的时刻；只有实时会话才有 */
  startedAt?: number
  /** 变成 completed 的时刻；只有实时会话才有 */
  endedAt?: number
}

export interface RunAgent {
  id: string
  /** 触发它的工具名：新版本是 Agent，老版本是 Task */
  tool: string
  /** CLI 的任务 id（task_started / task_notification 里的 task_id） */
  taskId?: string
  /** Explore / Plan / general-purpose … */
  type: string
  description: string
  status: RunAgentStatus
  startedAt: number
  /** 耗时。实时用 startedAt 算，历史用 CLI 回执里的 totalDurationMs */
  ms?: number
  /** 结果摘要（一句话） */
  result?: string
  /** 实时活动：task_progress 的 summary / last_tool_name */
  activity?: string
  /** 后台启动（async_launched）；完成状态要等 task_notification */
  isBackground?: boolean
  /** CLI 回执里的完整统计 */
  info?: AgentRunInfo
}

export interface RunState {
  tasks: RunTask[]
  agents: RunAgent[]
  /** 本轮开始时刻（用户发出消息时）；0 = 未知 */
  startedAt: number
  endedAt?: number
  durationMs?: number
  /** 本轮工具调用数 */
  steps: number
  /** 本轮增删行数 */
  added: number
  removed: number
  /**
   * 任务清单来自哪套工具。
   * 老版本 CLI 用 TodoWrite，新版本用 TaskCreate/TaskUpdate —— 后者是增量的，
   * 前者是整份覆盖，归约方式不一样，所以要分开记。
   */
  taskMode: 'todo' | 'task' | null
  /** TaskCreate 的临时 id 映射：工具调用 id → 本地临时任务 id */
  pendingCreates: Record<string, string>
}

export function emptyRunState(): RunState {
  return {
    tasks: [],
    agents: [],
    startedAt: 0,
    steps: 0,
    added: 0,
    removed: 0,
    taskMode: null,
    pendingCreates: {}
  }
}

/**
 * 用户发了一条新消息：本轮重新开始。
 *
 * **任务和子代理都保留** —— 面板不是一个每轮清空的临时区。新一轮的条目
 * 从上面顶进来，老的往下走；数量不设上限，面板自己滚动。
 * 步数 / 改动量 / 本轮耗时属于当前这一轮，重新计。
 */
export function startRun(prev: RunState, at: number): RunState {
  return {
    ...prev,
    agents: prev.agents,
    startedAt: at,
    endedAt: undefined,
    durationMs: undefined,
    steps: 0,
    added: 0,
    removed: 0,
    // 上一轮还没回执的 TaskCreate 先留着，回执到了还能把临时 id 对上
    pendingCreates: prev.pendingCreates
  }
}

/* ── 解析输入 ─────────────────────────────────────────────── */

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

function firstLine(s: string): string {
  const line = s.split('\n').find((l) => l.trim()) ?? ''
  return line.trim().slice(0, 120)
}

function normalizeTaskStatus(v: string): RunTaskStatus | 'deleted' | null {
  const s = v.toLowerCase().replace(/[-\s]/g, '_')
  if (s === 'in_progress' || s === 'active') return 'in_progress'
  if (s === 'completed' || s === 'complete' || s === 'done') return 'completed'
  if (s === 'pending' || s === 'todo') return 'pending'
  if (s === 'deleted' || s === 'cancelled' || s === 'canceled') return 'deleted'
  return null
}

interface RawTodo {
  content: string
  status: string
  activeForm?: string
}

function todosOf(input: unknown): RawTodo[] | null {
  const o = obj(input)
  const list = o?.todos
  if (!Array.isArray(list)) return null
  return list.map((x, i) => {
    const t = obj(x) ?? {}
    const activeForm = str(t.activeForm)
    return {
      content: str(t.content) || activeForm || `任务 ${i + 1}`,
      status: str(t.status),
      activeForm: activeForm || undefined
    }
  })
}

/** 子代理结果外面常包一层 [Subagent hand-back] 说明；摘要要的是正文 */
function summaryOfContent(content: string): string | undefined {
  let s = content.trim()
  if (!s) return undefined
  if (s.startsWith('[Subagent hand-back]')) {
    const cut = s.indexOf('\n\n')
    s = cut >= 0 ? s.slice(cut + 2).trim() : s.replace(/^\[Subagent hand-back\][^\n]*\n?/, '').trim()
  }
  const lines = s
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

/* ── 任务 ─────────────────────────────────────────────────── */

function applyTodoList(prev: RunTask[], raw: RawTodo[], now: number, live: boolean): RunTask[] {
  const bySubject = new Map<string, RunTask>()
  for (const t of prev) if (!bySubject.has(t.subject)) bySubject.set(t.subject, t)

  const seen = new Map<string, number>()
  return raw.map((td) => {
    const n = (seen.get(td.content) ?? 0) + 1
    seen.set(td.content, n)

    const before = bySubject.get(td.content)
    const parsed = normalizeTaskStatus(td.status)
    const status: RunTaskStatus =
      parsed === 'deleted' || parsed === null ? 'pending' : parsed

    let startedAt = before?.startedAt
    let endedAt = before?.endedAt
    if (status === 'in_progress') {
      if (before?.status !== 'in_progress' && !startedAt) startedAt = live ? now : undefined
      endedAt = undefined
    } else if (status === 'completed') {
      if (before?.status !== 'completed' && live) endedAt = now
    } else {
      endedAt = undefined
    }

    return {
      id: n === 1 ? `todo:${td.content}` : `todo:${td.content}#${n}`,
      subject: td.content,
      activeForm: td.activeForm,
      status,
      startedAt,
      endedAt
    }
  })
}

/** 按状态迁移补时间戳；patch 里没有的字段保留原值 */
function patchTask(
  prev: RunTask,
  patch: Partial<RunTask> & { status?: RunTaskStatus },
  now: number,
  live: boolean
): RunTask {
  const status = patch.status ?? prev.status
  let startedAt = prev.startedAt
  let endedAt = prev.endedAt
  if (status === 'in_progress') {
    if (prev.status !== 'in_progress' && !startedAt) startedAt = live ? now : undefined
    endedAt = undefined
  } else if (status === 'completed') {
    if (prev.status !== 'completed' && live) endedAt = now
  } else {
    endedAt = undefined
  }
  return { ...prev, ...patch, status, startedAt, endedAt }
}

function removeTask(tasks: RunTask[], id: string): RunTask[] {
  return tasks.filter((t) => t.id !== id)
}

/** TaskCreate 回执：把本地临时任务换成 CLI 分配的真实 id */
function rekeyCreated(
  state: RunState,
  callId: string,
  newId: string,
  subject: string,
  now: number,
  live: boolean
): RunState {
  const tempId = state.pendingCreates[callId]
  const pending = { ...state.pendingCreates }
  delete pending[callId]

  if (!tempId) return { ...state, pendingCreates: pending }

  const idx = state.tasks.findIndex((t) => t.id === tempId)
  if (idx < 0) return { ...state, pendingCreates: pending }

  const finalId = `task:${newId}`
  const tasks = state.tasks.slice()
  const existing = tasks.findIndex((t) => t.id === finalId)
  if (existing >= 0) {
    // 极少数情况：TaskUpdate 先到，占位任务已经在列表里了 —— 合并到它身上
    const merged = patchTask(
      tasks[existing],
      { subject: subject || tasks[existing].subject },
      now,
      live
    )
    tasks[existing] = merged
    tasks.splice(idx, 1)
  } else {
    tasks[idx] = { ...tasks[idx], id: finalId, subject: subject || tasks[idx].subject }
  }
  return { ...state, tasks, pendingCreates: pending }
}

/* ── 子代理 ───────────────────────────────────────────────── */

function agentStatusOf(toolStatus: ToolStatus, info?: AgentRunInfo): ToolStatus {
  if (toolStatus === 'error' || toolStatus === 'denied') return toolStatus
  const s = (info?.status ?? '').toLowerCase()
  if (s === 'failed' || s === 'killed' || s === 'error' || s === 'aborted') return 'error'
  return 'ok'
}

/** 子代理的统计会从多个来源补进来（tool_result / task_progress / notification），逐字段合并 */
function mergeAgentInfo(base?: AgentRunInfo, next?: AgentRunInfo): AgentRunInfo | undefined {
  if (!base) return next
  if (!next) return base
  return {
    agentId: next.agentId ?? base.agentId,
    agentType: next.agentType ?? base.agentType,
    status: next.status ?? base.status,
    durationMs: next.durationMs ?? base.durationMs,
    totalTokens: next.totalTokens ?? base.totalTokens,
    toolUseCount: next.toolUseCount ?? base.toolUseCount,
    model: next.model ?? base.model,
    toolStats: next.toolStats ?? base.toolStats,
    async: next.async ?? base.async,
    summary: next.summary ?? base.summary
  }
}

/** 同一张代理卡可能先由 task_started 创建、也可能先由 Agent 工具调用创建 */
function findAgentIndex(agents: RunAgent[], taskId?: string, toolUseId?: string): number {
  if (toolUseId) {
    const i = agents.findIndex((a) => a.id === toolUseId)
    if (i >= 0) return i
  }
  if (taskId) {
    const i = agents.findIndex((a) => a.taskId === taskId)
    if (i >= 0) return i
  }
  return -1
}

function applyAgentResult(
  state: RunState,
  e: Extract<AgentEvent, { t: 'tool_result' }>,
  now: number,
  live: boolean
): RunState {
  const info = e.agent
  if (!info) return state

  const idx = findAgentIndex(state.agents, info.agentId, e.id)
  const type = info.agentType || 'subagent'
  const base: RunAgent =
    idx >= 0
      ? state.agents[idx]
      : {
          id: e.id,
          tool: 'Agent',
          type,
          description: type,
          status: 'running',
          startedAt: 0
        }

  /*
   * 后台启动的回执只是「已开跑」，不是结果。这时候绝不能把卡片改成完成 ——
   * 真正的状态在后面的 task_started / task_progress / task_notification 里。
   */
  if (info.async && e.status === 'ok' && info.status !== 'failed' && info.status !== 'killed') {
    const next: RunAgent = {
      ...base,
      type: info.agentType || base.type,
      taskId: info.agentId || base.taskId,
      status: 'running',
      isBackground: true,
      info: mergeAgentInfo(base.info, info)
    }
    const agents = state.agents.slice()
    if (idx >= 0) agents[idx] = next
    else agents.unshift(next)
    return { ...state, agents }
  }

  const status = agentStatusOf(e.status, info)
  const ms = info.durationMs ?? (base.startedAt && live ? now - base.startedAt : undefined)
  const result = info.summary || summaryOfContent(e.content)
  const next: RunAgent = {
    ...base,
    type: info.agentType || base.type,
    taskId: info.agentId || base.taskId,
    status,
    ms,
    result,
    isBackground: info.async ? true : base.isBackground,
    activity: undefined,
    info: mergeAgentInfo(base.info, info)
  }

  const agents = state.agents.slice()
  if (idx >= 0) agents[idx] = next
  else agents.unshift(next) // 没有 call 记录的兜底：仍然按“新的在上面”
  return { ...state, agents }
}

/* ── 主 reducer ───────────────────────────────────────────── */

export function reduceRun(state: RunState, e: AgentEvent, live = true): RunState {
  const now = live ? Date.now() : 0

  switch (e.t) {
    case 'user_message':
      // 新一轮只重置本轮的计时和计数；任务、子代理都留着
      return startRun(state, live ? now : parseAt(e.at))

    case 'tool_call': {
      const base = live
        ? { ...state, endedAt: undefined, durationMs: undefined }
        : state

      switch (e.name) {
        case 'TodoWrite': {
          const todos = todosOf(e.input)
          if (!todos) return base
          return {
            ...base,
            steps: base.steps + 1,
            tasks: applyTodoList(base.tasks, todos, now, live),
            taskMode: 'todo'
          }
        }

        case 'TaskCreate': {
          const o = obj(e.input) ?? {}
          const subject = str(o.subject) || str(o.description) || '新任务'
          const tempId = `pending:${e.id}`
          const task: RunTask = {
            id: tempId,
            subject,
            description: str(o.description) || undefined,
            activeForm: str(o.activeForm) || undefined,
            status: 'pending'
          }
          return {
            ...base,
            steps: base.steps + 1,
            // 新任务从上面进来，老的往下顶；换到任务系统时旧清单不再代表当前计划
            tasks: base.taskMode === 'task' ? [task, ...base.tasks] : [task],
            taskMode: 'task',
            pendingCreates: { ...base.pendingCreates, [e.id]: tempId }
          }
        }

        case 'TaskUpdate': {
          const o = obj(e.input) ?? {}
          const rawId = o.taskId ?? o.task_id
          if (rawId === undefined || rawId === null) return { ...base, steps: base.steps + 1 }
          const id = `task:${String(rawId)}`
          const parsed = normalizeTaskStatus(str(o.status))
          const status: RunTaskStatus | undefined =
            parsed === 'deleted' || parsed === null ? undefined : parsed

          if (parsed === 'deleted') {
            return { ...base, steps: base.steps + 1, tasks: removeTask(base.tasks, id) }
          }

          let tasks = base.taskMode === 'task' ? base.tasks : []
          let idx = tasks.findIndex((t) => t.id === id)
          if (idx < 0) {
            // 没见过的任务 id（回放从中间开始）：补一条，也放在最上面
            tasks = [
              {
                id,
                subject: str(o.subject) || `任务 #${String(rawId)}`,
                description: str(o.description) || undefined,
                activeForm: str(o.activeForm) || undefined,
                status: 'pending'
              },
              ...tasks
            ]
            idx = 0
          }

          // 空字段不能覆盖原值：TaskUpdate 经常只带 status/taskId
          const patch: Partial<RunTask> & { status?: RunTaskStatus } = { status }
          const subject = str(o.subject)
          const description = str(o.description)
          const activeForm = str(o.activeForm)
          if (subject) patch.subject = subject
          if (description) patch.description = description
          if (activeForm) patch.activeForm = activeForm

          const next = tasks.slice()
          next[idx] = patchTask(tasks[idx], patch, now, live)
          return { ...base, steps: base.steps + 1, tasks: next, taskMode: 'task' }
        }

        case 'Agent':
        case 'Task': {
          if (state.agents.some((a) => a.id === e.id)) {
            return { ...base, steps: base.steps + 1 }
          }
          const o = obj(e.input) ?? {}
          const type = str(o.subagent_type) || (e.name === 'Task' ? 'general-purpose' : 'subagent')
          const description = str(o.description) || firstLine(str(o.prompt)) || type
          const agent: RunAgent = {
            id: e.id,
            tool: e.name,
            type,
            description,
            status: 'running',
            startedAt: live ? now : 0
          }
          // 新的在上面：面板跨轮保留，后来的把老的往下顶
          return {
            ...base,
            steps: base.steps + 1,
            agents: [agent, ...base.agents]
          }
        }

        default:
          return { ...base, steps: base.steps + 1 }
      }
    }

    case 'tool_result': {
      let next = state
      if (e.stat) {
        next = { ...next, added: next.added + e.stat.added, removed: next.removed + e.stat.removed }
      }
      if (e.agent) next = applyAgentResult(next, e, now, live)

      if (e.task) {
        if (e.task.created) {
          next = rekeyCreated(next, e.id, e.task.created.id, e.task.created.subject, now, live)
        } else if (e.task.updated) {
          const id = `task:${e.task.updated.taskId}`
          const to = normalizeTaskStatus(e.task.updated.to ?? '')
          if (to === 'deleted') {
            next = { ...next, tasks: removeTask(next.tasks, id) }
          } else {
            const idx = next.tasks.findIndex((t) => t.id === id)
            if (idx >= 0) {
              const tasks = next.tasks.slice()
              tasks[idx] = patchTask(
                tasks[idx],
                { status: to === null ? undefined : to },
                now,
                live
              )
              next = { ...next, tasks }
            }
          }
        }
      } else if (next.pendingCreates[e.id]) {
        if (e.status === 'ok') {
          // 回执里没有结构化 task 字段（老版本 CLI）：从 "Task #3 created successfully" 里抠 id
          const m = /#(\d+)/.exec(e.content)
          if (m) next = rekeyCreated(next, e.id, m[1], '', now, live)
        } else {
          // 创建失败：别把一个永远等不到回执的占位任务留在面板里
          const tempId = next.pendingCreates[e.id]
          const pending = { ...next.pendingCreates }
          delete pending[e.id]
          next = { ...next, tasks: removeTask(next.tasks, tempId), pendingCreates: pending }
        }
      }
      return next
    }

    /*
     * 任务系统事件。后台代理的状态由它们推进，而不是由 Agent 工具的回执。
     * 这些事件不影响步数/改动量，只更新对应的子代理卡片。
     */
    case 'task_started': {
      const base = live ? { ...state, endedAt: undefined, durationMs: undefined } : state
      const idx = findAgentIndex(base.agents, e.taskId, e.toolUseId)
      if (idx >= 0) {
        const prev = base.agents[idx]
        const agents = base.agents.slice()
        agents[idx] = {
          ...prev,
          taskId: e.taskId,
          type: e.agentType || prev.type,
          description: e.description || prev.description,
          // 已经结束的卡不被迟到的 start 重新唤醒
          status: prev.status === 'running' ? 'running' : prev.status,
          isBackground: e.isBackground ?? prev.isBackground
        }
        return { ...base, agents }
      }
      if (!e.toolUseId && !e.agentType) return base
      const agent: RunAgent = {
        id: e.toolUseId || `task:${e.taskId}`,
        tool: 'Agent',
        taskId: e.taskId,
        type: e.agentType || 'subagent',
        description: e.description || e.agentType || '子代理',
        status: 'running',
        startedAt: live ? now : 0,
        isBackground: e.isBackground
      }
      return { ...base, agents: [agent, ...base.agents] }
    }

    case 'task_progress': {
      const idx = findAgentIndex(state.agents, e.taskId, e.toolUseId)
      if (idx < 0) return state
      const prev = state.agents[idx]
      const info = mergeAgentInfo(prev.info, {
        agentType: e.agentType,
        durationMs: e.durationMs,
        totalTokens: e.totalTokens,
        toolUseCount: e.toolUses
      })
      const agents = state.agents.slice()
      agents[idx] = {
        ...prev,
        taskId: e.taskId,
        type: e.agentType || prev.type,
        description: e.description || prev.description,
        ms: e.durationMs ?? prev.ms,
        activity:
          prev.status === 'running'
            ? e.summary || (e.lastToolName ? `正在调用 ${e.lastToolName}` : prev.activity)
            : prev.activity,
        info
      }
      return { ...state, agents }
    }

    case 'task_updated': {
      const idx = findAgentIndex(state.agents, e.taskId)
      if (idx < 0) return state
      const prev = state.agents[idx]
      const map: Record<string, RunAgentStatus> = {
        pending: 'running',
        running: 'running',
        completed: 'ok',
        failed: 'error',
        killed: 'error',
        paused: 'running'
      }
      const status = e.status ? (map[e.status] ?? prev.status) : prev.status
      const endMs = e.endTime
        ? e.endTime > 1e12
          ? e.endTime
          : e.endTime * 1000
        : undefined
      const agents = state.agents.slice()
      agents[idx] = {
        ...prev,
        taskId: e.taskId,
        description: e.description || prev.description,
        status,
        ms: endMs && prev.startedAt ? endMs - prev.startedAt : prev.ms,
        result: e.error || prev.result,
        isBackground: e.isBackground ?? prev.isBackground,
        activity: status === 'running' ? prev.activity : undefined
      }
      return { ...state, agents }
    }

    case 'task_notification': {
      const idx = findAgentIndex(state.agents, e.taskId, e.toolUseId)
      const status: RunAgentStatus =
        e.status === 'completed' ? 'ok' : e.status === 'stopped' ? 'stopped' : 'error'
      const info = mergeAgentInfo(idx >= 0 ? state.agents[idx].info : undefined, {
        agentId: e.taskId,
        status: e.status,
        durationMs: e.durationMs,
        totalTokens: e.totalTokens,
        toolUseCount: e.toolUses,
        summary: e.summary || undefined
      })

      if (idx < 0) {
        /*
         * 找不到对应卡片就丢掉这条通知。后台 shell 也会发 task_notification，
         * 它们的 tool_use_id 指向 Bash 调用；如果在这里补卡，执行台会被
         * 一堆「Background command ...」冒充成子代理。
         */
        return state
      }

      const prev = state.agents[idx]
      const agents = state.agents.slice()
      agents[idx] = {
        ...prev,
        taskId: e.taskId,
        status,
        ms: e.durationMs ?? prev.ms,
        result: e.summary || prev.result,
        activity: undefined,
        info
      }
      return { ...state, agents }
    }

    case 'turn_end': {
      const duration =
        e.durationMs > 0 ? e.durationMs : live && state.startedAt ? now - state.startedAt : undefined
      return {
        ...state,
        durationMs: duration,
        endedAt: live ? now : duration && state.startedAt ? state.startedAt + duration : undefined
      }
    }

    default:
      return state
  }
}

/** 历史记录里的 ISO 时间 → 毫秒；拿不到就 0 */
function parseAt(at: string): number {
  const t = Date.parse(at)
  return Number.isFinite(t) ? t : 0
}
