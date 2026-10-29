import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '../src/shared/events'
import { DshWebSession } from '../src/main/providers/dsh/web/session'
import { disposeAllDshWebHosts, getDshWebHost } from '../src/main/providers/dsh/web/host'
import { readDshTranscript } from '../src/main/providers/dsh/history'
import { DshEventTranslator } from '../src/main/providers/dsh/events'
import type { ProviderSessionOptions } from '../src/main/providers/types'

/**
 * 不花钱的 Web 协议自检：
 *  - 启动真实的 `dsh --profile web`（隔离 DSH_HOME）；
 *  - 走 /connect、session/create、session/follow、session/prompt；
 *  - 没有 API Key，所以只断言到 turn_end/error，不断言模型文本。
 */

const TIMEOUT_MS = 150_000

function fail(message: string): never {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

function translatorChecks(cwd: string): void {
  const events: AgentEvent[] = []
  const tr = new DshEventTranslator({
    sessionId: 'session-test',
    cwd,
    live: true,
    emitStarted: false,
    onEvent: (e) => events.push(e)
  })

  tr.push({ type: 'turn/start', seq: 1, time: 1_000, data: { turn: 1 } })
  tr.pushStream({ type: 'start', attemptId: 'a1', revision: 1 })
  tr.pushStream({
    type: 'chunk',
    attemptId: 'a1',
    revision: 2,
    index: 0,
    chunk: { type: 'text-delta', text: 'Hel' }
  })
  tr.pushStream({
    type: 'chunk',
    attemptId: 'a1',
    revision: 3,
    index: 1,
    chunk: { type: 'text-delta', text: 'lo' }
  })
  tr.push({
    type: 'assistant/message',
    seq: 2,
    time: 1_100,
    data: {
      turn: 1,
      step: 1,
      message: {
        content: [
          { type: 'text', text: 'Hello' },
          {
            type: 'tool-call',
            id: 'call-1',
            name: 'edit',
            arguments: '{"file_path":"a.txt","old_string":"a","new_string":"b"}'
          }
        ]
      },
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }
    }
  })
  tr.push({
    type: 'tool/result',
    seq: 3,
    time: 1_200,
    data: {
      turn: 1,
      step: 1,
      message: {
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'ok' }],
        isError: false
      },
      meta: { diffs: [{ path: 'a.txt', oldText: 'a', newText: 'b' }] }
    }
  })
  tr.push({
    type: 'turn/end',
    seq: 4,
    time: 1_500,
    data: { turn: 1, reason: { kind: 'completed' } }
  })

  const text = events
    .filter((e) => e.t === 'text_delta')
    .map((e) => (e.t === 'text_delta' ? e.text : ''))
    .join('')
  if (text !== 'Hello') fail(`流式文本去重失败：${JSON.stringify(text)}`)
  if (!events.some((e) => e.t === 'tool_started' && e.name === 'Edit')) {
    fail('tool-call 没有转成 Edit')
  }
  if (!events.some((e) => e.t === 'tool_result' && e.status === 'ok')) {
    fail('tool/result 没有转成 tool_result')
  }
  if (!events.some((e) => e.t === 'file_change' && e.path === 'a.txt')) {
    fail('diff 没有转成 file_change')
  }
  const end = events.find((e) => e.t === 'turn_end')
  if (!end || end.t !== 'turn_end' || end.usage.inputTokens !== 10) {
    fail('turn/end usage 不对')
  }

  const errEvents: AgentEvent[] = []
  const errTr = new DshEventTranslator({
    sessionId: 'session-err',
    cwd,
    live: true,
    emitStarted: false,
    onEvent: (e) => errEvents.push(e)
  })
  errTr.push({
    type: 'turn/end',
    seq: 1,
    time: 2_000,
    data: {
      turn: 1,
      reason: { kind: 'error', error: { message: 'boom', code: 'X' } }
    }
  })
  if (!errEvents.some((e) => e.t === 'error')) fail('turn/end error 没有转成 error')
  console.log('translator: ok')
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ccoder-dsh-web-'))
  const home = join(root, 'home')
  const cwd = join(root, 'workspace')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  /*
   * 放一个 MCP patch：host 会用 `--patch` 传给 dsh。dsh 的启动器只解析
   * 自己的参数，`--patch` 必须排在 web app 的 `--no-open` 之前，否则会被
   * 原样转给 web app 报 unknown option。这条路径必须被自检覆盖。
   */
  mkdirSync(join(home, 'profiles', 'acp'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'acp', 'cordis.patch.yml'), '[]\n')

  const events: AgentEvent[] = []
  let exited = false
  let started = false
  let turnEnded = false
  let sawError = false

  const options: ProviderSessionOptions = {
    channel: null,
    cwd,
    model: 'deepseek-v4.1-flash',
    permissionMode: 'standard',
    effort: 'high',
    addDirs: [],
    dshHome: home,
    mcpServers: [],
    resumeId: null,
    onEvent: (e) => {
      events.push(e)
      if (e.t === 'session_started') started = true
      if (e.t === 'turn_end') turnEnded = true
      if (e.t === 'error') sawError = true
    },
    onExit: () => {
      exited = true
    }
  }

  console.log('home:', home)
  console.log('cwd :', cwd)
  translatorChecks(cwd)

  // 统计 host 启动次数：两个会话必须共用同一个 host
  let spawns = 0
  const originalWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (String(chunk).includes('dsh.web.spawn')) spawns += 1
    return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stderr.write

  const session = new DshWebSession(options)
  session.send({ text: 'ping' })

  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline && !turnEnded && !exited) {
    await new Promise((r) => setTimeout(r, 300))
  }

  const ids = events.filter((e) => e.t === 'session_started')
  const startedEvent = ids[0]
  console.log('events:', events.map((e) => e.t).join(', '))

  if (!started) fail('没有收到 session_started')
  if (!(startedEvent && startedEvent.t === 'session_started')) fail('session_started 形状不对')
  if (!startedEvent.sessionId.startsWith('session-')) {
    fail(`sessionId 不像 dsh 会话：${startedEvent.sessionId}`)
  }
  if (!turnEnded && !exited) fail('超时：没有收到 turn_end 或进程退出')
  if (!sawError && !exited) {
    // 没有 API Key 时 dsh 必然报 MISSING_CREDENTIAL；有 Key 时这条允许缺席
    console.log('note: 没有错误事件（可能配置了真实凭据）')
  }

  // 审批 / 提问的 UI 事件形状（不依赖真实模型）
  session.onApproval('approval-test', {
    toolName: 'bash',
    callId: 'call-test',
    reason: 'needs network'
  })
  const perm = events.find((e) => e.t === 'permission_request')
  if (!perm || perm.t !== 'permission_request') fail('审批没有转成 permission_request')
  if (perm.tool !== 'Bash') fail(`审批工具名不对：${perm.tool}`)
  for (const value of ['allow', 'allow-always', 'deny']) {
    if (!perm.options.some((o) => o.value === value)) {
      fail(`审批缺少选项 ${value}`)
    }
  }

  session.onQuestion('question-test', {
    questions: [
      {
        id: 'q1',
        question: 'Pick one',
        options: [{ label: 'A' }, { label: 'B' }]
      }
    ]
  })
  const question = events.find((e) => e.t === 'question_request')
  if (!question || question.t !== 'question_request') fail('提问没有转成 question_request')
  if (question.questions[0]?.question !== 'Pick one') {
    fail('question_request 文案不对')
  }

  const firstId = startedEvent.sessionId
  console.log('session:', firstId)

  // 历史回放（同一条 zstd 日志）必须也能产出会话/用户消息
  const encoded = readdirSync(join(home, 'sessions'))[0]
  const transcriptFile = join(
    home,
    'sessions',
    encoded,
    firstId,
    'session.v4.jsonl.zstd'
  )
  const replay = readDshTranscript(transcriptFile, cwd, firstId)
  const replayTypes = replay.map((e) => e.t)
  console.log('history events:', replayTypes.join(', '))
  if (!replayTypes.includes('session_started')) fail('历史回放缺少 session_started')
  if (!replayTypes.includes('user_message')) fail('历史回放缺少 user_message')

  /*
   * 断线重连：follow 断开期间 Host 提交的事件，必须在重连快照里补发。
   * 这里用 onHostDisconnected / onHostConnected 模拟 socket 断开
   *（真实路径也是「关 follow → 重连 → reopen follow」）。
   * 少了这段补发，断线期间跑完的 turn/end 会丢，界面永远停在「运行中」。
   */
  const liveHost = getDshWebHost({
    home,
    channel: null,
    cwd,
    patchFile: join(home, 'profiles', 'acp', 'cordis.patch.yml')
  })
  session.onHostDisconnected()
  const gapMark = events.length
  await liveHost.call('session/prompt', {
    request: {
      requestId: `gap-${Date.now()}`,
      sessionId: firstId,
      mode: 'queue',
      content: [{ type: 'text', text: 'committed while disconnected' }],
      clientTimeZone: 'Asia/Shanghai'
    }
  })
  // 没有 Key 时这一轮会快速报错并 turn/end；给它一点时间落盘
  await new Promise((r) => setTimeout(r, 1_500))
  session.onHostConnected()
  await new Promise((r) => setTimeout(r, 2_500))
  const gapTypes = events.slice(gapMark).map((e) => e.t)
  if (!gapTypes.includes('turn_end')) {
    fail(`重连后没有补发断线期间的 turn/end（收到：${gapTypes.join(',') || 'none'}）`)
  }
  console.log('reconnect replay: ok')

  // 第二个会话复用同一个 host，并且 resume 同一条 dsh 会话
  const events2: AgentEvent[] = []
  let ended2 = false
  const session2 = new DshWebSession({
    ...options,
    resumeId: firstId,
    onEvent: (e) => {
      events2.push(e)
      if (e.t === 'turn_end') ended2 = true
    }
  })
  session.dispose()
  session2.send({ text: 'ping again' })

  const deadline2 = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline2 && !ended2) {
    await new Promise((r) => setTimeout(r, 300))
  }

  const started2 = events2.find((e) => e.t === 'session_started')
  if (!started2 || started2.t !== 'session_started') fail('resume 没有收到 session_started')
  if (started2.sessionId !== firstId) {
    fail(`resume 换了会话：期望 ${firstId}，得到 ${started2.sessionId}`)
  }
  if (!ended2) fail('resume 超时：没有收到 turn_end')
  if (spawns !== 1) fail(`host 启动次数应为 1，实际 ${spawns}`)

  console.log('resume events:', events2.map((e) => e.t).join(', '))
  console.log('host spawns:', spawns)
  session2.dispose()
  disposeAllDshWebHosts()

  // 给 host 一点时间走完 SIGTERM
  await new Promise((r) => setTimeout(r, 1500))
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // 临时目录清理失败不影响结论
  }

  console.log('PASS')
  process.exit(0)
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
