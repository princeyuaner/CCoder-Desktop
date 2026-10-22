import { useCallback, useEffect, useRef, useState } from 'react'
import type { VcsDetectData, VcsStatus } from '@shared/vcs'

/**
 * IDE 窗口的 VCS 摘要。放到 hook 里，是因为工具栏、文件树徽标、状态栏和
 * 版本控制工作区都要读同一份状态，不能各拉一次。
 */
export function useVcsStatus(cwd: string): {
  detect: VcsDetectData | null
  status: VcsStatus | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
} {
  const [detect, setDetect] = useState<VcsDetectData | null>(null)
  const [status, setStatus] = useState<VcsStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    const id = ++seq.current
    setLoading(true)
    setError(null)
    try {
      const d = await window.api!.vcs.detect(cwd)
      if (id !== seq.current) return
      if (!d.ok) {
        setDetect(null)
        setStatus(null)
        setError(d.error.message)
        return
      }
      setDetect(d.data)
      if (!d.data.repo) {
        setStatus(null)
        return
      }
      const s = await window.api!.vcs.status({ cwd })
      if (id !== seq.current) return
      if (!s.ok) {
        setStatus(null)
        setError(s.error.message)
        return
      }
      setStatus(s.data)
    } catch (err) {
      if (id === seq.current) {
        setStatus(null)
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (id === seq.current) setLoading(false)
    }
  }, [cwd])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { detect, status, loading, error, refresh }
}
