/*
 * 验证 MCP 探测链路：initialize → tools/resources/prompts list。
 * 用法：先 esbuild 打包 src/main/mcp-probe.ts，再 node tools/verify-mcp-probe.cjs
 */
const http = require('node:http')
const path = require('node:path')
const { probeMcpServer } = require(path.join(__dirname, '..', '.tmp-build', 'mcp-probe.cjs'))

function startHttpServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (d) => (raw += d))
      req.on('end', () => {
        let msg = {}
        try {
          msg = JSON.parse(raw)
        } catch {
          // ignore
        }
        if (msg.method === 'notifications/initialized') {
          res.writeHead(202).end()
          return
        }
        const body = (() => {
          if (msg.method === 'initialize') {
            return {
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'http-test', version: '1' }
              }
            }
          }
          if (msg.method === 'tools/list') {
            return {
              jsonrpc: '2.0',
              id: msg.id,
              result: { tools: [{ name: 'http_echo', description: 'HTTP echo' }] }
            }
          }
          return { jsonrpc: '2.0', id: msg.id, result: {} }
        })()
        if (req.url.includes('sse')) {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'sse-session'
          })
          res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`)
          // 故意不马上关流：探测端必须边读边解析并在拿到响应后取消
          setTimeout(() => res.end(), 3000)
          return
        }
        res.writeHead(200, {
          'content-type': 'application/json',
          'mcp-session-id': 'test-session'
        })
        res.end(JSON.stringify(body))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, port })
    })
  })
}

async function main() {
  const command = process.execPath
  const args = [path.join(__dirname, 'fixtures', 'mcp-test-server.cjs')]
  const result = await probeMcpServer({
    name: 'probe-test',
    description: '',
    transport: 'stdio',
    command,
    args,
    env: [],
    url: '',
    headers: [],
    enabled: true,
    scope: 'global',
    workingDir: ''
  })
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) throw new Error(`probe failed: ${result.error}`)
  if (result.tools.length !== 2) throw new Error(`expected 2 tools, got ${result.tools.length}`)
  if (result.resources.length !== 1) throw new Error(`expected 1 resource`)
  if (result.prompts.length !== 1) throw new Error(`expected 1 prompt`)

  const { server, port } = await startHttpServer()
  try {
    const httpResult = await probeMcpServer({
      name: 'http-probe',
      description: '',
      transport: 'http',
      command: '',
      args: [],
      env: [],
      url: `http://127.0.0.1:${port}/mcp`,
      headers: [{ key: 'X-Test', value: 'ok' }],
      enabled: true,
      scope: 'global',
      workingDir: ''
    })
    console.log(JSON.stringify(httpResult, null, 2))
    if (!httpResult.ok) throw new Error(`HTTP probe failed: ${httpResult.error}`)
    if (httpResult.tools[0]?.name !== 'http_echo') throw new Error('HTTP tools/list mismatch')

    const sseResult = await probeMcpServer({
      name: 'sse-probe',
      description: '',
      transport: 'http',
      command: '',
      args: [],
      env: [],
      url: `http://127.0.0.1:${port}/sse`,
      headers: [],
      enabled: true,
      scope: 'global',
      workingDir: ''
    })
    if (!sseResult.ok) throw new Error(`SSE-style HTTP probe failed: ${sseResult.error}`)
    if (sseResult.latencyMs > 2000) throw new Error('SSE response was not consumed incrementally')
    console.log('SSE-style HTTP probe OK', sseResult.latencyMs + 'ms')
  } finally {
    await new Promise((r) => server.close(r))
  }
  console.log('MCP probe OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
