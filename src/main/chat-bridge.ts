import type { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  ChatActiveInfo,
  ChatTargetInfo,
  IdeSendPayload,
  IdeSendResult
} from '../shared/ide-chat'
import { sameCwd } from '../shared/settings'
import { listStoredSessions } from './session-store'
import { safeSend } from './safe-send'
import { t } from './i18n'

/**
 * IDE → 聊天的中转站。
 *
 * IDE 是独立窗口，主窗口的 React 状态它看不到。这里只存两样东西：
 *  - 主窗口上报的当前会话（用来算默认目标）；
 *  - 主窗口的 BrowserWindow 引用（用来投递引用）。
 *
 * 真正的「挂到哪条会话、放进输入框」由主窗口渲染进程决定。
 */

let mainWin: BrowserWindow | null = null
let active: ChatActiveInfo | null = null

/** main/index 建主窗口时登记；主窗口关掉时传 null 清空 */
export function setChatMainWindow(win: BrowserWindow | null): void {
  mainWin = win
  if (!win) active = null
}

/** 主窗口上报当前打开的会话 */
export function reportActiveChat(info: ChatActiveInfo): void {
  active = info
}

/** 这条 IPC 是不是主窗口发来的（IDE 窗口不该能改「当前会话」） */
export function isChatMainSender(webContentsId: number): boolean {
  return !!mainWin && !mainWin.isDestroyed() && mainWin.webContents.id === webContentsId
}

/**
 * 这个工作区能发到哪些聊天。
 *
 * 顺序就是 IDE 下拉框的顺序：当前活跃会话 → 同工作区最近会话 → 兜底新会话。
 * 只读 CLI 自己写的会话记录，不会凭空造一条。
 */
export function listChatTargets(cwd: string): ChatTargetInfo[] {
  const out: ChatTargetInfo[] = []

  if (active && active.cwd && sameCwd(active.cwd, cwd)) {
    out.push({
      kind: 'active',
      id: active.id,
      cwd,
      title: active.title || t('chat.title.newSession'),
      cli: active.cli,
      isNew: active.isNew
    })
  }

  let stored: ReturnType<typeof listStoredSessions> = []
  try {
    stored = listStoredSessions()
  } catch {
    // 读不到会话目录不影响当前会话这个目标
  }

  stored
    .filter((s) => sameCwd(s.cwd, cwd))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .forEach((s) => {
      if (out.length >= 9) return
      // 当前会话如果已经是一条存储会话，别重复列两遍
      if (out.some((t) => t.id === s.id)) return
      out.push({
        kind: 'session',
        id: s.id,
        cwd: s.cwd,
        title: s.title || t('codexHistory.untitled'),
        cli: s.cli,
        isNew: false,
        updatedAt: s.updatedAt
      })
    })

  // 一条都没有（新工作区、CLI 还没落过盘）：让它开一条新会话
  if (out.length === 0) {
    out.push({
      kind: 'new',
      id: null,
      cwd,
      title: t('chat.title.newSession'),
      cli: 'claude',
      isNew: true
    })
  }

  return out
}

/** 把引用投递给主窗口。是否切会话由主窗口渲染进程处理。 */
export function sendRefsToChat(payload: IdeSendPayload): IdeSendResult {
  if (!mainWin || mainWin.isDestroyed()) {
    return { ok: false, message: t('chatBridge.windowClosed') }
  }
  safeSend(mainWin, IPC.chatAttachRefs, payload)
  return { ok: true }
}

/**
 * 让主窗口在指定目录开一条新会话。
 *
 * 只负责投递和把窗口带到前台；真正的 `newSession(cwd)` 由主窗口渲染进程执行。
 * 返回 ok 不代表 CLI 已启动。
 */
export function openSessionInChat(cwd: string): { ok: boolean; message?: string } {
  if (!mainWin || mainWin.isDestroyed()) {
    return { ok: false, message: t('chatBridge.windowClosed') }
  }
  if (mainWin.isMinimized()) mainWin.restore()
  mainWin.show()
  mainWin.focus()
  safeSend(mainWin, IPC.chatOpenSession, cwd)
  return { ok: true }
}
