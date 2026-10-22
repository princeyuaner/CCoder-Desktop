/*
 * 验证「执行台」的数据链路：真实会话记录 → replayRecords → reduceRun。
 * 用法：
 *   esbuild src/main/providers/claude/history.ts --bundle --platform=node --format=cjs --outfile=tools/_history.cjs
 *   esbuild src/renderer/src/run-state.ts --bundle --platform=node --format=cjs --alias:@shared=src/shared --outfile=tools/_run-state.cjs
 *   node tools/verify-runpanel.cjs <会话.jsonl>
 * 不参与打包，随时可删。
 */
const fs = require('node:fs')
const { replayRecords } = require('./_history.cjs')
const { emptyRunState, reduceRun } = require('./_run-state.cjs')

const file = process.argv[2]
if (!file) {
  console.error('用法：node tools/verify-runpanel.cjs <会话.jsonl>')
  process.exit(2)
}

const records = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  })
  .filter(Boolean)

const events = replayRecords(records)
const run = events.reduce((acc, e) => reduceRun(acc, e, false), emptyRunState())

console.log(`events=${events.length}`)
console.log(`tasks=${run.tasks.length} mode=${run.taskMode}`)
for (const t of run.tasks) {
  console.log(`  [${t.status}] #${t.id} ${t.subject}`)
}
console.log(`agents=${run.agents.length}`)
for (const a of run.agents) {
  const stats = a.info && a.info.toolStats
  console.log(
    `  [${a.status}] ${a.type} "${a.description}" ms=${a.ms ?? '-'} tools=${
      a.info && a.info.toolUseCount
    } read=${stats ? stats.readCount : '-'} search=${stats ? stats.searchCount : '-'}`
  )
  if (a.result) console.log(`      result: ${a.result.slice(0, 80)}`)
  if (a.error) console.log(`      error: ${a.error.slice(0, 120)}`)
  if (a.report) console.log(`      report: ${a.report.length} chars`)
  if (a.outputFile) console.log(`      outputFile: ${a.outputFile}`)
}
console.log(`steps=${run.steps} added=${run.added} removed=${run.removed}`)
