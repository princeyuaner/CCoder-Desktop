/*
 * 验证 `/` 指令表的合并、去重与搜索。
 *
 * 用法：
 *   esbuild src/renderer/src/commands.ts --bundle --platform=node --format=cjs \
 *     --alias:@shared=src/shared --outfile=tools/_commands.cjs
 *   node tools/verify-commands.cjs
 *
 * 纯数据，不需要 Electron / CLI。
 */
const { buildCommandItems, filterCommands } = require('./_commands.cjs')

let failed = 0
function check(label, cond, detail) {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300))
  }
}

const t = (key) =>
  ({
    'commands.group.skills': 'Skills',
    'commands.group.session': 'Session',
    'commands.group.modelPermissions': 'Model & permissions',
    'commands.group.system': 'System'
  })[key] ?? key

/* ── Claude：动态表 + 宿主指令去重/分组 ─────────────────── */

const claudeNative = [
  { name: 'clear', description: 'native clear', run: 'send', group: 'command' },
  { name: 'context', description: 'show context usage', run: 'send', group: 'command' },
  {
    name: 'debug-issue',
    label: 'Debug Issue',
    description: 'debug things',
    aliases: ['debug-issue'],
    run: 'send',
    group: 'skill'
  },
  { name: 'dataviz', description: 'make charts', run: 'send', group: 'skill' }
]

const claude = buildCommandItems(t, 'claude', claudeNative)
const names = claude.map((c) => c.name)
check('CCoder /clear 只出现一次', names.filter((n) => n === '/clear').length === 1, names)
check('原生 clear 被 CCoder 版本去重', claude.find((c) => c.name === '/clear')?.source === 'app')
check('原生 context 被加入', names.includes('/context'), names)
check('技能 dataviz 被加入', names.includes('/dataviz'), names)
check(
  '原生指令排在技能前（分组连续）',
  names.indexOf('/context') < names.indexOf('/dataviz'),
  names
)
check(
  '展示名和发送名分开',
  claude.find((c) => c.name === '/debug-issue')?.label === 'Debug Issue' &&
    claude.find((c) => c.name === '/debug-issue')?.kind === 'skill'
)

const filteredAlias = filterCommands(claude, 'debug issue').map((c) => c.name)
check('按展示名搜索命中', filteredAlias.includes('/debug-issue'), filteredAlias)
const filteredHint = filterCommands(claude, 'show context').map((c) => c.name)
check('按参数/描述搜索命中', filteredHint.includes('/context'), filteredHint)

/* ── Codex：静态可执行子集 ──────────────────────────────── */

const codex = buildCommandItems(t, 'codex', [])
const codexNames = codex.map((c) => c.name)
check('Codex /plan 存在', codexNames.includes('/plan'), codexNames)
check('Codex /new 存在', codexNames.includes('/new'), codexNames)
check('Codex /mention 存在', codexNames.includes('/mention'), codexNames)
check('Codex 不重复 /permissions', codexNames.filter((n) => n === '/permissions').length === 1)
check(
  'Codex /mention 是插入动作',
  codex.find((c) => c.name === '/mention')?.action === 'insert' &&
    codex.find((c) => c.name === '/mention')?.insert === '@'
)
check('Codex 不含不可执行的 /goal', !codexNames.includes('/goal'), codexNames)

/* ── dsh：静态可执行子集 ───────────────────────────────── */

const dsh = buildCommandItems(t, 'dsh', [])
const dshNames = dsh.map((c) => c.name)
check('dsh /permission 存在', dshNames.includes('/permission'), dshNames)
check('dsh /plan 存在', dshNames.includes('/plan'), dshNames)
check('dsh 不含不可执行的 /compact（原生）', dshNames.filter((n) => n === '/compact').length === 1)
check('dsh 不含 /goal', !dshNames.includes('/goal'), dshNames)

console.log(failed === 0 ? '\n全部通过 ✓' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
