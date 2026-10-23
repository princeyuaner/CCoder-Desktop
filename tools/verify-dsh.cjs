/*
 * 验证 DeepSeek Harness（dsh）的 ACP stdio 协议。
 *
 * 不调用模型、不需要 API key：只跑 initialize → session/new →
 * set_config_option → close → list → resume。任何一条协议假设变了，
 * 这里会先红，而不是等到会话跑到一半才发现。
 *
 * 用法：
 *   node tools/verify-dsh.cjs
 *   node tools/verify-dsh.cjs --keep     保留临时 DSH_HOME / workspace
 *
 * 前置：npm i -g @deepseek-ai/dsh，且系统 Node 24+（dsh 的 bin.js
 * 用 import.meta.main 自启动；Node 20 会静默退出 0）。
 *
 * 不参与打包，随时可删。
 */
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const IS_WIN = process.platform === 'win32'
const KEEP = process.argv.includes('--keep')

function pathDirs() {
  return (process.env.PATH || '').split(IS_WIN ? ';' : ':').filter(Boolean)
}

function binJsFromEntry(entry) {
  if (!entry) return null
  if (/\.(m?js)$/i.test(entry)) return fs.existsSync(entry) ? entry : null
  const dir = path.dirname(entry)
  const nearby = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (fs.existsSync(nearby)) return nearby
  const prefix = path.join(
    dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'
  )
  if (fs.existsSync(prefix)) return prefix
  if (!IS_WIN) {
    try {
      const real = fs.realpathSync(entry)
      if (/\.(m?js)$/i.test(real) && fs.existsSync(real)) return real
    } catch {
      // 不是符号链接
    }
  }
  return null
}

function resolveBinJs() {
  const override = (process.env.DSH_BIN || '').trim()
  if (override) return binJsFromEntry(override)

  const dirs = []
  if (IS_WIN) {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'))
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'npm'))
    if (process.env.ProgramFiles) dirs.push(path.join(process.env.ProgramFiles, 'nodejs'))
  } else {
    dirs.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin')
  }
  dirs.push(...pathDirs())

  for (const dir of dirs) {
    for (const rel of [
      ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
      ['..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js']
    ]) {
      const p = path.join(dir, ...rel)
      if (fs.existsSync(p)) return p
    }
    for (const name of IS_WIN ? ['dsh.cmd', 'dsh.ps1', 'dsh'] : ['dsh']) {
      const p = path.join(dir, name)
      if (!fs.existsSync(p)) continue
      const derived = binJsFromEntry(p)
      if (derived) return derived
    }
  }
  return null
}

function assertNodeSupportsImportMetaMain() {
  try {
    execFileSync(
      process.execPath,
      ['--input-type=module', '-e', 'process.exit(import.meta.main === true ? 0 : 1)'],
      { timeout: 5000, stdio: 'ignore', windowsHide: true }
    )
  } catch {
    throw new Error(
      `dsh 需要 Node 24+（当前 ${process.execPath} 不支持 import.meta.main）。` +
        '请换用 Node 24 运行本脚本。'
    )
  }
}

/** 极简 NDJSON JSON-RPC 客户端，只覆盖本脚本用到的请求 */
class Rpc {
  constructor(child) {
    this.child = child
    this.buf = ''
    this.seq = 0
    this.pending = new Map()
    this.stderr = ''
    this.closed = false

    child.stdout.on('data', (d) => this.onData(d.toString()))
    child.stderr.on('data', (d) => {
      this.stderr += d.toString()
      if (this.stderr.length > 8000) this.stderr = this.stderr.slice(-8000)
    })
    child.on('error', (e) => this.failAll(e))
    child.on('close', (code) => {
      this.closed = true
      this.failAll(new Error(`dsh 已退出（${code}）`))
    })
  }

  onData(chunk) {
    this.buf += chunk
    let i
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      this.onMessage(msg)
    }
  }

  onMessage(msg) {
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      // 没有 prompt 时不会出现；真出现就按取消回，别让服务端挂着
      this.respond(msg.id, { outcome: { outcome: 'cancelled' } })
      return
    }
    if (msg.id !== undefined && msg.id !== null) {
      const p = this.pending.get(String(msg.id))
      if (!p) return
      this.pending.delete(String(msg.id))
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
      else p.resolve(msg.result)
      return
    }
    // 通知：session/update 等，本脚本不消费
  }

  request(method, params, timeoutMs = 20000) {
    if (this.closed) return Promise.reject(new Error('dsh 已退出'))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id))
        reject(new Error(`请求超时：${method}`))
      }, timeoutMs)
      this.pending.set(String(id), { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  respond(id, result) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  }

  failAll(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }
}

function sessionConfig(options, id) {
  return (options || []).find((o) => o.id === id || o.category === id)
}

function selectValues(opt) {
  const out = []
  for (const item of (opt && opt.options) || []) {
    if (Array.isArray(item.options)) {
      for (const n of item.options) if (n.value) out.push(n.value)
    } else if (item.value) {
      out.push(item.value)
    }
  }
  return out
}

function fail(msg, rpc) {
  console.error('FAIL:', msg)
  if (rpc && rpc.stderr.trim()) console.error('--- dsh stderr ---\n' + rpc.stderr.trim())
  process.exitCode = 1
}

async function main() {
  const binJs = resolveBinJs()
  if (!binJs) {
    console.log('SKIP: 没有找到 @deepseek-ai/dsh。先运行 npm i -g @deepseek-ai/dsh')
    return
  }

  assertNodeSupportsImportMetaMain()
  console.log('dsh bin.js =', binJs)
  console.log('node       =', process.execPath, process.version)

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-dsh-verify-'))
  const home = path.join(base, 'home')
  const ws = path.join(base, 'ws')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(ws, { recursive: true })
  console.log('DSH_HOME   =', home)
  console.log('workspace  =', ws)

  const child = spawn(process.execPath, [binJs, '--profile', 'acp'], {
    cwd: ws,
    env: { ...process.env, DSH_HOME: home },
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const rpc = new Rpc(child)
  const killer = setTimeout(() => {
    console.error('FAIL: 45 秒内没有跑完')
    try {
      child.kill()
    } catch {
      // ignore
    }
    process.exitCode = 1
  }, 45000)

  try {
    // 1) 握手
    const init = await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      }
    })
    assert.equal(init.protocolVersion, 1, 'initialize 应返回 ACP v1')
    assert.equal(init.agentInfo && init.agentInfo.name, 'deepseek-harness-acp')
    assert.ok(init.agentCapabilities, '缺少 agentCapabilities')
    assert.ok(
      init.agentCapabilities.sessionCapabilities &&
        init.agentCapabilities.sessionCapabilities.list !== undefined,
      '没有声明 session/list'
    )
    assert.ok(
      init.agentCapabilities.sessionCapabilities.resume !== undefined,
      '没有声明 session/resume'
    )
    console.log('ok  initialize')

    // 2) 新会话 + 配置目录
    const created = await rpc.request('session/new', { cwd: ws, mcpServers: [] })
    const sessionId = created.sessionId
    assert.ok(typeof sessionId === 'string' && sessionId.length > 0, '缺少 sessionId')
    const modelOpt = sessionConfig(created.configOptions, 'model')
    const effortOpt =
      sessionConfig(created.configOptions, 'thought_level') ||
      sessionConfig(created.configOptions, 'reasoning_effort')
    assert.ok(modelOpt, '缺少 model 配置项')
    assert.ok(effortOpt, '缺少 reasoning_effort 配置项')
    const models = selectValues(modelOpt)
    const efforts = selectValues(effortOpt)
    assert.ok(models.length > 0, 'model 目录为空')
    assert.ok(efforts.includes('max'), 'reasoning_effort 应包含 max')
    console.log('ok  session/new', sessionId)
    console.log('    models  =', models.join(', '))
    console.log('    efforts =', efforts.join(', '))

    // 3) 设置思考深度
    const effortSet = await rpc.request('session/set_config_option', {
      sessionId,
      configId: effortOpt.id || 'reasoning_effort',
      value: 'max'
    })
    const effortNow =
      sessionConfig(effortSet.configOptions, 'thought_level') ||
      sessionConfig(effortSet.configOptions, 'reasoning_effort')
    assert.equal(effortNow.currentValue, 'max', 'reasoning_effort 没有生效')
    console.log('ok  set reasoning_effort=max')

    // 4) 设置模型为目录里的当前值（不依赖凭据）
    const currentModel = selectValues(modelOpt)[0]
    const modelSet = await rpc.request('session/set_config_option', {
      sessionId,
      configId: modelOpt.id || 'model',
      value: currentModel
    })
    const modelNow = sessionConfig(modelSet.configOptions, 'model')
    assert.ok(modelNow, '设置模型后没有返回完整配置状态')
    assert.equal(modelNow.currentValue, currentModel, '模型没有生效')
    console.log('ok  set model')

    // 5) 关闭 → 列表里应出现（dsh 在 close 时才 flush 持久化）
    await rpc.request('session/close', { sessionId })
    const listed = await rpc.request('session/list', { cwd: ws })
    const ids = (listed.sessions || []).map((s) => s.sessionId)
    assert.ok(ids.includes(sessionId), 'session/list 没有返回刚关闭的会话')
    console.log('ok  close/list')

    // 6) 恢复
    const resumed = await rpc.request('session/resume', {
      sessionId,
      cwd: ws,
      mcpServers: []
    })
    assert.ok(Array.isArray(resumed.configOptions), 'session/resume 没有返回 configOptions')
    await rpc.request('session/close', { sessionId })
    console.log('ok  resume/close')

    clearTimeout(killer)
    child.kill()
    if (!KEEP) fs.rmSync(base, { recursive: true, force: true })
    console.log(KEEP ? `kept: ${base}` : 'cleaned')
    console.log('PASS')
  } catch (e) {
    clearTimeout(killer)
    try {
      child.kill()
    } catch {
      // ignore
    }
    fail(e instanceof Error ? e.message : String(e), rpc)
    if (!KEEP) fs.rmSync(base, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error('FAIL:', e)
  process.exitCode = 1
})
