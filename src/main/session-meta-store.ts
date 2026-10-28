import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CLI_IDS, type CliId } from '../shared/settings'
import {
  sessionMetaKey,
  type SessionMeta,
  type SessionMetaMap,
  type SessionMetaUpdate
} from '../shared/session'
import { logMain } from './crash-log'

/**
 * 应用自己的会话元数据（重命名 / 置顶 / 归档）。
 *
 * 为什么单独存一份、不塞进 settings.json：
 *  - settings 里全是带密钥的渠道配置，重命名一次就要重新加密一遍；
 *  - 侧栏元数据只跟主窗口有关，和外观 / 凭据没有关系；
 *  - 单独文件坏了也只影响侧栏，不会把设置一起带崩。
 *
 * 会话本身仍然只认 CLI 写的那份记录，这里只存"界面层"的补充信息。
 */

const TITLE_MAX = 120
/** 模型名再长也长不到这个量级；挡住手写文件里的超长垃圾 */
const MODEL_MAX = 120

function file(): string {
  return join(app.getPath('userData'), 'session-meta.json')
}

let cache: SessionMetaMap | null = null

function cleanTitle(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  // 换行会把侧栏行撑高，压成一行再截断
  const s = v.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX)
  return s || undefined
}

function cleanModel(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim().slice(0, MODEL_MAX)
  return s || undefined
}

/** 渠道 id 是 UUID / 短串；不做格式校验，只挡超长垃圾 */
function cleanChannelId(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim().slice(0, MODEL_MAX)
  return s || undefined
}

/**
 * 只接受 `sessionMetaKey()` 生成的三元组，顺手挡住手写文件里的
 * `__proto__` 之类的键 —— 后面的赋值是普通对象赋值。
 */
function validKey(k: string): boolean {
  try {
    const a: unknown = JSON.parse(k)
    return (
      Array.isArray(a) &&
      a.length === 3 &&
      typeof a[0] === 'string' &&
      CLI_IDS.includes(a[0] as CliId) &&
      typeof a[1] === 'string' &&
      typeof a[2] === 'string'
    )
  } catch {
    return false
  }
}

function normalize(raw: unknown): SessionMetaMap {
  const out: SessionMetaMap = {}
  if (!raw || typeof raw !== 'object') return out
  const sessions = (raw as { sessions?: unknown }).sessions
  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return out

  for (const [key, value] of Object.entries(sessions as Record<string, unknown>)) {
    if (!validKey(key)) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const o = value as Record<string, unknown>
    const entry: SessionMeta = {}
    const title = cleanTitle(o.title)
    if (title) entry.title = title
    // 只有明确的 true 才算；缺字段 / 坏数据一律当没设置
    if (o.pinned === true) entry.pinned = true
    if (o.archived === true) entry.archived = true
    const model = cleanModel(o.model)
    if (model) entry.model = model
    if (o.authMode === 'official' || o.authMode === 'channel') entry.authMode = o.authMode
    const channelId = cleanChannelId(o.channelId)
    if (channelId) entry.channelId = channelId
    if (
      entry.title ||
      entry.pinned ||
      entry.archived ||
      entry.model ||
      entry.channelId ||
      entry.authMode === 'official'
    ) {
      out[key] = entry
    }
  }
  return out
}

export function getSessionMeta(): SessionMetaMap {
  if (cache) return cache
  try {
    cache = normalize(JSON.parse(readFileSync(file(), 'utf8')))
  } catch {
    // 文件不存在 / 坏了都当空，绝不因此影响会话列表
    cache = {}
  }
  return cache
}

function persist(): void {
  const target = file()
  try {
    mkdirSync(dirname(target), { recursive: true })
    const tmp = `${target}.tmp`
    writeFileSync(
      tmp,
      JSON.stringify({ v: 1, sessions: cache ?? {} }, null, 2),
      'utf8'
    )
    renameSync(tmp, target)
  } catch (err) {
    // 只影响"下次启动还记不记得"，不值得弹窗打断用户
    logMain('session-meta.save', err)
  }
}

/**
 * 合并一条元数据。只处理 patch 里真正出现的字段：
 * `title: ''` 恢复原标题，`pinned: false` 取消置顶，没有的字段保持原样。
 */
export function updateSessionMeta(update: SessionMetaUpdate): SessionMetaMap {
  const meta = getSessionMeta()
  if (
    !update ||
    !CLI_IDS.includes(update.cli) ||
    typeof update.cwd !== 'string' ||
    typeof update.id !== 'string' ||
    !update.cwd ||
    !update.id
  ) {
    return meta
  }

  const key = sessionMetaKey(update.cli, update.cwd, update.id)
  const next: SessionMeta = { ...(meta[key] ?? {}) }
  const patch = update.patch ?? {}

  if ('title' in patch) {
    const title = cleanTitle(patch.title)
    if (title) next.title = title
    else delete next.title
  }
  if (patch.pinned === true) next.pinned = true
  else if (patch.pinned === false) delete next.pinned
  if (patch.archived === true) next.archived = true
  else if (patch.archived === false) delete next.archived
  if ('model' in patch) {
    const model = cleanModel(patch.model)
    if (model) next.model = model
    else delete next.model
  }
  /*
   * 渠道 / 来源也是会话级选择。`channelId: ''` + `authMode: 'official'`
   * 表示"这条会话走官方登录"；空串 = 没有显式选择，跟随设置默认值。
   */
  if ('authMode' in patch) {
    if (patch.authMode === 'official' || patch.authMode === 'channel') {
      next.authMode = patch.authMode
    } else {
      delete next.authMode
    }
  }
  if ('channelId' in patch) {
    const channelId = cleanChannelId(patch.channelId)
    if (channelId) next.channelId = channelId
    else delete next.channelId
  }

  // 空条目不留在文件里，否则删掉的会话会在配置里越攒越多
  if (
    next.title ||
    next.pinned ||
    next.archived ||
    next.model ||
    next.channelId ||
    // 显式的 official 也要留：没有它，下次打开会回落到设置里的默认来源
    next.authMode === 'official'
  ) {
    meta[key] = next
  } else delete meta[key]

  persist()
  return meta
}

/** 会话记录被删掉后，把它的界面元数据一起清掉（不按 cli 区分，id + cwd 就够） */
export function forgetSessionMeta(cwd: string, id: string): void {
  const meta = getSessionMeta()
  let changed = false
  for (const key of Object.keys(meta)) {
    try {
      const a: unknown = JSON.parse(key)
      if (Array.isArray(a) && a[1] === cwd && a[2] === id) {
        delete meta[key]
        changed = true
      }
    } catch {
      // 不是我们写进去的键，忽略
    }
  }
  if (changed) persist()
}
