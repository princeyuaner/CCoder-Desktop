/*
 * 更新卡片的渲染冒烟：把 CliUpdatePanel 用 react-dom/server 渲染成 HTML，
 * 逐个人肉可读的状态检查文案与按钮有没有出来。
 *
 * 用法：
 *   npx esbuild src/renderer/src/components/CliUpdatePanel.tsx --bundle \
 *     --platform=node --format=cjs --jsx=automatic --alias:@shared=./src/shared \
 *     --external:react --external:react-dom --outfile=tools/_cli-update-panel.cjs
 *   node tools/verify-cli-update-panel.cjs
 *
 * 覆盖的是「状态 → 文案/按钮」这一层；真实 IPC 与安装动作不在这里跑。
 */
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

/*
 * 渲染层里 `window.api.platform` 决定要不要显示「以管理员身份重试」。
 * 这里给一个最小桩，让渲染走和真实窗口一样的分支（默认按 Windows 跑）。
 */
globalThis.window = { api: { platform: 'win32' } }

const { CliUpdatePanel, UpdateConfirmDialog } = require('./_cli-update-panel.cjs')

let failed = 0
const check = (label, cond, detail) => {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : String(detail).slice(0, 300))
  }
}

const BASE = {
  cli: 'claude',
  packageName: '@anthropic-ai/claude-code',
  notesUrl: 'https://example.com/notes',
  installed: true,
  path: 'C:\\Users\\CY\\AppData\\Roaming\\npm\\claude.cmd',
  current: '2.0.31',
  currentRaw: '2.0.31 (Claude Code)',
  latest: '2.1.0',
  installKind: 'npm-global',
  checkedAt: Date.now() - 60 * 60_000
}

const CMD = 'npm install -g @anthropic-ai/claude-code@2.1.0'

const CASES = [
  {
    label: '有新版本：强调态 + 更新按钮 + 要执行的命令',
    state: { ...BASE, phase: 'available', canUpdate: true, command: CMD },
    want: ['发现新版本', '2.1.0', '更新到 2.1.0', 'npm install -g @anthropic-ai/claude-code@2.1.0', '更新说明']
  },
  {
    label: '已是最新',
    state: { ...BASE, phase: 'up-to-date', canUpdate: false },
    want: ['已是最新', '2.0.31', '检查更新']
  },
  {
    label: '非 npm 安装：降级成复制命令',
    state: { ...BASE, phase: 'available', canUpdate: false, installKind: 'other' },
    want: ['无法自动更新', '复制命令', 'claude update']
  },
  {
    label: '更新中：进度条 + 取消 + 执行中',
    state: { ...BASE, phase: 'updating', command: CMD, startedAt: Date.now() - 9000, line: 'added 1 package' },
    want: ['正在更新到', 'prog--indeterminate', '取消', '执行中', 'added 1 package']
  },
  {
    label: '更新完成：说明生效范围',
    state: { ...BASE, phase: 'done', current: '2.1.0', canUpdate: false },
    want: ['已更新到', '2.1.0', '新开的会话']
  },
  {
    label: '检查失败：不报红，给重试',
    state: { ...BASE, phase: 'error', errorScope: 'check', error: 'HTTP 503' },
    want: ['检查更新失败', 'HTTP 503', '重试']
  },
  {
    label: '更新失败 + 权限不足：复制命令 / 管理员重试',
    state: {
      ...BASE,
      phase: 'error',
      errorScope: 'update',
      needAdmin: true,
      command: CMD,
      error: 'npm ERR! code EPERM'
    },
    want: ['更新失败', '权限不足', '复制命令', '以管理员身份重试', 'npm ERR! code EPERM']
  },
  {
    label: '没装：不显示更新动作',
    state: { ...BASE, phase: 'unknown', installed: false, installKind: 'missing' },
    want: ['没有检测到已安装的 CLI']
  },
  {
    label: '首帧（还没拿到快照）',
    state: null,
    want: ['正在检查新版本']
  }
]

const noop = () => undefined
const asyncNoop = async () => ({ ok: true })

console.log('\n[1] 各状态渲染')
for (const c of CASES) {
  let html = ''
  try {
    html = renderToStaticMarkup(
      React.createElement(CliUpdatePanel, {
        cli: 'claude',
        name: 'Claude Code',
        state: c.state,
        autoCheck: true,
        tagInNav: true,
        runningSessions: 2,
        onAutoCheck: noop,
        onTagInNav: noop,
        onCheck: noop,
        onRun: asyncNoop,
        onRunElevated: asyncNoop,
        onCancel: noop
      })
    )
  } catch (e) {
    failed++
    console.log('  FAIL', c.label, '渲染抛错：', e && e.message)
    continue
  }
  const missing = c.want.filter((w) => !html.includes(w))
  check(c.label, missing.length === 0, `缺少：${missing.join(' / ')}`)
}

console.log('\n[2] 结构检查')
const available = renderToStaticMarkup(
  React.createElement(CliUpdatePanel, {
    cli: 'claude',
    name: 'Claude Code',
    state: { ...BASE, phase: 'available', canUpdate: true, command: CMD },
    autoCheck: true,
    tagInNav: true,
    runningSessions: 0,
    onAutoCheck: noop,
    onTagInNav: noop,
    onCheck: noop,
    onRun: asyncNoop,
    onRunElevated: asyncNoop,
    onCancel: noop
  })
)
check('有「更新」分区标题', available.includes('secthead') && available.includes('更新'))
check('两个开关都在', (available.match(/class="switch"/g) || []).length === 2)
check('命令条只出现一次', (available.match(/updcmd"/g) || []).length === 1)
check('状态卡复用现有样式', available.includes('statuscard'))
check('没有把确认弹窗默认渲染出来', !available.includes('modal__dlg'))

const noUpdate = renderToStaticMarkup(
  React.createElement(CliUpdatePanel, {
    cli: 'claude',
    name: 'Claude Code',
    state: { ...BASE, phase: 'up-to-date', canUpdate: false },
    autoCheck: false,
    tagInNav: true,
    runningSessions: 0,
    onAutoCheck: noop,
    onTagInNav: noop,
    onCheck: noop,
    onRun: asyncNoop,
    onRunElevated: asyncNoop,
    onCancel: noop
  })
)
check('已是最新时不显示命令条', !noUpdate.includes('updcmd'))
check('自动检查关闭时标题右侧改文案', noUpdate.includes('自动检查已关闭'))

/* 非 Windows 上不显示「以管理员身份重试」—— 那个动作只在 Windows 有实现 */
console.log('\n[3] 平台差异')
globalThis.window = { api: { platform: 'darwin' } }
const macHtml = renderToStaticMarkup(
  React.createElement(CliUpdatePanel, {
    cli: 'claude',
    name: 'Claude Code',
    state: {
      ...BASE,
      phase: 'error',
      errorScope: 'update',
      needAdmin: true,
      command: CMD,
      error: 'EACCES'
    },
    autoCheck: true,
    tagInNav: true,
    runningSessions: 0,
    onAutoCheck: noop,
    onTagInNav: noop,
    onCheck: noop,
    onRun: asyncNoop,
    onRunElevated: asyncNoop,
    onCancel: noop
  })
)
check('macOS 上不给提权重试按钮', !macHtml.includes('以管理员身份重试'))
check('但仍可复制命令', macHtml.includes('复制命令'))

/* 确认弹窗单独渲染（它是 position:fixed 的，跟卡片不在一起测） */
console.log('\n[4] 确认弹窗')
globalThis.window = { api: { platform: 'win32' } }
const dlg = renderToStaticMarkup(
  React.createElement(UpdateConfirmDialog, {
    name: 'Claude Code',
    command: CMD,
    count: 2,
    current: '2.0.31',
    latest: '2.1.0',
    onCancel: noop,
    onConfirm: noop
  })
)
for (const [label, want] of [
  ['标题带 CLI 名', '更新 Claude Code'],
  ['展示要执行的命令', CMD],
  ['说明不影响运行中的会话', '不会打断正在运行的 2 个会话'],
  ['给出新旧版本号', '2.0.31'],
  ['有取消与开始按钮', '开始更新'],
  ['是模态对话框', 'aria-modal="true"']
]) {
  check(label, dlg.includes(want), want)
}

console.log(`\n${failed === 0 ? '渲染冒烟通过 ✓' : `${failed} 项失败 ✗`}`)
process.exit(failed === 0 ? 0 : 1)
