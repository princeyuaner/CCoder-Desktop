import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { app } from 'electron'
import {
  defaultSyncConfig,
  SYNC_DEFAULTS,
  type SyncConfig,
  type SyncProblem
} from '../../shared/sync'
import { isSameOrInside, pathKey } from '../path-key'
import { normalizePatternList } from './filters'

/**
 * 目录同步配置（按工作区一份）。存在 `sync-configs.json` 里。
 *
 * 为什么不塞进 settings.json：同步配置只跟某个 IDE 工作区有关，
 * 而且每个键都可能随用户输入实时变化；把它和带密钥的渠道配置混在一起，
 * 改一次目录就要重新加密一遍全部凭据。
 */

interface StoredConfig {
  enabled?: unknown
  src?: unknown
  dst?: unknown
  syncRoots?: unknown
  exclude?: unknown
  settleMs?: unknown
  sweepMs?: unknown
  deleteMissing?: unknown
}

interface StoredFile {
  v?: unknown
  workspaces?: Record<string, StoredConfig>
}

function file(): string {
  return join(app.getPath('userData'), 'sync-configs.json')
}

let cache: Record<string, StoredConfig> | null = null

function loadFile(): Record<string, StoredConfig> {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as StoredFile
    cache =
      raw && raw.workspaces && typeof raw.workspaces === 'object' ? raw.workspaces : {}
  } catch {
    cache = {}
  }
  return cache
}

function strings(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string')
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** 规整一份（可能半填、可能类型不对的）配置。缺项 / 类型不对一律回落默认。 */
export function normalizeConfig(cwd: string, raw: StoredConfig | null): SyncConfig {
  const d = defaultSyncConfig(cwd)
  const settle = Math.round(
    Math.min(
      SYNC_DEFAULTS.maxSettleMs,
      Math.max(SYNC_DEFAULTS.minSettleMs, num(raw?.settleMs, d.settleMs))
    )
  )
  const rawSweep = num(raw?.sweepMs, d.sweepMs)
  // 0 是有效值（关闭兜底巡检），不能一起夹下限
  const sweep = rawSweep <= 0 ? 0 : Math.max(SYNC_DEFAULTS.minSettleMs, Math.round(rawSweep))
  return {
    enabled: bool(raw?.enabled, d.enabled),
    src: typeof raw?.src === 'string' && raw.src.trim() ? raw.src.trim() : d.src,
    dst: typeof raw?.dst === 'string' ? raw.dst.trim() : d.dst,
    syncRoots: normalizePatternList(strings(raw?.syncRoots)),
    exclude: normalizePatternList(strings(raw?.exclude)),
    settleMs: settle,
    sweepMs: sweep,
    deleteMissing: bool(raw?.deleteMissing, d.deleteMissing)
  }
}

export function loadConfig(cwd: string): SyncConfig {
  const all = loadFile()
  return normalizeConfig(cwd, all[pathKey(cwd)] ?? null)
}

export function saveConfig(cwd: string, config: SyncConfig): SyncConfig {
  const all = loadFile()
  const fresh = normalizeConfig(cwd, config as unknown as StoredConfig)
  all[pathKey(cwd)] = fresh as unknown as StoredConfig
  const target = file()
  try {
    mkdirSync(dirname(target), { recursive: true })
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify({ v: 1, workspaces: all }, null, 2), 'utf8')
    renameSync(tmp, target)
  } catch {
    // 落盘失败不影响本次运行；下次启动会回到上一份配置
  }
  return fresh
}

/**
 * 配置哪里不齐 / 哪里不能做。返回 null 表示形状上没问题（目录存在性另查）。
 * `enabled === false` 时仍返回 null，由调用方把 run 设为 disabled。
 */
export function configProblem(cwd: string, config: SyncConfig): SyncProblem | null {
  if (!config.src || !isAbsolute(config.src)) return 'noSrc'
  if (!config.dst || !isAbsolute(config.dst)) return 'noDst'
  const src = pathKey(config.src)
  const dst = pathKey(config.dst)
  if (src === dst) return 'sameDir'
  if (isSameOrInside(config.dst, config.src) || isSameOrInside(config.src, config.dst)) {
    return 'nested'
  }
  return null
}
