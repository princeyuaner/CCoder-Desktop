/*
 * Codex 成功链路：本地假 Responses SSE 端点，验证 turn/start → 文本增量 →
 * turn/completed 的完整路径，以及「测试连接」的返回值。
 *
 * 用法：
 *   CODEX_BIN=<codex 可执行文件> node tools/verify-codex-success.cjs
 */
const http = require('node:http')
const path = require('node:path')
const os = require('node:os')
const { mkdtempSync } = require('node:fs')

process.env.CODEX_HOME = process.env.CODEX_HOME || mkdtempSync(path.join(os.tmpdir(), 'ccoder-codex-ok-'))
if (!process.env.CODEX_BIN) {
  console.error('请用 CODEX_BIN 指向一个 codex 可执行文件')
  process.exit(2)
}

const { testCodexChannel } = require('./_codex-runner.cjs')

const created = (status, output, usage) => ({
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
    console.log('  endpoint', req.method, req.url, 'auth=', req.headers.authorization || '(none)', 'x-api-key=', req.headers['x-api-key'] || '(none)')
    console.log('  body:', body.slice(0, 500))
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

    send('response.created', { type: 'response.created', response: created('in_progress', [], null) })
    send('response.in_progress', { type: 'response.in_progress', response: created('in_progress', [], null) })
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
    send('response.output_text.done', {
      type: 'response.output_text.done',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      text: 'OK'
    })
    send('response.content_part.done', {
      type: 'response.content_part.done',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: 'OK', annotations: [] }
    })
    send('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: message
    })
    send('response.completed', {
      type: 'response.completed',
      response: created('completed', [message], {
        input_tokens: 5,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 6
      })
    })
    res.end()
  })
})

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  const result = await testCodexChannel({
    id: 'verify',
    name: 'verify',
    kind: 'openai',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'gpt-5',
    models: [],
    smallFastModel: '',
    authMode: process.env.AUTH === 'key' ? 'key' : 'token',
    authToken: 'sk-verify',
    wireApi: 'responses',
    extraEnv: []
  })
  console.log('  result:', JSON.stringify(result))
  server.close()
  const ok = result.ok && /OK/.test(result.message)
  console.log(`\n${ok ? '成功链路通过 ✓' : '成功链路失败 ✗'}`)
  process.exit(ok ? 0 : 1)
})
