import { baseName, dirName, shortDir } from '@shared/path'
import type { AgentEvent } from '@shared/events'

/**
 * 本轮改过的一个文件 —— 按路径去重之后的累计。
 *
 * 「本轮」= 最后一次用户发言之后。数据来自两类事件：
 *  - `file_change`（agent / subagent）：每次编辑工具回执累加；
 *  - `file_change`（disk）：轮末磁盘/Git 快照，补上没有工具统计的路径。
 *
 * 后者的意义是补上**没有工具卡**的改动：Bash、脚本、MCP 工具，
 * 以及已经跑完但主对话没收到回执的子代理。
 */
export interface ChangedFile {
  /** 归一化后的路径，当 React key 用（同一个文件两种斜杠写法算同一个） */
  key: string
  /** 原始路径 —— 只进 title */
  path: string
  /** 文件名 */
  name: string
  /** 父目录（缩短形式，跟工具卡上那行一个规则） */
  dir: string
  added: number
  removed: number
  /** 用 Write 写过（图标用 ＋，跟编辑区分开） */
  wrote: boolean
  /** 本轮**新建**（Write 且回执里带 created，或磁盘快照发现的新文件） */
  created: boolean
  /** 本轮被删掉了（只有磁盘快照知道） */
  deleted: boolean
  /**
   * 行数是不是工具回执算出来的。
   *
   * git 磁盘快照给的是**当前对 HEAD 的总 diff**；文件在本轮之前就脏的话，
   * 这个数会把旧改动也算进来。所以已经有工具统计时不让磁盘覆盖 ——
   * 那才是真正属于这一轮的行数。
   */
  byTool: boolean
}

/** 归一化路径：Windows 上同一个文件可能一会儿 \ 一会儿 / */
export function fileKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

function makeFile(ch: Extract<AgentEvent, { t: 'file_change' }>): ChangedFile {
  const path = ch.path.trim()
  return {
    key: fileKey(path),
    path,
    name: baseName(path),
    dir: shortDir(dirName(path)),
    added: ch.added ?? 0,
    removed: ch.removed ?? 0,
    wrote: ch.wrote === true || ch.created === true,
    created: ch.created === true,
    deleted: ch.deleted === true,
    byTool: ch.source !== 'disk'
  }
}

/**
 * 把一条 file_change 合进列表。
 *
 * 合并规则：
 *  - 工具来源：同一文件多次编辑累加；
 *  - 磁盘来源：只补「还没有工具统计」的路径。git 给的是对 HEAD 的总 diff，
 *    文件本轮之前就脏的话会把旧改动算进来，所以不能覆盖工具算出的行数。
 */
export function applyFileChange(
  files: ChangedFile[],
  ch: Extract<AgentEvent, { t: 'file_change' }>
): ChangedFile[] {
  if (!ch.path.trim()) return files
  const key = fileKey(ch.path)
  const i = files.findIndex((f) => f.key === key)

  if (i < 0) return [...files, makeFile(ch)]

  const cur = files[i]
  const next: ChangedFile = { ...cur }

  if (ch.source === 'disk') {
    // 删除是权威状态，行数也跟着磁盘走（文件已经不在了）
    if (ch.deleted) {
      next.deleted = true
      if (ch.added != null) next.added = ch.added
      if (ch.removed != null) next.removed = ch.removed
    } else if (!cur.byTool) {
      // 没有工具统计的（Bash/脚本/MCP）才用磁盘值兜底
      if (ch.added != null) next.added = ch.added
      if (ch.removed != null) next.removed = ch.removed
    }
    if (ch.created) {
      next.created = true
      next.wrote = true
    }
  } else {
    next.added += ch.added ?? 0
    next.removed += ch.removed ?? 0
    if (ch.created) next.created = true
    if (ch.deleted) next.deleted = true
    if (ch.wrote) next.wrote = true
    next.byTool = true
  }

  const copy = files.slice()
  copy[i] = next
  return copy
}

/**
 * 历史回放：只保留**最后一条用户消息之后**的改动。
 *
 * 打开旧会话时「本轮修改」应该显示最后一次提问那一轮，而不是整个会话。
 */
export function filesAfterLastTurn(events: AgentEvent[]): ChangedFile[] {
  let files: ChangedFile[] = []
  for (const e of events) {
    if (e.t === 'user_message' || e.t === 'turn_started') files = []
    else if (e.t === 'file_change') files = applyFileChange(files, e)
  }
  return files
}
