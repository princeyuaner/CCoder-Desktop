import { statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * 定位随应用分发的 ripgrep 可执行文件 —— 纯 Node，不 import Electron。
 *
 * 顺序：显式覆盖 → 打包后的 resources/bin → 开发期 node_modules / build/rg
 * → PATH。找不到时返回 null，调用方回退内置搜索。
 */

const RG_NAME = process.platform === 'win32' ? 'rg.exe' : 'rg'
const IS_WIN = process.platform === 'win32'
/** 解析结果缓存：避免每次按键都 stat 一串路径 */
const RESOLVE_TTL_MS = 10_000
/** 明确失败后冷却一段时间，避免反复 spawn / 探测 */
const UNAVAILABLE_TTL_MS = 60_000

let cached: { at: number; path: string | null } | null = null
let unavailableUntil = 0

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Electron 的 process.resourcesPath；普通 Node（测试）下不存在 */
function resourcesRoot(): string | undefined {
  const p = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return typeof p === 'string' && p ? p : undefined
}

function pathCandidates(name: string): string[] {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  return dirs.map((dir) => join(dir, name))
}

function platformPackageDir(): string {
  return `ripgrep-${process.platform}-${process.arch}`
}

/**
 * 解析 rg 路径。返回值可能是绝对路径，也可能是 PATH 里的裸命令名（兜底）。
 */
export function resolveRgPath(): string | null {
  const now = Date.now()
  if (cached && now - cached.at < RESOLVE_TTL_MS) return cached.path
  if (now < unavailableUntil) return null

  const tried: string[] = []

  const override = process.env.CCODER_RG_PATH?.trim()
  if (override) {
    if (isFile(override)) {
      cached = { at: now, path: override }
      return override
    }
    // 允许用户只写 "rg"：继续走 PATH 查找，而不是直接判失败
    tried.push(override)
    if (!override.includes('/') && !override.includes('\\')) {
      const hit = pathCandidates(override).find(isFile)
      if (hit) {
        cached = { at: now, path: hit }
        return hit
      }
    }
  }

  const candidates: string[] = []

  const resources = resourcesRoot()
  if (resources) candidates.push(join(resources, 'bin', RG_NAME))

  // 开发期：仓库根目录下的 staging / node_modules
  const cwd = process.cwd()
  candidates.push(
    join(cwd, 'build', 'rg', RG_NAME),
    join(cwd, 'node_modules', '@vscode', platformPackageDir(), 'bin', RG_NAME),
    // 旧版 @vscode/ripgrep 直接放在包内 bin/
    join(cwd, 'node_modules', '@vscode', 'ripgrep', 'bin', RG_NAME)
  )

  for (const candidate of candidates) {
    tried.push(candidate)
    if (isFile(candidate)) {
      cached = { at: now, path: candidate }
      return candidate
    }
  }

  // PATH 里可能有用户自己安装的 rg；Windows 上同时试 rg.exe 和 rg
  const names = IS_WIN ? ['rg.exe', 'rg'] : ['rg']
  for (const name of names) {
    const hit = pathCandidates(name).find(isFile)
    if (hit) {
      cached = { at: now, path: hit }
      return hit
    }
  }

  cached = { at: now, path: null }
  return null
}

/** 启动失败（ENOENT / EACCES / 被安全软件拦截）后调用，冷却期内直接走回退路径 */
export function markRgUnavailable(): void {
  unavailableUntil = Date.now() + UNAVAILABLE_TTL_MS
  cached = { at: Date.now(), path: null }
}

/** 测试 / 环境变化时清空解析缓存 */
export function resetRgPathState(): void {
  cached = null
  unavailableUntil = 0
}
