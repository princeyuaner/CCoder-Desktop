import { BrowserWindow, Notification } from 'electron'
import type { SessionFocusTarget, SessionNotifyPayload } from '../shared/session'
import { IPC } from '../shared/ipc'
import { logMain } from './crash-log'
import { safeSend } from './safe-send'

/**
 * 一轮跑完的系统通知。
 *
 * 为什么判断放在主进程：只有它知道窗口是不是在前台、最小化了没有。
 * 渲染层负责拼文案（只有它知道当前语言和会话标题），弹不弹由这里决定 ——
 * 用户正盯着这条会话看的时候弹通知纯属噪音。
 *
 * 和 sync/service.ts 里那套一样，Notification 对象必须显式攥住：
 * 只写 `new Notification(...).show()` 的话对象可能被 GC，点击回调就收不到。
 */

const active = new Set<Notification>()

/** 主窗口引用由 index.ts 建窗口时登记 */
let mainWin: BrowserWindow | null = null

export function setNotifyMainWindow(win: BrowserWindow | null): void {
  mainWin = win
  if (!win) {
    // 窗口关了，留着通知也没处点
    for (const n of active) n.close()
    active.clear()
  }
}

/**
 * 窗口在前台吗。
 *
 * 主窗口最小化 / 被遮住 / 在别的虚拟桌面时都算"不在眼前"。这里只问
 * `isFocused()`：它已经涵盖了最小化的情形，而且不会因为别的应用抢了焦点
 * 就误判成"用户在看" —— 那正是最该提醒的时候。
 */
function mainWindowFocused(): boolean {
  return !!mainWin && !mainWin.isDestroyed() && mainWin.isFocused()
}

/**
 * 渲染层说「这一轮跑完了」。
 *
 * `activeSessionId` 是主窗口当前打开的那条会话（CLI 自己的 id）。如果跑完的
 * 正好是它、而且窗口在前台，就什么都不弹 —— 用户已经在看着结果了。
 */
export function maybeNotifyDone(
  payload: SessionNotifyPayload,
  activeSessionId: string | null
): void {
  const target = payload?.target
  if (!target || typeof target.id !== 'string' || !target.id) return
  if (typeof payload.title !== 'string' || !payload.title) return

  /*
   * 没有主窗口就什么都不做。
   *
   * 窗口还没建好、或者用户已经把它关了（只剩 IDE 窗口）时弹一条
   * 「点一下切回会话」的通知，点下去也没地方切 —— 而且那种情况下应用
   * 多半正在退出。宁可不提醒，也不要给一个点不动的通知。
   */
  if (!mainWin || mainWin.isDestroyed()) return

  const focused = mainWindowFocused()
  if (focused && activeSessionId === target.id) return

  if (!Notification.isSupported()) return

  try {
    const notification = new Notification({
      title: payload.title,
      body: typeof payload.body === 'string' ? payload.body : '',
      // 点通知不该只把窗口拎到前台、还停在原来那条会话上
      silent: false
    })
    active.add(notification)
    const release = (): void => {
      active.delete(notification)
    }
    notification.on('close', release)
    notification.on('click', () => {
      release()
      focusSession(target)
    })
    notification.show()
    logMain('chat.notify', { id: target.id, cwd: target.cwd, focused })
  } catch (e) {
    // 通知失败绝不能影响会话本身
    logMain('chat.notify.failed', e)
  }
}

/** 把主窗口带到前台，并让它切到这条会话 */
function focusSession(target: SessionFocusTarget): void {
  if (!mainWin || mainWin.isDestroyed()) return
  if (mainWin.isMinimized()) mainWin.restore()
  mainWin.show()
  mainWin.focus()
  safeSend(mainWin, IPC.chatFocusSession, target)
}

/** 退出前收掉还挂着的通知，别让它们变成关不掉的幽灵 */
export function disposeChatNotify(): void {
  for (const n of active) {
    try {
      n.close()
    } catch {
      // 通知可能已经自己关掉了
    }
  }
  active.clear()
  mainWin = null
}
