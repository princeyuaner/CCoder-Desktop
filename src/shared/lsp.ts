/**
 * 语言服务器（LSP）的数据形状。
 *
 * 渲染层只负责把 Monaco 的请求转成 LSP 方法名 / 参数，并通过 IPC 发给
 * 主进程；真正的进程管理、JSON-RPC 分帧和服务器探测都在主进程。
 * 这里刻意不引入任何 LSP SDK 类型 —— 只描述我们实际用到的那部分。
 */

export type LspErrorCode =
  | 'forbidden'
  | 'unsupported'
  | 'not-found'
  | 'spawn-failed'
  | 'initialize-failed'
  | 'timeout'
  | 'stopped'
  | 'disabled'
  | 'unknown'

/** 0-based 行列，和 LSP 的 Position 一致（UTF-16 code unit） */
export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface LspStartRequest {
  cwd: string
  /** Monaco 语言 id，例如 typescript / rust / python */
  language: string
}

export type LspStartResult =
  | {
      ok: true
      /** 展示用服务器名，例如 rust-analyzer */
      server: string
      /** 服务器声明的能力，暂不透传给渲染层 */
      capabilities: unknown
    }
  | {
      ok: false
      code: LspErrorCode
      error: string
    }

export interface LspRequest {
  cwd: string
  language: string
  /** LSP 方法名，例如 textDocument/definition */
  method: string
  params: unknown
  /** 默认 20s；主进程会夹到 1s–60s */
  timeoutMs?: number
}

export type LspResponse =
  | { ok: true; result: unknown }
  | { ok: false; code: LspErrorCode; error: string }

export interface LspNotification {
  cwd: string
  language: string
  method: string
  params: unknown
}

export interface LspDiagnostic {
  range: LspRange
  /** 1 = error, 2 = warning, 3 = information, 4 = hint */
  severity?: number
  code?: string | number
  source?: string
  message: string
  /** 1 = unnecessary, 2 = deprecated */
  tags?: number[]
}

export interface LspDiagnosticsEvent {
  cwd: string
  /** 文档 URI；和 didOpen 时发出去的完全一致 */
  uri: string
  version?: number
  diagnostics: LspDiagnostic[]
}

export type LspSessionState = 'starting' | 'ready' | 'error' | 'stopped'

export interface LspStateEvent {
  cwd: string
  language: string
  state: LspSessionState
  server?: string
  message?: string
  /** initialize 返回的服务器能力；ready 时带回，语义着色需要读 legend */
  capabilities?: unknown
}
