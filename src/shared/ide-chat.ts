/**
 * IDE → 聊天的数据形状。
 *
 * IDE 是独立窗口，聊天在主窗口里。两边不直接共享 React 状态：
 *  - IDE 通过主进程问「这个工作区有哪些聊天」，再把代码引用交给主进程；
 *  - 主进程转给主窗口，由主窗口决定挂到哪条会话的输入框。
 *
 * 这里只放**跨进程**的数据，UI 专用的解析/格式化在 renderer 里。
 */
import type { CliId } from './settings'

/** 一条代码引用：选区或整个文件 */
export interface IdeCodeRef {
  /** 渲染层 key / 去重用 */
  id: string
  kind: 'selection' | 'file'
  /** 相对工作区，正斜杠 */
  rel: string
  /** 绝对路径，给模型 / 后续操作用 */
  path: string
  /** 文件名，列表里显示 */
  name: string
  /** 1-based；file 时没有 */
  startLine?: number
  /** 1-based；file 时没有 */
  endLine?: number
  /** 代码围栏语言，如 tsx / py */
  lang: string
  /** 选区文本或整份文件内容 */
  code: string
  /** 文件总行数 */
  totalLines: number
  /** 文件读取被 2MB 上限截断 */
  truncated?: boolean
  cwd: string
}

/**
 * 一条可选的聊天目标。
 *
 * `active` 是主窗口当前显示的会话；`session` 是同工作区的其他已有会话；
 * `new` 只在一个能用的会话都没有时出现。
 */
export interface ChatTargetInfo {
  kind: 'active' | 'session' | 'new'
  /** stored session id；新会话为 null */
  id: string | null
  cwd: string
  title: string
  cli: CliId
  isNew: boolean
  /** 仅 session 目标：磁盘记录的更新时间 */
  updatedAt?: number
}

/** 主窗口把「我现在打开的是哪条会话」告诉主进程 */
export interface ChatActiveInfo {
  cwd: string
  cli: CliId
  /** 已有会话的 CLI session id；新会话为 null */
  id: string | null
  title: string
  isNew: boolean
}

/** IDE → 主窗口：把 refs 附加到目标会话的输入框 */
export interface IdeSendPayload {
  target: ChatTargetInfo
  refs: IdeCodeRef[]
}

export interface IdeSendResult {
  ok: boolean
  message?: string
}
