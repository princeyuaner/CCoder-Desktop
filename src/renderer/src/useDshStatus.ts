import { useCallback, useEffect, useState } from 'react'
import type { DshStatus } from '@shared/dsh'
import { tr } from './i18n'

export interface DshStatusApi {
  status: DshStatus | null
  loading: boolean
  error: string | null
  refresh(): Promise<void>
}

/**
 * DeepSeek Harness 安装 / Node / DSH_HOME 状态。
 *
 * 只在打开 dsh 设置页时探测（enabled=true）—— 探测会解析 npm 全局包并跑一次
 * `dsh --version`，没必要在应用启动时给每个用户都付这份成本。
 */
export function useDshStatus(enabled: boolean): DshStatusApi {
  const [status, setStatus] = useState<DshStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!api?.dsh) {
      setError(tr('errors.notElectronDsh'))
      return
    }
    setLoading(true)
    setError(null)
    try {
      setStatus(await api.dsh.status())
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (enabled) void refresh()
  }, [enabled, refresh])

  return { status, loading, error, refresh }
}
