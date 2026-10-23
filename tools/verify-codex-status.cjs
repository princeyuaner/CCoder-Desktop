/*
 * Codex 接入冒烟：只做 app-server 握手 + thread/start，不发模型请求。
 *
 * 用法：
 *   CODEX_BIN=<codex 可执行文件> node tools/verify-codex-status.cjs
 *
 * 需要先：
 *   npx esbuild src/main/providers/codex/adapter.ts --bundle --platform=node \
 *     --format=cjs --outfile=tools/_codex-adapter.cjs
 *   npx esbuild src/main/codex-runner.ts --bundle --platform=node \
 *     --format=cjs --outfile=tools/_codex-runner.cjs
 */
const path = require('node:path')
const os = require('node:os')
const { mkdtempSync } = require('node:fs')

process.env.CODEX_HOME = process.env.CODEX_HOME || mkdtempSync(path.join(os.tmpdir(), 'ccoder-codex-verify-'))
if (!process.env.CODEX_BIN) {
  console.error('请用 CODEX_BIN 指向一个 codex 可执行文件')
  process.exit(2)
}

const { checkCodexStatus } = require('./_codex-runner.cjs')
const { CodexProvider } = require('./_codex-adapter.cjs')

const CHANNEL = {
  id: 'verify',
  name: 'verify',
  kind: 'openai',
  baseUrl: 'http://127.0.0.1:9/v1',
  model: 'gpt-5',
  models: [],
  smallFastModel: '',
  authMode: 'token',
  authToken: 'sk-verify',
  wireApi: 'responses',
  extraEnv: []
}

let failed = 0
const check = (label, cond, detail) => {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : String(detail).slice(0, 400))
  }
}

async function main() {
  console.log('\n[1] checkCodexStatus')
  const status = await checkCodexStatus()
  console.log('  ', JSON.stringify(status))
  check('识别为已安装', status.installed === true)
  check('拿到版本号', !!status.version, status.version)
  check('app-server 握手成功', status.appServerOk === true, status.error)

  console.log('\n[2] Provider 启动（thread/start，不发送）')
  const events = []
  const session = new CodexProvider().start({
    channel: CHANNEL,
    cwd: process.cwd(),
    model: CHANNEL.model,
    permissionMode: 'standard',
    effort: 'medium',
    addDirs: [],
    resumeId: null,
    onEvent: (e) => {
      events.push(e)
      console.log('  event', JSON.stringify(e).slice(0, 300))
    },
    onExit: (code, stderr) => console.log('  exit', code, String(stderr).slice(-300))
  })

  const started = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 25_000)
    const tick = setInterval(() => {
      const s = events.find((e) => e.t === 'session_started')
      if (s) {
        clearTimeout(t)
        clearInterval(tick)
        resolve(s)
      }
      const err = events.find((e) => e.t === 'error')
      if (err) {
        clearTimeout(t)
        clearInterval(tick)
        resolve(err)
      }
    }, 100)
  })

  check('收到 session_started', !!started && started.t === 'session_started', JSON.stringify(started))
  check('sessionId 是 thread id', !!(started && started.sessionId), started && started.sessionId)
  check('provider 是 codex', !!started && started.provider === 'codex', started && started.provider)
  check('模型名回填', !!started && !!started.model, started && started.model)

  session.dispose()
  console.log(`\n${failed === 0 ? '冒烟通过 ✓' : `${failed} 项失败 ✗`}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
