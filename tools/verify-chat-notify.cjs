/*
 * 「跑完提醒」的两个判断点。
 *
 * 1. 渲染层：只有用户**自己发起**的轮次结束才请求通知 —— 打开会话时主进程
 *    推的那条 idle 不是任何一轮的结束，弹通知就是噪音。
 * 2. 主进程：窗口在前台、且正开着这条会话时不弹；其余情况都弹。
 *
 * 这两条都是"多弹一次"和"该弹不弹"的分界线，不容易从界面上看出来，
 * 所以单独断言。用 tools/electron-stub.cjs 顶掉 electron。
 *
 * 用法：
 *   npx esbuild src/main/chat-notify.ts --bundle --platform=node --format=cjs \
 *     --external:electron --alias:electron=./tools/electron-stub.cjs \
 *     --outfile=.tmp-build/chat-notify.cjs
 *   node tools/verify-chat-notify.cjs
 */
const path = require('node:path')
const fs = require('node:fs')
const Module = require('node:module')

const stubPath = path.join(__dirname, 'electron-stub.cjs')
const stub = require(stubPath)

let failed = 0
function check(label, cond, detail) {
  if (cond) console.log('  PASS', label)
  else {
    failed++
    console.log('  FAIL', label, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300))
  }
}

// 记录每次 new Notification() 的参数，并模拟点击
const shown = []
let clickHandler = null
class FakeNotification {
  constructor(opts) {
    this.opts = opts
    shown.push(opts)
  }
  on(event, cb) {
    if (event === 'click') clickHandler = cb
  }
  show() {}
  close() {}
}
FakeNotification.isSupported = () => true

const fakeWin = {
  isFocused: () => false,
  isDestroyed: () => false,
  isMinimized: () => false,
  webContents: {
    id: 1,
    isDestroyed: () => false,
    send: (channel, payload) => sentToWin.push({ channel, payload })
  },
  restore() {},
  show() {},
  focus() {}
}
const sentToWin = []

const fakeElectron = {
  ...stub,
  Notification: FakeNotification,
  BrowserWindow: {
    ...(stub.BrowserWindow || {}),
    fromWebContents: () => null
  }
}

// 拦截 require('electron')
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron
  return origLoad.call(this, request, parent, isMain)
}

process.env.NODE_ENV = 'test'
const notify = require('../.tmp-build/chat-notify.cjs')

const PAYLOAD = {
  title: 'Claude Code · 已完成',
  body: '帮我看看这段代码',
  target: { cli: 'claude', cwd: 'C:/proj', id: 'sess-1', title: '帮我看看这段代码' }
}

console.log('\n[1] 没有窗口时什么都不做')
{
  shown.length = 0
  notify.maybeNotifyDone(PAYLOAD, null)
  check('不弹', shown.length === 0, shown)
}

console.log('\n[2] 窗口在前台 + 正开着这条会话 → 不弹')
{
  shown.length = 0
  notify.setNotifyMainWindow({ ...fakeWin, isFocused: () => true })
  notify.maybeNotifyDone(PAYLOAD, 'sess-1')
  check('不弹（用户就在看）', shown.length === 0, shown)
}

console.log('\n[3] 窗口在前台 + 开着别的会话 → 弹')
{
  shown.length = 0
  notify.maybeNotifyDone(PAYLOAD, 'sess-2')
  check('弹了', shown.length === 1, shown.length)
  check('标题原样', shown[0]?.title === PAYLOAD.title, shown[0]?.title)
  check('正文原样', shown[0]?.body === PAYLOAD.body, shown[0]?.body)
}

console.log('\n[4] 窗口在后台 → 弹')
{
  shown.length = 0
  notify.setNotifyMainWindow({ ...fakeWin, isFocused: () => false })
  notify.maybeNotifyDone(PAYLOAD, 'sess-1')
  check('弹了（用户在看别的窗口）', shown.length === 1, shown.length)
}

console.log('\n[5] 点通知 → 把窗口带到前台并投递目标')
{
  shown.length = 0
  clickHandler = null
  const win = {
    ...fakeWin,
    webContents: fakeWin.webContents,
    isFocused: () => false,
    isMinimized: () => true,
    restore() {
      this.restored = true
    },
    show() {
      this.shown = true
    },
    focus() {
      this.focused = true
    }
  }
  notify.setNotifyMainWindow(win)
  notify.maybeNotifyDone(PAYLOAD, null)
  check('先弹出来', shown.length === 1, shown.length)
  check('有 click 回调', typeof clickHandler === 'function')
  clickHandler?.()
  check('restore 被调用', win.restored === true)
  check('show 被调用', win.shown === true)
  check('focus 被调用', win.focused === true)
  const sent = sentToWin.find((x) => x.channel === 'chat:focus-session')
  check('投递了 chat:focus-session', !!sent, sentToWin.map((x) => x.channel))
  check('目标正确', sent?.payload?.id === 'sess-1', sent?.payload)
}

console.log('\n[6] 坏数据不弹、不抛')
{
  shown.length = 0
  notify.maybeNotifyDone(null, null)
  notify.maybeNotifyDone({ title: '', body: '', target: null }, null)
  notify.maybeNotifyDone({ title: 'x', body: '', target: { id: '' } }, null)
  check('全被挡掉', shown.length === 0, shown)
}

console.log('\n[7] 通知不可用时安静返回')
{
  shown.length = 0
  FakeNotification.isSupported = () => false
  notify.maybeNotifyDone(PAYLOAD, null)
  check('不弹', shown.length === 0, shown)
  FakeNotification.isSupported = () => true
}

console.log('\n[8] 渲染层只在用户发起的轮次结束时请求通知')
{
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'src', 'useChat.ts'),
    'utf8'
  )
  check('有 turnNotified 闸门', /turnNotified/.test(src))
  check('idle 分支带这个条件', /p\.status === 'idle' && this\.turnNotified/.test(src))
  check('performSend 置位', /this\.turnNotified = true/.test(src))
  check('发完之后清掉', /this\.turnNotified = false/.test(src))
  check('exited 不通知', !/p\.status === 'exited'[\s\S]{0,200}notifyTurnDone/.test(src))
}

if (failed > 0) {
  console.log(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
