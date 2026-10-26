import type { SyncConfig, SyncWorkspaceState } from '../../shared/sync'
import { pathKey } from '../path-key'
import { SyncService } from './service'

/**
 * 工作区 → 同步服务。IDE 窗口打开时创建，窗口关闭时销毁。
 *
 * 每个工作区一份，和「一个工作区一个 IDE 窗口」一一对应；这样源目录默认
 * 就是当前工作区，关掉窗口也不会接着同步别的项目。
 */
const services = new Map<string, SyncService>()

export function ensureSync(cwd: string): SyncService {
  const key = pathKey(cwd)
  const existing = services.get(key)
  if (existing) return existing
  const service = new SyncService(cwd)
  services.set(key, service)
  service.initialize()
  return service
}

export function getSyncState(cwd: string): SyncWorkspaceState {
  return ensureSync(cwd).getState()
}

export function saveSyncConfig(cwd: string, config: SyncConfig): SyncWorkspaceState {
  return ensureSync(cwd).updateConfig(config)
}

export function syncNow(cwd: string): { ok: boolean; message?: string } {
  return ensureSync(cwd).syncNow()
}

export async function disposeSync(cwd: string): Promise<void> {
  const key = pathKey(cwd)
  const service = services.get(key)
  if (!service) return
  services.delete(key)
  await service.dispose()
}

export async function disposeAllSync(): Promise<void> {
  const all = [...services.values()]
  services.clear()
  await Promise.all(all.map((s) => s.dispose()))
}

/** 给 IPC 用：这个工作区是否已经有同步服务（不主动创建）。 */
export function hasSync(cwd: string): boolean {
  return services.has(pathKey(cwd))
}
