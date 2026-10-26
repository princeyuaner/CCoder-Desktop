/**
 * 归一化事件模型 —— 主进程与渲染进程之间唯一的数据契约。
 *
 * 设计要点：UI 只认这一组事件，**不认识任何 CLI 的私有格式**。
 * 每个 provider 适配器（claude / codex / …）负责把自家的输出翻译成
 * 这里的联合类型。加一个新 CLI = 加一个适配器，UI 一行不改。
 */

import type { ToolStat } from './tool'
import type { ImageAttachment } from './attachment'
import type { LocalizedText } from './i18n'
import type { NativeCommand } from './commands'

export type PermissionMode =
  | 'standard'
  | 'acceptEdits'
  | 'auto'
  | 'plan'
  | 'dontAsk'
  | 'bypassPermissions'

/** 某一次请求的上下文构成；四项之和就是那一次请求结束时的上下文占用 */
export interface UsageBreakdown {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** 每轮结束时的瞬时吞吐，状态栏「199 tok/s」 */
  tokensPerSecond?: number
  /** 上下文窗口占用百分比，状态栏「1%」 */
  contextPercent?: number
  /**
   * 这一轮最后一次请求结束时，上下文里实际占用的 token
   * （输入 + 缓存读取 + 缓存写入 + 输出）。
   *
   * 取的是**最后一条 assistant 消息**的 usage，而不是 result 里的累计值 ——
   * 后者把一轮里每次工具调用的输入都加在一起，多工具轮次会严重高估。
   */
  contextTokens?: number
  /**
   * 与 contextTokens 同一来源的四项构成。
   *
   * 上面那四个 `inputTokens` 等字段是**一轮累计**（result 的 usage），
   * 多工具轮次会明显大于最后一次请求；上下文详情浮层要的是最后一次请求，
   * 所以单独带一份，别拿累计值去拆 contextTokens。
   */
  contextUsage?: UsageBreakdown
}

/** 一次工具调用的状态，供工具卡渲染 */
export type ToolStatus = 'running' | 'ok' | 'error' | 'denied'

/**
 * 子代理（Agent / Task 工具）跑完之后的收尾统计。
 *
 * CLI 的 `tool_use_result` 里带这些字段（stdout 上 key 是 snake_case，
 * jsonl 里是 camelCase，主进程两边都认）。它让右侧执行台除了「完成」之外，
 * 还能说清楚这个代理读了多少、搜了多少、花了多久。
 */
export interface AgentToolStats {
  readCount: number
  searchCount: number
  bashCount: number
  editFileCount: number
  linesAdded: number
  linesRemoved: number
  otherToolCount: number
}

export interface AgentRunInfo {
  agentId?: string
  /** Explore / Plan / general-purpose … */
  agentType?: string
  /** completed / failed / killed / async_launched … */
  status?: string
  durationMs?: number
  totalTokens?: number
  /** 这个子代理一共调了多少次工具 */
  toolUseCount?: number
  model?: string
  toolStats?: AgentToolStats
  /**
   * 后台启动。Agent 工具会立刻回一条 `async_launched` 的回执，
   * 真正的完成结果要等后面的 `task_notification` —— 不能把这条回执当完成。
   */
  async?: boolean
  /**
   * 结果的第一行摘要。由主进程从 `tool_use_result.content` 里提炼，
   * 只上抛一句话 —— 完整报告可能有两万字符，绝不能塞进事件流。
   */
  summary?: string
}

/** TaskCreate / TaskUpdate 的回执。用来把「临时任务」对上真实 id，或确认状态迁移 */
export interface TaskResultInfo {
  /** TaskCreate 成功：CLI 分配的 id 和最终 subject */
  created?: { id: string; subject: string }
  /** TaskUpdate 成功：状态从哪变到哪 */
  updated?: {
    taskId: string
    from?: string
    to?: string
    updatedFields?: string[]
  }
}

/** diff 的一行 */
export interface DiffLine {
  kind: 'add' | 'del' | 'ctx'
  text: string
}

/**
 * 审批预览。由**主进程**算好再发给 UI —— 因为要读原文件、
 * 应用改动、算行级 diff，这些渲染进程做不了（它不碰文件系统）。
 */
export interface PermissionPreview {
  kind: 'diff' | 'command' | 'text'
  /** 卡片标题，如「编辑 app.py」。主进程给 key，渲染层按当前语言解析。 */
  title: LocalizedText
  /** 涉及的绝对路径（diff 时） */
  path?: string
  /** diff 内容 */
  lines?: DiffLine[]
  /** Bash 的命令原文 */
  command?: string
  /**
   * 副标题。**两种含义，看 kind**：diff 时是改动统计（`+2 −1`），
   * 命令时是风险提醒（`删除文件且不可恢复`）。
   */
  note?: LocalizedText
  /**
   * 这条操作有真实风险（命中 RISKY 表）。
   *
   * 单独给一个字段而不是让界面从 `note` 里猜 —— 因为 diff 的 note 是
   * 改动统计、命令的 note 才是警告，两者长得一样，猜错了就是把
   * `rm -rf` 当普通改动放行。判断归主进程，界面只管照着渲染。
   */
  danger?: boolean
}

export interface PermissionOption {
  value: string
  label: LocalizedText
  danger?: boolean
}

/* ── AskUserQuestion ─────────────────────────────────────── */

export interface QuestionOption {
  /** 选项正文（CLI 的 label） */
  label: string
  /** 解释这个选项意味着什么 */
  description: string
  /** 可选的预览内容（HTML 片段），目前只原样保留，不渲染 */
  preview?: string
}

/**
 * CLI 的 `AskUserQuestion` 里的一道题。
 *
 * 只保留界面真正需要的字段：CLI 的输入里还有 kind/min/max 等扩展字段，
 * UI 不认它们 —— 归一化在主进程做，渲染层只拿这一份。
 */
export interface Question {
  /** 完整问题，通常以问号结尾 */
  question: string
  /** 很短的标签（≤12 字符），显示成胶囊 */
  header: string
  /** 2–4 个选项；CLI 会自动提供「其他」 */
  options: QuestionOption[]
  /** true = 多选（答案回传数组） */
  multiSelect: boolean
}

export type AgentEvent =
  | {
      t: 'session_started'
      sessionId: string
      provider: string
      model: string
      cwd: string
      tools: string[]
      permissionMode: PermissionMode
    }
  /**
   * 会话的权限模式变了。
   *
   * 由适配器在 CLI 确认后上抛；CLI 自己回落到别的模式（例如 auto 不可用）
   * 也会发。渲染层用它校正右下角的模式胶囊 —— 不能只信用户点选时的乐观值。
   */
  | { t: 'permission_mode_changed'; mode: PermissionMode }
  /**
   * 一轮**真正开始**。
   *
   * 用户发送时可能因为上一轮还在跑而排队；渲染层不能拿「点了发送」当轮次
   * 起点，否则排队期间上一轮的磁盘改动会串到新一轮的修改清单里。
   */
  | { t: 'turn_started' }
  /** 历史回放时用来重建用户气泡；`at` 是 ISO 时间串，空串表示"现在" */
  | { t: 'user_message'; text: string; at: string; images?: ImageAttachment[] }
  | { t: 'text_delta'; text: string }
  | { t: 'thinking_delta'; text: string }
  | { t: 'tool_call'; id: string; name: string; input: unknown }
  /**
   * 一个 tool_use 块**开始**流式生成，入参还没到齐。
   *
   * 开着 `--include-partial-messages` 时，工具入参是一段一段来的：写一个大
   * 文件可能要生成几十秒，完整的 `tool_call`（带 input）要等整个块结束才到。
   * 只等它就等于让界面空着几十秒 —— 所以块一出现就先发这条，让工具卡立刻
   * 画出来；完整入参到达后仍按原来的 `tool_call` 发一次，渲染层按 id 合并。
   *
   * `path` 是从已经流出来的入参里提前认出的文件路径（文件类工具），
   * 用来在生成期间就把文件名显示出来。认不出就不带。
   */
  | { t: 'tool_started'; id: string; name: string; path?: string }
  | {
      t: 'tool_result'
      id: string
      status: ToolStatus
      content: string
      /**
       * 精确的增删行数。来自 CLI 的 `structuredPatch`（Edit/Write 才有）。
       * 折叠行在 tool_call 时先用 input 算一版；这个字段到了之后覆盖它 ——
       * replace_all 到底替换了几处，只有 patch 知道。
       */
      stat?: ToolStat
      /**
       * 这条结果**新建了文件**（CLI 的 `tool_use_result.type === 'create'`）。
       *
       * Write 覆盖已有文件时不会有这个标记。界面上那枚「新」标签只认它 ——
       * 拿工具名去猜（"Write 就是新建"）会把覆盖也算成新建，是假话。
       */
      created?: boolean
      /** 子代理收尾统计。只有 Agent / Task 结果才可能有 */
      agent?: AgentRunInfo
      /** TaskCreate / TaskUpdate 的回执。普通工具没有 */
      task?: TaskResultInfo
    }
  /*
   * CLI 的任务系统事件。子代理在后台跑时，tool_result 只是一条
   * `async_launched` 回执；真正的进度与完成在下面这几类事件里。
   * UI 只消费归一化后的字段，不认识 CLI 的私有形状。
   */
  | {
      t: 'task_started'
      taskId: string
      /** 触发它的 Agent / Task 工具调用 id */
      toolUseId?: string
      description: string
      /**
       * 子代理类型。**没有它就不是子代理** —— 后台 shell / workflow
       * 也会发 task_started，界面把它们单列成「后台任务」。
       */
      agentType?: string
      isBackground?: boolean
      skipTranscript?: boolean
    }
  | {
      t: 'task_progress'
      taskId: string
      toolUseId?: string
      description?: string
      agentType?: string
      totalTokens?: number
      toolUses?: number
      durationMs?: number
      lastToolName?: string
      summary?: string
    }
  | {
      t: 'task_updated'
      taskId: string
      status?: 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'paused'
      description?: string
      endTime?: number
      error?: string
      isBackground?: boolean
    }
  | {
      t: 'task_notification'
      taskId: string
      toolUseId?: string
      status: 'completed' | 'failed' | 'stopped'
      summary: string
      reason?: string
      outputFile?: string
      totalTokens?: number
      toolUses?: number
      durationMs?: number
      skipTranscript?: boolean
    }
  | {
      t: 'permission_request'
      /** 控制协议的 request_id，回执要带回去 */
      id: string
      tool: string
      input: unknown
      preview: PermissionPreview
      options: PermissionOption[]
    }
  /**
   * 模型在向用户提问（AskUserQuestion）。
   *
   * 它不是审批：审批问的是「能不能执行」，提问问的是「选哪个」。
   * 答案通过 `updatedInput.answers` 回给 CLI，审批的 allow/deny 承载不了。
   */
  | {
      t: 'question_request'
      /** 控制协议的 request_id，答复要带回去 */
      id: string
      tool: 'AskUserQuestion'
      /** CLI 原始 input —— 回答时要原样放进 updatedInput */
      input: unknown
      questions: Question[]
      /**
       * 历史回放专用：jsonl 的 toolUseResult 里直接带着答案。
       * 实时流永远没有这两个字段（要等用户回答）。
       */
      answers?: Record<string, string | string[]>
      skipped?: boolean
    }
  /**
   * 一个文件在本轮被改动了。
   *
   * 为什么单独做成事件、而不是继续从工具卡里推：
   *  - 子代理改的文件没有工具卡（sidechain 不进主转写）；
   *  - Bash / MCP / 脚本改的文件根本没有 Edit 工具卡。
   * 两种来源都要进「本轮修改」，所以统一汇到这里。
   *
   * `source` 决定合并方式：
   *  - agent / subagent：每次工具回执累加（同一文件改几次就加几次）；
   *  - disk：轮末磁盘快照兜底。已有工具统计时不覆盖行数 —— git 给的是
   *    对 HEAD 的总 diff，文件在本轮之前就脏的话会把旧改动也算进来。
   */
  | {
      t: 'file_change'
      /** 绝对路径。git 的相对路径由主进程先 resolve 过 */
      path: string
      /** 增删行数。disk 来源在非 git 目录下可能拿不到，就省略 */
      added?: number
      removed?: number
      created?: boolean
      deleted?: boolean
      /** 用 Write 写的（列表里用 ＋ 区分于普通编辑） */
      wrote?: boolean
      source: 'agent' | 'subagent' | 'disk'
    }
  | {
      t: 'turn_end'
      durationMs: number
      usage: Usage
      costUsd?: number
      /** 本轮的步数，状态栏「1 轮 2 步」里的「2 步」 */
      steps: number
    }
  /**
   * CLI 原生指令表。替换语义：收到就整份覆盖上一条。
   *
   * 只有能上报的 provider 才发（Claude 用 initialize 控制请求 /
   * commands_changed）；Codex / dsh 的可执行子集是静态表，由渲染层直接合入。
   */
  | { t: 'native_commands'; commands: NativeCommand[] }
  | { t: 'error'; message: LocalizedText; fatal: boolean }
