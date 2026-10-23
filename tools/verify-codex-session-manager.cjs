/*
 * 端到端：SessionManager + CodexProvider + 假 Responses SSE 端点。
 * 覆盖「渠道 → -c 覆盖 → app-server → turn/start → 事件归一化 → turn_end」。
 *
 * 用法：
 *   CODEX_BIN=<codex 可执行文件> node tools/verify-codex-session-manager.cjs
 */
const http = require('node:http')
const path = require('node:path')
const os = require('node:os')
const { mkdtempSync } = require('node:fs')

process.env.CODEX_HOME =
  process.env.CODEX_HOME || mkdtempSync(path.join(os.tmpdir(), 'ccoder-codex-sm-'))
if (!process.env.CODEX_BIN) {
  console.error('请用 CODEX_BIN 指向一个 codex 可执行文件')
  process.exit(2)
}

const { SessionManager } = require('./_session-manager.cjs')

const baseResponse = (status, output, usage) => ({
  id: 'resp_verify',
  object: 'response',
  created_at: Math.floor(Date.now() / 1000),
  status,
  model: 'gpt-5',
  output,
  usage
})

const message = {
  id: 'msg_verify',
  type: 'message',
  status: 'completed',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'OK', annotations: [] }]
}

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    console.log('  endpoint', req.method, req.url, 'auth=', req.headers.authorization || '(none)')
    if (req.method !== 'POST' || !req.url.endsWith('/responses')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    const send = (event, data) => {
      res.write(`event: ${event}\n`)
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }
    send('response.created', { type: 'response.created', response: baseResponse('in_progress', [], null) })
    send('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...message, status: 'in_progress', content: [] }
    })
    send('response.content_part.added', {
      type: 'response.content_part.added',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] }
    })
    send('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: 'OK'
    })
    send('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: message
    })
    send('response.completed', {
      type: 'response.completed',
      response: baseResponse('completed', [message], {
        input_tokens: 12,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens: 2,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 14
      })
    })
    res.end()
  })
})

function channel(baseUrl) {
  return {
    id: 'ch-codex',
    name: 'verify',
    kind: 'openai',
    baseUrl: `${baseUrl}/v1`,
    model: 'gpt-5',
    models: [],
    smallFastModel: '',
    authMode: 'token',
    authToken: 'sk-verify',
    wireApi: 'responses',
    extraEnv: []
  }
}

function settings(ch) {
  return {
    clis: {
      claude: { enabled: false, activeChannelId: null, channels: [], effort: 'medium' },
      codex: { enabled: true, activeChannelId: ch.id, channels: [ch], effort: 'high' }
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
}

let failed = 0
const check = (label, cond, detail) => {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : String(detail).slice(0, 500))
  }
}

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  const ch = channel(`http://127.0.0.1:${port}`)
  const events = []
  const statuses = []
  const manager = new SessionManager(
    () => settings(ch),
    (p) => {
      events.push(p.event)
      console.log('  event', p.sessionId.slice(0, 8), JSON.stringify(p.event).slice(0, 300))
    },
    (p) => {
      statuses.push(p)
      console.log('  status', p.status, p.providerSessionId || '')
    }
  )

  const id = manager.start({
    cli: 'codex',
    cwd: process.cwd(),
    permissionMode: 'standard',
    effort: 'high'
  })
  const sent = manager.send(id, { text: 'say hi' })
  check('send 返回 ok', sent.ok === true, sent.message)

  const first = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 40_000)
    const tick = setInterval(() => {
      const end = events.find((e) => e.t === 'turn_end')
      const err = events.find((e) => e.t === 'error' && e.fatal)
      if (end || err) {
        clearTimeout(t)
        clearInterval(tick)
        resolve(end || err)
      }
    }, 100)
  })
  check('收到 turn_end', !!first && first.t === 'turn_end', JSON.stringify(first))

  const started = events.find((e) => e.t === 'session_started')
  check('session_started 来自 codex', !!started && started.provider === 'codex', JSON.stringify(started))
  check('providerSessionId 回填到 status', statuses.some((s) => !!s.providerSessionId))
  const text = events
    .filter((e) => e.t === 'text_delta')
    .map((e) => e.text)
    .join('')
  check('文本增量到达', text.includes('OK'), text)
  const end = events.find((e) => e.t === 'turn_end')
  check('用量已归一化', !!end && end.usage.inputTokens >= 0 && end.usage.outputTokens === 2, JSON.stringify(end && end.usage))
  check('状态回到 idle', statuses.some((s) => s.status === 'idle'))

  manager.stop(id)
  server.close()
  console.log(`\n${failed === 0 ? '端到端通过 ✓' : `${failed} 项失败 ✗`}`)
  process.exit(failed === 0 ? 0 : 1)
})
