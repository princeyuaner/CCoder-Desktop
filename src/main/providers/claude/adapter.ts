import type { ChildProcess } from 'node:child_process'
import { t } from '../../i18n'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EffortLevel } from '../../../shared/settings'
import type { RuntimeMcpServer } from '../../../shared/mcp'
import type { PermissionDecision, QuestionAnswer, SessionSendInput } from '../../../shared/session'
import { channelToEnv } from '../../channel-env'
import { resolveClaudeBin, spawnClaude } from '../../claude-runner'
import { NdjsonDecoder, parseLine } from '../../ndjson'
import type { Provider, ProviderSession, ProviderSessionOptions } from '../types'
import { parseControlRequest } from './control'
import { claudeCommands } from './commands'
import { ClaudeStreamTranslator, normalizePermissionMode } from './stream-json'

/**
 * 我们自己的权限模式名 → CLI 的 `--permission-mode` 取值。
 *
 * 现在有了权限宿主，'standard' 终于可以映射成 'manual' —— 也就是
 * "每个要动你机器的动作都先问你"，这才是"标准模式"该有的语义。
 * （M1 时没有宿主，只能不传，结果被 CLI 自己的 auto 配置接管了。）
 */
const CLI_MODE: Record<string, string | null> = {
  standard: 'manual',
  acceptEdits: 'acceptEdits',
  auto: 'auto',
  plan: 'plan',
  dontAsk: 'dontAsk',
  bypassPermissions: 'bypassPermissions'
}

export function buildClaudeArgs(o: {
  model: string
  permissionMode: string
  effort?: EffortLevel
  addDirs: string[]
  resumeId?: string | null
  /**
   * 官方登录模式。此时**不加载用户级 settings.json** —— 用户全局那套
   * ANTHROPIC_BASE_URL / AUTH_TOKEN 会盖过官方 OAuth 凭据，让"官方登录"
   * 名不副实。项目级 / local 配置仍然生效。
   */
  official?: boolean
  /** CCoder 托管的 MCP 配置临时文件；null = 不额外加载 */
  mcpConfigPath?: string | null
}): string[] {
  const args = [
    '-p',
    // 长驻模式：stdin 是 NDJSON 消息流，不是一段裸文本
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    // 关键：把审批请求交给我们（host），而不是没人应答地自动拒绝
    '--permission-prompts',
    'host',
    // 把 AskUserQuestion 也暴露给模型。
    // 只传 --permission-prompts host 时，CLI 2.1.x 会把 AskUserQuestion 从
    // 工具表里拿掉（非交互会话没有能答题的 UI）；这个隐藏参数告诉它
    // 「权限走 stdio，宿主会接」，工具才会出现。
    '--permission-prompt-tool',
    'stdio',
    /*
     * 让 bypassPermissions 成为**可选项**，但不默认启用。
     *
     * 少了这一条，运行中的会话切到「跳过权限」会被 CLI 拒绝
     * （bypass_not_launched）—— 用户只能通过重启进程来绕过，而正在跑的
     * 子代理会跟着一起没。默认模式仍然由 --permission-mode 决定。
     */
    '--allow-dangerously-skip-permissions'
  ]

  if (o.model.trim()) args.push('--model', o.model.trim())

  // 思考深度。**medium 不传**：那是 CLI 的默认档，显式传一遍等于把
  // "没动过设置"的用户也推进新参数里 —— 万一他的 CLI 版本还不认
  // `--effort`，本来好端端的会话就全崩了。只有真选过别的档才加这个参数。
  // ultra 是 Codex 专属档，绝不能传给 Claude。
  if (o.effort && o.effort !== 'medium' && o.effort !== 'ultra') {
    args.push('--effort', o.effort)
  }

  // 接着已有会话跑。cwd 必须和原会话一致，否则 CLI 找不到那份记录。
  if (o.resumeId) args.push('--resume', o.resumeId)

  // 官方登录：绕开 ~/.claude/settings.json 里的全局 provider env。
  // 只保留项目级 / local 配置（MCP、hooks 等仍按目录生效）。
  if (o.official) args.push('--setting-sources', 'project,local')

  if (o.mcpConfigPath) args.push('--mcp-config', o.mcpConfigPath)

  const mode = CLI_MODE[o.permissionMode]
  if (mode) args.push('--permission-mode', mode)

  for (const d of o.addDirs) {
    if (d.trim()) args.push('--add-dir', d.trim())
  }
  return args
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * 渲染层的一条消息 → CLI 的 stream-json user 记录。
 *
 * 文本和图片可以同时存在；图片按 Anthropic 的 image content block 形状
 * 放进同一个 content 数组。抽成纯函数是为了 verify 脚本能直接断言结构，
 * 不用起进程。
 */
export function buildUserMessage(input: SessionSendInput): unknown {
  const content: unknown[] = []
  const text = input.text.trim()
  if (text) content.push({ type: 'text', text })

  for (const img of input.images ?? []) {
    if (!img.data) continue
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mediaType,
        data: img.data
      }
    })
  }

  return { type: 'user', message: { role: 'user', content } }
}

/**
 * 一个长驻的 claude 会话进程。
 *
 * 与 M1 的"每轮一个进程"相比，这里多出来的能力全在 stdin 上：
 * 除了用户消息，还要能回 control_response（审批答复）。
 * 而 stdout 上除了事件，还会来 control_request（审批请求）。
 */
/** 把 CCoder 的运行时结构转成 Claude `--mcp-config` 认的 JSON 形状 */
export function buildClaudeMcpConfig(servers: RuntimeMcpServer[]): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {}
  for (const s of servers) {
    if (s.transport === 'stdio') {
      mcpServers[s.name] = {
        type: 'stdio',
        command: s.command,
        args: s.args,
        ...(Object.keys(s.env).length ? { env: s.env } : {})
      }
    } else {
      mcpServers[s.name] = {
        type: s.transport,
        url: s.url,
        ...(Object.keys(s.headers).length ? { headers: s.headers } : {})
      }
    }
  }
  return { mcpServers }
}

class ClaudeSession implements ProviderSession {
  private child: ChildProcess
  private decoder = new NdjsonDecoder()
  private translator = new ClaudeStreamTranslator()
  private stderr = ''
  private done = false
  private reqSeq = 0
  /** initialize 控制请求的 id；响应里带完整 slash 指令表 */
  private cmdReqId = ''
  /** 最近一次拿到的原始指令数组；init 到达后用它重新映射分组 */
  private rawCommands: unknown[] = []
  /** `--mcp-config` 的临时目录；进程退出后删掉，别把 token 留在 temp */
  private mcpDir = ''
  /**
   * 当前**实际生效**的权限模式（我们自己的名字）。
   *
   * 运行中切换走 control_request，CLI 可能拒绝（bypass 未授权、auto 不可用
   * 等）。所以不能拿界面上的乐观值当真 —— 只有回执成功才更新这里。
   */
  private permissionMode: string
  /** 等待 CLI 回执的权限模式切换：request_id → 要切到的模式 */
  private pendingModes = new Map<string, string>()
  /**
   * 待回答的提问：request_id → CLI 原始 input。
   *
   * 回答时要把它原样放进 `updatedInput`，再带上 answers —— CLI 用
   * updatedInput **替换**整个工具入参，只给 answers 会把 questions 弄丢。
   */
  private questionInputs = new Map<string, unknown>()

  constructor(private o: ProviderSessionOptions) {
    this.permissionMode = o.permissionMode

    let mcpConfigPath: string | null = null
    if (o.mcpServers.length > 0) {
      try {
        this.mcpDir = mkdtempSync(join(tmpdir(), 'ccoder-mcp-'))
        mcpConfigPath = join(this.mcpDir, 'mcp.json')
        writeFileSync(
          mcpConfigPath,
          JSON.stringify(buildClaudeMcpConfig(o.mcpServers), null, 2),
          { encoding: 'utf8', mode: 0o600 }
        )
      } catch (e) {
        this.cleanupMcpConfig()
        // MCP 配置写不出来不该拖垮整个会话；CLI 仍然能按原生配置启动
        o.onEvent({
          t: 'error',
          message: t('claudeAdapter.mcpConfigFailed', {
            detail: e instanceof Error ? e.message : String(e)
          }),
          fatal: false
        })
        mcpConfigPath = null
      }
    }

    const args = buildClaudeArgs({
      model: o.model,
      permissionMode: o.permissionMode,
      effort: o.effort,
      addDirs: o.addDirs,
      resumeId: o.resumeId,
      // channel 为 null = 官方登录
      official: !o.channel,
      mcpConfigPath
    })

    // channel 为 null = 官方登录：不注入渠道环境，也不加
    // CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST，让 CLI 用自己保存的 OAuth 凭据。
    this.child = spawnClaude(args, {
      env: o.channel ? channelToEnv(o.channel) : {},
      cwd: o.cwd,
      providerManaged: !!o.channel
    })

    /*
     * 子进程先退出时，stdin 上的写入会异步抛 EPIPE。没有 error 监听时
     * 这是**未捕获的流错误**，会把整个主进程带走 —— 表现就是应用闪退。
     * 退出本身由下面的 close 事件收尾，这里只需吞掉这条竞态错误。
     */
    this.child.stdin?.on('error', () => undefined)

    this.child.stdout?.on('data', (d: Buffer) => {
      try {
        this.onStdout(d.toString())
      } catch (e) {
        // CLI 输出不可信；解析失败最多丢一条事件，不能让它杀掉主进程
        if (this.done) return
        this.o.onEvent({
          t: 'error',
          message: t('claudeAdapter.parseFailed', {
            detail: e instanceof Error ? e.message : String(e)
          }),
          fatal: false
        })
      }
    })
    this.child.stderr?.on('data', (d: Buffer) => {
      this.stderr += d.toString()
      if (this.stderr.length > 8000) this.stderr = this.stderr.slice(-8000)
    })

    this.child.on('error', (err) => {
      if (this.done) return
      this.done = true
      this.cleanupMcpConfig()
      o.onEvent({ t: 'error', message: err.message, fatal: true })
      o.onExit(null, `${this.stderr}${err.message}`)
    })

    this.child.on('close', (code) => {
      if (this.done) return
      this.done = true
      this.cleanupMcpConfig()
      try {
        for (const line of this.decoder.flush()) this.handleLine(line)
      } catch {
        // 收尾时的解析错误不改变退出事实，交给 onExit 报给会话
      }
      o.onExit(code, this.stderr)
    })

    /*
     * 顺手问一次指令表。SDK 的 initialize 控制请求会返回完整 commands；
     * 必须等 stdout 监听挂好再写，几分钟前的老 CLI 也可能立刻回。
     */
    this.cmdReqId = `host-cmds-${++this.reqSeq}`
    this.write({
      type: 'control_request',
      request_id: this.cmdReqId,
      request: { subtype: 'initialize' }
    })
  }

  private cleanupMcpConfig(): void {
    if (!this.mcpDir) return
    const dir = this.mcpDir
    this.mcpDir = ''
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // temp 目录被系统清理掉也无所谓
    }
  }

  send(input: SessionSendInput): void {
    this.write(buildUserMessage(input))
  }

  respondPermission(requestId: string, decision: PermissionDecision): void {
    const response =
      decision.behavior === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: decision.message ?? t('permission.userDenied') }

    this.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response }
    })
  }

  /**
   * 运行中切换权限模式。
   *
   * CLI 的 toolPermissionContext 是活的状态；子代理每次做权限判断都会
   * 重新读它，所以这条请求能影响**已经在跑的子代理**，不需要换进程。
   * 回执里的 mode 才是实际生效值（例如 manual 会回成 default）。
   */
  setPermissionMode(mode: string): void {
    if (mode === this.permissionMode) return
    const cliMode = CLI_MODE[mode]
    if (!cliMode) return

    const requestId = `host-mode-${++this.reqSeq}`
    this.pendingModes.set(requestId, mode)
    this.write({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'set_permission_mode', mode: cliMode }
    })
  }

  /**
   * 回答 AskUserQuestion。
   *
   * CLI 侧的入口是普通 can_use_tool：`allow` 放行后工具会读入参里的
   * `answers`（实测 2.1.303）。所以不是另起一套协议，而是 allow +
   * updatedInput —— 这和修改工具入参是同一条通路。
   */
  respondQuestion(requestId: string, answer: QuestionAnswer): void {
    // 已经答过 / 进程重启后丢掉的请求，直接忽略。
    // 不这么挡的话，双击「提交」会用空 input 回第二次，把 questions 覆盖掉。
    if (!this.questionInputs.has(requestId)) return
    const input = this.questionInputs.get(requestId)
    this.questionInputs.delete(requestId)

    const response = answer.skipped
      ? { behavior: 'deny' as const, message: t('permission.userSkipped') }
      : {
          behavior: 'allow' as const,
          updatedInput: {
            ...obj(input ?? {}),
            answers: answer.answers
          }
        }

    this.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response }
    })
  }

  interrupt(): void {
    // 被打断的提问不会再有答案，别把原始 input 留在内存里
    this.questionInputs.clear()
    this.write({
      type: 'control_request',
      request_id: `host-${++this.reqSeq}`,
      request: { subtype: 'interrupt' }
    })
  }

  dispose(): void {
    this.questionInputs.clear()
    // 不要在 dispose 立刻删：CLI 可能刚 spawn 还没读到 --mcp-config。
    // close 回调里统一清理，进程真的退出后才把含 token 的临时文件删掉。
    try {
      this.child.stdin?.end()
    } catch {
      // 已经关了
    }
    // 给 CLI 一点时间自己退；不退就杀
    const t = setTimeout(() => {
      try {
        this.child.kill()
      } catch {
        // 已经退出了
      }
    }, 800)
    t.unref?.()
  }

  private write(msg: unknown): void {
    try {
      this.child.stdin?.write(`${JSON.stringify(msg)}\n`)
    } catch {
      // 子进程没了；退出事件会走到 onExit
    }
  }

  private onStdout(chunk: string): void {
    for (const line of this.decoder.push(chunk)) this.handleLine(line)
  }

  private handleLine(line: string): void {
    const raw = parseLine(line)
    if (!raw) return // 前缀垃圾行是常态

    // 控制通道：CLI 问我们，或回我们的问
    const outcome = parseControlRequest(raw, this.o.cwd)
    if (outcome) {
      if (outcome.action === 'event') {
        // 记住原始入参：回答时 updatedInput 要用它补全
        if (outcome.event.t === 'question_request') {
          this.questionInputs.set(outcome.event.id, outcome.event.input)
        }
        this.o.onEvent(outcome.event)
      } else {
        // 不认识就明确回绝 —— 沉默会让 CLI 一直等下去
        this.write({
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: outcome.requestId,
            error: `unsupported control request subtype: ${outcome.subtype}`
          }
        })
      }
      return
    }
    if (raw.type === 'control_response') {
      this.onControlResponse(raw)
      return
    }

    // commands_changed 的原始数组留一份：init 到达后要按 skills 重新分组
    if (raw.type === 'system' && raw.subtype === 'commands_changed') {
      this.rawCommands = Array.isArray(raw.commands) ? raw.commands : this.rawCommands
    }

    for (const ev of this.translator.translate(raw)) {
      /*
       * init / status 里的权限模式才是 CLI 的实际值 —— 可能和请求的不同
       * （例如 auto 不可用时回落到 default）。用实际值更新本地记录，
       * 否则下一次切到同一个名字会被误判成“没变化”而直接跳过。
       */
      if (ev.t === 'session_started') this.permissionMode = ev.permissionMode
      else if (ev.t === 'permission_mode_changed') this.permissionMode = ev.mode
      this.o.onEvent(ev)
    }

    /*
     * init 里有 skills / terminal_slash_commands。initialize 的响应可能
     * 比它先到，那时分组只能按 builtin 退回；到这里用完整信息再发一次，
     * 让弹层拿到准确的分组和过滤结果。
     */
    if (raw.type === 'system' && raw.subtype === 'init') this.emitCommands()
  }

  /** initialize / set_permission_mode 的回执 → 指令表或模式校正 */
  private onControlResponse(raw: Record<string, unknown>): void {
    const response = obj(raw.response)
    const requestId = str(response.request_id)

    // 权限模式切换的回执。成功时 CLI 也会推一条 system/status，
    // 两条都转成 permission_mode_changed —— 渲染层按值去重，不会重复画。
    const requested = this.pendingModes.get(requestId)
    if (requested !== undefined) {
      this.pendingModes.delete(requestId)
      if (response.subtype === 'success') {
        const applied = normalizePermissionMode(obj(response.response).mode || requested)
        this.permissionMode = applied
        this.o.onEvent({ t: 'permission_mode_changed', mode: applied })
      } else {
        const detail = str(response.error) || str(response.subtype)
        this.o.onEvent({
          t: 'error',
          message: t('claudeAdapter.modeSwitchFailed', { detail }),
          fatal: false
        })
        // 界面已经乐观改过胶囊了；CLI 没接，按实际模式校回去
        this.o.onEvent({
          t: 'permission_mode_changed',
          mode: normalizePermissionMode(this.permissionMode)
        })
      }
      return
    }

    // initialize 的响应 → 完整指令表。其它回执是 interrupt 之类，无需上抛。
    if (requestId !== this.cmdReqId) return

    const payload = obj(response.response)
    if (!Array.isArray(payload.commands)) return
    this.rawCommands = payload.commands
    this.emitCommands()
  }

  private emitCommands(): void {
    if (this.rawCommands.length === 0) return
    this.o.onEvent({
      t: 'native_commands',
      commands: claudeCommands(this.rawCommands, {
        skillNames: this.translator.skillNames,
        terminalNames: this.translator.terminalNames
      })
    })
  }
}

export class ClaudeProvider implements Provider {
  id = 'claude'

  async detect(): Promise<{ installed: boolean; path: string }> {
    const path = resolveClaudeBin()
    return { installed: existsSync(path), path }
  }

  start(o: ProviderSessionOptions): ProviderSession {
    return new ClaudeSession(o)
  }
}
