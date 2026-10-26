import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  SyncActionResult,
  SyncConfig,
  SyncWorkspaceState
} from '@shared/sync'
import { tr } from '../i18n'

export interface SyncApiState {
  state: SyncWorkspaceState | null
  loading: boolean
  error: string | null
  save(config: SyncConfig): Promise<SyncConfig | null>
  syncNow(): Promise<SyncActionResult>
  openTarget(): Promise<SyncActionResult>
  pickDir(which: 'src' | 'dst'): Promise<string | null>
}

function sameCwd(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  return window.api?.platform === 'win32'
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b)
}

/**
 * IDE 窗口的同步状态。工具栏、状态栏、气泡和同步工作区读同一份。
 *
 * 状态由主进程推送；这里只维护快照，配置改动走 save（服务端会归一化并
 * 返回真正落盘的那份）。
 */
export function useSync(cwd: string): SyncApiState {
  const [state, setState] = useState<SyncWorkspaceState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const available = typeof window !== 'undefined' && !!window.api?.sync
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd

  useEffect(() => {
    setState(null)
    setLoading(true)
    setError(null)
    if (!available) {
      setLoading(false)
      setError(tr('errors.notElectron'))
      return
    }
    let alive = true
    void window.api!.sync
      .get(cwd)
      .then((fresh) => {
        if (alive) setState(fresh)
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })

    const off = window.api!.sync.onStatus((payload) => {
      if (!alive || !sameCwd(payload.cwd, cwdRef.current)) return
      setState((cur) =>
        cur ? { ...cur, snapshot: payload.snapshot } : cur
      )
    })
    return () => {
      alive = false
      off()
    }
  }, [available, cwd])

  const save = useCallback(
    async (config: SyncConfig): Promise<SyncConfig | null> => {
      if (!available) return null
      setState((cur) => (cur ? { ...cur, config } : cur))
      try {
        const fresh = await window.api!.sync.save(cwd, config)
        setState(fresh)
        setError(null)
        return fresh.config
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        return null
      }
    },
    [available, cwd]
  )

  const syncNow = useCallback(async (): Promise<SyncActionResult> => {
    if (!available) return { ok: false, message: tr('errors.notElectron') }
    try {
      return await window.api!.sync.syncNow(cwd)
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }, [available, cwd])

  const openTarget = useCallback(async (): Promise<SyncActionResult> => {
    if (!available) return { ok: false, message: tr('errors.notElectron') }
    try {
      return await window.api!.sync.openTarget(cwd)
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }, [available, cwd])

  const pickDir = useCallback(
    async (which: 'src' | 'dst'): Promise<string | null> => {
      if (!available) return null
      try {
        return await window.api!.sync.pickDir(cwd, which)
      } catch {
        return null
      }
    },
    [available, cwd]
  )

  return { state, loading, error, save, syncNow, openTarget, pickDir }
}
