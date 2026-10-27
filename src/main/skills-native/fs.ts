import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { CliId } from '../../shared/settings'

/**
 * 技能文件的安全读写。
 *
 * 写 manifest 走「临时文件 + rename」；覆盖和删除之前先把原内容复制到
 * userData/skills-backups。任何一步失败都返回结构化错误，不半途而废。
 */

export interface TextRead {
  ok: true
  text: string
  size: number
  mtime: number
  truncated: boolean
}

export type TextReadResult = TextRead | { ok: false; errorKey: string; detail: string }

const MAX_READ = 512 * 1024

export function readText(path: string): TextReadResult {
  try {
    const st = statSync(path)
    // 按上限截断，避免用户放了个巨大文件把主进程读卡
    let text: Buffer
    if (st.size > MAX_READ) {
      const fd = openSync(path, 'r')
      try {
        text = Buffer.alloc(MAX_READ)
        readSync(fd, text, 0, MAX_READ, 0)
      } finally {
        closeSync(fd)
      }
    } else {
      text = readFileSync(path)
    }
    return {
      ok: true,
      text: text.toString('utf8').replace(/^﻿/, ''),
      size: st.size,
      mtime: st.mtimeMs,
      truncated: st.size > MAX_READ
    }
  } catch (e) {
    return {
      ok: false,
      errorKey: 'skill.error.readFailed',
      detail: e instanceof Error ? e.message : String(e)
    }
  }
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // 环境不支持就立即重试
  }
}

export function writeAtomic(path: string, text: string, mode = 0o644): boolean {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${basename(path)}.ccoder-${process.pid}-${Date.now()}.tmp`)
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', mode })
    try {
      chmodSync(tmp, mode)
    } catch {
      // Windows 上 chmod 不可用
    }
    let last: unknown = null
    for (let i = 0; i < 3; i++) {
      try {
        renameSync(tmp, path)
        return true
      } catch (e) {
        last = e
        const code = (e as NodeJS.ErrnoException).code
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break
        sleepSync(40 * (i + 1))
      }
    }
    throw last
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      // rename 成功
    }
  }
}

function timestamp(): string {
  const d = new Date()
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
}

function prune(dir: string, keep: number): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.bak'))
      .map((f) => {
        const p = join(dir, f)
        try {
          return { p, mtime: statSync(p).mtimeMs }
        } catch {
          return null
        }
      })
      .filter((x): x is { p: string; mtime: number } => !!x)
      .sort((a, b) => b.mtime - a.mtime)
    for (const f of files.slice(keep)) {
      try {
        rmSync(f.p, { recursive: true, force: true })
      } catch {
        // 清不掉就留着
      }
    }
  } catch {
    // 目录不存在
  }
}

export interface BackupOut {
  ok: boolean
  path?: string
  errorKey?: string
  detail?: string
}

/** 备份单个文件；目标不存在时视作成功（没什么可备份） */
export function backupFile(
  path: string,
  backupRoot: string,
  cli: CliId,
  name: string
): BackupOut {
  try {
    if (!existsSync(path)) return { ok: true }
    const dir = join(backupRoot, cli)
    mkdirSync(dir, { recursive: true })
    const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'skill'
    const dest = join(dir, `${safe}.${timestamp()}.bak`)
    copyFileSync(path, dest)
    prune(dir, 8)
    return { ok: true, path: dest }
  } catch (e) {
    return {
      ok: false,
      errorKey: 'skill.error.backupFailed',
      detail: e instanceof Error ? e.message : String(e)
    }
  }
}

/** 删除前备份整个技能目录 / 文件 */
export function backupSkillPath(
  path: string,
  backupRoot: string,
  cli: CliId,
  name: string
): BackupOut {
  try {
    if (!existsSync(path)) return { ok: true }
    const dir = join(backupRoot, cli)
    mkdirSync(dir, { recursive: true })
    const safe = `${name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'skill'}.${timestamp()}.bak`
    const dest = join(dir, safe)
    cpSync(path, dest, { recursive: true, dereference: false, errorOnExist: false })
    prune(dir, 8)
    return { ok: true, path: dest }
  } catch (e) {
    return {
      ok: false,
      errorKey: 'skill.error.backupFailed',
      detail: e instanceof Error ? e.message : String(e)
    }
  }
}

export function removePath(path: string): { ok: boolean; errorKey?: string; detail?: string } {
  try {
    rmSync(path, { recursive: true, force: true })
    return { ok: true }
  } catch (e) {
    return {
      ok: false,
      errorKey: 'skill.error.deleteFailed',
      detail: e instanceof Error ? e.message : String(e)
    }
  }
}

export function renamePath(
  from: string,
  to: string
): { ok: boolean; errorKey?: string; detail?: string } {
  try {
    if (!existsSync(from)) return { ok: false, errorKey: 'skill.error.notFound' }
    if (existsSync(to)) return { ok: false, errorKey: 'skill.error.nameTaken' }
    renameSync(from, to)
    return { ok: true }
  } catch (e) {
    return {
      ok: false,
      errorKey: 'skill.error.renameFailed',
      detail: e instanceof Error ? e.message : String(e)
    }
  }
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

export function ctime(path: string): number {
  try {
    return statSync(path).birthtimeMs || statSync(path).ctimeMs
  } catch {
    return 0
  }
}

export function listEntries(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/** 递归收集技能目录里的文件；跳过 manifest 自身与明显的临时文件 */
export function collectResources(
  root: string,
  manifest: string,
  maxFiles = 200,
  maxDepth = 4
): { path: string; size: number; dir: boolean; modifiedAt: number }[] {
  const out: { path: string; size: number; dir: boolean; modifiedAt: number }[] = []
  const walk = (dir: string, rel: string, depth: number): void => {
    if (out.length >= maxFiles || depth > maxDepth) return
    for (const entry of listEntries(dir)) {
      if (entry === '.' || entry === '..') continue
      if (depth === 0 && entry === manifest) continue
      if (entry.endsWith('.tmp')) continue
      const abs = join(dir, entry)
      const relPath = rel ? `${rel}/${entry}` : entry
      try {
        const st = statSync(abs)
        if (st.isDirectory()) {
          out.push({ path: relPath, size: 0, dir: true, modifiedAt: st.mtimeMs })
          walk(abs, relPath, depth + 1)
        } else if (st.isFile()) {
          out.push({ path: relPath, size: st.size, dir: false, modifiedAt: st.mtimeMs })
        }
      } catch {
        // 读不了就跳过
      }
      if (out.length >= maxFiles) return
    }
  }
  walk(root, '', 0)
  return out
}
