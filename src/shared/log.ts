/**
 * 渲染进程 → 主进程的错误上报。
 *
 * 只用于写本地日志，不参与业务逻辑。渲染进程没有直接写文件的权限，
 * 而打包版没有 DevTools，未捕获异常 / Promise 拒绝只会停在控制台里 ——
 * 用户看到白屏或界面失灵，主进程日志却一个字都没有。
 */

export type RendererLogKind = 'error' | 'unhandledrejection' | 'resource'

export interface RendererLogReport {
  kind: RendererLogKind
  message: string
  /** 未捕获异常的调用栈（如果有） */
  stack?: string
  /** 出错脚本 / 资源地址 */
  source?: string
  line?: number
  column?: number
  /** 出错页面（主窗口 / IDE 窗口的 URL） */
  url?: string
  /** 渲染进程侧的时间戳，便于和主进程日志对齐 */
  at: number
}

/** 单条日志字段上限：防止一条报错把日志文件刷爆 */
export const RENDERER_LOG_LIMITS = {
  message: 4000,
  stack: 8000,
  source: 1000,
  url: 1000
} as const
