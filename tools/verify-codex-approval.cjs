/*
 * Codex 审批链路：假 Responses 端点先返回一个 shell 调用，确认 app-server
 * 发出 item/commandExecution/requestApproval，再由宿主答复 allow，
 * 命令执行完继续第二轮并收到最终文本。
 *
 * 用法：
 *   CODEX_BIN=<codex 可执行文件> node tools/verify-codex-approval.cjs
 */
const http = require('node:http')
const path = require('node:path')
const os = require('node:os')
const { mkdtempSync } = require('node:fs')

process.env.CODEX_HOME =
  process.env.CODEX_HOME || mkdtempSync(path.join(os.tmpdir(), 'ccoder-codex-approval-'))
if (!process.env.CODEX_BIN) {
  console.error('请用 CODEX_BIN 指向一个 codex 可执行文件')
  process.exit(2)
}

const { SessionManager } = require('./_session-manager.cjs')

const resp = (status, output, usage) => ({
  id: `resp_${Math.random().toString(36).slice(2)}`,
  object: 'response',
  created_at: Math.floor(Date.now() / 1000),
  status,
  model: 'gpt-5',
  output,
  usage
})

const textItem = (text) => ({
  id: 'msg_verify',
  type: 'message',
  status: 'completed',
  role: 'assistant',
  content: [{ type: 'output_text', text, annotations: [] }]
})

const callItem = {
  id: 'fc_verify',
  type: 'function_call',
  status: 'completed',
  name: 'exec_command',
  arguments: JSON.stringify({ cmd: 'echo ccoder-approval-ok' }),
  call_id: 'call_verify'
}

let requestNo = 0
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    requestNo++
    console.log('  endpoint #' + requestNo, req.method, req.url)
    try { const j=JSON.parse(body); console.log('  input#%d', requestNo, JSON.stringify((j.input||[]).map(x=>({type:x.type,role:x.role,name:x.name,call_id:x.call_id,output:typeof x.output==='string'?x.output.slice(0,200):x.output})))); console.log('  tools', JSON.stringify((j.tools||[]).slice(0,2))) } catch { console.log(body.slice(0,500)) }
    if (req.method !== 'POST' || !req.url.endsWith('/responses')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"not found"}}')
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (event, data) => {
      res.write(`event: ${event}\n`)
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }

    if (requestNo === 1) {
      send('response.created', { type: 'response.created', response: resp('in_progress', [], null) })
      send('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...callItem, status: 'in_progress', arguments: '' }
      })
      send('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: callItem.id,
        output_index: 0,
        delta: callItem.arguments
      })
      send('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: callItem.id,
        output_index: 0,
        arguments: callItem.arguments
      })
      send('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item: callItem
      })
      send('response.completed', {
        type: 'response.completed',
        response: resp('completed', [callItem], {
          input_tokens: 10,
          output_tokens: 4,
          total_tokens: 14,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 }
        })
      })
      res.end()
      return
    }

    send('response.created', { type: 'response.created', response: resp('in_progress', [], null) })
    const final = textItem('OK')
    send('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...final, status: 'in_progress', content: [] }
    })
    send('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: final.id,
      output_index: 0,
      content_index: 0,
      delta: 'OK'
    })
    send('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: final
    })
    send('response.completed', {
      type: 'response.completed',
      response: resp('completed', [final], {
        input_tokens: 20,
        output_tokens: 2,
        total_tokens: 22,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 }
      })
    })
    res.end()
  })
})

let failed = 0
const check = (label, cond, detail) => {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : String(detail).slice(0, 500))
  }
}

server.listen(0, '127.0.0.1', async () => {
  const ch = {
    id: 'ch-codex',
    name: 'verify',
    kind: 'openai',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: 'gpt-5',
    models: [],
    smallFastModel: '',
    authMode: 'token',
    authToken: 'sk-verify',
    wireApi: 'responses',
    extraEnv: []
  }
  const settings = {
    clis: {
      claude: { enabled: false, activeChannelId: null, channels: [], effort: 'medium' },
      codex: { enabled: true, activeChannelId: ch.id, channels: [ch], effort: 'low' }
    },
    permissionMode: 'standard',
    defaultCwd: '',
    openedCwds: [],
    theme: 'contrast',
    uiZoom: 1,
    chatFontSize: 14,
    uiFont: '',
    monoFont: '',
    showTimestamps: false,
    thinkingOpen: false,
    toolDetail: 'full',
    sendKey: 'enter'
  }

  const events = []
  let permissionAnswered = false
  const manager = new SessionManager(
    () => settings,
    (p) => {
      events.push(p.event)
      console.log('  event', JSON.stringify(p.event).slice(0, 300))
      if (p.event.t === 'permission_request' && !permissionAnswered) {
        permissionAnswered = true
        setTimeout(() => {
          console.log('  answer allow', p.event.id)
          manager.respondPermission(p.sessionId, p.event.id, { behavior: 'allow' }, false)
        }, 200)
      }
    },
    () => undefined
  )

  const id = manager.start({
    cli: 'codex',
    cwd: process.cwd(),
    permissionMode: 'standard',
    effort: 'low'
  })
  manager.send(id, { text: 'run echo' })

  const end = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 60_000)
    const tick = setInterval(() => {
      const e = events.find((x) => x.t === 'turn_end')
      if (e) {
        clearTimeout(t)
        clearInterval(tick)
        resolve(e)
      }
    }, 100)
  })

  const perm = events.find((e) => e.t === 'permission_request')
  check('收到审批请求', !!perm, JSON.stringify(events))
  check('工具是 Bash', !!perm && perm.tool === 'Bash', perm && perm.tool)
  check('预览带命令', !!perm && perm.preview.kind === 'command' && /echo/.test(perm.preview.command || ''), perm && perm.preview)
  check('审批后命令执行', events.some((e) => e.t === 'tool_result' && /ccoder-approval-ok/.test(e.content)), JSON.stringify(events.filter((e) => e.t === 'tool_result')))
  check('收到最终文本', events.some((e) => e.t === 'text_delta' && e.text.includes('OK')))
  check('收到 turn_end', !!end)

  manager.stop(id)
  server.close()
  console.log(`\n${failed === 0 ? '审批链路通过 ✓' : `${failed} 项失败 ✗`}`)
  process.exit(failed === 0 ? 0 : 1)
})
