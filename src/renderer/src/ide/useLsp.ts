import { useCallback, useEffect, useRef, useState } from 'react'
import {
  installLspProviders,
  LspController,
  type LspOpenDoc,
  type LspStateInfo
} from './lsp-client'

/**
 * 一个 IDE 窗口一个 LSP 控制器。
 *
 * 关掉设置里的开关时直接 dispose：渲染层不再注册 provider，主进程收到
 * stop 后结束服务器；Monaco 自带的 TS worker 恢复原来的行为。
 */
export function useLsp(
  cwd: string,
  enabled: boolean
): {
  syncDocs: (docs: LspOpenDoc[]) => void
  states: Record<string, LspStateInfo>
} {
  const [states, setStates] = useState<Record<string, LspStateInfo>>({})
  const controllerRef = useRef<LspController | null>(null)

  useEffect(() => {
    setStates({})
    if (!enabled) return

    const controller = new LspController(cwd, (language, info) => {
      setStates((prev) => {
        const current = prev[language]
        if (
          current &&
          current.state === info.state &&
          current.server === info.server &&
          current.message === info.message
        ) {
          return prev
        }
        return { ...prev, [language]: info }
      })
    })
    controllerRef.current = controller
    const uninstall = installLspProviders(controller)

    return () => {
      uninstall()
      controller.dispose()
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [cwd, enabled])

  const syncDocs = useCallback((docs: LspOpenDoc[]): void => {
    controllerRef.current?.sync(docs)
  }, [])

  return { syncDocs, states }
}
