import { useCallback, useEffect, useRef, useState } from 'react'
import { whatsNewFor, type WhatsNewRelease } from '@shared/whats-new'

/** 上次运行时的版本。和 IDE 草稿一样放 localStorage：只影响这一台设备 */
const LAST_VERSION_KEY = 'ccoder.lastRunVersion'

export interface PendingWhatsNew {
  release: WhatsNewRelease
  /** 没有上次版本记录：首次安装，或第一次带上这个功能的版本 */
  welcome: boolean
}

/**
 * 版本变化后弹一次「本次更新」。
 *
 * 判定就三行：当前版本和上次记录不同 → 弹；弹完立刻记下当前版本。
 * 不比较版本高低（降级同样值得看说明），也不依赖更新器状态 —— 无论是
 * 自动更新、手动装包还是便携版覆盖，只要版本号变了就会触发。
 *
 * 显示时机由 updater 状态里的 currentVersion 驱动：主进程是版本号的
 * 唯一来源，渲染层不自己拼。
 */
export function useWhatsNew(currentVersion: string | undefined): {
  pending: PendingWhatsNew | null
  dismiss(): void
} {
  const [pending, setPending] = useState<PendingWhatsNew | null>(null)
  /** StrictMode 会重跑一次 effect；同一个版本只处理一次 */
  const handled = useRef<string | null>(null)

  useEffect(() => {
    if (!currentVersion || handled.current === currentVersion) return
    handled.current = currentVersion

    let previous: string | null = null
    try {
      previous = localStorage.getItem(LAST_VERSION_KEY)
      localStorage.setItem(LAST_VERSION_KEY, currentVersion)
    } catch {
      // 存储不可用时宁可不弹，也不能让启动流程失败
      return
    }
    if (previous === currentVersion) return

    const release = whatsNewFor(currentVersion)
    if (release) setPending({ release, welcome: previous == null })
  }, [currentVersion])

  const dismiss = useCallback(() => setPending(null), [])

  return { pending, dismiss }
}
