/*
 * 用**录制的真实 NDJSON** 验证解析层。
 *
 * 为什么不直接跑真 CLI：失败请求会被 CLI 重试最多 10 次，单次要 4 秒，
 * 每次跑验证都得等好几个 4 秒。fixture 快、确定、且同样是对着真实输出测。
 * 真 CLI 的连通性由 verify:turn 单独冒烟（只有一个用例）。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ClaudeStreamTranslator } = require('./_stream-json.cjs')
const { parseControlRequest } = require('./_control.cjs')

const HERE = __dirname
let failed = 0
function check(label, cond, detail) {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300))
  }
}

// ── 1) 事件流解析
console.log('\n[1] stream-json → AgentEvent')
{
  const tr = new ClaudeStreamTranslator()
  const lines = fs
    .readFileSync(path.join(HERE, 'fixtures', 'stream-basic.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())

  const events = []
  for (const line of lines) {
    // 与 adapter 一致：非 JSON 行（前缀垃圾）直接跳过
    if (!line.trim().startsWith('{')) continue
    for (const e of tr.translate(JSON.parse(line))) events.push(e)
  }

  const byType = (t) => events.filter((e) => e.t === t)
  const started = byType('session_started')[0]
  check('init → session_started', !!started)
  check('  sessionId', started?.sessionId === 'sess-1', started?.sessionId)
  check('  model', started?.model === 'deepseek-chat', started?.model)
  // CLI 的 manual 在我们这边叫 standard —— 同一个语义，必须映射对
  check('  permissionMode: manual → standard', started?.permissionMode === 'standard', started?.permissionMode)
  check('  tools 4 个', started?.tools?.length === 4, started?.tools?.length)

  // status / api_retry / commands_changed（16KB 命令表）都不该上抛
  check('status 不上抛', !events.some((e) => JSON.stringify(e).includes('requesting')))
  check('api_retry 不上抛', !events.some((e) => JSON.stringify(e).includes('api_retry')))
  check('commands_changed 不上抛', !events.some((e) => JSON.stringify(e).includes('caveman')))

  check('thinking_delta', byType('thinking_delta').length === 1)
  check('thinking 内容', byType('thinking_delta')[0]?.text === '先看看项目结构。')

  // 关键：流式 delta 与随后的 assistant 完整文本**不能重复**
  const text = byType('text_delta')
    .map((e) => e.text)
    .join('')
  check('文本不重复', text === '这个项目是一个 Flask 服务。', text)

  const calls = byType('tool_call')
  check('两次 tool_call', calls.length === 2, calls.length)
  check('  tu1 = Read', calls[0]?.name === 'Read' && calls[0]?.id === 'tu1')
  check('  tu2 = Bash', calls[1]?.name === 'Bash')

  const results = byType('tool_result')
  check('两次 tool_result', results.length === 2)
  check('  tu1 成功', results[0]?.status === 'ok' && results[0]?.content.includes('flask'))
  check('  tu2 失败', results[1]?.status === 'error', results[1]?.status)
  check('  块数组 content 被摊平', results[1]?.content === 'fatal: not a git repository', results[1]?.content)

  const end = byType('turn_end')[0]
  check('turn_end 存在', !!end)
  check('  durationMs', end?.durationMs === 7000, end?.durationMs)
  check('  costUsd', end?.costUsd === 0.012, end?.costUsd)
  check('  inputTokens', end?.usage?.inputTokens === 21000)
  check('  cacheReadTokens', end?.usage?.cacheReadTokens === 22058)
  check('  tokensPerSecond 已计算', end?.usage?.tokensPerSecond === 843, end?.usage?.tokensPerSecond)
}

// ── 2) 控制协议
console.log('\n[2] control_request → 审批事件')
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-ctl-'))
  const target = path.join(tmp, 'app.py')
  fs.writeFileSync(target, 'def main():\n    old line\n    return 0\n')

  const lines = fs
    .readFileSync(path.join(HERE, 'fixtures', 'control-requests.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l.replace('__FIXTURE_FILE__', target.replace(/\\/g, '/'))))

  // can_use_tool (Bash)
  const bash = parseControlRequest(lines[0], tmp)
  check('Bash 请求 → event', bash?.action === 'event', bash?.action)
  check('  工具名', bash?.event?.tool === 'Bash')
  check('  request_id 带上了', bash?.event?.id === 'req-allow', bash?.event?.id)
  check('  三个选项', bash?.event?.options?.length === 3, bash?.event?.options?.length)
  check('  预览是命令', bash?.event?.preview?.kind === 'command', bash?.event?.preview?.kind)
  check('  命令原文', bash?.event?.preview?.command === 'ls -la')
  check('  安全命令无提醒', !bash?.event?.preview?.note)

  // can_use_tool (Edit) —— 必须出真 diff
  const edit = parseControlRequest(lines[1], tmp)
  check('Edit 请求 → event', edit?.action === 'event')
  check('  预览是 diff', edit?.event?.preview?.kind === 'diff', edit?.event?.preview?.kind)
  check('  有删除行', edit?.event?.preview?.lines?.some((l) => l.kind === 'del' && l.text.includes('old line')))
  check('  有新增行', edit?.event?.preview?.lines?.some((l) => l.kind === 'add' && l.text.includes('new line')))
  check('  带绝对路径', typeof edit?.event?.preview?.path === 'string' && edit.event.preview.path.includes('app.py'))

  // 未知 subtype —— 必须回绝，不能让 CLI 干等
  const unknown = parseControlRequest(lines[2], tmp)
  check('未知 subtype → unsupported', unknown?.action === 'unsupported', unknown?.action)
  check('  带回 request_id', unknown?.requestId === 'req-unknown', unknown?.requestId)

  // control_response 不是请求，解析器应当放行给别处
  check('control_response 返回 null', parseControlRequest(lines[3], tmp) === null)

  // AskUserQuestion —— 必须走提问事件，不能落到普通审批
  const ask = parseControlRequest(
    {
      type: 'control_request',
      request_id: 'req-ask',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Which color?',
              header: 'Color',
              multiSelect: true,
              options: [
                { label: 'Red', description: 'warm' },
                { label: 'Blue', description: 'cool' }
              ]
            }
          ]
        }
      }
    },
    tmp
  )
  check('AskUserQuestion → question_request', ask?.event?.t === 'question_request', ask?.event?.t)
  check('  不是审批事件', ask?.event?.preview === undefined)
  check('  request_id 带上了', ask?.event?.id === 'req-ask')
  check('  题目归一化', ask?.event?.questions?.[0]?.question === 'Which color?')
  check('  header 保留', ask?.event?.questions?.[0]?.header === 'Color')
  check('  multiSelect 保留', ask?.event?.questions?.[0]?.multiSelect === true)
  check('  选项 2 个', ask?.event?.questions?.[0]?.options?.length === 2)

  // 题不够（只有 1 个选项）→ 退回普通审批，至少还能拒绝
  const malformed = parseControlRequest(
    {
      type: 'control_request',
      request_id: 'req-bad-ask',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Only one?',
              header: 'Bad',
              multiSelect: false,
              options: [{ label: 'Only', description: '' }]
            }
          ]
        }
      }
    },
    tmp
  )
  check('坏题目退回审批', malformed?.event?.t === 'permission_request', malformed?.event?.t)

  fs.rmSync(tmp, { recursive: true, force: true })
}

// ── 3) 工具入参流：卡片必须比完整 tool_call 先出现
console.log('\n[3] tool_started：生成大文件时卡片立刻出现')
{
  const tr = new ClaudeStreamTranslator()
  const start = (index, id, name) => ({
    type: 'stream_event',
    event: { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name } }
  })
  const delta = (index, partial_json) => ({
    type: 'stream_event',
    event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } }
  })

  const input = {
    file_path: path.join('C:', 'proj', 'src', 'big.ts'),
    content: 'x\n'.repeat(2000)
  }
  const json = JSON.stringify(input)

  tr.translate({ type: 'stream_event', event: { type: 'message_start' } })
  const evs = []
  evs.push(...tr.translate(start(0, 'w1', 'Write')))
  check('块一开始就发 tool_started', evs[0]?.t === 'tool_started' && evs[0]?.id === 'w1')
  check('  此时还没有 path', evs[0]?.path === undefined)

  // 路径通常在入参最前面；就算被分片切开也要能认出来
  evs.push(...tr.translate(delta(0, json.slice(0, 12))))
  check('路径没闭合前不发事件', evs.length === 1, evs.length)
  evs.push(...tr.translate(delta(0, json.slice(12, 60))))
  const withPath = evs.filter((e) => e.t === 'tool_started' && e.path)
  check(
    '路径闭合后补一条',
    withPath.length === 1 && withPath[0].path === input.file_path,
    withPath[0]
  )

  const after = tr.translate(delta(0, json.slice(60)))
  check('之后不再每段都发', after.length === 0, after.length)

  // 完整入参照旧走 tool_call；渲染层按 id 合并成同一张卡
  const full = tr.translate({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'w1', name: 'Write', input }] }
  })
  check('完整入参 → tool_call', full[0]?.t === 'tool_call' && full[0]?.id === 'w1')
  check('  入参完整', full[0]?.input?.content === input.content)

  // 新消息的块序号从 0 重来：别把上一条消息的残留拼进来
  tr.translate({ type: 'stream_event', event: { type: 'message_start' } })
  const fresh = tr.translate(start(0, 'w2', 'Read'))
  check('新消息重新从 index 0 开始', fresh[0]?.id === 'w2', fresh[0])
  const freshPath = tr.translate(delta(0, '{"file_path":"/tmp/a.ts"}'))
  check('  新块独立认出路径', freshPath[0]?.path === '/tmp/a.ts', freshPath[0])

  // 正文/思考块开始不该冒出一张工具卡
  check(
    'text 块不发 tool_started',
    tr.translate({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
    }).length === 0
  )
}

console.log(`\n${failed === 0 ? '全部通过 ✓' : `${failed} 项失败 ✗`}`)
process.exit(failed === 0 ? 0 : 1)
