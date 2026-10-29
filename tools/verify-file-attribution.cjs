/*
 * 「本轮改动」的会话归属。
 *
 * 同一工作区可以同时跑几条会话，轮末的磁盘快照只看目录状态、分不清文件
 * 是谁写的。实测过：A 会话在 B 这一轮跑着的时候写了个 mockup，B 的「本轮
 * 改动」里就冒出了 A 的文件。
 *
 * 这里不 spawn CLI —— 直接摆好两条 Live 的轮前快照和文件归属序号，改盘、
 * 喂工具事件，再看轮末结算出来的磁盘改动。覆盖：
 *   1. 别的会话在本轮开始后用工具写的文件，不进本轮的清单；
 *   2. 写那条文件的会话自己仍然能报出来；
 *   3. 别的会话在本轮**开始前**写过的文件，本会话自己改（Bash 这类没有
 *      工具事件）仍然要报 —— 别过滤过头；
 *   4. 轮前就存在的未跟踪文件不算「本轮新建」；
 *   5. 本轮真正新建的文件才算「新」。
 *
 * 用法（先 npx esbuild 打包，见 package.json 的 verify:file-attribution）：
 *   node tools/verify-file-attribution.cjs
 */
const { execFileSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { SessionManager } = require('../.tmp-build/session-manager.cjs')

const settings = () => ({
  clis: {
    claude: {
      enabled: true,
      activeChannelId: 'ch-a',
      channels: [],
      effort: 'medium',
      authMode: 'channel',
      officialModel: ''
    },
    codex: { enabled: false, activeChannelId: null, channels: [], effort: 'medium', authMode: 'channel', officialModel: '' },
    dsh: { enabled: false, activeChannelId: null, channels: [], effort: 'medium', authMode: 'official', officialModel: '' }
  },
  language: 'zh',
  permissionMode: 'standard',
  defaultCwd: '',
  openedCwds: [],
  theme: 'contrast',
  uiZoom: 1,
  chatFontSize: 14,
  uiFont: '',
  monoFont: '',
  showTimestamps: false,
  thinkingOpen: false,
  toolDetail: 'full',
  sendKey: 'enter',
  notifyOnDone: false,
  editor: {},
  keybindings: {},
  lsp: { enabled: true },
  cliUpdate: { autoCheck: false, tagInNav: false }
})

const manager = new SessionManager(
  () => settings(),
  () => {},
  () => {}
)

let failed = 0
const check = (label, cond, detail) => {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const git = (cwd, args) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

/** 临时 git 仓库：一个已提交文件，好让 untracked / 修改两种状态都能测 */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ccoder-attr-'))
  git(dir, ['init', '-q'])
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  git(dir, ['add', 'a.txt'])
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'])
  return dir
}

const liveOf = (id) => manager.live.get(id)
const start = (cwd) => manager.start({ cli: 'claude', cwd, permissionMode: 'standard' })

/** 模拟轮开始：先取归属序号，再拍磁盘快照（与 SessionManager.send 同序） */
function beginTurn(s) {
  s.claimSeq = manager.fileSeq
  s.diskBefore = manager.snapshotForTurn(s)
}

/** 模拟另一条会话用 Edit / Write 改了文件 */
function toolWrite(s, path, patch = {}) {
  manager.onEvent(s, {
    t: 'file_change',
    path,
    added: 1,
    removed: 0,
    source: 'agent',
    ...patch
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const dir = makeRepo()
  try {
    const a = liveOf(start(dir))
    const b = liveOf(start(dir))
    const mockup = join(dir, 'docs', 'mockup.html')
    mkdirSync(join(dir, 'docs'), { recursive: true })

    console.log('\n[1] 别的会话在 B 本轮里写的文件不进 B 的清单')
    beginTurn(a)
    writeFileSync(mockup, 'v1\n')
    toolWrite(a, mockup, { created: true, wrote: true })
    await sleep(30)

    beginTurn(b)
    await sleep(30)
    writeFileSync(mockup, 'v2\n')
    toolWrite(a, mockup, { source: 'subagent' })

    const bFiles = manager.collectDiskChanges(b)
    check(
      'B 的轮末清单里没有 A 写的 mockup',
      !bFiles.some((c) => c.path === mockup),
      bFiles.map((c) => c.path)
    )

    console.log('\n[2] A 自己报得出来')
    const aFiles = manager.collectDiskChanges(a)
    const aHit = aFiles.find((c) => c.path === mockup)
    check('A 的清单里有 mockup', !!aHit, aFiles.map((c) => c.path))
    check('A 看到的是它自己创建的文件', aHit?.created === true, aHit)

    console.log('\n[3] 轮前就写过的文件，本会话自己改仍要报')
    const old = join(dir, 'docs', 'old.html')
    writeFileSync(old, 'old\n')
    toolWrite(a, old)
    await sleep(30)
    beginTurn(b)
    await sleep(30)
    // B 用 Bash 改的：没有工具事件，只能靠磁盘快照
    appendFileSync(old, 'bash edit\n')
    const fresh = join(dir, 'docs', 'fresh.html')
    writeFileSync(fresh, 'new\n')
    const bFiles2 = manager.collectDiskChanges(b)
    const oldHit = bFiles2.find((c) => c.path === old)
    check('B 的清单里有 old.html', !!oldHit, bFiles2.map((c) => c.path))
    check('轮前已存在的未跟踪文件不算「新」', oldHit?.created !== true, oldHit)

    console.log('\n[4] 本轮真正新建的文件算「新」')
    const freshHit = bFiles2.find((c) => c.path === fresh)
    check('B 的清单里有 fresh.html', !!freshHit, bFiles2.map((c) => c.path))
    check('fresh.html 标成新建', freshHit?.created === true, freshHit)

    console.log(`\n${failed === 0 ? '会话文件归属验证通过 ✓' : `${failed} 项失败 ✗`}`)
  } finally {
    setTimeout(() => rmSync(dir, { recursive: true, force: true }), 200)
  }
  process.exit(failed === 0 ? 0 : 1)
})()
