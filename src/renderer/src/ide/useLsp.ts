import { useCallback, useEffect, useRef, useState } from 'react'
import type * as monaco from 'monaco-editor'
import {
  installLspProviders,
  LspController,
  type LspOpenDoc,
  type LspOutlineSymbol,
  type LspStateInfo,
  type LspWorkspaceSymbol
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
  documentSymbols: (model: monaco.editor.ITextModel) => Promise<LspOutlineSymbol[]>
  workspaceSymbols: (query: string, seedLanguage?: string) => Promise<LspWorkspaceSymbol[]>
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

  const documentSymbols = useCallback(
    async (model: monaco.editor.ITextModel): Promise<LspOutlineSymbol[]> =>
      (await controllerRef.current?.documentSymbols(model)) ?? [],
    []
  )

  const workspaceSymbols = useCallback(
    async (query: string, seedLanguage?: string): Promise<LspWorkspaceSymbol[]> =>
      (await controllerRef.current?.workspaceSymbols(query, seedLanguage)) ?? [],
    []
  )

  return { syncDocs, states, documentSymbols, workspaceSymbols }
}
