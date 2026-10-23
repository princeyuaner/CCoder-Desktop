import type { BrowserWindow } from 'electron'
import { logMain } from './crash-log'

/**
 * 向窗口发消息，但绝不让窗口销毁的竞态变成主进程异常。
 *
 * 会话事件是从 CLI 的数据流回调里广播出去的，与窗口关闭完全异步；
 * 此时 `webContents.send` 可能抛 "Object has been destroyed"。窗口刚好
 * 在 getAllWindows() 和 send() 之间被销毁时，只看 isDestroyed() 也不够。
 */
export function safeSend(win: BrowserWindow, channel: string, payload?: unknown): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  try {
    win.webContents.send(channel, payload)
  } catch (e) {
    logMain('webContents.send', { channel, error: e })
  }
}
