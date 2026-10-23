/*
 * Claude 官方登录：解析器 + 本机状态探测。
 * 用法：
 *   npx esbuild src/main/claude-auth.ts --bundle --platform=node --format=cjs \
 *     --outfile=tools/_claude-auth.cjs
 *   node tools/verify-claude-auth.cjs
 *
 * 不发起真实登录（那需要人在浏览器里操作）；只验证：
 *  - auth status --json 能被正确探测 / 解析
 *  - URL 只认 https + Anthropic 自家域名
 *  - 账号字段的嵌套变体能被取出来
 */
const {
  probeClaudeAuth,
  parseClaudeAuthStatus,
  parseClaudeAuthUrl,
  initClaudeAuth,
  startClaudeLogin,
  cancelClaudeLogin,
  claudeLoginSnapshot
} = require('./_claude-auth.cjs')

let failed = 0
const ok = (cond, name, extra) => {
  if (cond) {
    console.log('  ✓', name)
  } else {
    failed++
    console.log('  ✗', name, extra === undefined ? '' : extra)
  }
}

async function main() {
  console.log('[1] URL 解析')
  const line =
    'If the browser didn\u2019t open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y'
  ok(
    parseClaudeAuthUrl(line) ===
      'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y',
    '从 CLI 输出里认出授权 URL'
  )
  ok(parseClaudeAuthUrl('https://evil.example/oauth') === null, '拒绝非 Anthropic 域名')
  ok(parseClaudeAuthUrl('javascript:alert(1)') === null, '拒绝 javascript:')
  ok(parseClaudeAuthUrl('https://platform.claude.com/oauth/code/callback') !== null, '允许子域名')

  console.log('[2] 状态字段解析')
  const nested = parseClaudeAuthStatus({
    loggedIn: true,
    authMethod: 'oauth_token',
    apiProvider: 'firstParty',
    account: { email: 'dev@example.com' },
    organizationName: 'Example Org',
    subscriptionType: 'max'
  })
  ok(nested.loggedIn === true, 'loggedIn')
  ok(nested.email === 'dev@example.com', 'account.email')
  ok(nested.organizationName === 'Example Org', 'organizationName')
  ok(nested.subscriptionType === 'max', 'subscriptionType')

  const top = parseClaudeAuthStatus({
    loggedIn: false,
    authMethod: 'none',
    email: 'solo@example.com'
  })
  ok(top.loggedIn === false, '未登录')
  ok(top.email === 'solo@example.com', '顶层 email')
  ok(parseClaudeAuthStatus(null).loggedIn === false, 'null 不抛错')

  console.log('[3] 本机真实探测')
  const st = await probeClaudeAuth()
  console.log('     ', JSON.stringify(st))
  ok(typeof st.installed === 'boolean', 'installed 是布尔')
  ok(typeof st.loggedIn === 'boolean', 'loggedIn 是布尔')
  ok(typeof st.checkedAt === 'number', 'checkedAt')
  if (st.installed) {
    ok(!!st.version, '拿到版本号')
    ok(st.authMethod.length > 0, '拿到 authMethod')
  }

  /*
   * 可选的登录进程冒烟测试：只启动、观察、取消，**不提交授权码**。
   * 设 CCCODER_LIVE_AUTH=1 才跑 —— 它会真的 spawn 一个 `claude auth login`，
   * 但 BROWSER=echo 且 openExternal 没注入，不会打开浏览器。
   */
  if (process.env.CCCODER_LIVE_AUTH === '1') {
    console.log('[4] 登录流程（启动 / 取消）')
    const events = []
    initClaudeAuth({
      emit: (e) => {
        events.push(e)
        if (e.t === 'url') console.log('      URL =', e.url.slice(0, 80) + '…')
      }
    })
    const started = startClaudeLogin()
    ok(started.ok, '登录进程启动', started.message)
    await new Promise((r) => setTimeout(r, 4000))
    const snap = claudeLoginSnapshot()
    console.log('      phase =', snap.phase, '| url =', snap.url ? '有' : '无')
    const cancelled = cancelClaudeLogin()
    ok(cancelled.ok, '取消登录')
    ok(claudeLoginSnapshot().running === false, '取消后没有残留进程')
  }

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
