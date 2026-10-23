import { useCallback, useEffect, useState } from 'react'
import type { UpdateInstallResult, UpdateState } from '@shared/update'

export interface UpdaterUi {
  state: UpdateState | null
  download(): void
  install(): Promise<UpdateInstallResult>
}

/**
 * 订阅主进程的更新状态。
 *
 * 状态完全由主进程持有，这里不推导、不改写 —— 界面刷新（dev 热更新）
 * 之后也能靠 status() 立刻补回当前进度。
 */
export function useUpdater(): UpdaterUi {
  const [state, setState] = useState<UpdateState | null>(null)

  useEffect(() => {
    const api = window.api?.updater
    if (!api) return
    let alive = true
    void api
      .status()
      .then((s) => {
        if (alive) setState(s)
      })
      .catch(() => undefined)
    const off = api.onState(setState)
    return () => {
      alive = false
      off()
    }
  }, [])

  const download = useCallback((): void => {
    void window.api?.updater.download()
  }, [])

  const install = useCallback(async (): Promise<UpdateInstallResult> => {
    if (!window.api?.updater) {
      return { ok: false, message: '当前不在 Electron 中运行，无法安装更新' }
    }
    try {
      return await window.api.updater.install()
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }, [])

  return { state, download, install }
}
