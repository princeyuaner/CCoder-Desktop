/*
 * 冒烟：真跑一次 CLI，确认它说的话还是我们解析的那套。
 *
 * **只保留一个用例**。失败请求会被 CLI 重试最多 10 次（实测单次 4.2 秒），
 * 多写几个用例就是几十秒的等待。解析逻辑的正确性由 verify:translate 用
 * 录制的 fixture 覆盖，这里只负责"真东西还认不认"。
 *
 * 用法：esbuild 打包 adapter 后 node tools/verify-turn.cjs
 */
const { ClaudeProvider, buildClaudeArgs } = require('./_adapter.cjs')

const CHANNEL = {
  id: 't',
  name: 't',
  kind: 'anthropic',
  baseUrl: 'https://api.deepseek.com/anthropic',
  model: 'deepseek-chat',
  smallFastModel: '',
  authMode: 'token',
  authToken: 'sk-bogus-key',
  extraEnv: []
}

let failed = 0
function check(label, cond, detail) {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : String(detail).slice(0, 200))
  }
}

function main() {
  // 参数构造是纯函数，先测它（不花时间）
  const args = buildClaudeArgs({ model: 'm', permissionMode: 'standard', addDirs: [] }).join(' ')
  console.log('\n[0] 参数构造')
  check('长驻输入', args.includes('--input-format stream-json'))
  check('事件输出', args.includes('--output-format stream-json'))
  check('权限宿主', args.includes('--permission-prompts host'))
  // 只传 --permission-prompts host 时 CLI 会把 AskUserQuestion 从工具表里拿掉；
  // 这个参数是让它留在工具表里的开关（实测 2.1.303）。
  check('提问工具可用', args.includes('--permission-prompt-tool stdio'))
  check('standard → manual', args.includes('--permission-mode manual'))
  // 让运行中切到 bypassPermissions 成为可能（否则 CLI 回 bypass_not_launched）
  check('bypass 可切换', args.includes('--allow-dangerously-skip-permissions'))
  check('逐 token 流式', args.includes('--include-partial-messages'))

  console.log('\n[1] 真 CLI 冒烟（约 5 秒，等 CLI 重试结束）')
  const t0 = Date.now()
  const events = []
  const provider = new ClaudeProvider()

  const sess = provider.start({
    channel: CHANNEL,
    cwd: process.cwd(),
    model: CHANNEL.model,
    permissionMode: 'standard',
    effort: 'medium',
    addDirs: [],
    mcpServers: [],
    resumeId: null,
    onEvent: (e) => {
      events.push(e)
      // 长驻进程不会因为一轮结束就自己退；收齐结果后主动收摊，onExit 才会跑检查
      if (e.t === 'turn_end') setTimeout(() => sess.dispose(), 50)
    },
    onExit: () => {
      const ms = Date.now() - t0
      const init = events.find((e) => e.t === 'session_started')
      const err = events.find((e) => e.t === 'error')
      const end = events.find((e) => e.t === 'turn_end')

      check(`init 可解析（${ms}ms）`, !!init && !!init.sessionId, JSON.stringify(init)?.slice(0, 120))
      check('  拿到了模型名', !!init?.model, init?.model)
      check('  拿到了工具表', (init?.tools?.length ?? 0) > 0, init?.tools?.length)
      check('401 翻译成 error 事件', !!err && /401|invalid|authenticat/i.test(err.message))
      check('turn_end 带用量', !!end && typeof end.usage?.inputTokens === 'number')

      console.log(`\n${failed === 0 ? '冒烟通过 ✓' : `${failed} 项失败 ✗`}`)
      process.exit(failed === 0 ? 0 : 1)
    }
  })

  sess.send({ text: 'say hi' })

  // 兜底：万一 CLI 卡住，别让验证永远挂着
  setTimeout(() => {
    console.log('  FAIL 超过 30 秒未结束')
    process.exit(1)
  }, 30_000)
}

main()
