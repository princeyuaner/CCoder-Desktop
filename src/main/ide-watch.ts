import { watch, type FSWatcher } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { markWorkspaceSearchStale } from './workspace-search'
import { isIgnoredDirName } from './workspace-ignore'

/**
 * 工作区文件监听 —— 纯 Node，不 import Electron。
 *
 * 一圈递归 `fs.watch`，把事件去抖、合并成批次交给上层。渲染进程拿到的
 * 是一组工作区相对路径，而不是每个事件；它自己决定重载哪些打开的缓冲区。
 *
 * 忽略规则和文件树 / 代码检索共用 `WORKSPACE_IGNORE_DIRS`：`node_modules` /
 * `.git` / `out` 这类目录的写入既不值得刷新，也不该把 IPC 打爆。
 */

export interface WorkspaceWatchBatch {
  /** 工作区相对路径，正斜杠；可能是文件或目录 */
  rels: string[]
  /** 超出路径数 / 字符上限，`rels` 不完整 */
  truncated: boolean
  /** 无法定位到具体路径（filename 为 null、根事件等） */
  generic: boolean
}

export interface WorkspaceWatchOptions {
  /** 尾随去抖，默认 250ms */
  debounceMs?: number
  /** 连续写入时的强制 flush 上限，默认 1000ms */
  maxWaitMs?: number
  /** 一批最多带多少条路径，默认 500 */
  maxPaths?: number
}

const DEFAULT_DEBOUNCE_MS = 250
const DEFAULT_MAX_WAIT_MS = 1000
const DEFAULT_MAX_PATHS = 500
/** 路径列表的字符上限，防止极端事件把 IPC 载荷撑大 */
const MAX_BATCH_CHARS = 32_000
/** watcher 出错后多久尝试重建 */
const RESTART_MS = 1000

const WIN = process.platform === 'win32'

function ignoredSegment(name: string): boolean {
  return isIgnoredDirName(name)
}

/** 把 fs.watch 给的 filename 换算成工作区相对 POSIX 路径 */
function toRel(
  root: string,
  filename: string | Buffer | null
): { rel?: string; generic: boolean } {
  if (filename == null) return { generic: true }
  const raw = typeof filename === 'string' ? filename : filename.toString('utf8')
  // 空字符串、NUL 都说明这次事件定位不到具体条目
  if (!raw || raw.includes('\0')) return { generic: true }

  let rel: string
  if (isAbsolute(raw)) {
    rel = relative(root, raw).replace(/\\/g, '/')
  } else {
    rel = raw.replace(/\\/g, '/')
  }
  rel = rel.replace(/^\.\//, '').replace(/\/+$/, '')
  if (!rel || rel === '.' || rel.startsWith('../') || isAbsolute(rel)) {
    return { generic: true }
  }
  if (rel.split('/').some((part) => part === '..' || part === '')) {
    return { generic: true }
  }
  return { rel, generic: false }
}

function isIgnored(rel: string): boolean {
  return rel.split('/').some((part) => ignoredSegment(part))
}

/**
 * 开始监听 `cwd`，返回幂等的停止函数。
 *
 * 错误处理：创建 watcher 失败（Linux inotify 配额耗尽 / 平台不支持递归）时
 * 退回只监听根目录；这种情况下事件范围未知，按 `generic` 上报。watcher
 * 运行中出错则关闭并在 1 秒后重建一次。
 */
export function startWorkspaceWatch(
  cwd: string,
  onBatch: (batch: WorkspaceWatchBatch) => void,
  options: WorkspaceWatchOptions = {}
): () => void {
  const root = resolve(cwd)
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
  const maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS

  let watcher: FSWatcher | null = null
  let disposed = false
  let restartTimer: NodeJS.Timeout | null = null
  let trailingTimer: NodeJS.Timeout | null = null
  let hardTimer: NodeJS.Timeout | null = null

  const pending = new Set<string>()
  let chars = 0
  let truncated = false
  let generic = false
  /** 非递归降级：只能看到根目录条目，范围未知 */
  let fallback = false

  const clearTimers = (): void => {
    if (trailingTimer) {
      clearTimeout(trailingTimer)
      trailingTimer = null
    }
    if (hardTimer) {
      clearTimeout(hardTimer)
      hardTimer = null
    }
  }

  const flush = (): void => {
    if (disposed) return
    clearTimers()
    const rels = [...pending]
    const wasTruncated = truncated
    const wasGeneric = generic || fallback
    pending.clear()
    chars = 0
    truncated = false
    generic = false

    if (rels.length === 0 && !wasTruncated && !wasGeneric) return

    // 只标记 stale：下一次快速打开先返回旧列表并在后台刷新，不阻塞输入。
    // 传 cwd 保证只影响当前工作区，不会把其它窗口的缓存一起清掉。
    markWorkspaceSearchStale(cwd)
    try {
      onBatch({ rels, truncated: wasTruncated, generic: wasGeneric })
    } catch {
      // 上层（窗口推送）出错不能把主进程带崩
    }
  }

  const schedule = (): void => {
    if (trailingTimer) clearTimeout(trailingTimer)
    trailingTimer = setTimeout(flush, debounceMs)
    // 持续写入时尾随计时器会一直被重置，必须有一道硬上限
    if (!hardTimer) hardTimer = setTimeout(flush, maxWaitMs)
  }

  const onEvent = (eventType: string, filename: string | Buffer | null): void => {
    if (disposed) return
    const mapped = toRel(root, filename)
    if (mapped.generic) {
      generic = true
      schedule()
      return
    }
    const rel = mapped.rel
    if (!rel || isIgnored(rel)) return
    // 非递归降级只能看到根目录条目，无法判断子树里改了什么
    if (fallback) {
      generic = true
      schedule()
      return
    }

    if (!pending.has(rel)) {
      if (pending.size >= maxPaths || chars + rel.length > MAX_BATCH_CHARS) {
        truncated = true
      } else {
        pending.add(rel)
        chars += rel.length
      }
    }
    schedule()
  }

  const attach = (recursive: boolean): void => {
    fallback = !recursive
    try {
      watcher = watch(root, { recursive }, onEvent)
    } catch {
      // 递归不可用（或配额不足）时退回根目录监听，至少让根级改动可见
      if (recursive) {
        attach(false)
      } else {
        watcher = null
      }
      return
    }

    watcher.on('error', () => {
      if (disposed) return
      try {
        watcher?.close()
      } catch {
        // 已经坏了，忽略
      }
      watcher = null
      if (restartTimer) clearTimeout(restartTimer)
      restartTimer = setTimeout(() => {
        restartTimer = null
        // 先重试递归；递归仍不可用时会自动降级到根目录
        if (!disposed) attach(true)
      }, RESTART_MS)
    })
  }

  attach(true)

  return () => {
    if (disposed) return
    disposed = true
    clearTimers()
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    try {
      watcher?.close()
    } catch {
      // 关闭失败不影响窗口销毁
    }
    watcher = null
  }
}
