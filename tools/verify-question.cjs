/*
 * 真 CLI 冒烟：AskUserQuestion 从事件到 answers 回传的整条链路。
 * 用法：electron tools/verify-question.cjs
 * 会真花一次模型调用（一个小问题），只在需要验证协议时跑。
 */
const { app, safeStorage } = require('electron')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { ClaudeProvider } = require('./_adapter.cjs')

const SETTINGS = join(process.env.APPDATA, 'ccoder-desktop', 'settings.json')
/** MULTI=1 时验证多选题：答案回传数组，模型应同时看到两个 label */
const MULTI = process.env.MULTI === '1'

app.setName('ccoder-desktop')
app.setPath('userData', join(process.env.APPDATA, 'ccoder-desktop'))

function channel() {
  const raw = JSON.parse(readFileSync(SETTINGS, 'utf8'))
  const cli = raw.clis.claude
  const ch = cli.channels.find((c) => c.id === cli.activeChannelId)
  const token =
    ch.secret.v === 1
      ? safeStorage.decryptString(Buffer.from(ch.secret.enc, 'base64'))
      : ch.secret.plain
  return {
    id: ch.id,
    name: ch.name,
    kind: ch.kind,
    baseUrl: ch.baseUrl,
    model: ch.model,
    smallFastModel: ch.smallFastModel || ch.model,
    authMode: ch.authMode,
    authToken: token,
    extraEnv: ch.extraEnv || []
  }
}

let failed = 0
const check = (label, cond, detail) => {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : String(detail).slice(0, 400))
  }
}

app.whenReady().then(() => {
  let ch
  try {
    ch = channel()
  } catch (e) {
    console.log('  FAIL 读取渠道失败', String(e))
    app.exit(1)
    return
  }

  const provider = new ClaudeProvider()
  let sess = null
  let asked = null
  let text = ''
  let ended = false

  const finish = (why) => {
    if (ended) return
    ended = true
    console.log('\n[result]', why)
    check('收到 question_request', !!asked)
    if (asked) {
      const q = asked.questions?.[0]
      check('  题目归一化', !!q?.question, JSON.stringify(asked.questions)?.slice(0, 200))
      check('  至少两个选项', (q?.options?.length ?? 0) >= 2, q?.options?.length)
    }
    if (MULTI) {
      check('  是多选题', asked?.questions?.[0]?.multiSelect === true, asked?.questions?.[0]?.multiSelect)
      check('模型读到了两个答案', /Red/i.test(text) && /Blue/i.test(text), text.slice(-300))
    } else {
      check('模型读到了答案', /Red/i.test(text), text.slice(-300))
    }
    console.log(`\n${failed === 0 ? '提问链路通过 ✓' : `${failed} 项失败 ✗`}`)
    setTimeout(() => app.exit(failed === 0 ? 0 : 1), 150)
  }

  sess = provider.start({
    channel: ch,
    cwd: process.env.TEMP || process.cwd(),
    model: ch.model,
    permissionMode: 'standard',
    effort: 'medium',
    addDirs: [],
    resumeId: null,
    onEvent: (e) => {
      if (e.t === 'question_request') {
        asked = e
        const q = e.questions[0]
        console.log('[question]', JSON.stringify(q).slice(0, 600))
        const answers = MULTI
          ? [q.options[0].label, q.options[1].label]
          : q.options[0].label
        sess?.respondQuestion(e.id, {
          answers: { [q.question]: answers }
        })
      }
      if (e.t === 'text_delta') text += e.text
      if (e.t === 'turn_end') finish('turn_end')
      if (e.t === 'error') console.log('[error]', e.message)
    },
    onExit: (code, stderr) => {
      if (!ended) finish(`exit ${code} ${stderr?.slice(-200) ?? ''}`)
    }
  })

  sess.send({
    text: MULTI
      ? 'Use the AskUserQuestion tool exactly once to ask me "Which colors do you want?" ' +
        'with header "Colors", multiSelect set to true, and exactly two options: "Red" and "Blue", ' +
        'with short descriptions. Do not call any other tool. After I answer, reply with one short ' +
        'sentence that lists every color I chose.'
      : 'Use the AskUserQuestion tool exactly once to ask me "Which color do you prefer?" ' +
        'with header "Color" and exactly two options: "Red" and "Blue", with short descriptions. ' +
        'Do not call any other tool. After I answer, reply with one short sentence that includes my chosen color.'
  })

  setTimeout(() => finish('timeout'), 75_000)
})
