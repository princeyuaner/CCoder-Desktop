import { randomUUID } from 'node:crypto'
import { dialog, ipcMain, shell } from 'electron'
import { IPC } from '../../shared/ipc'
import type { PluginMutationResult } from '../../shared/plugins'
import { createPluginHostContext, type PluginHostContext } from './context'
import { listMarket, installMarketPlugin } from './marketplace'
import {
  deletePluginStorage,
  getPluginStorage,
  inspectPluginDirectory,
  installFromDirectory,
  listPlugins,
  pluginDir,
  readPluginRuntime,
  setPluginEnabled,
  setPluginStorage,
  uninstallPlugin
} from './store'

const LOCAL_TOKEN_TTL_MS = 10 * 60 * 1000

export interface PluginIpcOptions {
  /** 插件目录 / 状态变化后通知所有窗口 */
  changed: () => void
  /** 本地市场索引：开发模式优先使用，打包版只在远程失败时兜底 */
  devMarketIndex?: string
  preferDevMarket?: boolean
}

export function registerPluginIpc(options: PluginIpcOptions): PluginHostContext {
  const ctx = createPluginHostContext({
    devMarketIndex: options.devMarketIndex,
    preferDevMarket: options.preferDevMarket
  })
  const notify = (): void => options.changed()
  const idOf = (raw: unknown): string => (typeof raw === 'string' ? raw : '')
  /** 本地目录安装的两步 token：渲染层不持有路径，只能凭主进程发的 token 安装 */
  const pendingLocal = new Map<string, { source: string; expiresAt: number }>()

  const pruneLocal = (): void => {
    const now = Date.now()
    for (const [token, item] of pendingLocal) {
      if (item.expiresAt <= now) pendingLocal.delete(token)
    }
  }

  ipcMain.handle(IPC.pluginsList, () => listPlugins(ctx))

  ipcMain.handle(IPC.pluginsInspectLocal, async () => {
    pruneLocal()
    const picked = await dialog.showOpenDialog({
      title: '选择插件目录',
      properties: ['openDirectory']
    })
    const source = picked.filePaths[0]
    if (picked.canceled || !source) return { ok: false, error: 'canceled' }

    const inspected = inspectPluginDirectory(ctx, source)
    if (!inspected.ok || !inspected.manifest) {
      return { ok: false, error: inspected.error ?? 'manifest-invalid' }
    }
    const token = randomUUID()
    pendingLocal.set(token, { source, expiresAt: Date.now() + LOCAL_TOKEN_TTL_MS })
    return {
      ok: true,
      preview: {
        token,
        source,
        manifest: inspected.manifest,
        size: inspected.size ?? 0
      }
    }
  })

  ipcMain.handle(
    IPC.pluginsInstallLocal,
    (_e, tokenRaw: unknown): PluginMutationResult => {
      const token = typeof tokenRaw === 'string' ? tokenRaw : ''
      const pending = pendingLocal.get(token)
      pendingLocal.delete(token)
      if (!pending || pending.expiresAt <= Date.now()) {
        return { ok: false, error: 'install-token-expired', list: listPlugins(ctx) }
      }
      const result = installFromDirectory(ctx, pending.source)
      if (result.ok) notify()
      return result
    }
  )

  ipcMain.handle(IPC.pluginsSetEnabled, (_e, idRaw: unknown, enabledRaw: unknown) => {
    const result = setPluginEnabled(ctx, idOf(idRaw), enabledRaw === true)
    if (result.ok) notify()
    return result
  })

  ipcMain.handle(IPC.pluginsUninstall, (_e, idRaw: unknown) => {
    const result = uninstallPlugin(ctx, idOf(idRaw))
    if (result.ok) notify()
    return result
  })

  ipcMain.handle(IPC.pluginsReveal, async (_e, idRaw: unknown) => {
    const dir = pluginDir(ctx, idOf(idRaw))
    if (!dir) return { ok: false, error: 'plugin-not-found' }
    const error = await shell.openPath(dir)
    return error ? { ok: false, error } : { ok: true }
  })

  ipcMain.handle(IPC.pluginsReadRuntime, (_e, idRaw: unknown) =>
    readPluginRuntime(ctx, idOf(idRaw))
  )

  ipcMain.handle(IPC.pluginsStorageGet, (_e, idRaw: unknown, keyRaw: unknown) =>
    getPluginStorage(ctx, idOf(idRaw), typeof keyRaw === 'string' ? keyRaw : '')
  )

  ipcMain.handle(
    IPC.pluginsStorageSet,
    (_e, idRaw: unknown, keyRaw: unknown, value: unknown) =>
      setPluginStorage(ctx, idOf(idRaw), typeof keyRaw === 'string' ? keyRaw : '', value)
  )

  ipcMain.handle(IPC.pluginsStorageDelete, (_e, idRaw: unknown, keyRaw: unknown) =>
    deletePluginStorage(ctx, idOf(idRaw), typeof keyRaw === 'string' ? keyRaw : '')
  )

  ipcMain.handle(IPC.pluginsMarketList, (_e, forceRaw: unknown) =>
    listMarket(ctx, forceRaw === true)
  )

  ipcMain.handle(IPC.pluginsMarketInstall, async (_e, idRaw: unknown, versionRaw: unknown) => {
    const result = await installMarketPlugin(
      ctx,
      idOf(idRaw),
      typeof versionRaw === 'string' ? versionRaw : undefined
    )
    if (result.ok) notify()
    return result
  })

  return ctx
}
