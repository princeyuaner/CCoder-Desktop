/**
 * 输入历史回归探针：存储 / 去重 / 上限 / 会话身份迁移 / 删除清理。
 *
 * 不启动 Electron —— `ChatController` 的构造和 `recordInput` 只依赖
 * localStorage，用内存实现就能覆盖。由 `npm run verify:input-history`
 * 先用 esbuild 打包再执行，不参与打包产物。
 */
import { acquireChat, forgetInputHistory } from '../src/renderer/src/useChat'

const store = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0
} as unknown as Storage

/* `loadHistory` 走的是 window.api，这里给一个最小 stub */
const transcript = [
  { t: 'user_message', text: 'plain seed', at: '2026-01-01T00:00:00Z' },
  {
    t: 'user_message',
    text:
      'hello\n<ide_reference path="a.ts" lines="1-1" lang="ts">\n```ts\nx\n```\n</ide_reference>\nworld',
    at: '2026-01-01T00:00:01Z'
  },
  { t: 'thinking_delta', text: 'think ' },
  { t: 'text_delta', text: 'part one ' },
  {
    t: 'tool_call',
    id: 'tool-1',
    name: 'Read',
    input: { file_path: 'C:/test/src/a.ts' }
  },
  { t: 'tool_result', id: 'tool-1', status: 'ok', content: 'file body' },
  {
    t: 'turn_end',
    durationMs: 0,
    steps: 3,
    usage: {
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheCreationTokens: 0
    }
  },
  {
    t: 'file_change',
    path: 'C:/test/src/a.ts',
    added: 3,
    removed: 1,
    source: 'agent'
  }
]
;(globalThis as unknown as { window: unknown }).window = {
  api: {
    session: {
      onEvent: () => () => undefined,
      onStatus: () => () => undefined,
      start: async () => 'live-seed',
      stop: () => undefined,
      reconfigure: () => undefined
    },
    sessions: {
      transcript: async () => transcript
    }
  }
}

const init = (resumeId: string | null, cwd = 'C:/test') => ({
  cli: 'claude' as const,
  cwd,
  permissionMode: 'standard' as const,
  effort: 'medium' as const,
  resumeId,
  model: ''
})

let failed = 0
let passed = 0
const check = (label: string, cond: boolean, detail?: unknown): void => {
  if (cond) {
    passed++
    console.log('  PASS', label)
  } else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : JSON.stringify(detail))
  }
}

console.log('══ 输入历史检查 ══\n')

const storedKey = 'stored\u0000claude\u0000C:/test\u0000sess-1'
const c1 = acquireChat(storedKey, init('sess-1'))
c1.recordInput('one')
c1.recordInput('  two  ')
c1.recordInput('two')
check(
  '去空白并去掉相邻重复',
  JSON.stringify(c1.snapshot.inputHistory) === '["one","two"]',
  c1.snapshot.inputHistory
)
check('已有会话立即落盘', [...store.values()][0]?.includes('"two"') === true, [
  ...store.values()
])

const c2 = acquireChat('stored\u0000claude\u0000c:/TEST\u0000sess-1', init('sess-1'))
check(
  '同一条会话复用 controller，历史还在',
  JSON.stringify(c2.snapshot.inputHistory) === '["one","two"]',
  c2.snapshot.inputHistory
)

/*
 * 新会话：CLI 给出 id 之前只放内存；session_started 后迁到稳定键。
 * 这里用不同的 id，避免被 findByProvider 复用回上一条 controller。
 */
const draft = acquireChat('new\u0000claude\u00005', init(null))
draft.recordInput('draft message')
const before = store.size
draft.handleEvent({
  t: 'session_started',
  sessionId: 'sess-2',
  provider: 'claude',
  model: 'm',
  cwd: 'C:/test',
  tools: [],
  permissionMode: 'standard'
})
check('新会话拿到 id 后迁移到稳定键', store.size === before + 1, store.size)
check(
  '迁移内容存在',
  [...store.values()].some((v) => v.includes('draft message')),
  [...store.entries()]
)
check(
  '迁移后快照 history 未丢',
  draft.snapshot.inputHistory.includes('draft message'),
  draft.snapshot.inputHistory
)

check(
  '删除会话时同时清掉历史',
  (() => {
    forgetInputHistory('claude', 'C:\\test\\', 'sess-2')
    return ![...store.values()].some((v) => v.includes('draft message'))
  })()
)

const many = acquireChat('stored\u0000claude\u0000C:/test\u0000sess-many', init('sess-many'))
for (let i = 0; i < 130; i++) many.recordInput(`msg-${i}`)
check('最多保留 100 条', many.snapshot.inputHistory.length === 100, many.snapshot.inputHistory.length)
check('保留的是最新 100 条', many.snapshot.inputHistory[0] === 'msg-30', many.snapshot.inputHistory[0])

const big = acquireChat('stored\u0000claude\u0000C:/test\u0000sess-big', init('sess-big'))
big.recordInput('x'.repeat(150_000))
big.recordInput('tail')
check(
  '字符预算生效，但最新一条永远保留',
  big.snapshot.inputHistory[big.snapshot.inputHistory.length - 1] === 'tail',
  big.snapshot.inputHistory.map((s) => s.length)
)

/*
 * 老会话：本功能上线前发出的消息不在 localStorage 里，靠转写里的
 * user_message 补齐；IDE 引用块要剥掉。
 */
const seeded = acquireChat(
  'stored\u0000claude\u0000C:/test\u0000sess-seed',
  init('sess-seed')
)
void seeded
  .ensureStarted()
  .then(() => {
    check(
      '老会话从转写补齐输入历史',
      seeded.snapshot.inputHistory.includes('plain seed'),
      seeded.snapshot.inputHistory
    )
    check(
      '转写里的 IDE 引用块被剥掉',
      seeded.snapshot.inputHistory.some((v) => v.includes('hello') && !v.includes('ide_reference')),
      seeded.snapshot.inputHistory
    )
    /* 单遍归约的产物：轮数 / 步数 / usage / 本轮修改 / 卡片 */
    check('历史回放的轮数正确', seeded.snapshot.turns === 2, seeded.snapshot.turns)
    check('历史回放的步数正确', seeded.snapshot.steps === 3, seeded.snapshot.steps)
    check(
      '历史回放的 usage 正确',
      seeded.snapshot.usage?.inputTokens === 11 && seeded.snapshot.usage?.outputTokens === 7,
      seeded.snapshot.usage
    )
    check(
      '历史回放只保留最后一轮的修改',
      seeded.snapshot.files.length === 1 &&
        seeded.snapshot.files[0].path.endsWith('src/a.ts') &&
        seeded.snapshot.files[0].added === 3,
      seeded.snapshot.files
    )
    check(
      '历史回放生成两条用户卡片',
      seeded.snapshot.items.filter((i) => i.kind === 'user').length === 2,
      seeded.snapshot.items.map((i) => i.kind)
    )
    check(
      '回放把 delta 合并成一张正文卡',
      seeded.snapshot.items.some((i) => i.kind === 'text' && i.text === 'part one '),
      seeded.snapshot.items
    )
    check(
      '回放的工具卡合上了回执',
      seeded.snapshot.items.some(
        (i) => i.kind === 'tool' && i.id === 'tool-1' && i.status === 'ok' && i.content === 'file body'
      ),
      seeded.snapshot.items
    )
    if (failed > 0) {
      console.log(`\n${failed} 项失败`)
      process.exit(1)
    }
    console.log(`\n全部通过 ✓ (${passed} 项)`)
  })
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
