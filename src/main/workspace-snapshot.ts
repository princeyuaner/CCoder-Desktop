import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, relative, resolve } from 'node:path'
import type { AgentEvent } from '../shared/events'

/**
 * 轮末的磁盘快照。
 *
 * 为什么不能只靠工具事件：Bash、脚本、MCP 工具改的文件没有 Edit 工具卡。
 * 只靠工具事件会把它们全部漏掉。
 *
 * 优先走 git：`status --porcelain` + `diff --numstat` 能拿到准确的新增/删除
 * 行数，而且只扫描被改过的文件。不是 git 仓库时退化成目录树快照 ——
 * 只比 mtime/size，拿不到行数，但至少「改过哪些文件」是对的。
 *
 * 快照在每轮开始时拍一次、轮末再拍一次，两次都成功（没有超时/截断）
 * 才交付差异；任何一边不完整就整轮放弃磁盘来源，避免报出一堆假改动。
 */

/** 单条 git 命令的上限。超时就当这个目录不是可用的 git 工作区，退回目录树。 */
const GIT_TIMEOUT = 2000
const GIT_MAX_BUFFER = 16 * 1024 * 1024
/** 非 git 目录的时间/数量上限 —— 大仓库靠 git，纯目录树不能无限扫 */
const FS_DEADLINE_MS = 600
const FS_MAX_FILES = 20_000
/** 新建文件数行时的读取上限，避免把几 GB 的产物读进内存 */
const COUNT_LINES_MAX_BYTES = 2 * 1024 * 1024

/**
 * 非 git 快照跳过的目录。
 *
 * 这些目录要么是依赖/产物（改了也不该出现在修改清单里），要么是 VCS
 * 自己的元数据。`.claude` 也跳过 —— 它是 CLI 的配置地盘，不是工作区内容。
 */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'out',
  'dist',
  'build',
  'release',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.parcel-cache',
  '.cache',
  '.idea',
  '.vscode',
  '.claude',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  'target',
  'vendor'
])

interface FileState {
  added: number
  removed: number
  mtimeMs: number
  size: number
  created: boolean
  deleted: boolean
}

export interface WorkspaceSnapshot {
  cwd: string
  kind: 'git' | 'fs'
  /** false = 超时/超量/命令失败，差异不可信，直接不用 */
  complete: boolean
  files: Map<string, FileState>
}

type FileChange = Extract<AgentEvent, { t: 'file_change' }>

const empty = (cwd: string, kind: 'git' | 'fs'): WorkspaceSnapshot => ({
  cwd,
  kind,
  complete: false,
  files: new Map()
})

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT,
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'ignore']
  })
}

function countLines(path: string): number {
  try {
    if (statSync(path).size > COUNT_LINES_MAX_BYTES) return 0
    const text = readFileSync(path, 'utf8')
    if (!text) return 0
    return text.replace(/\n$/, '').split('\n').length
  } catch {
    return 0
  }
}

/** `--numstat -z` 的输出：`added\tremoved\tpath\0`，二进制是 `-\t-` */
function parseNumstat(out: string, into: Map<string, { added: number; removed: number }>): void {
  for (const rec of out.split('\0')) {
    if (!rec) continue
    const parts = rec.split('\t')
    if (parts.length < 3) continue
    const added = parts[0] === '-' ? 0 : Number(parts[0]) || 0
    const removed = parts[1] === '-' ? 0 : Number(parts[1]) || 0
    // 路径里可能有 tab；-z 只保证记录之间用 NUL 分隔
    const path = parts.slice(2).join('\t')
    const cur = into.get(path)
    if (cur) {
      cur.added += added
      cur.removed += removed
    } else {
      into.set(path, { added, removed })
    }
  }
}

function gitSnapshot(cwd: string): WorkspaceSnapshot {
  const files = new Map<string, FileState>()

  /*
   * status 和 diff 的路径都相对**仓库根**（实测：即便 -C 到子目录，
   * porcelain 也还是给仓库根相对路径）。所以先拿到 toplevel，统一 resolve。
   * 之前用 --relative 把 diff 变成 cwd 相对、status 却是仓库根相对，
   * 两边的 key 对不上，子目录工作区会拼出 `packages/app/packages/app/...`。
   *
   * --no-renames：重命名拆成「删 + 增」两条，和修改清单的粒度一致。
   */
  const root = runGit(cwd, ['rev-parse', '--show-toplevel']).trim() || cwd
  const status = runGit(cwd, [
    '-c',
    'status.relativePaths=false',
    'status',
    '--porcelain=v1',
    '-z',
    '--no-renames',
    '--untracked-files=all'
  ])

  /** path → 状态；只收 dirty / untracked */
  const statuses = new Map<string, string>()
  for (const rec of status.split('\0')) {
    // 形如 " M src/a.ts" / "?? new.ts"
    if (rec.length < 4) continue
    const xy = rec.slice(0, 2)
    const path = rec.slice(3)
    if (!path) continue
    statuses.set(path, xy)
  }

  const stats = new Map<string, { added: number; removed: number }>()
  parseNumstat(runGit(cwd, ['diff', '--numstat', '-z', '--no-renames']), stats)
  parseNumstat(runGit(cwd, ['diff', '--cached', '--numstat', '-z', '--no-renames']), stats)

  for (const [rel, xy] of statuses) {
    const abs = resolve(root, rel)
    // 工作区是仓库子目录时，只报这个子树里的改动
    const relToCwd = relative(cwd, abs)
    if (relToCwd.startsWith('..') || isAbsolute(relToCwd)) continue
    const deleted = xy.includes('D')
    const created = xy === '??'
    const st = deleted ? null : existsSync(abs) ? statSync(abs) : null
    const exact = stats.get(rel)
    // untracked 不在 numstat 里，按内容行数算
    const added = created ? countLines(abs) : (exact?.added ?? 0)
    const removed = created ? 0 : (exact?.removed ?? 0)

    files.set(abs, {
      added,
      removed,
      mtimeMs: st?.mtimeMs ?? 0,
      size: st?.size ?? 0,
      created,
      deleted
    })
  }

  return { cwd, kind: 'git', complete: true, files }
}

function fsSnapshot(cwd: string): WorkspaceSnapshot {
  // 主目录 / 盘根不是工作区，递归扫会把整台机器拖死
  if (cwd === homedir() || resolve(cwd) === parse(resolve(cwd)).root) {
    return empty(cwd, 'fs')
  }

  const files = new Map<string, FileState>()
  const started = Date.now()
  let complete = true
  const stack = [resolve(cwd)]

  while (stack.length > 0) {
    if (Date.now() - started > FS_DEADLINE_MS || files.size > FS_MAX_FILES) {
      complete = false
      break
    }
    const dir = stack.pop()
    if (!dir) break
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) stack.push(full)
        continue
      }
      // 符号链接不跟 —— 目录环会让遍历停不下来
      if (!e.isFile()) continue
      try {
        const st = statSync(full)
        files.set(full, {
          added: 0,
          removed: 0,
          mtimeMs: st.mtimeMs,
          size: st.size,
          created: false,
          deleted: false
        })
      } catch {
        // 扫描过程中被删掉的文件，忽略
      }
      if (files.size > FS_MAX_FILES) {
        complete = false
        break
      }
    }
  }

  return { cwd, kind: 'fs', complete, files }
}

export function snapshotWorkspace(cwd: string): WorkspaceSnapshot {
  if (!cwd || !existsSync(cwd)) return empty(cwd, 'fs')
  try {
    // 不是仓库 / git 不可用 / 超时，rev-parse 会立刻抛错，直接落到目录树
    return gitSnapshot(cwd)
  } catch {
    return fsSnapshot(cwd)
  }
}

function sameState(a: FileState, b: FileState): boolean {
  return (
    a.mtimeMs === b.mtimeMs &&
    a.size === b.size &&
    a.added === b.added &&
    a.removed === b.removed &&
    a.created === b.created &&
    a.deleted === b.deleted
  )
}

/**
 * 前后两次快照 → 本轮文件改动。
 *
 * 只报**状态发生变化**的路径：
 *  - 轮前已是 dirty、轮后还是同样的 diff → 不是这一轮改的，跳过；
 *  - 轮前 clean、轮后 dirty → 算这一轮；
 *  - 轮前 dirty、轮后变回 clean → 是这一轮改回去了，没有净改动，跳过；
 *  - 目录树来源下，轮后消失的文件 = 本轮删除。
 */
export function diffWorkspace(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot
): FileChange[] {
  if (
    !before.complete ||
    !after.complete ||
    before.kind !== after.kind ||
    before.cwd !== after.cwd
  ) {
    return []
  }

  const out: FileChange[] = []
  const git = after.kind === 'git'

  for (const [path, st] of after.files) {
    const prev = before.files.get(path)
    if (prev && sameState(prev, st)) continue

    /*
     * 「本轮新建」= 轮前的快照里根本没有这个路径。
     *
     * git 的 st.created 只是「此刻还是未跟踪」—— 几天前就建好、一直没提交
     * 的文件也满足这个条件。只看 st.created 会把早就存在的未跟踪文件标成
     * 这一轮的新增（实测：别的会话早先写的 mockup 被打上「新」）。
     */
    const created = !prev && (st.created || !git)
    /*
     * git 的新增/删除行数是权威值，覆盖工具事件里的估算；
     * 目录树拿不到行数，就**省略**字段 —— 否则会把工具事件已经算好的
     * +N −M 覆盖成 0。
     */
    const stat = git
      ? { added: st.added, removed: st.removed }
      : created
        ? // 目录树快照不存内容，新建文件的行数在这里补算
          { added: countLines(path), removed: 0 }
        : {}

    out.push({
      t: 'file_change',
      path,
      ...stat,
      ...(created ? { created: true } : {}),
      ...(st.deleted ? { deleted: true } : {}),
      source: 'disk'
    })
  }

  // 目录树来源：轮后消失 = 删除。git 下删除会以 D 状态出现在 after 里
  if (!git) {
    for (const [path, st] of before.files) {
      if (st.deleted || after.files.has(path)) continue
      out.push({ t: 'file_change', path, deleted: true, source: 'disk' })
    }
  }

  return out
}
