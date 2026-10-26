import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { FilePair } from './plan'
import type { FileStamp } from './scan'

/**
 * 内容基线：上次**已核实**的双方 (大小, mtime)。
 *
 * 身份由源 / 目标两个绝对路径一起决定。换了任何一端，旧基线自动作废，
 * 下一轮重做一次全量核对 —— 这是安全且自愈的行为。
 */

interface StoredFilePair {
  /** [size, mtimeMs] */
  src: [number, number]
  dst: [number, number]
}

interface StoredBaseline {
  v: 1
  srcKey: string
  dstKey: string
  files: Record<string, StoredFilePair>
}

// 扩展名用 .json 之外的后缀，避免被用户误认成可编辑配置文件
export function baselineFile(srcKey: string, dstKey: string): string {
  const hash = createHash('sha1')
    .update(`${srcKey}\0${dstKey}`)
    .digest('hex')
    .slice(0, 20)
  return join(app.getPath('userData'), 'sync', `baseline-${hash}.json`)
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function stamp(v: unknown): FileStamp | null {
  if (!Array.isArray(v) || v.length !== 2) return null
  const size = num(v[0])
  const mtimeMs = num(v[1])
  return size == null || mtimeMs == null ? null : { size, mtimeMs }
}

export function loadBaseline(
  path: string,
  srcKey: string,
  dstKey: string
): Map<string, FilePair> {
  const out = new Map<string, FilePair>()
  let raw: StoredBaseline
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as StoredBaseline
  } catch {
    return out
  }
  if (
    !raw ||
    raw.v !== 1 ||
    raw.srcKey !== srcKey ||
    raw.dstKey !== dstKey ||
    !raw.files ||
    typeof raw.files !== 'object'
  ) {
    return out
  }
  for (const [rel, pair] of Object.entries(raw.files)) {
    if (!pair || typeof pair !== 'object') continue
    const src = stamp(pair.src)
    const dst = stamp(pair.dst)
    if (src && dst) out.set(rel, { src, dst })
  }
  return out
}

export function saveBaseline(
  path: string,
  srcKey: string,
  dstKey: string,
  files: Map<string, FilePair>
): void {
  const out: Record<string, StoredFilePair> = {}
  for (const [rel, pair] of files) {
    out[rel] = {
      src: [pair.src.size, pair.src.mtimeMs],
      dst: [pair.dst.size, pair.dst.mtimeMs]
    }
  }
  const stored: StoredBaseline = { v: 1, srcKey, dstKey, files: out }
  const target = path
  try {
    mkdirSync(dirname(target), { recursive: true })
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify(stored), 'utf8')
    renameSync(tmp, target)
  } catch {
    // 基线存不下来只影响下一轮的增量优化，不影响正确性（会退回全量核对）
  }
}

/** 两份基线是否逐条相同 —— 稳态下没必要每个巡检周期都重写一个大文件。 */
export function sameBaseline(
  a: Map<string, FilePair>,
  b: Map<string, FilePair>
): boolean {
  if (a.size !== b.size) return false
  for (const [rel, pair] of a) {
    const other = b.get(rel)
    if (
      !other ||
      pair.src.size !== other.src.size ||
      pair.src.mtimeMs !== other.src.mtimeMs ||
      pair.dst.size !== other.dst.size ||
      pair.dst.mtimeMs !== other.dst.mtimeMs
    ) {
      return false
    }
  }
  return true
}
