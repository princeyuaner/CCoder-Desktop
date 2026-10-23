import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentEvent,
  PermissionMode,
  PermissionOption,
  ToolStatus,
  Usage
} from '../../../shared/events'
import {
  DSH_DEFAULT_MODEL,
  type Channel,
  type ChannelTestResult,
  type EffortLevel
} from '../../../shared/settings'
import type { PermissionDecision, QuestionAnswer, SessionSendInput } from '../../../shared/session'
import type { ToolStat } from '../../../shared/tool'
import { localizeText } from '../../../shared/i18n'
import { mainLocale } from '../../i18n'
import { NdjsonDecoder, parseLine } from '../../ndjson'
import { buildPreview, diffLines } from '../permission-preview'
import type { Provider, ProviderSession, ProviderSessionOptions } from '../types'
import {
  checkDshStatus,
  dshChannelEnv,
  dshHomeForChannel,
  ensureDshHome,
  findDshHomeForSession,
  killDshTree,
  resolveNodeBin,
  spawnDsh
} from './runner'

/**
 * DeepSeek Harness（dsh）的 ACP 适配器。
 *
 * 用 `dsh --profile acp`，不走 Python SDK：
 *  - SDK 只是 `dsh --profile sdk` 的 JSON-RPC 封装；
 *  - SDK 协议没有审批回传、也没有取消方法（文档明确 server→client 请求
 *    “为未来审批预留”，当前从不发送）；
 *  - ACP 面有 `session/request_permission` 和 `session/cancel`，正好对上
 *    我们的 PermissionModal 与“停止”按钮。
 *
 * 实测（dsh 0.2.1-rc.2）确认可用：initialize / session/new / list / resume /
 * set_config_option / close；session/update 与 request_permission 的标准形状
 * 见 ACP v1。
 */

type Obj = Record<string, unknown>

const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {}
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

function clip(s: string, max = 20_000): string {
  return s.length > max ? `${s.slice(0, max)}\n…（输出已截断）` : s
}

/**
 * ACP 的 ToolCallStatus 只表达“这次工具调用有没有跑完”，不表达命令本身
 * 成功与否：PowerShell 的 UnauthorizedAccessException 也会以 completed 收尾。
 * 从输出里的 exit code 兜一层，避免工具卡把失败画成绿色。
 */
export function toolFailed(content: string, rawOutput: unknown): boolean {
  const m = content.match(/\[exit code:\s*(-?\d+)\]/i)
  if (m && Number(m[1]) !== 0) return true

  if (isObj(rawOutput)) {
    const code = rawOutput.exitCode ?? rawOutput.exit_code ?? rawOutput.status
    if (typeof code === 'number' && code !== 0) return true
  }
  if (typeof rawOutput === 'string') {
    const rm = rawOutput.match(/exit code[:\s]+(-?\d+)/i)
    if (rm && Number(rm[1]) !== 0) return true
  }
  return false
}

function safeJson(v: unknown): string {
  if (v === undefined) return ''
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')

/** `deepseek-v4-flash[1m]` → `deepseek-v4-flash`；渠道里的模型名可能带窗口标记 */
function bareModel(s: string): string {
  return s.trim().replace(/\s*\[[^\]]*\]\s*$/, '').trim()
}

/** ACP 的模型值可能是 JSON 元组：`["deepseek-official","deepseek-v4-flash"]` */
function modelOfValue(value: string): string {
  const s = value.trim()
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s) as unknown
      if (Array.isArray(parsed)) {
        const last = parsed[parsed.length - 1]
        if (typeof last === 'string') return bareModel(last)
      }
    } catch {
      // 不是 JSON 就按普通字符串处理
    }
  }
  return bareModel(s)
}

/**
 * dsh 的工具名是小写的（read/write/edit/bash…），而 UI 的
 * toolFamily / 工具卡只认识 Claude 那套 PascalCase。这里做一次归一化，
 * 否则图标、折叠标题、权限预览都会退化。
 */
export function uiToolName(raw: string, kind: string): string {
  const name = raw.trim()
  const key = name.toLowerCase().replace(/[\s-]+/g, '_')
  const MAP: Record<string, string> = {
    read: 'Read',
    write: 'Write',
    edit: 'Edit',
    multi_edit: 'MultiEdit',
    multiedit: 'MultiEdit',
    str_replace_editor: 'Edit',
    apply_patch: 'ApplyPatch',
    bash: 'Bash',
    shell: 'Bash',
    pwsh: 'Bash',
    powershell: 'Bash',
    execute: 'Bash',
    grep: 'Grep',
    glob: 'Glob',
    search: 'Grep',
    web_search: 'WebSearch',
    websearch: 'WebSearch',
    web_fetch: 'WebFetch',
    webfetch: 'WebFetch',
    todo_write: 'TodoWrite',
    todowrite: 'TodoWrite',
    ask_user: 'AskUserQuestion',
    task: 'Task',
    subagent: 'Task',
    agent: 'Task'
  }
  if (MAP[key]) return MAP[key]

  const k = kind.toLowerCase()
  if (k === 'execute') return 'Bash'
  if (k === 'read') return 'Read'
  if (k === 'edit' || k === 'move' || k === 'delete') return 'Edit'
  if (k === 'search') return 'Grep'
  if (k === 'fetch') return 'WebFetch'
  return name || kind || 'tool'
}

/**
 * 把 ACP 的 rawInput 补齐成 permission-preview 认识的形状。
 *
 * 这里全是防御性归一化：不同版本 / 不同工具的字段名不完全一致，
 * 认不出就原样保留，让 buildPreview 退化成“参数展示”，绝不抛错。
 */
export function normalizeToolInput(raw: unknown, locations: Obj[]): Obj {
  const input: Obj = isObj(raw) ? { ...raw } : raw == null ? {} : { value: raw }

  const path =
    str(input.file_path) ||
    str(input.path) ||
    str(input.filePath) ||
    str(locations[0]?.path)
  if (path && !str(input.file_path)) input.file_path = path

  if (!str(input.command) && str(input.cmd)) input.command = str(input.cmd)
  if (!str(input.old_string) && typeof input.oldText === 'string') {
    input.old_string = input.oldText
  }
  if (!str(input.new_string) && typeof input.newText === 'string') {
    input.new_string = input.newText
  }
  return input
}

function pathOf(input: Obj, locations: Obj[]): string {
  return (
    str(input.file_path) ||
    str(input.path) ||
    str(locations[0]?.path)
  )
}

function modelChoices(opt: Obj): { value: string; model: string; name: string }[] {
  const out: { value: string; model: string; name: string }[] = []
  const push = (o: Obj): void => {
    const value = str(o.value)
    if (!value) return
    out.push({ value, model: modelOfValue(value), name: str(o.name) })
  }
  for (const item of arr(opt.options).map(obj)) {
    const nested = arr(item.options).map(obj)
    if (nested.length > 0) nested.forEach(push)
    else push(item)
  }
  return out
}

function selectValues(opt: Obj): string[] {
  const out: string[] = []
  for (const item of arr(opt.options).map(obj)) {
    const nested = arr(item.options).map(obj)
    if (nested.length > 0) {
      for (const n of nested) if (str(n.value)) out.push(str(n.value))
    } else if (str(item.value)) {
      out.push(str(item.value))
    }
  }
  return out
}

function matchModel(
  choices: { value: string; model: string; name: string }[],
  wanted: string
): { value: string; model: string; name: string } | null {
  const w = bareModel(wanted).toLowerCase()
  if (!w) return null
  return (
    choices.find((c) => c.value === wanted) ??
    choices.find((c) => bareModel(c.model).toLowerCase() === w) ??
    choices.find((c) => bareModel(c.name).toLowerCase() === w) ??
    null
  )
}

/** 思考深度 → dsh 的 reasoning_effort 取值。medium 是默认档，不显式覆盖。 */
function dshEffort(effort: EffortLevel): string | null {
  switch (effort) {
    case 'low':
      return 'low'
    case 'medium':
      return null
    case 'high':
      return 'high'
    case 'xhigh':
    case 'max':
    case 'ultra':
      return 'max'
    default:
      return null
  }
}

/**
 * 权限模式 → 宿主侧自动答复。
 *
 * ACP 只有 ask 的请求通道，没有 Claude 那套 --permission-mode 启动参数；
 * 所以“不问”的几档必须在宿主侧代答：
 *  - bypassPermissions / auto / dontAsk：直接允许（依赖 dsh 自己的沙箱约束）；
 *  - plan：直接拒绝所有需要升级的操作，等价于只读；
 *  - acceptEdits：文件编辑放行，命令仍然问；
 *  - standard：全部问。
 */
function autoPermission(
  mode: string,
  tool: string,
  kind: string
): 'allow' | 'deny' | null {
  if (mode === 'bypassPermissions' || mode === 'auto' || mode === 'dontAsk') return 'allow'
  if (mode === 'plan') return 'deny'
  if (mode === 'acceptEdits') {
    const k = kind.toLowerCase()
    if (k === 'edit' || k === 'delete' || k === 'move') return 'allow'
    if (/^(Write|Edit|MultiEdit|ApplyPatch)$/i.test(tool)) return 'allow'
  }
  return null
}

function uiPermissionOptions(tool: string, acpOptions: Obj[]): PermissionOption[] {
  const out: PermissionOption[] = []
  for (const o of acpOptions) {
    const kind = str(o.kind)
    const value =
      kind === 'allow_once'
        ? 'allow'
        : kind === 'allow_always'
          ? 'allow-always'
          : kind === 'reject_once'
            ? 'deny'
            : kind === 'reject_always'
              ? 'deny-always'
              : ''
    if (!value || out.some((x) => x.value === value)) continue
    out.push({
      value,
      label:
        kind === 'allow_once'
          ? '允许'
          : kind === 'allow_always'
            ? `本会话总是允许 ${tool}`
            : kind === 'reject_once'
              ? '拒绝'
              : '本会话总是拒绝',
      ...(kind.startsWith('reject') ? { danger: true } : {})
    })
  }
  // UI 的 PermissionModal 只认这三个 value；缺哪个就补哪个，别让它没按钮可点
  if (!out.some((o) => o.value === 'allow')) out.unshift({ value: 'allow', label: '允许' })
  if (!out.some((o) => o.value === 'deny')) {
    out.push({ value: 'deny', label: '拒绝', danger: true })
  }
  return out
}

/* ── stdio JSON-RPC ──────────────────────────────────────── */

interface DshRpcOptions {
  onNotification: (method: string, params: Obj) => void
  onServerRequest: (id: string | number, method: string, params: Obj) => void
  onExit: (code: number | null, stderr: string) => void
}

/**
 * ACP 的 NDJSON JSON-RPC 客户端。
 *
 * 和 codex-runner 的 CodexRpc 同一套思路：有 id 的是请求，有 method 的是
 * 通知（或服务端请求）；区别是 ACP 的 stdout 只放协议帧，日志走 stderr。
 */
class DshRpc {
  private decoder = new NdjsonDecoder()
  private seq = 0
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }
  >()
  private stderr = ''
  private closed = false
  private disposed = false

  constructor(
    readonly child: ChildProcess,
    private o: DshRpcOptions
  ) {
    this.child.stdin?.on('error', () => undefined)
    this.child.stdout?.on('data', (d: Buffer) => this.onStdout(d.toString()))
    this.child.stderr?.on('data', (d: Buffer) => {
      this.stderr += d.toString()
      if (this.stderr.length > 16_000) this.stderr = this.stderr.slice(-16_000)
    })
    this.child.on('error', (err) => {
      this.failAll(err)
      if (!this.closed) {
        this.closed = true
        this.o.onExit(null, `${this.stderr}${err.message}`)
      }
    })
    this.child.on('close', (code) => {
      try {
        for (const line of this.decoder.flush()) this.onLine(line)
      } catch {
        // 收尾解析失败不改变退出事实
      }
      this.failAll(new Error(`DeepSeek Harness 已退出（${code ?? 'signal'}）`))
      if (!this.closed) {
        this.closed = true
        this.o.onExit(code, this.stderr)
      }
    })
  }

  get stderrText(): string {
    return stripAnsi(this.stderr)
  }

  private onStdout(chunk: string): void {
    try {
      for (const line of this.decoder.push(chunk)) this.onLine(line)
    } catch (e) {
      this.stderr += `\n[parse error] ${e instanceof Error ? e.message : String(e)}`
      if (this.stderr.length > 16_000) this.stderr = this.stderr.slice(-16_000)
    }
  }

  private onLine(line: string): void {
    const msg = parseLine(line)
    if (!msg) return

    const id = msg.id
    const method = typeof msg.method === 'string' ? msg.method : ''
    const params = isObj(msg.params) ? msg.params : {}

    // 服务端请求：有 method 也有 id（ACP 的 session/request_permission）
    if (method && id !== undefined && id !== null) {
      this.o.onServerRequest(id as string | number, method, params)
      return
    }

    // 响应：只有 id
    if (id !== undefined && id !== null) {
      const key = String(id)
      const p = this.pending.get(key)
      if (!p) return
      this.pending.delete(key)
      if (p.timer) clearTimeout(p.timer)
      if (msg.error) {
        const e = obj(msg.error)
        p.reject(new Error(str(e.message) || 'JSON-RPC error'))
      } else {
        p.resolve(msg.result)
      }
      return
    }

    if (method) this.o.onNotification(method, params)
  }

  request<T = Obj>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('DeepSeek Harness 已退出'))
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(String(id))
          reject(new Error(`DeepSeek Harness 请求超时：${method}`))
        }, timeoutMs)
      }
      this.pending.set(String(id), { resolve: (v) => resolve(v as T), reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown = {}): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  respond(id: string | number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result })
  }

  respondError(id: string | number, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  private write(msg: Obj): void {
    if (this.closed || this.disposed) return
    try {
      this.child.stdin?.write(`${JSON.stringify(msg)}\n`)
    } catch {
      // 子进程已退，close 事件会收尾
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.failAll(new Error('DeepSeek Harness 已关闭'))
    try {
      this.child.stdin?.end()
    } catch {
      // ignore
    }
    killDshTree(this.child)
  }
}

/* ── 会话 ────────────────────────────────────────────────── */

interface ToolState {
  rawName: string
  uiName: string
  kind: string
  input: Obj
  inputJson: string
  locations: Obj[]
  firstPath?: string
  finished: boolean
}

interface DshFileChange {
  path: string
  added?: number
  removed?: number
  created?: boolean
  deleted?: boolean
  wrote?: boolean
}

interface DshUsage {
  used: number
  size: number
  cost?: { amount: number; currency: string }
}

class DshSession implements ProviderSession {
  private rpc: DshRpc
  private ready: Promise<void>
  private sessionId = ''
  private configOptions: Obj[] = []
  private effectiveModel = ''
  private imageSupported = false
  private usage: DshUsage | null = null
  private turnSeq = 0
  /** 状态栏的 steps 由 session-manager 用 tool_call 计数覆盖；这里只保留本地值 */
  private turnSteps = 0
  private toolStates = new Map<string, ToolState>()
  private deniedTools = new Set<string>()
  private pendingPermissions = new Map<
    string,
    { rpcId: string | number; options: Obj[]; toolCallId: string }
  >()
  private warnedImages = false
  private done = false
  private exited = false
  private disposed = false

  constructor(private o: ProviderSessionOptions) {
    /*
     * resume 必须回到写这条会话的那个 home；新会话则用渠道自己的 home。
     * 渠道 home 里没有 `.credentials.yaml`，dsh 才会真正采用我们注入的
     * DEEPSEEK_API_KEY —— 共享 `~/.dsh` 里的同名凭据会把它顶掉。
     */
    const home = o.dshHome?.trim()
      ? ensureDshHome(o.dshHome)
      : findDshHomeForSession(o.resumeId) ?? dshHomeForChannel(o.channel)
    const child = spawnDsh(['--profile', 'acp'], {
      cwd: o.cwd,
      env: { ...dshChannelEnv(o.channel), DSH_HOME: home },
      dshHome: home
    })

    this.rpc = new DshRpc(child, {
      onNotification: (m, p) => this.onNotification(m, p),
      onServerRequest: (id, m, p) => this.onServerRequest(id, m, p),
      onExit: (code, stderr) => this.onRpcExit(code, stderr)
    })

    // 初始化失败不能变成未处理的 Promise rejection —— 主进程会被带走
    this.ready = this.init().catch((e) => this.fatal(e))
  }

  private async init(): Promise<void> {
    const init = await this.rpc.request<Obj>(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false
        }
      },
      30_000
    )
    const caps = obj(obj(init).agentCapabilities)
    this.imageSupported = obj(caps.promptCapabilities).image === true

    const restored = this.o.resumeId
      ? await this.rpc.request<Obj>(
          'session/resume',
          { sessionId: this.o.resumeId, cwd: this.o.cwd, mcpServers: [] },
          60_000
        )
      : await this.rpc.request<Obj>(
          'session/new',
          { cwd: this.o.cwd, mcpServers: [] },
          60_000
        )

    this.sessionId = this.o.resumeId ?? str(obj(restored).sessionId)
    if (!this.sessionId) throw new Error('session/new 没有返回 sessionId')
    this.configOptions = arr(obj(restored).configOptions).map(obj)

    // 顺序很关键：dsh 切换模型会把 reasoning_effort 重置为模型默认值
    await this.applyModel()
    await this.applyEffort()

    this.emit({
      t: 'session_started',
      sessionId: this.sessionId,
      provider: 'dsh',
      model: this.effectiveModel || bareModel(this.o.model),
      cwd: this.o.cwd,
      tools: [],
      permissionMode: this.o.permissionMode as PermissionMode
    })
  }

  send(input: SessionSendInput): void {
    if (this.done || this.disposed) return
    this.ready.then(() => this.prompt(input)).catch(() => undefined)
  }

  respondPermission(requestId: string, decision: PermissionDecision): void {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return
    this.pendingPermissions.delete(requestId)
    this.answerPermission(pending.rpcId, pending.options, decision, pending.toolCallId)
  }

  /**
   * ACP 的 acp profile 明确不提供 elicitation（AskUserQuestion 的等价物），
   * 所以这里不会收到提问请求；留一个空实现满足 ProviderSession 契约。
   */
  respondQuestion(_requestId: string, _answer: QuestionAnswer): void {
    // 不支持的界面：dsh 的 ACP 服务器刻意省略了 elicitation
  }

  interrupt(): void {
    if (!this.sessionId || this.done) return
    // session/cancel 是通知，不是请求，没有响应
    this.rpc.notify('session/cancel', { sessionId: this.sessionId })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pendingPermissions.clear()

    const sid = this.sessionId
    if (!sid) {
      this.rpc.dispose()
      return
    }

    // 先请求 session/close（让 dsh flush 持久化），再强制收进程
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      this.rpc.dispose()
    }
    this.rpc
      .request('session/close', { sessionId: sid }, 1_500)
      .catch(() => undefined)
      .finally(finish)
    const t = setTimeout(finish, 2_000)
    t.unref?.()
  }

  /* ── 初始化 / 配置 ─────────────────────────────────────── */

  private findConfig(match: string): Obj | null {
    return (
      this.configOptions.find((c) => str(c.id) === match || str(c.category) === match) ??
      null
    )
  }

  private async setConfig(configId: string, value: string): Promise<Obj[]> {
    const res = await this.rpc.request<Obj>(
      'session/set_config_option',
      { sessionId: this.sessionId, configId, value },
      30_000
    )
    return arr(res.configOptions).map(obj)
  }

  private async applyModel(): Promise<void> {
    const opt = this.findConfig('model')
    const wanted = this.o.model.trim()
    if (!opt) {
      this.effectiveModel = bareModel(wanted)
      return
    }

    const current = str(opt.currentValue)
    const choice = wanted ? matchModel(modelChoices(opt), wanted) : null
    if (wanted && !choice) {
      this.note(
        `DeepSeek Harness 没有模型「${wanted}」，继续使用 ${modelOfValue(current) || '默认模型'}。`
      )
    } else if (choice && choice.value !== current) {
      const next = await this.setConfig('model', choice.value)
      if (next.length > 0) this.configOptions = next
      else this.note(`切换模型失败：DeepSeek Harness 没有接受「${choice.model}」。`)
    }

    const now = this.findConfig('model')
    this.effectiveModel =
      modelOfValue(str(now?.currentValue)) || choice?.model || bareModel(wanted)
  }

  private async applyEffort(): Promise<void> {
    const opt = this.findConfig('thought_level') ?? this.findConfig('reasoning_effort')
    if (!opt) return
    const target = dshEffort(this.o.effort)
    if (!target) return // medium：保持 dsh 默认档

    const values = selectValues(opt)
    if (values.length > 0 && !values.includes(target)) {
      this.note(
        `DeepSeek Harness 不支持思考深度「${this.o.effort}」（可选：${values.join(' / ')}）。`
      )
      return
    }
    if (str(opt.currentValue) === target) return

    const next = await this.setConfig(str(opt.id) || 'reasoning_effort', target)
    if (next.length > 0) this.configOptions = next
  }

  /* ── 发送 / 轮次 ───────────────────────────────────────── */

  private buildPrompt(input: SessionSendInput): Obj[] {
    const blocks: Obj[] = []
    const text = input.text.trim()
    if (text) blocks.push({ type: 'text', text })

    for (const img of input.images ?? []) {
      if (!img.data) continue
      if (!this.imageSupported) {
        if (!this.warnedImages) {
          this.warnedImages = true
          this.note('DeepSeek Harness 的 ACP 接口当前不支持图片，已忽略随消息发送的图片。')
        }
        continue
      }
      blocks.push({ type: 'image', data: img.data, mimeType: img.mediaType })
    }

    if (blocks.length === 0) this.note('消息内容为空，未发送。')
    return blocks
  }

  private async prompt(input: SessionSendInput): Promise<void> {
    if (this.done || this.disposed) return
    const blocks = this.buildPrompt(input)
    if (blocks.length === 0) return

    const seq = ++this.turnSeq
    const started = Date.now()
    this.turnSteps = 0
    this.usage = null

    // prompt 的任期可能很长；不设超时，靠 session/cancel 或进程退出收尾
    this.rpc
      .request<Obj>('session/prompt', { sessionId: this.sessionId, prompt: blocks }, 0)
      .then(() => this.finishTurn(seq, started))
      .catch((e) => {
        if (this.done || this.disposed || seq !== this.turnSeq) return
        this.note(`DeepSeek Harness 轮次失败：${e instanceof Error ? e.message : String(e)}`)
        this.finishTurn(seq, started)
      })
  }

  private finishTurn(seq: number, started: number): void {
    if (this.done || this.disposed || seq !== this.turnSeq) return

    const u = this.usage
    const usage: Usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0
    }
    if (u) {
      usage.contextTokens = u.used
      if (u.size > 0) usage.contextPercent = Math.round((u.used / u.size) * 100)
    }
    const costUsd = u?.cost && u.cost.currency === 'USD' ? u.cost.amount : undefined

    this.emit({
      t: 'turn_end',
      durationMs: Date.now() - started,
      usage,
      ...(costUsd !== undefined ? { costUsd } : {}),
      steps: this.turnSteps
    })
  }

  /* ── 审批 ──────────────────────────────────────────────── */

  private onServerRequest(id: string | number, method: string, params: Obj): void {
    if (method === 'session/request_permission') {
      this.handlePermission(id, params)
      return
    }
    // 我们没声明 fs / terminal / elicitation 能力，理论上不会走到这里；
    // 真来了必须明确回绝，否则 dsh 会一直等。
    this.rpc.respondError(id, -32601, `不支持的 ACP 请求：${method}`)
  }

  private handlePermission(id: string | number, params: Obj): void {
    if (this.sessionId && str(params.sessionId) !== this.sessionId) {
      this.rpc.respond(id, { outcome: { outcome: 'cancelled' } })
      return
    }

    const toolCall = obj(params.toolCall)
    const options = arr(params.options).map(obj)
    const toolCallId = str(toolCall.toolCallId)
    const rawName = str(toolCall.name) || str(toolCall.title)
    const kind = str(toolCall.kind)
    const tool = uiToolName(rawName, kind)
    const locations = arr(toolCall.locations).map(obj)
    const input = normalizeToolInput(toolCall.rawInput, locations)

    const auto = autoPermission(this.o.permissionMode, tool, kind)
    if (auto) {
      this.answerPermission(id, options, { behavior: auto }, toolCallId)
      return
    }

    const key = String(id)
    this.pendingPermissions.set(key, { rpcId: id, options, toolCallId })
    this.emit({
      t: 'permission_request',
      id: key,
      tool,
      input,
      preview: buildPreview(tool, input, this.o.cwd),
      options: uiPermissionOptions(tool, options)
    })
  }

  private answerPermission(
    id: string | number,
    options: Obj[],
    decision: PermissionDecision,
    toolCallId: string
  ): void {
    const allow = decision.behavior === 'allow'
    const order = allow
      ? decision.always
        ? ['allow_always', 'allow_once']
        : ['allow_once', 'allow_always']
      : decision.always
        ? ['reject_always', 'reject_once']
        : ['reject_once', 'reject_always']

    const pick = order
      .map((k) => options.find((o) => str(o.kind) === k))
      .find((v): v is Obj => !!v)

    if (pick) {
      this.rpc.respond(id, {
        outcome: { outcome: 'selected', optionId: str(pick.optionId) }
      })
      if (!allow && toolCallId) this.deniedTools.add(toolCallId)
      return
    }

    // 没有匹配的选项：按“取消”回，宁可失败也不默认放行
    this.rpc.respond(id, { outcome: { outcome: 'cancelled' } })
    if (!allow && toolCallId) this.deniedTools.add(toolCallId)
  }

  /* ── 事件翻译 ──────────────────────────────────────────── */

  private onNotification(method: string, params: Obj): void {
    if (method !== 'session/update') return
    if (this.sessionId && str(params.sessionId) !== this.sessionId) return

    const update = obj(params.update)
    const kind = str(update.sessionUpdate)

    switch (kind) {
      case 'agent_message_chunk': {
        const content = obj(update.content)
        if (str(content.type) === 'text') {
          this.emit({ t: 'text_delta', text: str(content.text) })
        }
        return
      }
      case 'agent_thought_chunk': {
        const content = obj(update.content)
        if (str(content.type) === 'text') {
          this.emit({ t: 'thinking_delta', text: str(content.text) })
        }
        return
      }
      case 'tool_call':
        this.onToolCall(update)
        return
      case 'tool_call_update':
        this.onToolCallUpdate(update)
        return
      case 'usage_update': {
        const cost = obj(update.cost)
        this.usage = {
          used: num(update.used),
          size: num(update.size),
          ...(Object.keys(cost).length > 0
            ? { cost: { amount: num(cost.amount), currency: str(cost.currency) } }
            : {})
        }
        return
      }
      case 'config_option_update':
        this.configOptions = arr(update.configOptions).map(obj)
        return
      case 'session_info_update':
        // 标题留给历史/侧栏那条线，实时转写不需要
        return
      case 'notice': {
        const text = str(update.message) || str(update.text)
        if (text && str(update.severity) === 'error') this.note(text)
        return
      }
      default:
        // plan / compaction / available_commands 等：ACP 自动化面不提供，
        // 或者暂时没有对应的归一化事件。安静忽略，别污染转写。
        return
    }
  }

  private onToolCall(update: Obj): void {
    const id = str(update.toolCallId)
    if (!id) return

    const prev = this.toolStates.get(id)
    const rawName = str(update.name) || str(update.title) || prev?.rawName || 'tool'
    const kind = str(update.kind) || prev?.kind || ''
    const uiName = prev?.uiName || uiToolName(rawName, kind)
    const locations = arr(update.locations).map(obj)
    const locs = locations.length > 0 ? locations : (prev?.locations ?? [])
    const input =
      update.rawInput !== undefined
        ? normalizeToolInput(update.rawInput, locs)
        : (prev?.input ?? {})
    const inputJson = safeJson(input)

    const state: ToolState = {
      rawName,
      uiName,
      kind,
      input,
      inputJson,
      locations: locs,
      firstPath: prev?.firstPath,
      finished: prev?.finished ?? false
    }
    this.toolStates.set(id, state)

    if (!prev) {
      this.turnSteps += 1
      const path = pathOf(input, locs)
      this.emit({ t: 'tool_started', id, name: uiName, ...(path ? { path } : {}) })
    }
    if (!prev || inputJson !== prev.inputJson) {
      this.emit({ t: 'tool_call', id, name: uiName, input })
    }

    const status = str(update.status)
    if (!state.finished && (status === 'completed' || status === 'failed')) {
      this.finishTool(id, update)
    }
  }

  private onToolCallUpdate(update: Obj): void {
    const id = str(update.toolCallId)
    if (!id) return

    // 有些 agent 先发 update；先按 tool_call 建卡，再走合并
    if (!this.toolStates.has(id)) this.onToolCall({ ...update, toolCallId: id })
    const prev = this.toolStates.get(id)
    if (!prev) return

    const rawName = str(update.name) || str(update.title) || prev.rawName
    const kind = str(update.kind) || prev.kind
    const uiName = prev.uiName || uiToolName(rawName, kind)
    const locations = arr(update.locations).map(obj)
    const locs = locations.length > 0 ? locations : prev.locations
    const input =
      update.rawInput !== undefined
        ? normalizeToolInput(update.rawInput, locs)
        : prev.input
    const inputJson = safeJson(input)

    const state: ToolState = {
      rawName,
      uiName,
      kind,
      input,
      inputJson,
      locations: locs,
      firstPath: prev.firstPath,
      finished: prev.finished
    }
    this.toolStates.set(id, state)

    if (update.rawInput !== undefined && inputJson !== prev.inputJson) {
      this.emit({ t: 'tool_call', id, name: uiName, input })
    }

    const status = str(update.status)
    if (!state.finished && (status === 'completed' || status === 'failed')) {
      this.finishTool(id, update)
    }
  }

  private finishTool(id: string, update: Obj): void {
    const state = this.toolStates.get(id)
    if (!state || state.finished) return
    state.finished = true

    const acpStatus = str(update.status) || 'completed'
    const denied = this.deniedTools.has(id)
    const { content, stat, created, files } = this.readToolOutput(update, state)
    // ACP 说 completed 不代表命令成功（沙箱拒绝也会走 completed），
    // 再从输出里的 exit code 判一次
    const failed = acpStatus === 'failed' || toolFailed(content, update.rawOutput)
    const status: ToolStatus = denied ? 'denied' : failed ? 'error' : 'ok'

    this.emit({
      t: 'tool_result',
      id,
      status,
      content,
      ...(stat ? { stat } : {}),
      ...(created ? { created: true } : {})
    })

    for (const f of files) {
      this.emit({ t: 'file_change', ...f, source: 'agent' })
    }
  }

  private readToolOutput(
    update: Obj,
    state: ToolState
  ): { content: string; stat?: ToolStat; created: boolean; files: DshFileChange[] } {
    const parts: string[] = []
    const files: DshFileChange[] = []
    let added = 0
    let removed = 0
    let hasStat = false
    let created = false

    for (const item of arr(update.content).map(obj)) {
      const type = str(item.type)
      if (type === 'content') {
        const content = obj(item.content)
        if (str(content.type) === 'text') parts.push(str(content.text))
        else if (str(content.type) === 'image') parts.push('[图片]')
        else parts.push(safeJson(content))
        continue
      }
      if (type === 'diff') {
        const path = str(item.path)
        const oldText = item.oldText == null ? null : str(item.oldText)
        const newText = str(item.newText)
        const lines = diffLines(oldText ?? '', newText)
        const a = lines.filter((l) => l.kind === 'add').length
        const r = lines.filter((l) => l.kind === 'del').length
        added += a
        removed += r
        hasStat = true
        const isNew = item.oldText == null
        if (isNew) created = true
        if (path) {
          files.push({
            path,
            added: a,
            removed: r,
            ...(isNew ? { created: true } : {}),
            ...(state.uiName === 'Write' ? { wrote: true } : {})
          })
        }
        parts.push(`修改 ${path || '(未知文件)'}`)
        continue
      }
      if (type === 'terminal') {
        parts.push(`终端输出（${str(item.terminalId)}）`)
      }
    }

    // 有些工具只给 rawOutput，不给 content
    if (parts.length === 0 && update.rawOutput !== undefined) {
      parts.push(
        typeof update.rawOutput === 'string'
          ? update.rawOutput
          : safeJson(update.rawOutput)
      )
    }

    // 没有 diff 内容、但有 locations（move/delete 等）：至少把文件列进本轮修改
    if (
      files.length === 0 &&
      state.locations.length > 0 &&
      state.kind !== 'read' &&
      state.kind !== 'search' &&
      state.kind !== 'think'
    ) {
      for (const loc of state.locations) {
        const path = str(loc.path)
        if (!path) continue
        files.push({
          path,
          ...(state.kind === 'delete' ? { deleted: true } : {}),
          ...(state.uiName === 'Write' ? { wrote: true } : {})
        })
      }
    }

    const fallback = str(update.status) === 'failed' ? '执行失败' : '完成'
    return {
      content: clip(parts.filter(Boolean).join('\n') || fallback),
      stat: hasStat ? { added, removed } : undefined,
      created,
      files
    }
  }

  /* ── 收尾 ──────────────────────────────────────────────── */

  private emit(event: AgentEvent): void {
    if (this.done) return
    this.o.onEvent(event)
  }

  private note(message: string): void {
    this.emit({ t: 'error', message, fatal: false })
  }

  private fatal(e: unknown): void {
    if (this.exited) return
    this.exited = true
    this.done = true
    const message = e instanceof Error ? e.message : String(e)
    this.o.onEvent({
      t: 'error',
      message: `DeepSeek Harness 启动失败：${message}`,
      fatal: true
    })
    this.o.onExit(null, this.rpc.stderrText || message)
  }

  private onRpcExit(code: number | null, stderr: string): void {
    if (this.exited) return
    this.exited = true
    this.done = true
    this.pendingPermissions.clear()
    this.o.onExit(code, stripAnsi(stderr))
  }
}

export class DshProvider implements Provider {
  id = 'dsh'

  async detect(): Promise<{ installed: boolean; path: string }> {
    const status = checkDshStatus()
    return { installed: status.installed && status.nodeOk, path: status.path }
  }

  start(o: ProviderSessionOptions): ProviderSession {
    return new DshSession(o)
  }
}

/**
 * 渠道连通性测试：起一个临时 ACP 会话，发一句 ping，等 turn_end。
 *
 * 走完整的 `dsh --profile acp` 链路（含 dshChannelEnv 注入），所以它验证的
 * 是"这个渠道真的能出字"，不是"二进制存在"。临时 workspace 用完即删；
 * DSH_HOME 用用户自己的（`~/.dsh` 优先），这样没填渠道时也能用终端里
 * 已经配好的 Harness 凭据。
 */
export async function testDshChannel(channel: Channel): Promise<ChannelTestResult> {
  const started = Date.now()
  const ws = mkdtempSync(join(tmpdir(), 'ccoder-dsh-test-'))
  const provider = new DshProvider()
  // 用对象包一层：Promise executor 里的赋值不会被 TypeScript 的控制流分析
  // 视为对外层变量生效，直接写 `let session` 会在 finally 里被收窄成 never。
  const holder: { session: ProviderSession | null } = { session: null }

  try {
    const message = await new Promise<string>((resolve, reject) => {
      let text = ''
      let sent = false
      const timer = setTimeout(
        () => reject(new Error('60 秒内没有返回（模型或端点没有响应）')),
        60_000
      )

      holder.session = provider.start({
        channel,
        cwd: ws,
        model: channel.model.trim() || DSH_DEFAULT_MODEL,
        // 测试不要卡在审批上；临时目录里的东西跑完就删
        permissionMode: 'bypassPermissions',
        effort: 'high',
        addDirs: [],
        resumeId: null,
        // 不传 dshHome：走渠道自己的 home，测的就是真实会话会用的那个目录
        onEvent: (e) => {
          if (e.t === 'session_started' && !sent) {
            sent = true
            holder.session?.send({ text: 'ping' })
            return
          }
          if (e.t === 'text_delta') {
            text += e.text
            return
          }
          if (e.t === 'turn_end') {
            clearTimeout(timer)
            resolve(text.trim() || '连接正常')
            return
          }
          if (e.t === 'error' && e.fatal) {
            clearTimeout(timer)
            reject(new Error(localizeText(mainLocale(), e.message)))
          }
        },
        onExit: (code, stderr) => {
          clearTimeout(timer)
          reject(
            new Error(
              `dsh 在测试期间退出（${code ?? 'signal'}）` +
                (stderr ? `\n${stderr.slice(-400)}` : '')
            )
          )
        }
      })
    })

    return { ok: true, message, latencyMs: Date.now() - started }
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
      latencyMs: Date.now() - started
    }
  } finally {
    holder.session?.dispose()
    // dispose 会先请求 session/close；等它 flush 完再清临时目录
    const t = setTimeout(() => {
      try {
        rmSync(ws, { recursive: true, force: true })
      } catch {
        // 目录被占用就留给系统临时目录清理
      }
    }, 3_000)
    t.unref?.()
  }
}

/** 给 verify 脚本 / 设置页用：不启动会话，只看安装状态 */
export { checkDshStatus, resolveNodeBin }
