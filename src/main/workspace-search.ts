import { promises as fs } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { FileMatch } from '../shared/workspace'

/**
 * 工作区文件检索 —— 纯 Node，不 import Electron。
 *
 * 被 `@` 文件引用使用。刻意**不在渲染进程里做**：renderer 没有 fs 权限，
 * 而且大项目递归扫描必须异步，不能卡住主进程处理 IPC。
 *
 * 第一版不做 .gitignore 解析：用一份固定的忽略表覆盖常见的生成目录和敏感文件。
 * 这样没有依赖、行为可预测；以后需要精确跟随 .gitignore 再单独换实现。
 */

/** 最多走这么多条目就停 —— 大项目返回部分结果，别把主进程拖死 */
const MAX_ENTRIES = 50_000
/** 目录深度上限，防止 node_modules 之类的意外深层结构 */
const MAX_DEPTH = 12
/** 缓存多久；目录内容变化不频繁，15 秒足够让连续输入 @ 不重复扫盘 */
const CACHE_TTL_MS = 15_000
/** 最多缓存几个工作区 */
const MAX_ROOTS = 12
/** 默认 / 最多返回条数 */
const DEFAULT_LIMIT = 20
const MAX_RESULTS = 60

const IGNORE_DIRS = new Set([
  'node_modules',
  'out',
  'dist',
  'build',
  'release',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.parcel-cache',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.pytest_cache',
  '.mypy_cache',
  '.git',
  '.claude',
  '.idea',
  '.vscode',
  'logs'
])

const IGNORE_FILES = new Set([
  '.DS_Store',
  'Thumbs.db',
  '.npmrc',
  '.netrc'
])

function isIgnoredFile(name: string, rel: string): boolean {
  if (IGNORE_FILES.has(name)) return true
  if (/^\.env(\.|$)/i.test(name)) return true
  if (/\.(log|pem|p12|pfx|key)$/i.test(name)) return true
  if (/^id_(rsa|ed25519|ecdsa)(\.|$)/i.test(name)) return true
  // verify 脚本 esbuild 出来的临时 bundle，体积大且没检索价值
  if (rel.startsWith('tools/_') && rel.endsWith('.cjs')) return true
  return false
}

/** IDE 文件树也用这一份忽略表，免得 node_modules 又冒出来 */
export const WORKSPACE_IGNORE_DIRS: ReadonlySet<string> = IGNORE_DIRS

/**
 * 扫描结果。搜索 / 替换必须知道列表是否完整：
 * `truncated` 是条目或深度上限，`incomplete` 是有目录读失败。
 */
export interface WorkspaceScanResult {
  files: FileMatch[]
  truncated: boolean
  incomplete: boolean
}

interface Cached extends WorkspaceScanResult {
  /** resolve 后的真实根路径，用来读盘 */
  root: string
  at: number
}

const cache = new Map<string, Cached>()
const inFlight = new Map<string, Promise<WorkspaceScanResult>>()
/**
 * 失效代数。清缓存时递增，让失效前已经开始的扫描不要把它读到的旧目录
 * 内容再写回缓存 —— 否则外部改完文件后快速打开仍可能看到旧列表。
 */
let generation = 0

/** 缓存键：Windows 上盘符大小写不敏感，折叠一下；POSIX 保持原样 */
function cacheKey(cwd: string): string {
  const root = resolve(cwd).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? root.toLowerCase() : root
}

const toPosix = (p: string): string => p.replace(/\\/g, '/')

async function scan(root: string): Promise<WorkspaceScanResult> {
  const out: FileMatch[] = []
  let seen = 0
  let truncated = false
  let incomplete = false
  /** 栈里存相对路径；最后统一拼绝对路径，避免每个条目都做一次 resolve */
  const stack: { rel: string; depth: number }[] = [{ rel: '', depth: 0 }]

  while (stack.length > 0) {
    const { rel: dirRel, depth } = stack.pop()!
    const absDir = dirRel ? join(root, dirRel) : root

    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true })
    } catch {
      // 单个目录不可读（权限 / 刚被删）就跳过，但要让调用方知道列表不完整
      incomplete = true
      continue
    }

    for (const ent of entries) {
      if (++seen > MAX_ENTRIES) {
        truncated = true
        return { files: out, truncated, incomplete }
      }
      // 不跟随符号链接：避免环、也避免跑到工作区外面
      if (ent.isSymbolicLink()) continue

      const rel = dirRel ? `${dirRel}/${ent.name}` : ent.name
      if (ent.isDirectory()) {
        if (IGNORE_DIRS.has(ent.name)) continue
        if (depth >= MAX_DEPTH) {
          truncated = true
          continue
        }
        out.push({
          path: rel,
          name: ent.name,
          dir: dirRel,
          kind: 'dir'
        })
        stack.push({ rel, depth: depth + 1 })
      } else if (ent.isFile()) {
        if (isIgnoredFile(ent.name, rel)) continue
        out.push({
          path: rel,
          name: ent.name,
          dir: dirRel,
          kind: 'file'
        })
      }
    }
  }

  return { files: out, truncated, incomplete }
}

function getScan(cwd: string): Promise<WorkspaceScanResult> {
  const key = cacheKey(cwd)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit)

  const running = inFlight.get(key)
  if (running) return running

  const root = resolve(cwd)
  const gen = generation
  const p = scan(root)
    .then((result) => {
      // 扫描期间缓存被失效（外部文件变化）就不要回填旧结果
      if (gen === generation) {
        cache.set(key, { root, at: Date.now(), ...result })
        // 只留最近用到的几个工作区，避免长时间运行后缓存无限涨
        while (cache.size > MAX_ROOTS) {
          const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
          if (!oldest) break
          cache.delete(oldest[0])
        }
      }
      return result
    })
    .finally(() => {
      inFlight.delete(key)
    })

  inFlight.set(key, p)
  return p
}

function score(m: FileMatch, query: string): number {
  const name = m.name.toLowerCase()
  const path = m.path.toLowerCase()
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  let s = 0

  for (const t of tokens) {
    if (name === t) s += 120
    else if (name.startsWith(t)) s += 90
    else if (name.includes(t)) s += 70
    else if (path.includes(t)) s += 40
    else return -1
  }

  // 文件优先于目录；路径越短越可能是用户想找的
  if (m.kind === 'file') s += 8
  s += Math.max(0, 24 - m.path.split('/').length * 3)
  return s
}

/**
 * 工作区的完整条目表（含目录），供 IDE 代码搜索复用。
 *
 * 和 `searchWorkspaceFiles` 共用同一份扫描缓存；调用方自己决定上限。
 */
export async function listWorkspaceFiles(cwd: string): Promise<FileMatch[]> {
  if (!cwd || !isAbsolute(cwd)) return []
  try {
    const st = await fs.stat(cwd)
    if (!st.isDirectory()) return []
    return (await getScan(cwd)).files
  } catch {
    return []
  }
}

/**
 * 和 `listWorkspaceFiles` 同一份缓存，但带上「扫描是否完整」。
 * 代码搜索 / 全部替换用它：替换在列表不完整时宁可中止，也不能静默漏文件。
 */
export async function listWorkspaceFilesDetailed(
  cwd: string
): Promise<WorkspaceScanResult> {
  if (!cwd || !isAbsolute(cwd)) {
    return { files: [], truncated: false, incomplete: true }
  }
  try {
    const st = await fs.stat(cwd)
    if (!st.isDirectory()) return { files: [], truncated: false, incomplete: true }
    return await getScan(cwd)
  } catch {
    return { files: [], truncated: false, incomplete: true }
  }
}

/**
 * 在工作区里搜文件。结果按“文件名命中 > 路径命中 > 路径长度”排序。
 *
 * 空查询返回工作区里的文件（不含目录）；有查询时文件和目录都可能返回，
 * 目录可以用来继续补全路径。
 */
export async function searchWorkspaceFiles(
  cwd: string,
  query: string,
  limit = DEFAULT_LIMIT
): Promise<FileMatch[]> {
  if (!cwd || !isAbsolute(cwd)) return []

  try {
    const st = await fs.stat(cwd)
    if (!st.isDirectory()) return []
  } catch {
    return []
  }

  let files: FileMatch[]
  try {
    files = (await getScan(cwd)).files
  } catch {
    return []
  }

  // 用户可能顺手打 Windows 的反斜杠；结果路径统一是正斜杠
  const q = query.trim().replace(/\\/g, '/')
  const max = Math.min(MAX_RESULTS, Math.max(1, Math.floor(limit) || DEFAULT_LIMIT))

  if (!q) {
    return files
      .filter((f) => f.kind === 'file')
      .sort((a, b) => {
        const da = a.path.split('/').length
        const db = b.path.split('/').length
        return da - db || a.path.localeCompare(b.path)
      })
      .slice(0, max)
  }

  return files
    .map((f) => ({ f, s: score(f, q) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.f.path.length - b.f.path.length || a.f.path.localeCompare(b.f.path))
    .slice(0, max)
    .map((x) => x.f)
}

/** 清掉缓存：测试用，外部文件变化时也用来让快速打开立刻看到新列表 */
export function resetWorkspaceSearchCache(): void {
  generation++
  cache.clear()
  inFlight.clear()
}
