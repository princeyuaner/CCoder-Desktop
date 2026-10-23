import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { EffortLevel } from '../../../shared/settings'
import type { PermissionDecision, QuestionAnswer, SessionSendInput } from '../../../shared/session'
import { channelToEnv } from '../../channel-env'
import { resolveClaudeBin, spawnClaude } from '../../claude-runner'
import { NdjsonDecoder, parseLine } from '../../ndjson'
import type { Provider, ProviderSession, ProviderSessionOptions } from '../types'
import { parseControlRequest } from './control'
import { ClaudeStreamTranslator } from './stream-json'

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
    'stdio'
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
class ClaudeSession implements ProviderSession {
  private child: ChildProcess
  private decoder = new NdjsonDecoder()
  private translator = new ClaudeStreamTranslator()
  private stderr = ''
  private done = false
  private reqSeq = 0
  /**
   * 待回答的提问：request_id → CLI 原始 input。
   *
   * 回答时要把它原样放进 `updatedInput`，再带上 answers —— CLI 用
   * updatedInput **替换**整个工具入参，只给 answers 会把 questions 弄丢。
   */
  private questionInputs = new Map<string, unknown>()

  constructor(private o: ProviderSessionOptions) {
    const args = buildClaudeArgs({
      model: o.model,
      permissionMode: o.permissionMode,
      effort: o.effort,
      addDirs: o.addDirs,
      resumeId: o.resumeId,
      // channel 为 null = 官方登录
      official: !o.channel
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
          message: `解析 CLI 输出失败：${e instanceof Error ? e.message : String(e)}`,
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
      o.onEvent({ t: 'error', message: err.message, fatal: true })
      o.onExit(null, `${this.stderr}${err.message}`)
    })

    this.child.on('close', (code) => {
      if (this.done) return
      this.done = true
      try {
        for (const line of this.decoder.flush()) this.handleLine(line)
      } catch {
        // 收尾时的解析错误不改变退出事实，交给 onExit 报给会话
      }
      o.onExit(code, this.stderr)
    })
  }

  send(input: SessionSendInput): void {
    this.write(buildUserMessage(input))
  }

  respondPermission(requestId: string, decision: PermissionDecision): void {
    const response =
      decision.behavior === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: decision.message ?? '用户拒绝了这次操作' }

    this.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response }
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
      ? { behavior: 'deny' as const, message: '用户跳过了这次提问' }
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
      return // 我们对 interrupt 之类请求的回执，无需上抛
    }

    for (const ev of this.translator.translate(raw)) this.o.onEvent(ev)
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
