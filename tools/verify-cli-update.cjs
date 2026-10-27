/*
 * CLI 更新检查 / 更新的冒烟验证。
 *
 * 用法：
 *   npx esbuild src/main/cli-update.ts --bundle --platform=node --format=cjs \
 *     --outfile=tools/_cli-update.cjs
 *   node tools/verify-cli-update.cjs
 *   （或 npm run verify:cli-update）
 *
 * 前半段是纯函数（不联网），后半段会真的跑一次 --version + 问 registry；
 * 断网时只要求「优雅降级成检查失败」，不把网络当失败。
 *
 * **这个脚本不会安装任何东西** —— 更新动作会改开发机的全局 node_modules，
 * 只留给人手动点按钮验证。
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const {
  parseVersion,
  compareVersions,
  isUnder,
  nodeModulesPrefix,
  guessInstallKind,
  installCommand,
  lastMeaningfulLine,
  initCliUpdate,
  cliUpdateStates,
  checkCliUpdate,
  cancelCliUpdate,
  disposeCliUpdate
} = require('./_cli-update.cjs')

let failed = 0
const check = (label, cond, detail) => {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : String(detail).slice(0, 400))
  }
}

const eq = (label, actual, expected) =>
  check(label, actual === expected, `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`)

/* ── 1. 版本解析 ─────────────────────────────────────────── */

console.log('\n[1] parseVersion')
eq('claude --version', parseVersion('2.1.303 (Claude Code)'), '2.1.303')
eq('codex --version', parseVersion('codex-cli 0.163.0'), '0.163.0')
eq('dsh 预发布版', parseVersion('dsh 0.2.1-rc.2'), '0.2.1-rc.2')
eq('带 ANSI 的输出', parseVersion('\x1b[2m1.4.7\x1b[0m'), '1.4.7')
eq('没有版本号', parseVersion('command not found'), undefined)

/* ── 2. 版本比较 ─────────────────────────────────────────── */

console.log('\n[2] compareVersions')
check('2.1.0 > 2.0.31', compareVersions('2.1.0', '2.0.31') > 0)
check('2.0.31 < 2.1.0', compareVersions('2.0.31', '2.1.0') < 0)
eq('相等', compareVersions('1.2.3', '1.2.3'), 0)
check('正式版 > 预发布版', compareVersions('1.0.0', '1.0.0-rc.1') > 0)
check('rc.2 > rc.1', compareVersions('1.0.0-rc.2', '1.0.0-rc.1') > 0)
check('位数补齐（1.2 = 1.2.0）', compareVersions('1.2', '1.2.0') === 0)

/* ── 3. 安装来源判定 ─────────────────────────────────────── */

console.log('\n[3] guessInstallKind / nodeModulesPrefix')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-cli-update-'))
const prefix = path.join(tmp, 'npm-prefix')
const root = path.join(prefix, 'node_modules')
const pkgDir = path.join(root, '@acme', 'tool')
const bin = path.join(prefix, 'tool.cmd')
fs.mkdirSync(pkgDir, { recursive: true })
fs.writeFileSync(path.join(pkgDir, 'package.json'), '{"version":"1.0.0"}')
fs.writeFileSync(bin, '@echo off\n')

eq('prefix 推导', nodeModulesPrefix(root), prefix)
eq('prefix 下的可执行文件', guessInstallKind(bin, [root], '@acme/tool'), 'npm-global')
check('isUnder 大小写不敏感', isUnder(bin.toUpperCase(), prefix))

const otherBin = path.join(tmp, 'elsewhere', 'tool.exe')
fs.mkdirSync(path.dirname(otherBin), { recursive: true })
fs.writeFileSync(otherBin, '')
eq('不在 prefix 下 → other', guessInstallKind(otherBin, [root], '@acme/tool'), 'other')
eq('可执行文件不存在 → missing', guessInstallKind(path.join(tmp, 'nope.exe'), [root], '@acme/tool'), 'missing')
eq('包不在全局目录 → other', guessInstallKind(bin, [path.join(tmp, 'other-node_modules')], '@acme/tool'), 'other')
fs.rmSync(tmp, { recursive: true, force: true })

/* ── 4. 命令与输出 ───────────────────────────────────────── */

console.log('\n[4] installCommand / lastMeaningfulLine')
eq(
  '安装命令固定形状',
  installCommand('@anthropic-ai/claude-code', '2.1.0'),
  'npm install -g @anthropic-ai/claude-code@2.1.0'
)
eq(
  '过滤 npm warn 噪音',
  lastMeaningfulLine('npm warn deprecated foo\nadded 1 package in 3s\n'),
  'added 1 package in 3s'
)
eq('回车分隔的进度', lastMeaningfulLine('10%\r50%\r100%\r'), '100%')
eq('全是噪音时返回 undefined', lastMeaningfulLine('npm warn deprecated x\n'), undefined)

/* ── 5. 真机探测（会联网） ───────────────────────────────── */

async function live() {
  console.log('\n[5] 三个 CLI 的真实检查')
  const events = []
  initCliUpdate({ emit: (e) => events.push(e) })

  const snap = cliUpdateStates()
  check('初始快照包含三个 CLI', Object.keys(snap).length === 3, Object.keys(snap).join(','))

  for (const cli of ['claude', 'codex', 'dsh']) {
    const st = await checkCliUpdate(cli, { force: true })
    console.log(
      `  ${cli}: phase=${st.phase} current=${st.current ?? '—'} latest=${st.latest ?? '—'} kind=${st.installKind}` +
        (st.error ? ` error=${String(st.error).slice(0, 120)}` : '')
    )
    check(`${cli} 有合法 phase`, ['unknown', 'up-to-date', 'available', 'error'].includes(st.phase), st.phase)
    check(`${cli} 检查过会带时间戳`, typeof st.checkedAt === 'number')
    if (st.installed) {
      check(`${cli} 拿到了当前版本`, !!st.current, st.currentRaw)
      check(`${cli} packageName 固定`, st.packageName.startsWith('@'), st.packageName)
    }
    if (st.phase === 'error') {
      check(`${cli} 失败范围是 check`, st.errorScope === 'check')
    }
    if (st.phase === 'available') {
      check(`${cli} 有新版时给出 latest`, !!st.latest)
      check(
        `${cli} canUpdate 与安装方式一致`,
        st.canUpdate === (st.installKind === 'npm-global'),
        `canUpdate=${st.canUpdate} kind=${st.installKind}`
      )
      if (st.canUpdate) check(`${cli} 有更新命令`, /@\d+\.\d+\.\d+/.test(st.command || ''), st.command)
    }
  }

  check('状态变化有事件推出来', events.length > 0, events.length)

  console.log('\n[6] 取消是幂等的（不会真的安装任何东西）')
  // 刻意不在这里调 startCliUpdate：那会真的往开发机的全局 node_modules 里装包。
  // 更新动作留给人手动点按钮验证；这里只确认空转取消不炸、命令形状正确。
  const idle = cancelCliUpdate()
  check('没在更新时取消返回 ok', idle.ok === true, JSON.stringify(idle))
  const claude = cliUpdateStates().claude
  if (claude.phase === 'available' && claude.canUpdate) {
    check(
      '可更新时命令里带具体版本',
      /@\d+\.\d+\.\d+/.test(claude.command || ''),
      claude.command
    )
  }
  check('取消后不会进入 updating', cliUpdateStates().claude.phase !== 'updating')

  disposeCliUpdate()
}

live()
  .catch((e) => {
    console.error(e)
    failed++
  })
  .finally(() => {
    console.log(`\n${failed === 0 ? '冒烟通过 ✓' : `${failed} 项失败 ✗`}`)
    process.exit(failed === 0 ? 0 : 1)
  })
