/*
 * 自动化服务的行为检查（用假的 SessionManager，不真跑 CLI）。
 *
 * 覆盖最容易出错的几条：审批自动拒绝、提问策略、预算、完成后收进程、
 * 落盘与重启后的「中断」修正、以及新会话标题。
 *
 * 用法（见 package.json 的 verify:automation）：
 *   npm run verify:automation
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..')
const { AutomationService } = require(path.join(root, '.tmp-build', 'automation-service.cjs'))

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

const tick = () => new Promise((r) => setTimeout(r, 10))
const cwd = root

function makeSessions() {
  const calls = { start: [], send: [], stop: [], permissions: [], questions: [] }
  let seq = 0
  return {
    calls,
    start(options) {
      const id = `live-${++seq}`
      calls.start.push({ id, options })
      return id
    },
    send(id, input) {
      calls.send.push({ id, input })
      return Promise.resolve({ ok: true })
    },
    stop(id) {
      calls.stop.push(id)
    },
    respondPermission(id, requestId, decision, always) {
      calls.permissions.push({ id, requestId, decision, always })
    },
    respondQuestion(id, requestId, answer) {
      calls.questions.push({ id, requestId, answer })
    }
  }
}

function makeService(dir) {
  const sessions = makeSessions()
  const states = []
  const finished = []
  const titles = []
  const service = new AutomationService({
    sessions,
    dir,
    emitState: (s) => states.push(s),
    emitRunFinished: (p) => finished.push(p),
    titleSession: (t) => titles.push(t)
  })
  return { service, sessions, states, finished, titles }
}

function input(over = {}) {
  return {
    name: '测试任务',
    enabled: true,
    schedule: { kind: 'daily', everyMinutes: 60, time: '09:00', weekdays: [1] },
    cwd,
    cli: 'claude',
    model: '',
    effort: 'medium',
    permissionMode: 'dontAsk',
    sessionMode: 'new',
    resumeSessionId: '',
    prompt: '只回复 OK，不要调用工具。',
    timeoutMinutes: 30,
    budgetUsd: 2,
    onQuestion: 'pause',
    notifySuccess: true,
    notifyFailure: true,
    ...over
  }
}

function startAndRun(env, over) {
  const created = env.service.create(input(over))
  if (!created.ok) throw new Error(`create failed: ${created.message}`)
  const r = env.service.runNow(created.id)
  if (!r.ok) throw new Error(`runNow failed: ${r.message}`)
  const live = env.sessions.calls.start[0].id
  return { taskId: created.id, runId: r.runId, live }
}

function finishOk(env, live, cost = 0.12) {
  env.service.onSessionEvent({
    sessionId: live,
    event: { t: 'session_started', sessionId: 'prov-1', provider: 'claude', model: 'x', cwd, tools: [], permissionMode: 'dontAsk' }
  })
  env.service.onSessionStatus({ sessionId: live, status: 'running', providerSessionId: 'prov-1' })
  env.service.onSessionEvent({
    sessionId: live,
    event: { t: 'text_delta', text: '检查完成：2 个待处理项' }
  })
  env.service.onSessionEvent({
    sessionId: live,
    event: { t: 'turn_end', durationMs: 1000, usage: {}, steps: 1, costUsd: cost }
  })
}

const dirs = []
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-automation-test-'))
  dirs.push(d)
  return d
}

console.log('══ 自动化任务 · 服务行为 ══\n')

/* ── 创建与落盘 ─────────────────────────────────────── */
{
  const dir = tempDir()
  const env = makeService(dir)
  const created = env.service.create(input())
  check('创建任务成功', created.ok === true, created.message)
  check('任务出现在状态里', env.service.getState().tasks.length === 1)
  check('启用的任务有下次运行时间', env.service.getState().tasks[0].nextRunAt > Date.now())
  check('配置文件已落盘', fs.existsSync(path.join(dir, 'automation.json')))

  const bad = env.service.create(input({ name: '   ' }))
  check('拒绝空名称', bad.ok === false)
  const noPrompt = env.service.create(input({ prompt: '  ' }))
  check('拒绝空提示词', noPrompt.ok === false)
  const resume = env.service.create(input({ sessionMode: 'resume', resumeSessionId: '' }))
  check('续跑模式必须有会话 id', resume.ok === false)

  env.service.dispose()
}

/* ── 一次成功运行 ───────────────────────────────────── */
{
  const dir = tempDir()
  const env = makeService(dir)
  const { live } = startAndRun(env)
  check('start 传入了 cwd / 权限模式', env.sessions.calls.start[0].options.cwd === cwd)
  check('prompt 交给了 CLI', env.sessions.calls.send[0].input.text.includes('只回复 OK'))

  finishOk(env, live)
  const state = env.service.getState()
  const run = state.runs[0]
  check('运行状态为成功', run.status === 'ok', run.status)
  check('结果摘要取模型最后一句', run.message === '检查完成：2 个待处理项', run.message)
  check('花费被记录', run.costUsd === 0.12, run.costUsd)
  check('运行结束后进程被收掉', env.sessions.calls.stop.includes(live))
  check('任务记下上次结果', state.tasks[0].lastStatus === 'ok', state.tasks[0].lastStatus)
  check('发出了完成通知', env.finished.length === 1)
  check('通知带新会话标题', env.finished[0]?.title?.includes('测试任务'), env.finished[0]?.title)
  check('给新会话写了侧栏标题', env.titles.length === 1 && env.titles[0].id === 'prov-1')

  env.service.dispose()
}

/* ── 审批自动拒绝 ───────────────────────────────────── */
{
  const dir = tempDir()
  const env = makeService(dir)
  const { live } = startAndRun(env)
  env.service.onSessionEvent({
    sessionId: live,
    event: {
      t: 'permission_request',
      id: 'req-1',
      tool: 'Bash',
      input: { command: 'npm install' },
      preview: {},
      options: []
    }
  })
  const p = env.sessions.calls.permissions[0]
  check('审批被自动拒绝', p?.decision?.behavior === 'deny', p?.decision?.behavior)
  check('拒绝原因是无人值守', /无人值守/.test(p?.decision?.message || ''), p?.decision?.message)

  finishOk(env, live)
  check('拒绝后这一轮仍能正常结束', env.service.getState().runs[0].status === 'ok')
  env.service.dispose()
}

/* ── 提问：暂停 ─────────────────────────────────────── */
{
  const dir = tempDir()
  const env = makeService(dir)
  const { live } = startAndRun(env, { onQuestion: 'pause' })
  env.service.onSessionEvent({
    sessionId: live,
    event: {
      t: 'question_request',
      id: 'q-1',
      tool: 'AskUserQuestion',
      input: {},
      questions: [{ question: '选哪个？', header: '选择', options: [{ label: 'A' }], multiSelect: false }]
    }
  })
  const run = env.service.getState().runs[0]
  check('暂停策略把运行标记为失败', run.status === 'bad', run.status)
  check('失败原因说明需要人工回答', /人工回答/.test(run.message), run.message)
  check('提问后停掉了 CLI', env.sessions.calls.stop.includes(live))
  env.service.dispose()
}

/* ── 提问：跳过 ─────────────────────────────────────── */
{
  const dir = tempDir()
  const env = makeService(dir)
  const { live } = startAndRun(env, { onQuestion: 'deny' })
  env.service.onSessionEvent({
    sessionId: live,
    event: {
      t: 'question_request',
      id: 'q-2',
      tool: 'AskUserQuestion',
      input: {},
      questions: [{ question: '选哪个？', header: '选择', options: [{ label: 'A' }], multiSelect: false }]
    }
  })
  const q = env.sessions.calls.questions[0]
  check('跳过策略回传 skipped', q?.answer?.skipped === true, JSON.stringify(q?.answer))
  check('跳过后运行仍在进行', env.service.getState().runs[0].status === 'running')
  finishOk(env, live)
  env.service.dispose()
}

/* ── 预算 ───────────────────────────────────────────── */
{
  const dir = tempDir()
  const env = makeService(dir)
  const { live } = startAndRun(env, { budgetUsd: 0.05 })
  finishOk(env, live, 0.2)
  const run = env.service.getState().runs[0]
  check('超出预算标记失败', run.status === 'bad', run.status)
  check('失败原因带金额', /0\.20/.test(run.message) && /0\.05/.test(run.message), run.message)
  env.service.dispose()
}

/* ── 重启后修正「运行中」 ───────────────────────────── */
{
  const dir = tempDir()
  const env = makeService(dir)
  startAndRun(env)
  // 不结算就再开一个服务，模拟应用退出
  const second = makeService(dir)
  const run = second.service.getState().runs[0]
  check('重启后残留的运行被标记失败', run.status === 'bad', run.status)
  check('原因说明应用退出', /退出/.test(run.message), run.message)
  env.service.dispose()
  second.service.dispose()
}

/* ── 运行中删除任务 ─────────────────────────────────── */
{
  const dir = tempDir()
  const env = makeService(dir)
  const { taskId, live } = startAndRun(env)
  const r = env.service.remove(taskId)
  check('删除运行中的任务成功', r.ok === true, r.message)
  check('运行被中止并收进程', env.sessions.calls.stop.includes(live))
  check('运行记录保留', env.service.getState().runs.length === 1)
  check('运行标记为失败', env.service.getState().runs[0].status === 'bad')
  env.service.dispose()
}

/* ── 重启后恢复配置 ─────────────────────────────────── */
{
  const dir = tempDir()
  const env = makeService(dir)
  const created = env.service.create(input({ name: '要保留的任务' }))
  env.service.dispose()
  const second = makeService(dir)
  const task = second.service.getState().tasks.find((t) => t.id === created.id)
  check('重启后任务仍在', !!task)
  check('任务字段完整', task?.name === '要保留的任务' && task?.cwd === cwd)
  second.service.dispose()
}

for (const dir of dirs) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // 清理失败不影响结论
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
