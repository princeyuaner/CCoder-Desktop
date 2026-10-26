/**
 * 同步服务 → IDE 窗口的出口。
 *
 * 服务本身不 import Electron 的窗口 API；`main/index.ts` 在启动时把
 * 「往哪个窗口发」注入进来，这样服务可以单独测，也避免 ide-window ↔ sync
 * 的循环依赖。
 */
export interface SyncHost {
  send(cwd: string, channel: string, payload: unknown): void
  /** 系统通知点击：聚焦该工作区的 IDE 窗口，并请求打开同步日志。 */
  focus(cwd: string, openLog: boolean): void
}

let host: SyncHost = {
  send: () => undefined,
  focus: () => undefined
}

export function configureSyncHost(next: SyncHost): void {
  host = next
}

export function syncHost(): SyncHost {
  return host
}
