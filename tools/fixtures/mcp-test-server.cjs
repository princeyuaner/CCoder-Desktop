/*
 * 最小 MCP stdio 测试服务器，只用于验证 CCoder 的探测链路。
 * 不参与打包。
 */
const readline = require('node:readline')

const rl = readline.createInterface({ input: process.stdin })
const send = (v) => process.stdout.write(`${JSON.stringify(v)}\n`)

rl.on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'mcp-test-server', version: '1.0.0' }
      }
    })
    return
  }
  if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          { name: 'echo', description: 'Echo the input back', inputSchema: { type: 'object' } },
          { name: 'now', description: 'Return the current time', inputSchema: { type: 'object' } }
        ]
      }
    })
    return
  }
  if (msg.method === 'resources/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        resources: [
          { uri: 'test://hello', name: 'hello.txt', mimeType: 'text/plain' }
        ]
      }
    })
    return
  }
  if (msg.method === 'prompts/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { prompts: [{ name: 'greet', description: 'Say hello' }] }
    })
    return
  }
  if (msg.id !== undefined && msg.method) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not found' } })
  }
})
