/*
 * 把**应用自己的管线**（ClaudeProvider → ClaudeStreamTranslator）接到真 CLI 上跑一轮，
 * 逐条打印它产出的 AgentEvent，带相对时间戳。
 *
 * 和 capture-stream.cjs 的区别：那个看的是 CLI 的原始 NDJSON，
 * 这个看的是**翻译之后、真正会送进转写区的东西** —— 中间那层有没有吞事件，只有这里看得出来。
 *
 * 用法：electron tools/probe-thinking.cjs
 * 不参与打包，随时可删。
 */
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const UD = path.join(os.homedir(), 'AppData', 'Roaming', 'ccoder-desktop')
// safeStorage 是 app-bound 的：不认领身份就解不开（见 capture-stream.cjs 的注释）
app.setName('ccoder-desktop')
app.setPath('userData', UD)

const LOG = path.join(__dirname, 'probe-thinking.log')
fs.writeFileSync(LOG, '')
const say = (s) => fs.appendFileSync(LOG, s + '\n')

function readChannel() {
  const raw = JSON.parse(fs.readFileSync(path.join(UD, 'settings.json'), 'utf8'))
  const cfg = raw.clis?.claude ?? { activeChannelId: raw.activeChannelId, channels: raw.channels }
  const ch = (cfg.channels ?? []).find((c) => c.id === cfg.activeChannelId) ?? (cfg.channels ?? [])[0]
  let token = ''
  if (ch.secret?.v === 1 && ch.secret.enc) {
    token = safeStorage.decryptString(Buffer.from(ch.secret.enc, 'base64'))
  } else token = ch.authToken ?? ''
  return { ...ch, authToken: token }
}

app.whenReady().then(async () => {
  const { ClaudeProvider } = require('./_adapter.cjs')

  let ch
  try {
    ch = readChannel()
  } catch (err) {
    say(`[probe] 读设置失败：${err && err.stack ? err.stack : err}`)
    app.quit()
    return
  }
  say(`[probe] 渠道 ${ch.name} | ${ch.baseUrl} | model=${ch.model}`)

  const t0 = Date.now()
  const stamp = () => `+${String(Date.now() - t0).padStart(6)}ms`

  const provider = new ClaudeProvider()
  const session = provider.start({
    channel: ch,
    cwd: os.homedir(),
    model: ch.model,
    permissionMode: 'standard',
    addDirs: [],
    resumeId: null,
    onEvent: (e) => {
      // 只打类型和长度 —— 思考正文几千字，全打出来没法看
      const extra =
        e.t === 'thinking_delta' || e.t === 'text_delta'
          ? ` ${JSON.stringify(e.text)}`
          : e.t === 'tool_call'
            ? ` ${e.name}`
            : ''
      say(`${stamp()}  ${e.t}${extra}`)
    },
    onExit: (code, stderr) => {
      say(`[probe] onExit code=${code} ${stderr ? stderr.slice(0, 200) : ''}`)
    }
  })

  session.send('仔细想一下再回答：一个班 40 个人，至少有几个人的生日在同一个月？只给结论和一行理由。')

  // 给它 90 秒，然后收工
  setTimeout(() => {
    session.dispose()
    say(`[probe] 结束，总耗时 ${Date.now() - t0}ms`)
    app.quit()
  }, 90_000)
})
