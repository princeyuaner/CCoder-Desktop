import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import type { CliId } from '../../shared/settings'

/**
 * 原生配置文件的安全读写。
 *
 * 所有写入一律「重新读 → 只改目标字段 → 备份 → 同目录临时文件 + rename」。
 * 解析失败 / 只读 / 并发外部修改时返回结构化错误，调用方不会覆盖原文件。
 */

export interface TextFile {
  path: string
  exists: boolean
  /** 已去掉 BOM */
  text: string
  bom: boolean
  eol: '\n' | '\r\n'
  hash: string
  mode: number
}

export type ReadFileResult =
  | { ok: true; file: TextFile }
  | { ok: false; errorKey: string; detail: string }

export class NativeParseError extends Error {
  constructor(
    public readonly errorKey: string,
    public readonly detail: string
  ) {
    super(detail)
    this.name = 'NativeParseError'
  }
}

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function detectEol(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

function splitBom(raw: string): { text: string; bom: boolean } {
  if (raw.charCodeAt(0) === 0xfeff) return { text: raw.slice(1), bom: true }
  return { text: raw, bom: false }
}

export function readTextFile(path: string): ReadFileResult {
  try {
    if (!existsSync(path)) {
      return {
        ok: true,
        file: {
          path,
          exists: false,
          text: '',
          bom: false,
          eol: '\n',
          hash: hashText(''),
          mode: 0o600
        }
      }
    }
    const raw = readFileSync(path, 'utf8')
    const { text, bom } = splitBom(raw)
    const mode = statSync(path).mode & 0o777
    return {
      ok: true,
      file: {
        path,
        exists: true,
        text,
        bom,
        eol: detectEol(text),
        hash: hashText(text),
        mode
      }
    }
  } catch (e) {
    return {
      ok: false,
      errorKey: 'mcp.error.nativeRead',
      detail: e instanceof Error ? e.message : String(e)
    }
  }
}

/** 目标文件或父目录是否可写；用于 UI 的只读标记 */
export function isWritable(path: string): boolean {
  try {
    accessSync(existsSync(path) ? path : dirname(path), constants.W_OK)
    return true
  } catch {
    return false
  }
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // 极少数环境不支持 SharedArrayBuffer，直接重试
  }
}

function writeAtomic(path: string, text: string, mode: number): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${basename(path)}.ccoder-${process.pid}-${Date.now()}.tmp`)
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', mode })
    try {
      chmodSync(tmp, mode)
    } catch {
      // Windows 上 chmod 可能不支持，忽略
    }
    let last: unknown = null
    for (let i = 0; i < 3; i++) {
      try {
        renameSync(tmp, path)
        return
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
      // 已经 rename 成功
    }
  }
}

function backupName(path: string, timestamp: string): string {
  const hash = hashText(path).slice(0, 8)
  const base = basename(path).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)
  return `${base}.${hash}.${timestamp}.bak`
}

function timestamp(): string {
  const d = new Date()
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
}

/** 保留最近 keep 份；超大文件再压低 */
function pruneBackups(dir: string, keep: number, maxBytes: number): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.bak'))
      .map((f) => {
        const p = join(dir, f)
        try {
          const st = statSync(p)
          return { p, mtime: st.mtimeMs, size: st.size }
        } catch {
          return null
        }
      })
      .filter((x): x is { p: string; mtime: number; size: number } => !!x)
      .sort((a, b) => b.mtime - a.mtime)
    let total = 0
    let kept = 0
    for (const f of files) {
      total += f.size
      const overCount = kept >= keep
      const overSize = total > maxBytes
      if (overCount || overSize) {
        try {
          unlinkSync(f.p)
        } catch {
          // 忽略
        }
      } else {
        kept++
      }
    }
  } catch {
    // 备份目录读不了就跳过清理
  }
}

export type BackupResult = { ok: true; path?: string } | { ok: false; errorKey: string; detail: string }

export function backupFile(path: string, backupRoot: string, cli: CliId): BackupResult {
  try {
    if (!existsSync(path)) return { ok: true }
    const dir = join(backupRoot, cli)
    mkdirSync(dir, { recursive: true })
    const st = statSync(path)
    const dest = join(dir, backupName(path, timestamp()))
    copyFileSync(path, dest)
    pruneBackups(dir, 5, st.size > 5 * 1024 * 1024 ? 2 : 20 * 1024 * 1024)
    return { ok: true, path: dest }
  } catch (e) {
    return {
      ok: false,
      errorKey: 'mcp.error.backupFailed',
      detail: e instanceof Error ? e.message : String(e)
    }
  }
}

export interface WriteResult {
  ok: boolean
  errorKey?: string
  detail?: string
  changed: boolean
  sourceFile: string
  backupPath?: string
  /** 写入后的文本（不含 BOM） */
  text: string
}

/**
 * 读取 → 变换 → 备份 → 原子写。
 *
 * `mutate` 返回 null 表示无需改动。写入前会重读一次；如果外部改过，
 * 基于新内容重放一次 mutate，仍有冲突则返回 fileChanged 并且不写。
 */
export function withTextFile(
  path: string,
  cli: CliId,
  backupRoot: string,
  mutate: (text: string, exists: boolean) => string | null,
  newMode = 0o600
): WriteResult {
  const first = readTextFile(path)
  if (!first.ok) {
    return { ok: false, errorKey: first.errorKey, detail: first.detail, changed: false, sourceFile: path, text: '' }
  }

  function run(text: string, exists: boolean): string | null | WriteResult {
    try {
      return mutate(text, exists)
    } catch (e) {
      if (e instanceof NativeParseError) {
        return {
          ok: false,
          errorKey: e.errorKey,
          detail: e.detail,
          changed: false,
          sourceFile: path,
          text
        }
      }
      return {
        ok: false,
        errorKey: 'mcp.error.writeFailed',
        detail: e instanceof Error ? e.message : String(e),
        changed: false,
        sourceFile: path,
        text
      }
    }
  }

  const firstOut = run(first.file.text, first.file.exists)
  if (firstOut && typeof firstOut === 'object' && 'ok' in firstOut) return firstOut
  if (firstOut === null) {
    return { ok: true, changed: false, sourceFile: path, text: first.file.text }
  }

  // 写入前重读：外部改动过就基于新内容重放一次
  const second = readTextFile(path)
  if (!second.ok) {
    return { ok: false, errorKey: second.errorKey, detail: second.detail, changed: false, sourceFile: path, text: '' }
  }

  let current = second.file
  let nextText = firstOut
  if (second.file.hash !== first.file.hash || second.file.exists !== first.file.exists) {
    const replay = run(second.file.text, second.file.exists)
    if (replay && typeof replay === 'object' && 'ok' in replay) return replay
    if (replay === null) {
      return { ok: true, changed: false, sourceFile: path, text: second.file.text }
    }
    nextText = replay
    const third = readTextFile(path)
    if (!third.ok) {
      return { ok: false, errorKey: third.errorKey, detail: third.detail, changed: false, sourceFile: path, text: '' }
    }
    if (third.file.hash !== second.file.hash) {
      return {
        ok: false,
        errorKey: 'mcp.error.fileChanged',
        detail: path,
        changed: false,
        sourceFile: path,
        text: second.file.text
      }
    }
    current = third.file
  }

  if (nextText === current.text) {
    return { ok: true, changed: false, sourceFile: path, text: current.text }
  }

  // 保持原文件 EOL；adapter 内部统一用 \n 生成
  if (current.eol === '\r\n') nextText = nextText.replace(/\r?\n/g, '\r\n')
  const out = current.bom ? String.fromCharCode(0xfeff) + nextText : nextText

  let backupPath: string | undefined
  if (current.exists) {
    const backup = backupFile(path, backupRoot, cli)
    if (!backup.ok) {
      return {
        ok: false,
        errorKey: backup.errorKey,
        detail: backup.detail,
        changed: false,
        sourceFile: path,
        text: current.text
      }
    }
    backupPath = backup.path
  }

  try {
    writeAtomic(path, out, current.exists ? current.mode : newMode)
  } catch (e) {
    return {
      ok: false,
      errorKey: 'mcp.error.writeFailed',
      detail: e instanceof Error ? e.message : String(e),
      changed: false,
      sourceFile: path,
      text: current.text
    }
  }

  return {
    ok: true,
    changed: true,
    sourceFile: path,
    backupPath,
    text: nextText
  }
}

/** 读取目录里的文件（DSH home 等），失败返回空数组 */
export function listDir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}
