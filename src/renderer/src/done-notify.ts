import type { CliId } from '@shared/settings'
import type { SessionNotifyPayload } from '@shared/session'
import { tr } from './i18n'

/**
 * 「一轮跑完 → 系统通知」的渲染层入口。
 *
 * ChatController 在最深处知道一轮什么时候结束；标题和当前语言只有界面层
 * 知道。所以控制器只报「哪条会话跑完了」，由这里把文案拼好交给主进程；
 * 弹不弹由主进程判断（只有它知道窗口在不在前台、正开着哪条会话）。
 *
 * 用一个模块级单例而不是 props：控制器是模块级的，不挂在 React 树上。
 */

interface Hook {
  /** 设置里的总开关 */
  enabled: boolean
  /** 会话 id → 用户看到的标题（重命名后的那个） */
  titleOf: (cli: CliId, cwd: string, id: string) => string
}

let hook: Hook = { enabled: false, titleOf: () => '' }

/** 界面层（MainPane）装好开关和标题解析器 */
export function configureDoneNotify(next: Hook): void {
  hook = next
}

/**
 * 一轮结束。
 *
 * `errored` 只影响标题（「出错」还是「已完成」）—— 失败的轮次更需要提醒，
 * 用户可能已经切去干别的了。
 */
export function notifyTurnDone(o: {
  cli: CliId
  cwd: string
  id: string | null
  errored: boolean
  /** 后台任务还在跑：标题里带一句，别让用户以为全干完了 */
  backgroundRunning?: number
}): void {
  const api = typeof window !== 'undefined' ? window.api?.chat : undefined
  if (!api?.notifyDone) return
  if (!hook.enabled || !o.id) return

  const cliName =
    o.cli === 'codex' ? 'Codex CLI' : o.cli === 'dsh' ? 'DeepSeek Harness' : 'Claude Code'
  const title = hook.titleOf(o.cli, o.cwd, o.id).trim()
  const payload: SessionNotifyPayload = {
    title: tr(o.errored ? 'chat.notify.titleFailed' : 'chat.notify.title', { cli: cliName }),
    body: title || tr('chat.notify.bodyEmpty'),
    target: { cli: o.cli, cwd: o.cwd, id: o.id, title }
  }

  if ((o.backgroundRunning ?? 0) > 0) {
    payload.body = `${payload.body}\n${tr('chat.notify.background')}`
  }

  try {
    api.notifyDone(payload)
  } catch {
    // 通知失败不该影响会话本身
  }
}
