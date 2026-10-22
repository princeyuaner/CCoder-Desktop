/*
 * 端到端验证「测试连接」：渠道 -> 环境变量 -> 解析绝对路径 -> spawn -> 解析结果。
 * 用法：esbuild 打包 claude-runner 后 node tools/verify-channel.cjs
 */
const { testChannel, runClaudeOnce, resolveClaudeBin } = require('./_claude-runner.cjs')

const base = { id: 't', name: 't', kind: 'anthropic', smallFastModel: '', extraEnv: [] }

async function main() {
  console.log('解析到的 claude =', resolveClaudeBin())
  console.log()

  // A) 假 key 打真实端点：应当回报端点自己的 401 原话，而不是"未登录"
  const a = await testChannel({
    ...base,
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-chat',
    authMode: 'token',
    authToken: 'sk-bogus-key'
  })
  console.log('[A] 假 key      ok =', a.ok, '| ', a.latencyMs, 'ms')
  console.log('    message =', a.message.split('\n')[0].slice(0, 120))

  // B) 连不上的地址：应当失败，而不是静默成功。
  //    这条**默认不跑** —— DNS 失败比 401 慢得多，CLI 的 10 次退避重试
  //    实测要 100 秒以上。设 CCODER_SLOW_TESTS=1 才跑。
  let passB = true
  if (process.env.CCODER_SLOW_TESTS === '1') {
    const b = await testChannel({
      ...base,
      baseUrl: 'https://no-such-host.invalid/anthropic',
      model: 'deepseek-chat',
      authMode: 'token',
      authToken: 'sk-x'
    })
    console.log('[B] 坏地址     ok =', b.ok)
    console.log('    message =', b.message.split('\n')[0].slice(0, 120))
    passB = b.ok === false
  } else {
    console.log('[B] 坏地址     已跳过（设 CCODER_SLOW_TESTS=1 启用，约需 100 秒）')
  }

  // C) 恶意/刁钻 prompt：含 %VAR%、空格、换行、引号、& |。
  //    若 prompt 走命令行，cmd 会展开 %PATH% 或直接语法错；走 stdin 则应当
  //    照常发出请求（拿到干净的 401，而不是 shell 报错）。
  const c = await runClaudeOnce({
    channel: {
      ...base,
      baseUrl: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-chat',
      authMode: 'token',
      authToken: 'sk-bogus-key'
    },
    prompt: 'line1 %PATH% & | "quoted"\nline2',
    timeoutMs: 30_000
  })
  const cJson = c.json
  const cResult = cJson && typeof cJson.result === 'string' ? cJson.result : ''
  console.log('[C] 刁钻 prompt 退出码 =', c.code)
  console.log('    message =', cResult.split('\n')[0].slice(0, 120))

  const passA = a.ok === false && /401|invalid|authenticat/i.test(a.message)
  // C 的判据：拿到了 API 层的错误（说明请求确实发出去了），且没有 shell 语法错
  const passC =
    /401|invalid|authenticat/i.test(cResult) &&
    !/is not recognized|不是内部或外部命令|syntax error|语法/i.test(c.stderr + cResult)

  console.log()
  console.log('判定: A =', passA ? 'PASS' : 'FAIL', '| B =', passB ? 'PASS' : 'FAIL', '| C =', passC ? 'PASS' : 'FAIL')
  process.exit(passA && passB && passC ? 0 : 1)
}
main()
