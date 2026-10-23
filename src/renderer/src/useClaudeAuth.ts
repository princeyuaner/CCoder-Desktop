import { useCallback, useEffect, useState } from 'react'
import type {
  ClaudeAuthResult,
  ClaudeAuthStatus,
  ClaudeLoginPhase
} from '@shared/claude'
import { tr } from './i18n'

export interface ClaudeAuthApi {
  status: ClaudeAuthStatus | null
  loading: boolean
  error: string | null
  /** 登录流程阶段；没有进行中的流程时是 idle */
  phase: ClaudeLoginPhase
  /** 从 CLI 输出里认出的授权 URL */
  url: string | null
  /** 最近一段 CLI 输出，仅用于显示 */
  output: string
  /** 最近一次阶段变化附带的说明 */
  message: string | null
  busy: boolean
  refresh(): Promise<void>
  startLogin(): Promise<void>
  submitCode(code: string): Promise<ClaudeAuthResult>
  cancelLogin(): Promise<void>
  logout(): Promise<ClaudeAuthResult>
}

const BUSY_PHASES: ClaudeLoginPhase[] = ['starting', 'waiting', 'verifying']
const MAX_OUTPUT = 16 * 1024

/**
 * Claude Code 官方登录状态。
 *
 * 登录进程归主进程所有，这个 hook 只做三件事：读状态、订阅事件、发指令。
 * 离开设置页不会取消登录；重新进入时用 authLoginState() 把现场（URL / 输出 /
 * 阶段）恢复回来。
 */
export function useClaudeAuth(enabled: boolean): ClaudeAuthApi {
  const [status, setStatus] = useState<ClaudeAuthStatus | null>(null)
  // 初值为 true：第一次真正渲染 Claude 页时先显示"检测中"，不要闪一下"未安装"
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<ClaudeLoginPhase>('idle')
  const [url, setUrl] = useState<string | null>(null)
  const [output, setOutput] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  const api = typeof window !== 'undefined' ? window.api : undefined

  const refresh = useCallback(async (): Promise<void> => {
    if (!api?.claude) {
      setError(tr('errors.notElectronClaude'))
      return
    }
    setLoading(true)
    setError(null)
    try {
      setStatus(await api.claude.authStatus())
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [api])

  // 首次进入 / 重新进入设置页：拉状态 + 恢复可能还在跑的登录现场
  useEffect(() => {
    if (!enabled || !api?.claude) return
    void refresh()
    void api.claude
      .authLoginState()
      .then((s) => {
        setPhase(s.phase)
        setUrl(s.url)
        setOutput(s.output)
      })
      .catch(() => undefined)
  }, [enabled, api, refresh])

  // 事件订阅与页面是否可见无关：只要 hook 挂着就接
  useEffect(() => {
    if (!api?.claude) return
    return api.claude.onAuthEvent((e) => {
      if (e.t === 'output') {
        setOutput((cur) => (cur + e.text).slice(-MAX_OUTPUT))
        return
      }
      if (e.t === 'url') {
        setUrl(e.url)
        setPhase('waiting')
        return
      }
      if (e.t === 'status') {
        setStatus(e.status)
        return
      }
      setPhase(e.phase)
      setMessage(e.message ?? null)
      // 成功 / 失败后状态可能已经变了，主动对齐一次
      if (e.phase === 'success' || e.phase === 'failed') {
        setLoading(true)
        void api.claude
          .authStatus()
          .then(setStatus)
          .catch(() => undefined)
          .finally(() => setLoading(false))
      }
    })
  }, [api])

  const startLogin = useCallback(async (): Promise<void> => {
    if (!api?.claude) {
      setError(tr('errors.notElectronLogin'))
      return
    }
    setError(null)
    setMessage(null)
    setUrl(null)
    setOutput('')
    setPhase('starting')
    try {
      const r = await api.claude.authLogin()
      if (!r.ok) {
        setPhase('idle')
        setError(r.message ?? tr('errors.loginStartFailed'))
      }
    } catch (e) {
      setPhase('failed')
      setError(String(e))
    }
  }, [api])

  const submitCode = useCallback(
    async (code: string): Promise<ClaudeAuthResult> => {
      if (!api?.claude) return { ok: false, message: tr('errors.notElectronShort') }
      const r = await api.claude.authSubmitCode(code)
      if (r.ok) {
        setError(null)
        setPhase('verifying')
      } else {
        setError(r.message ?? tr('errors.submitCodeFailed'))
      }
      return r
    },
    [api]
  )

  const cancelLogin = useCallback(async (): Promise<void> => {
    if (!api?.claude) return
    await api.claude.authCancel()
    setPhase('cancelled')
  }, [api])

  const logout = useCallback(async (): Promise<ClaudeAuthResult> => {
    if (!api?.claude) return { ok: false, message: tr('errors.notElectronShort') }
    const r = await api.claude.authLogout()
    if (r.ok) {
      setMessage(r.message ?? null)
    } else {
      setError(r.message ?? tr('errors.logoutFailed'))
    }
    await refresh()
    return r
  }, [api, refresh])

  return {
    status,
    loading,
    error,
    phase,
    url,
    output,
    message,
    busy: BUSY_PHASES.includes(phase),
    refresh,
    startLogin,
    submitCode,
    cancelLogin,
    logout
  }
}
