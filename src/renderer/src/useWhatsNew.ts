import { useCallback, useEffect, useRef, useState } from 'react'
import { whatsNewFor, type WhatsNewRelease } from '@shared/whats-new'

/** 上次运行时的版本。和 IDE 草稿一样放 localStorage：只影响这一台设备 */
const LAST_VERSION_KEY = 'ccoder.lastRunVersion'
/**
 * 上次真正展示过更新说明的版本。
 *
 * 不能拿 LAST_VERSION_KEY 去重：某个版本发版时漏写说明，启动时虽然查不到
 * 内容，也会把版本记成「已运行」—— 之后补上说明就再也没机会弹了。这个键
 * 只在匹配到说明时写入，所以后补的说明能在下次启动补弹一次；老版本没有
 * 这个键，正好让补写的当前版本说明也弹出来。
 */
const LAST_SHOWN_KEY = 'ccoder.lastWhatsNewVersion'

export interface PendingWhatsNew {
  release: WhatsNewRelease
  /** 没有上次版本记录：首次安装，或第一次带上这个功能的版本 */
  welcome: boolean
}

/**
 * 当前版本有更新说明、且这个版本还没展示过 → 弹一次「本次更新」。
 *
 * 去重看 LAST_SHOWN_KEY，而不是「上次运行版本」：某次发版漏写说明时
 * 不能把版本记成已看过，后补的说明要能在下次启动补弹。
 * 不比较版本高低（降级同样值得看说明），也不依赖更新器状态 —— 无论是
 * 自动更新、手动装包还是便携版覆盖，只要当前版本有说明就会触发。
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

    const release = whatsNewFor(currentVersion)
    let previous: string | null = null
    let shown: string | null = null
    try {
      previous = localStorage.getItem(LAST_VERSION_KEY)
      shown = localStorage.getItem(LAST_SHOWN_KEY)
      localStorage.setItem(LAST_VERSION_KEY, currentVersion)
    } catch {
      // 存储不可用时宁可不弹，也不能让启动流程失败
      return
    }
    if (!release || shown === currentVersion) return

    try {
      localStorage.setItem(LAST_SHOWN_KEY, currentVersion)
    } catch {
      // 记不住展示记录就宁可这次不弹，否则每次启动都会重复弹
      return
    }
    setPending({ release, welcome: previous == null })
  }, [currentVersion])

  const dismiss = useCallback(() => setPending(null), [])

  return { pending, dismiss }
}
