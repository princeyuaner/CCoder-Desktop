/*
 * LSP 宿主验证脚本。
 *
 * 用一个自带的 mock language server（临时写进工作区的
 * node_modules/typescript-language-server/lib/cli.mjs）走一遍：
 * 探测 → initialize → initialized → 文档同步 → 诊断 → 请求 →
 * server→client 请求 → shutdown / exit。
 *
 * 用法：npm run verify:lsp
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '..')
const host = require('./_lsp-host.cjs')
const { diffChange } = require('./_lsp-diff.cjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check, timeoutMs = 5000, stepMs = 50) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = check()
    if (value) return value
    await sleep(stepMs)
  }
  return null
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}

const MOCK_SERVER = String.raw`
import fs from 'node:fs'

const marker = process.env.MOCK_LSP_MARKER || ''
const logFile = process.env.MOCK_LSP_LOG || ''
const docs = new Map()
let buffer = Buffer.alloc(0)

function log(entry) {
  if (!logFile) return
  try {
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n')
  } catch {}
}

function send(message) {
  const body = JSON.stringify(message)
  const header = 'Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\r\n\r\n'
  // 故意拆成三次写，验证客户端的粘包 / 半包处理
  process.stdout.write(header.slice(0, 7))
  process.stdout.write(header.slice(7))
  process.stdout.write(body)
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function error(id, message) {
  send({ jsonrpc: '2.0', id, error: { code: -32601, message } })
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params })
}

function handle(message) {
  const { id, method, params } = message || {}
  if (id !== undefined && method === undefined) {
    // server → client 请求的响应
    log({ type: 'client-response', id, result: message.result, error: message.error })
    return
  }
  if (!method) return

  switch (method) {
    case 'initialize': {
      respond(id, {
        capabilities: {
          textDocumentSync: 2,
          definitionProvider: true,
          referencesProvider: true,
          renameProvider: true,
          hoverProvider: true,
          completionProvider: { triggerCharacters: ['.'] },
          documentFormattingProvider: true
        }
      })
      // 初始化后主动发两个 server→client 请求，验证宿主处理
      send({
        jsonrpc: '2.0',
        id: 9001,
        method: 'workspace/configuration',
        params: { items: [{ section: 'mock' }] }
      })
      send({
        jsonrpc: '2.0',
        id: 9002,
        method: 'workspace/applyEdit',
        params: { edit: { changes: {} } }
      })
      return
    }
    case 'initialized':
      return
    case 'shutdown':
      log({ type: 'shutdown' })
      respond(id, null)
      return
    case 'exit':
      log({ type: 'exit' })
      if (marker) {
        try {
          fs.writeFileSync(marker, 'exited', 'utf8')
        } catch {}
      }
      process.exit(0)
      return
    case 'textDocument/didOpen': {
      const doc = params?.textDocument || {}
      docs.set(doc.uri, doc.text || '')
      notify('textDocument/publishDiagnostics', {
        uri: doc.uri,
        version: doc.version,
        diagnostics: [
          {
            range: { start: { line: 0, character: 2 }, end: { line: 0, character: 6 } },
            severity: 2,
            code: 'mock-warning',
            source: 'mock-lsp',
            message: 'mock diagnostic'
          }
        ]
      })
      return
    }
    case 'textDocument/didChange': {
      const uri = params?.textDocument?.uri
      const changes = Array.isArray(params?.contentChanges) ? params.contentChanges : []
      if (uri && changes.length) {
        const old = docs.get(uri) || ''
        const change = changes[0] || {}
        if (change.range) {
          const offset = offsetOf(old, change.range.start)
          const end = offsetOf(old, change.range.end)
          docs.set(uri, old.slice(0, offset) + (change.text || '') + old.slice(end))
        } else {
          docs.set(uri, change.text || '')
        }
        log({ type: 'didChange', uri, text: docs.get(uri) })
      }
      return
    }
    case 'textDocument/didClose':
      docs.delete(params?.textDocument?.uri)
      return
    case 'textDocument/definition':
      respond(id, {
        uri: params?.textDocument?.uri,
        range: {
          start: { line: 2, character: 0 },
          end: { line: 2, character: 5 }
        }
      })
      return
    case 'textDocument/references':
      respond(id, [
        {
          uri: params?.textDocument?.uri,
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }
        },
        {
          uri: params?.textDocument?.uri,
          range: { start: { line: 4, character: 1 }, end: { line: 4, character: 4 } }
        }
      ])
      return
    case 'textDocument/hover':
      respond(id, {
        contents: { kind: 'markdown', value: '**mock hover**' },
        range: { start: { line: 1, character: 1 }, end: { line: 1, character: 5 } }
      })
      return
    case 'textDocument/completion':
      respond(id, {
        isIncomplete: false,
        items: [
          {
            label: 'mockFn',
            kind: 3,
            detail: '() => void',
            documentation: { kind: 'markdown', value: 'Mock function.' },
            insertText: 'mockFn()',
            sortText: '0001'
          }
        ]
      })
      return
    case 'textDocument/rename':
      respond(id, {
        changes: {
          [params?.textDocument?.uri]: [
            {
              range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
              newText: params?.newName || 'renamed'
            }
          ]
        }
      })
      return
    case 'textDocument/formatting':
      respond(id, [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: '// formatted by mock\n'
        }
      ])
      return
    default:
      error(id, 'unknown method ' + method)
  }
}

function offsetOf(text, position) {
  const line = Math.max(0, position?.line || 0)
  const character = Math.max(0, position?.character || 0)
  let offset = 0
  for (let i = 0; i < line; i++) {
    const next = text.indexOf('\n', offset)
    if (next < 0) return text.length
    offset = next + 1
  }
  return Math.min(text.length, offset + character)
}

process.stdin.on('data', (chunk) => {
  buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) return
    const header = buffer.subarray(0, headerEnd).toString('ascii')
    const match = /Content-Length:\s*(\d+)/i.exec(header)
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4)
      continue
    }
    const length = Number(match[1])
    const start = headerEnd + 4
    if (buffer.length < start + length) return
    const body = buffer.subarray(start, start + length).toString('utf8')
    buffer = buffer.subarray(start + length)
    try {
      handle(JSON.parse(body))
    } catch (e) {
      log({ type: 'parse-error', message: String(e) })
    }
  }
})
`

function verifyDiff() {
  assert.equal(diffChange('abc', 'abc'), null)
  assert.deepEqual(diffChange('abc', 'abcd'), {
    range: { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } },
    text: 'd'
  })
  assert.deepEqual(diffChange('abc', 'abXc'), {
    range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } },
    text: 'X'
  })
  assert.deepEqual(diffChange('abcd', 'abd'), {
    range: { start: { line: 0, character: 2 }, end: { line: 0, character: 3 } },
    text: ''
  })
  assert.deepEqual(diffChange('line1\nline2\nline3', 'line1\nlineX\nline3'), {
    range: { start: { line: 1, character: 4 }, end: { line: 1, character: 5 } },
    text: 'X'
  })
  // emoji 是代理对；range 不能落在两个 code unit 中间
  const emoji = diffChange('a😀b', 'a😁b')
  assert.deepEqual(emoji, {
    range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } },
    text: '😁'
  })
  console.log('verify:lsp diff ok')
}

async function main() {
  verifyDiff()
  const base = path.join(ROOT, '.tmp-build', `lsp-verify-${process.pid}`)
  const ws = path.join(base, 'workspace')
  const marker = path.join(base, 'exit.marker')
  const logFile = path.join(base, 'server.log')
  fs.mkdirSync(ws, { recursive: true })
  write(
    path.join(ws, 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs'),
    MOCK_SERVER
  )
  write(path.join(ws, 'src', 'main.ts'), 'const hello = 1\nexport default hello\n')
  process.env.MOCK_LSP_MARKER = marker
  process.env.MOCK_LSP_LOG = logFile

  const events = []
  host.configureLspHost({
    send: (senderId, channel, payload) => events.push({ senderId, channel, payload }),
    log: () => {}
  })

  const uri = pathToFileURL(path.join(ws, 'src', 'main.ts')).href
  const req = (method, params, senderId = 1) =>
    host.requestLsp(senderId, {
      cwd: ws,
      language: 'typescript',
      method,
      params,
      timeoutMs: 5000
    })

  try {
    const started = await host.startLsp(1, ws, 'typescript')
    assert.equal(started.ok, true, `start should succeed: ${JSON.stringify(started)}`)
    assert.equal(started.server, 'typescript-language-server')
    const ready = events.find(
      (e) => e.channel === 'lsp:state' && e.payload.state === 'ready'
    )
    assert.ok(ready, 'should emit ready state')

    const definition = await req('textDocument/definition', {
      textDocument: { uri },
      position: { line: 1, character: 2 }
    })
    assert.equal(definition.ok, true)
    assert.equal(definition.result.range.start.line, 2)
    assert.equal(definition.result.range.start.character, 0)

    const references = await req('textDocument/references', {
      textDocument: { uri },
      position: { line: 1, character: 2 },
      context: { includeDeclaration: true }
    })
    assert.equal(references.ok, true)
    assert.equal(references.result.length, 2)

    const hover = await req('textDocument/hover', {
      textDocument: { uri },
      position: { line: 1, character: 2 }
    })
    assert.equal(hover.ok, true)
    assert.equal(hover.result.contents.value, '**mock hover**')

    const completion = await req('textDocument/completion', {
      textDocument: { uri },
      position: { line: 1, character: 2 },
      context: { triggerKind: 1 }
    })
    assert.equal(completion.ok, true)
    assert.equal(completion.result.items[0].label, 'mockFn')

    const rename = await req('textDocument/rename', {
      textDocument: { uri },
      position: { line: 1, character: 2 },
      newName: 'renamed'
    })
    assert.equal(rename.ok, true)
    assert.equal(rename.result.changes[uri][0].newText, 'renamed')

    const formatting = await req('textDocument/formatting', {
      textDocument: { uri },
      options: { tabSize: 2, insertSpaces: true }
    })
    assert.equal(formatting.ok, true)
    assert.equal(formatting.result[0].newText, '// formatted by mock\n')

    // 白名单：没列进去的方法不能透传
    const blocked = await req('workspace/executeCommand', {})
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'unsupported')

    // 文档同步 → 诊断事件
    host.notifyLsp(1, {
      cwd: ws,
      language: 'typescript',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri,
          languageId: 'typescript',
          version: 1,
          text: 'const hello = 1\nexport default hello\n'
        }
      }
    })
    host.notifyLsp(1, {
      cwd: ws,
      language: 'typescript',
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version: 2 },
        contentChanges: [
          {
            range: { start: { line: 0, character: 5 }, end: { line: 0, character: 10 } },
            text: 'world'
          }
        ]
      }
    })

    const diagnostics = await waitFor(() =>
      events.find(
        (e) =>
          e.channel === 'lsp:diagnostics' &&
          e.payload.uri === uri &&
          e.payload.diagnostics.length > 0
      )
    )
    assert.ok(diagnostics, 'should receive publishDiagnostics')
    assert.equal(diagnostics.payload.diagnostics[0].severity, 2)
    assert.equal(diagnostics.payload.diagnostics[0].message, 'mock diagnostic')

    // server → client 请求应该拿到宿主的默认响应
    const clientResponses = await waitFor(() => {
      try {
        const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n')
        const parsed = lines.map((line) => JSON.parse(line))
        const config = parsed.find((x) => x.type === 'client-response' && x.id === 9001)
        const edit = parsed.find((x) => x.type === 'client-response' && x.id === 9002)
        return config && edit ? { config, edit } : null
      } catch {
        return null
      }
    })
    assert.ok(clientResponses, 'server requests should receive responses')
    assert.deepEqual(clientResponses.config.result, [{}])
    assert.equal(clientResponses.edit.result.applied, false)

    // 同一工作区第二个窗口 → 独立进程
    assert.equal(host.lspSessionCount(), 1)
    const second = await host.startLsp(2, ws, 'typescript')
    assert.equal(second.ok, true)
    assert.equal(host.lspSessionCount(), 2)
    host.stopLspForSender(2)

    // 停止：shutdown + exit，进程退出
    host.stopLsp(1, ws)
    const exited = await waitFor(() => fs.existsSync(marker), 4000)
    assert.ok(exited, 'server should exit after stop')
    assert.equal(host.lspSessionCount(), 0)

    // Windows 的 .cmd / POSIX 的 shell shim：验证 PATH 探测和 shell 启动路径
    const mockCli = path.join(
      ws,
      'node_modules',
      'typescript-language-server',
      'lib',
      'cli.mjs'
    )
    const binDir = path.join(base, 'bin')
    const savedPath = process.env.PATH
    if (process.platform === 'win32') {
      write(
        path.join(binDir, 'rust-analyzer.cmd'),
        `@echo off\r\n"${process.execPath}" "${mockCli}" %*\r\n`
      )
    } else {
      const shim = path.join(binDir, 'rust-analyzer')
      write(shim, `#!/bin/sh\nexec "${process.execPath}" "${mockCli}" "$@"\n`)
      fs.chmodSync(shim, 0o755)
    }
    process.env.PATH = `${binDir}${path.delimiter}${savedPath || ''}`
    try {
      const rust = await host.startLsp(1, ws, 'rust')
      assert.equal(rust.ok, true, `shell server should start: ${JSON.stringify(rust)}`)
      const rustHover = await host.requestLsp(1, {
        cwd: ws,
        language: 'rust',
        method: 'textDocument/hover',
        params: { textDocument: { uri }, position: { line: 0, character: 0 } },
        timeoutMs: 5000
      })
      assert.equal(rustHover.ok, true)
      assert.equal(rustHover.result.contents.value, '**mock hover**')
      host.stopLsp(1, ws, 'rust')
    } finally {
      process.env.PATH = savedPath
    }

    // 找不到服务器
    process.env.PATH = ''
    try {
      const missing = await host.startLsp(1, ws, 'go')
      assert.equal(missing.ok, false)
      assert.equal(missing.code, 'not-found')
    } finally {
      process.env.PATH = savedPath
    }

    // 没有已知服务器定义的语言
    const unsupported = await host.startLsp(1, ws, 'kotlin')
    assert.equal(unsupported.ok, false)
    assert.equal(unsupported.code, 'unsupported')

    console.log('verify:lsp ok')
    console.log('  framing: split header/body, incremental didChange')
    console.log('  requests: definition, references, hover, completion, rename, formatting')
    console.log('  diagnostics: publishDiagnostics -> IPC event')
    console.log('  server requests: configuration, applyEdit')
    console.log('  lifecycle: per-window sessions, shutdown/exit, not-found, unsupported')
  } finally {
    host.killAllLsp()
    try {
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {}
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
