/*
 * 抓一次**真实**的 stream-json 输出，每条带相对时间戳。
 *
 * 要回答的问题：思考是"边想边吐 delta"，还是"想完了才一次给"？
 * 光看事件类型看不出来 —— 得看它们到达的**时间分布**。
 *
 * 用法：electron tools/capture-stream.cjs [prompt]
 * 环境变量：
 *   CCODER_SETTINGS  指定 settings.json（默认用户目录下那个）
 * 不参与打包，随时可删。
 */
const { app, safeStorage } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { channelToEnv } = require('./_channel-env.cjs')

const SETTINGS =
  process.env.CCODER_SETTINGS ||
  path.join(os.homedir(), 'AppData', 'Roaming', 'ccoder-desktop', 'settings.json')

/*
 * 必须先认领 app 身份再 whenReady。
 * 新版 Electron 的 safeStorage 走 Chromium 的 app-bound encryption ——
 * 密钥封在**本 app 的 userData 目录**里，且校验调用方可执行文件路径。
 * 不设这两行的话，同一个用户、同一个 electron.exe 也解不开（实测报
 * "Error while decrypting the ciphertext"）。
 */
app.setName('ccoder-desktop')
app.setPath('userData', path.dirname(SETTINGS))

/*
 * electron 在 Windows 上把 stdout 重定向到文件时会攒着，进程不退就看不到东西。
 * 直接同步写文件 —— 抓的就是"什么时候到"，攒着看就没意义了。
 */
const LOG = path.join(__dirname, 'capture-stream.log')
fs.writeFileSync(LOG, '')
const say = (s) => {
  console.log(s)
  fs.appendFileSync(LOG, s + '\n')
}

const PROMPT =
  process.argv[2] ||
  '仔细想一下再回答：一个班 40 个人，至少有几个人的生日在同一个月？只给结论和一行理由。'

/** 磁盘上的 v1 是平铺的 channels；v2 挂在 clis.claude 下面。读的时候都得认 */
function readClaudeChannel() {
  const raw = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))
  const cfg = raw.clis?.claude ?? { activeChannelId: raw.activeChannelId, channels: raw.channels }
  const ch = (cfg.channels ?? []).find((c) => c.id === cfg.activeChannelId) ?? (cfg.channels ?? [])[0]
  if (!ch) throw new Error('settings.json 里没有 claude 渠道')

  // 密钥是 safeStorage 封的，得在 electron 里解
  let token = ''
  const sealed = ch.secret
  if (sealed?.v === 1 && sealed.enc) token = safeStorage.decryptString(Buffer.from(sealed.enc, 'base64'))
  else token = ch.authToken ?? ''

  return { ...ch, authToken: token }
}

app.whenReady().then(() => {
  let ch
  try {
    ch = readClaudeChannel()
  } catch (err) {
    say(`[capture] 读设置失败：${err && err.stack ? err.stack : err}`)
    app.quit()
    return
  }
  say(`[capture] 渠道 ${ch.name} | ${ch.baseUrl} | model=${ch.model}`)

  const bin = path.join(process.env.APPDATA ?? '', 'npm', 'claude.cmd')
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    // 别在用户的历史里留垃圾
    '--no-session-persistence'
  ]
  if (ch.model) args.push('--model', ch.model)

  const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`
  const t0 = Date.now()
  const child = spawn([q(bin), ...args.map(q)].join(' '), {
    env: { ...process.env, ...channelToEnv(ch) },
    cwd: os.homedir(),
    shell: true,
    windowsHide: true
  })

  const stamp = () => `+${String(Date.now() - t0).padStart(6)}ms`
  let buf = ''

  child.stdout.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let o
      try {
        o = JSON.parse(line)
      } catch {
        say(`${stamp()}  <非JSON> ${line.slice(0, 100)}`)
        continue
      }
      const ev = o.event ?? {}
      const dl = ev.delta ?? {}
      const body = dl.thinking ?? dl.text ?? ''
      const what = [o.type, ev.type, dl.type].filter(Boolean).join('/')
      say(`${stamp()}  ${what}${body ? `  ${JSON.stringify(body)}` : ''}`)
    }
  })
  child.stderr.on("data", (d) => say(`${stamp()}  [stderr] ${d.toString().trim()}`))
  child.on('error', (err) => say(`${stamp()}  [spawn 失败] ${err.message}`))

  // prompt 走 stdin —— 和 app 里同一条路
  child.stdin.write(
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: PROMPT }] }
    }) + '\n'
  )

  child.on('close', (code) => {
    say(`[capture] 退出码 ${code}，总耗时 ${Date.now() - t0}ms`)
    app.quit()
  })
})
