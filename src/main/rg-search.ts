import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import type { IdeSearchFile, IdeSearchMatch } from '../shared/ide'
import { literalWholeWordSource, makeSnippet, type CompiledGlobs, type CompiledSearch } from './ide-search'
import { t } from './i18n'
import { killProcessTree } from './kill-process'
import { NdjsonDecoder, parseLine } from './ndjson'
import { normalizeRel } from './rg-files'
import { markRgUnavailable, resolveRgPath } from './rg-path'
import {
  MAX_SEARCH_FILE_BYTES,
  SEARCH_DEADLINE_MS,
  SEARCH_MAX_FILES_WITH_HITS,
  SEARCH_MAX_MATCHES,
  WORKSPACE_MAX_DEPTH
} from './search-limits'
import { WORKSPACE_IGNORE_GLOBS, isIgnoredWorkspacePath } from './workspace-ignore'

/**
 * ripgrep 流式搜索。
 *
 * 只负责 spawn / 解析 `rg --json` / 限额 / 批次；查询校验和模式选择在
 * `ide-search-service.ts`。失败时由上层决定是否回退内置搜索。
 */

const BATCH_INTERVAL_MS = 80
const BATCH_FILES = 20
/** stderr 只留一点用于判断错误类型，不把整段输出塞进内存 */
const MAX_STDERR = 8 * 1024

export interface RgSearchStats {
  matchCount: number
  scannedFiles: number
  truncated: boolean
  note?: string
}

export interface RgSearchInput {
  cwd: string
  search: CompiledSearch
  globs: CompiledGlobs
  signal?: AbortSignal
  onBatch: (files: IdeSearchFile[], stats: RgSearchStats) => void
  onDone: (stats: RgSearchStats) => void
  /** canFallback 只在还没产生任何结果时为 true，避免重复/闪烁 */
  onError: (error: { canFallback: boolean }) => void
}

interface FileBuffer {
  rel: string
  name: string
  dir: string
  matches: IdeSearchMatch[]
  invalid: boolean
}

function buildArgs(search: CompiledSearch): string[] {
  const args = [
    '--json',
    '--no-config',
    '--no-require-git',
    '--hidden',
    ...WORKSPACE_IGNORE_GLOBS.map((glob) => `--glob=${glob}`),
    ...(process.platform === 'win32' ? ['--glob-case-insensitive'] : []),
    `--max-filesize=${MAX_SEARCH_FILE_BYTES}`,
    `--max-depth=${WORKSPACE_MAX_DEPTH}`,
    `--max-count=${SEARCH_MAX_MATCHES}`
  ]

  if (!search.caseSensitive) args.push('-i')

  if (search.wholeWord) {
    // 与 JS 替换共用同一套 ASCII 词边界，避免“搜到多少”和“替换多少”分叉
    args.push('--pcre2', '-e', literalWholeWordSource(search.literalText ?? ''))
  } else {
    args.push('-F', '-e', search.literalText ?? '')
  }

  args.push('--', '.')
  return args
}

function asObj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** rg 的 submatch 偏移是字节；转成 IdeSearchMatch 需要的 UTF-16 下标 */
function utf16Index(full: string, ascii: boolean, buf: Buffer | null, byte: number): number {
  if (byte <= 0) return 0
  if (ascii) return Math.min(byte, full.length)
  return buf ? buf.subarray(0, byte).toString('utf8').length : 0
}

function fileOf(rel: string): { name: string; dir: string } {
  const parts = rel.split('/')
  return { name: parts[parts.length - 1], dir: parts.slice(0, -1).join('/') }
}

export function runRgSearch(input: RgSearchInput): Promise<void> {
  const root = resolve(input.cwd)
  const rg = resolveRgPath()
  if (!rg) {
    input.onError({ canFallback: true })
    return Promise.resolve()
  }

  let child: ChildProcess
  try {
    child = spawn(rg, buildArgs(input.search), {
      cwd: root,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch {
    markRgUnavailable()
    input.onError({ canFallback: true })
    return Promise.resolve()
  }

  return new Promise<void>((resolvePromise) => {
    const buffers = new Map<string, FileBuffer>()
    const pendingBatch = new Map<string, IdeSearchFile>()
    let totalMatches = 0
    let committedFiles = 0
    let scannedFiles = 0
    let truncated = false
    let note: string | undefined
    let anyBatch = false
    let finished = false
    let cancelled = false
    let closed = false
    let hitFileLimit = false
    let stderr = ''
    let batchTimer: NodeJS.Timeout | null = null
    let deadlineTimer: NodeJS.Timeout | null = null
    const decoder = new NdjsonDecoder()

    const clearTimers = (): void => {
      if (batchTimer) clearTimeout(batchTimer)
      if (deadlineTimer) clearTimeout(deadlineTimer)
      batchTimer = null
      deadlineTimer = null
    }

    const stats = (): RgSearchStats => ({
      matchCount: totalMatches,
      scannedFiles,
      truncated,
      ...(note ? { note } : {})
    })

    const flushBatch = (): void => {
      if (batchTimer) {
        clearTimeout(batchTimer)
        batchTimer = null
      }
      if (pendingBatch.size === 0) return
      const files = [...pendingBatch.values()]
      pendingBatch.clear()
      anyBatch = true
      input.onBatch(files, stats())
    }

    const scheduleFlush = (): void => {
      if (pendingBatch.size >= BATCH_FILES) {
        flushBatch()
        return
      }
      if (batchTimer || finished) return
      batchTimer = setTimeout(() => {
        batchTimer = null
        flushBatch()
      }, BATCH_INTERVAL_MS)
    }

    const commitFile = (buf: FileBuffer): void => {
      buffers.delete(buf.rel)
      if (buf.invalid || buf.matches.length === 0) {
        totalMatches -= buf.matches.length
        return
      }
      if (!input.globs.test(buf.rel) || isIgnoredWorkspacePath(buf.rel)) {
        totalMatches -= buf.matches.length
        return
      }
      if (committedFiles >= SEARCH_MAX_FILES_WITH_HITS) {
        totalMatches -= buf.matches.length
        truncated = true
        hitFileLimit = true
        note = t('ideError.searchTruncated', {
          files: SEARCH_MAX_FILES_WITH_HITS,
          matches: SEARCH_MAX_MATCHES
        })
        return
      }
      committedFiles++
      pendingBatch.set(buf.rel, {
        rel: buf.rel,
        name: buf.name,
        matches: buf.matches
      })
      // 与内置引擎一致：刚好 50 个命中文件也标记为截断
      if (committedFiles >= SEARCH_MAX_FILES_WITH_HITS) {
        truncated = true
        hitFileLimit = true
        note = t('ideError.searchTruncated', {
          files: SEARCH_MAX_FILES_WITH_HITS,
          matches: SEARCH_MAX_MATCHES
        })
      }
      scheduleFlush()
    }

    const commitOpenFiles = (): void => {
      for (const buf of [...buffers.values()]) commitFile(buf)
    }

    const finalize = (): void => {
      if (finished) return
      finished = true
      clearTimers()
      commitOpenFiles()
      flushBatch()
      input.onDone(stats())
      if (!closed) killProcessTree(child)
      input.signal?.removeEventListener('abort', cancel)
      resolvePromise()
    }

    const cancel = (): void => {
      if (finished) return
      cancelled = true
      finished = true
      clearTimers()
      killProcessTree(child)
      input.signal?.removeEventListener('abort', cancel)
      resolvePromise()
    }

    if (input.signal?.aborted) {
      cancel()
      return
    }
    input.signal?.addEventListener('abort', cancel, { once: true })

    const truncateAndFinish = (message: string): void => {
      truncated = true
      note = message
      finalize()
    }

    const handleMatch = (obj: Record<string, unknown>): void => {
      if (finished) return
      const pathText = asString(asObj(obj.path)?.text)
      if (!pathText) return
      const rel = normalizeRel(root, pathText)
      if (!rel) return

      const lines = asObj(obj.lines)
      const full = asString(lines?.text)
      if (!full) {
        // bytes = 非法 UTF-8，和内置搜索的严格解码保持一致：整份文件跳过
        const existing = buffers.get(rel)
        if (existing) existing.invalid = true
        return
      }

      let buf = buffers.get(rel)
      if (!buf) {
        const { name, dir } = fileOf(rel)
        buf = { rel, name, dir, matches: [], invalid: false }
        buffers.set(rel, buf)
      }
      if (buf.invalid) return

      const lineNumber = asNumber(obj.line_number)
      if (!lineNumber || lineNumber < 1 || !Number.isInteger(lineNumber)) return

      const line = full.replace(/\r?\n$/, '').replace(/\r$/, '')
      const ascii = full.length === Buffer.byteLength(full)
      const raw = ascii ? null : Buffer.from(full, 'utf8')
      const submatches = Array.isArray(obj.submatches) ? obj.submatches : []

      for (const item of submatches) {
        const sm = asObj(item)
        const start = asNumber(sm?.start)
        const end = asNumber(sm?.end)
        if (start === undefined || end === undefined) continue

        const index = Math.min(utf16Index(full, ascii, raw, start), line.length)
        const stop = Math.min(utf16Index(full, ascii, raw, end), line.length)
        const length = Math.max(0, stop - index)
        if (length === 0) continue

        if (totalMatches >= SEARCH_MAX_MATCHES) {
          truncated = true
          note = t('ideError.searchTruncated', {
            files: SEARCH_MAX_FILES_WITH_HITS,
            matches: SEARCH_MAX_MATCHES
          })
          finalize()
          return
        }

        const snippet = makeSnippet(line, { index, length })
        buf.matches.push({
          line: lineNumber,
          column: index + 1,
          length,
          text: snippet.text,
          offset: snippet.offset
        })
        totalMatches++
      }

      // 和内置引擎一样：达到 200 处即视为截断，即使文件刚好只有 200 处
      if (totalMatches >= SEARCH_MAX_MATCHES) {
        truncated = true
        note = t('ideError.searchTruncated', {
          files: SEARCH_MAX_FILES_WITH_HITS,
          matches: SEARCH_MAX_MATCHES
        })
        finalize()
      }
    }

    const handleEnd = (obj: Record<string, unknown>): void => {
      if (finished) return
      const pathText = asString(asObj(obj.path)?.text)
      if (!pathText) return
      const rel = normalizeRel(root, pathText)
      if (!rel) return

      scannedFiles++
      const buf = buffers.get(rel)
      if (!buf) return

      const binary = obj.binary_offset
      if (typeof binary === 'number' && binary >= 0) buf.invalid = true
      commitFile(buf)

      // commitFile 发现命中文件数触顶：把前面 50 个文件推出去后收尾
      if (hitFileLimit) finalize()
    }

    const handleSummary = (obj: Record<string, unknown>): void => {
      const n = asNumber(asObj(obj.stats)?.searches)
      if (n !== undefined) scannedFiles = Math.max(scannedFiles, n)
    }

    const handleLine = (line: string): void => {
      if (finished) return
      const obj = parseLine(line)
      if (!obj) return
      const type = asString(obj.type)
      const data = asObj(obj.data)
      if (!data) return
      if (type === 'match') handleMatch(data)
      else if (type === 'end') handleEnd(data)
      else if (type === 'summary') handleSummary(data)
      // begin / context 不需要：match 自带行号和行文本
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      for (const line of decoder.push(chunk)) handleLine(line)
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.slice(0, MAX_STDERR - stderr.length)
    })

    child.on('error', (err) => {
      if (finished) return
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EACCES') markRgUnavailable()
      closed = true
      finished = true
      clearTimers()
      input.signal?.removeEventListener('abort', cancel)
      if (!anyBatch && totalMatches === 0) {
        input.onError({ canFallback: true })
      } else {
        truncated = true
        note = t('ideError.searchIncomplete')
        commitOpenFiles()
        flushBatch()
        input.onDone(stats())
      }
      killProcessTree(child)
      resolvePromise()
    })

    child.on('close', (code) => {
      closed = true
      if (finished || cancelled) return
      for (const line of decoder.flush()) handleLine(line)

      if (code !== 0 && code !== 1 && code !== null) {
        if (!anyBatch && totalMatches === 0) {
          finished = true
          clearTimers()
          input.signal?.removeEventListener('abort', cancel)
          input.onError({ canFallback: true })
          resolvePromise()
          return
        }
        truncated = true
        note = note ?? t('ideError.searchIncomplete')
      } else if (stderr.trim()) {
        truncated = true
        note = note ?? t('ideError.searchIncomplete')
      }

      if (truncated && !note) note = t('ideError.searchIncomplete')
      finalize()
    })

    deadlineTimer = setTimeout(() => {
      truncateAndFinish(t('ideError.searchTimeout'))
    }, SEARCH_DEADLINE_MS)
    deadlineTimer.unref()
  })
}
