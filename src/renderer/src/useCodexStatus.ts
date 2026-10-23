import { useCallback, useEffect, useState } from 'react'
import type { CodexStatus } from '@shared/codex'
import { tr } from './i18n'

export interface CodexStatusApi {
  status: CodexStatus | null
  loading: boolean
  error: string | null
  refresh(): Promise<void>
}

/**
 * Codex 安装 / 登录状态。
 *
 * 只在打开 Codex 设置页时探测（enabled=true），不在应用启动时跑 ——
 * 探测会起一个 app-server，没装或不用 Codex 的用户不该为此付启动成本。
 */
export function useCodexStatus(enabled: boolean): CodexStatusApi {
  const [status, setStatus] = useState<CodexStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!api?.codex) {
      setError(tr('errors.notElectronCodex'))
      return
    }
    setLoading(true)
    setError(null)
    try {
      setStatus(await api.codex.status())
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
