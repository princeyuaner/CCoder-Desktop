import { promises as fs } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { FileMatch } from '../shared/workspace'
import { listFilesWithRg } from './rg-files'
import { WORKSPACE_MAX_DEPTH, WORKSPACE_MAX_ENTRIES } from './search-limits'
import { isIgnoredWorkspacePath } from './workspace-ignore'

/**
 * 工作区文件检索 —— 纯 Node，不 import Electron。
 *
 * 优先用 `rg --files`（遵循 .gitignore、大仓库更快），失败时回退到递归
 * `fs.readdir`。被 `@` 文件引用、快速打开、代码搜索和全部替换共用。
 *
 * 缓存采用 stale-while-revalidate：文件变化只把缓存标记为 stale，下一次
 * 输入先返回旧列表并在后台刷新，绝不让键盘输入等一次全量扫描。
 */

export { WORKSPACE_IGNORE_DIRS } from './workspace-ignore'

/** 缓存多久；目录内容变化不频繁，15 秒足够让连续输入 @ 不重复扫盘 */
const CACHE_TTL_MS = 15_000
/** rg 失败后多久再试；期间直接用 Node 扫描 */
const RG_RETRY_MS = 60_000
/** 最多缓存几个工作区 */
const MAX_ROOTS = 12
/** 默认 / 最多返回条数 */
const DEFAULT_LIMIT = 20
const MAX_RESULTS = 60

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
  /** 写入缓存的时间 */
  at: number
  /** 文件变化后置 true；仍可先返回，同时后台刷新 */
  stale: boolean
  /** 失效代数；扫描期间被失效就不要回填旧结果 */
  gen: number
  source: 'rg' | 'node'
}

const cache = new Map<string, Cached>()
const inFlight = new Map<string, Promise<WorkspaceScanResult>>()
const rgInFlight = new Map<string, Promise<WorkspaceScanResult | null>>()
/** 每个根工作区独立的失效代数 */
const generations = new Map<string, number>()
let rgUnavailableUntil = 0

/** 缓存键：Windows 上盘符大小写不敏感，折叠一下；POSIX 保持原样 */
function cacheKey(cwd: string): string {
  const root = resolve(cwd).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? root.toLowerCase() : root
}

function generationOf(key: string): number {
  return generations.get(key) ?? 0
}

function bumpGeneration(key: string): number {
  const next = generationOf(key) + 1
  generations.set(key, next)
  return next
}

/** 只留最近用到的几个工作区，避免长时间运行后缓存无限涨 */
function evictOldRoots(): void {
  while (cache.size > MAX_ROOTS) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (!oldest) break
    cache.delete(oldest[0])
  }
}

function store(key: string, root: string, gen: number, source: 'rg' | 'node', result: WorkspaceScanResult): void {
  if (gen !== generationOf(key)) return
  cache.set(key, { root, at: Date.now(), stale: false, gen, source, ...result })
  evictOldRoots()
}

/* ── Node 回退扫描 ─────────────────────────────────────────── */

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
      if (++seen > WORKSPACE_MAX_ENTRIES) {
        truncated = true
        return { files: out, truncated, incomplete }
      }
      // 不跟随符号链接：避免环、也避免跑到工作区外面
      if (ent.isSymbolicLink()) continue

      const rel = dirRel ? `${dirRel}/${ent.name}` : ent.name
      if (ent.isDirectory()) {
        if (isIgnoredWorkspacePath(rel)) continue
        if (depth >= WORKSPACE_MAX_DEPTH) {
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
        // 和 rg 路径保持一致：文件名命中的敏感文件 / 临时产物也跳过
        if (isIgnoredWorkspacePath(rel)) continue
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

/**
 * Node 扫描缓存。
 *
 * `fresh:true` 用于替换：等待一次新扫描；默认模式命中旧缓存立即返回，
 * 过期 / stale 时后台刷新。
 */
function getNodeScan(cwd: string, fresh = false): Promise<WorkspaceScanResult> {
  const key = cacheKey(cwd)
  const hit = cache.get(key)

  if (!fresh && hit) {
    if (hit.stale || Date.now() - hit.at >= CACHE_TTL_MS) {
      void getNodeScan(cwd, true).catch(() => undefined)
    }
    return Promise.resolve(hit)
  }

  const running = inFlight.get(key)
  if (running) return running

  const root = resolve(cwd)
  const gen = generationOf(key)
  const p = scan(root)
    .then((result) => {
      store(key, root, gen, 'node', result)
      return result
    })
    .finally(() => {
      inFlight.delete(key)
    })

  inFlight.set(key, p)
  return p
}

/* ── rg 文件列表 + 缓存 ────────────────────────────────────── */

async function scanWithRg(cwd: string): Promise<WorkspaceScanResult | null> {
  if (Date.now() < rgUnavailableUntil) return null

  const key = cacheKey(cwd)
  const running = rgInFlight.get(key)
  if (running) return running

  const root = resolve(cwd)
  const gen = generationOf(key)
  const p = listFilesWithRg(root)
    .then(async (result) => {
      if (!result.ok) {
        rgUnavailableUntil = Date.now() + RG_RETRY_MS
        return null
      }
      const scanResult: WorkspaceScanResult = {
        files: result.files,
        truncated: result.truncated,
        incomplete: result.incomplete
      }
      store(key, root, gen, 'rg', scanResult)
      return scanResult
    })
    .catch(() => {
      rgUnavailableUntil = Date.now() + RG_RETRY_MS
      return null
    })
    .finally(() => {
      rgInFlight.delete(key)
    })

  rgInFlight.set(key, p)
  return p
}

/**
 * 工作区完整条目表。rg 优先，失败回退 Node；`fresh:true` 时等待新列表。
 *
 * 默认模式下即使缓存 stale 也会先返回旧列表并后台刷新，避免快速打开在
 * 每次文件变化后都卡一下。
 */
async function refreshWorkspaceFiles(cwd: string): Promise<void> {
  const rgHit = await scanWithRg(cwd)
  if (!rgHit) await getNodeScan(cwd, true)
}

async function getWorkspaceFiles(
  cwd: string,
  options: { fresh?: boolean } = {}
): Promise<WorkspaceScanResult> {
  const key = cacheKey(cwd)
  const fresh = options.fresh === true
  const hit = cache.get(key)

  if (!fresh && hit) {
    if (hit.stale || Date.now() - hit.at >= CACHE_TTL_MS) {
      void refreshWorkspaceFiles(cwd).catch(() => undefined)
    }
    return hit
  }

  const rgHit = await scanWithRg(cwd)
  if (rgHit) return rgHit
  return getNodeScan(cwd, fresh)
}

/* ── 对外 API ─────────────────────────────────────────────── */

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
 * 和 `searchWorkspaceFiles` 共用同一份缓存；调用方自己决定上限。
 */
export async function listWorkspaceFiles(cwd: string): Promise<FileMatch[]> {
  if (!cwd || !isAbsolute(cwd)) return []
  try {
    const st = await fs.stat(cwd)
    if (!st.isDirectory()) return []
    return (await getWorkspaceFiles(cwd)).files
  } catch {
    return []
  }
}

/**
 * 和 `listWorkspaceFiles` 同一份缓存，但带上「扫描是否完整」。
 * 代码搜索 / 全部替换用它：替换在列表不完整时宁可中止，也不能静默漏文件。
 */
export async function listWorkspaceFilesDetailed(
  cwd: string,
  options: { fresh?: boolean } = {}
): Promise<WorkspaceScanResult> {
  if (!cwd || !isAbsolute(cwd)) {
    return { files: [], truncated: false, incomplete: true }
  }
  try {
    const st = await fs.stat(cwd)
    if (!st.isDirectory()) return { files: [], truncated: false, incomplete: true }
    return await getWorkspaceFiles(cwd, options)
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
    files = (await getWorkspaceFiles(cwd)).files
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

/**
 * 外部文件变化：只标记 stale，下一次请求先返回旧列表并后台刷新。
 * 不阻塞快速打开，也不影响其它工作区的缓存。
 */
export function markWorkspaceSearchStale(cwd: string): void {
  if (!cwd || !isAbsolute(cwd)) return
  const key = cacheKey(cwd)
  bumpGeneration(key)
  const hit = cache.get(key)
  if (hit) hit.stale = true
}

/**
 * 清掉缓存：测试用；替换前强制重扫也用它。
 * 不传 cwd 时清空所有根（仅测试），传 cwd 时只清这个工作区。
 */
export function resetWorkspaceSearchCache(cwd?: string): void {
  if (!cwd) {
    cache.clear()
    inFlight.clear()
    rgInFlight.clear()
    generations.clear()
    rgUnavailableUntil = 0
    return
  }
  const key = cacheKey(cwd)
  cache.delete(key)
  // 已经在跑的扫描可能读到失效前的目录内容；让新请求重新起一份，
  // 旧扫描完成时 generation 校验会阻止它回填缓存。
  inFlight.delete(key)
  rgInFlight.delete(key)
  bumpGeneration(key)
}
