/*
 * 自动化任务的计划计算检查。
 *
 * 调度器最怕的不是报错，而是「悄悄算错」：每天 09:00 算成今天 09:00 之后
 * 又立刻重跑、每周任务漏掉当天、间隔任务在休眠后不触发。这些都不会让
 * 应用崩溃，只会让任务在错误的时间跑。这里用固定日期把它们钉死。
 *
 * 用法（见 package.json 的 verify:automation）：
 *   npm run verify:automation
 */
const path = require('node:path')

const root = path.join(__dirname, '..')
const { computeNextRun, normalizeSchedule } = require(
  path.join(root, '.tmp-build', 'automation.cjs')
)

let failed = 0
let passed = 0
const check = (label, cond, detail) => {
  if (cond) {
    passed++
    console.log('  PASS', label)
  } else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : String(detail))
  }
}

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime()
const show = (ms) => new Date(ms).toLocaleString('zh-CN', { hour12: false })
const same = (actual, expected) => actual === expected

console.log('══ 自动化任务 · 计划计算 ══\n')

/* ── 间隔任务 ─────────────────────────────────────────── */
{
  const from = at(2026, 11, 8, 10, 0)
  const next = computeNextRun({ kind: 'interval', everyMinutes: 30 }, from)
  check('间隔 30 分钟 → 30 分钟后', same(next, from + 30 * 60_000), show(next))
  check(
    '间隔任务严格大于起点',
    computeNextRun({ kind: 'interval', everyMinutes: 1 }, from) > from
  )
}

/* ── 每天 ─────────────────────────────────────────────── */
{
  const before = at(2026, 11, 8, 8, 30)
  const next = computeNextRun({ kind: 'daily', time: '09:00' }, before)
  check('每天 09:00，当前 08:30 → 今天 09:00', same(next, at(2026, 11, 8, 9, 0)), show(next))

  const after = at(2026, 11, 8, 10, 0)
  const tomorrow = computeNextRun({ kind: 'daily', time: '09:00' }, after)
  check('每天 09:00，当前 10:00 → 明天 09:00', same(tomorrow, at(2026, 11, 9, 9, 0)), show(tomorrow))

  const exact = at(2026, 11, 8, 9, 0)
  const strictlyAfter = computeNextRun({ kind: 'daily', time: '09:00' }, exact)
  check('恰好等于触发时刻时推到明天', same(strictlyAfter, at(2026, 11, 9, 9, 0)), show(strictlyAfter))

  const monthEnd = computeNextRun({ kind: 'daily', time: '09:00' }, at(2026, 1, 31, 10, 0))
  check('跨月：1/31 10:00 → 2/1 09:00', same(monthEnd, at(2026, 2, 1, 9, 0)), show(monthEnd))
}

/* ── 每周 ─────────────────────────────────────────────── */
{
  // 2026-11-08 是周日
  const sunday = at(2026, 11, 8, 10, 0)
  const monday = computeNextRun(
    { kind: 'weekly', time: '09:00', weekdays: [1] },
    sunday
  )
  check('周日 10:00 → 周一 09:00', same(monday, at(2026, 11, 9, 9, 0)), show(monday))

  const sameDayLater = computeNextRun(
    { kind: 'weekly', time: '18:00', weekdays: [0] },
    sunday
  )
  check('周日 10:00 的周日 18:00 任务 → 今天 18:00', same(sameDayLater, at(2026, 11, 8, 18, 0)), show(sameDayLater))

  const sameDayPassed = computeNextRun(
    { kind: 'weekly', time: '09:00', weekdays: [0] },
    sunday
  )
  check('周日 10:00 的周日 09:00 任务 → 下周日', same(sameDayPassed, at(2026, 11, 15, 9, 0)), show(sameDayPassed))

  const multi = computeNextRun(
    { kind: 'weekly', time: '09:00', weekdays: [1, 3] },
    sunday
  )
  check('周一 / 周三任务取更近的周一', same(multi, at(2026, 11, 9, 9, 0)), show(multi))
}

/* ── 输入收敛 ─────────────────────────────────────────── */
{
  const fallback = normalizeSchedule({ kind: 'nope', everyMinutes: -5, time: '99:99', weekdays: [] })
  check('未知 kind 回落到每天', fallback.kind === 'daily', fallback.kind)
  check('间隔被夹到至少 1 分钟', fallback.everyMinutes === 1, fallback.everyMinutes)
  check('非法时间回落到 09:00', fallback.time === '09:00', fallback.time)
  check('空星期回落到周一', fallback.weekdays.join(',') === '1', fallback.weekdays.join(','))

  const capped = normalizeSchedule({ kind: 'interval', everyMinutes: 999999 })
  check('间隔上限 7 天', capped.everyMinutes === 7 * 24 * 60, capped.everyMinutes)

  const dedup = normalizeSchedule({ kind: 'weekly', time: '09:00', weekdays: [3, 1, 3, 1] })
  check('星期去重并按周一…周日排序', dedup.weekdays.join(',') === '1,3', dedup.weekdays.join(','))

  const sundayLast = normalizeSchedule({ kind: 'weekly', weekdays: [0, 5, 1] })
  check('周日排在周五之后', sundayLast.weekdays.join(',') === '1,5,0', sundayLast.weekdays.join(','))
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
