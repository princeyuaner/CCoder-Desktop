import { useCallback, useEffect, useState } from 'react'
import type { CliUpdateRunResult, CliUpdateState, CliUpdateStates } from '@shared/cli-update'
import type { CliId } from '@shared/settings'
import { tr } from './i18n'

export interface CliUpdateApi {
  /** null = 还没拿到快照（首帧 / 浏览器里跑） */
  states: CliUpdateStates | null
  check(cli: CliId, force?: boolean): void
  run(cli: CliId): Promise<CliUpdateRunResult>
  runElevated(cli: CliId): Promise<CliUpdateRunResult>
  cancel(): void
}

/**
 * 订阅三个 CLI 的更新状态。
 *
 * 状态完全由主进程持有：设置页、导航上的「可更新」标记都读同一份，
 * 更新进程也不会因为关掉设置页而中断。这里不做任何本地推导。
 */
export function useCliUpdate(): CliUpdateApi {
  const [states, setStates] = useState<CliUpdateStates | null>(null)

  useEffect(() => {
    const api = window.api?.cliUpdate
    if (!api) return
    let alive = true
    void api
      .states()
      .then((snapshot) => {
        if (alive) setStates(snapshot)
      })
      .catch(() => undefined)
    const off = api.onState((state) => {
      setStates((prev) => ({ ...(prev ?? ({} as CliUpdateStates)), [state.cli]: state }))
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  const check = useCallback((cli: CliId, force = false): void => {
    void window.api?.cliUpdate.check(cli, force).catch(() => undefined)
  }, [])

  const run = useCallback(async (cli: CliId): Promise<CliUpdateRunResult> => {
    if (!window.api?.cliUpdate) {
      return { ok: false, message: tr('errors.notElectronCliUpdate') }
    }
    try {
      return await window.api.cliUpdate.run(cli)
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }, [])

  const runElevated = useCallback(async (cli: CliId): Promise<CliUpdateRunResult> => {
    if (!window.api?.cliUpdate) {
      return { ok: false, message: tr('errors.notElectronCliUpdate') }
    }
    try {
      return await window.api.cliUpdate.runElevated(cli)
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }, [])

  const cancel = useCallback((): void => {
    void window.api?.cliUpdate.cancel().catch(() => undefined)
  }, [])

  return { states, check, run, runElevated, cancel }
}

/** 单个 CLI 的状态；还没加载时返回 null，由卡片显示「正在检查」 */
export function cliUpdateOf(states: CliUpdateStates | null, cli: CliId): CliUpdateState | null {
  return states?.[cli] ?? null
}
