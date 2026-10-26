import { promises as fs } from 'node:fs'
import { isAbsolute } from 'node:path'
import type {
  IdeFsErrorCode,
  IdeSearchFile,
  IdeSearchStartRequest,
  IdeSearchStartResult,
  IdeSearchStreamEvent
} from '../shared/ide'
import { searchCodeStreaming, type SearchStreamStats } from './ide-fs'
import {
  compileGlobs,
  compileSearch,
  SearchPatternError,
  type CompiledGlobs,
  type CompiledSearch
} from './ide-search'
import { t } from './i18n'
import { resetRgPathState, resolveRgPath } from './rg-path'
import { runRgSearch } from './rg-search'

/**
 * 流式搜索的生命周期管理：校验请求、选择 rg / 内置引擎、按 sender 取消旧
 * 搜索、把事件路由回发起它的 IDE 窗口。
 *
 * 不 import Electron，`send` 由 main/index.ts 注入，便于 Node 测试。
 */

interface ActiveSearch {
  requestId: string
  controller: AbortController
}

const active = new Map<number, ActiveSearch>()
/** 每个 sender 的启动序号：异步校验期间来了新请求，旧请求就不要真正启动 */
const startSeq = new Map<number, number>()
/** PCRE2 不可用时，全字匹配直接走内置引擎，避免每次查询都失败一次 */
let pcre2Disabled = false

export interface StartIdeSearchInput {
  senderId: number
  req: IdeSearchStartRequest
  send: (event: IdeSearchStreamEvent) => void
}

function failure(code: IdeFsErrorCode, message: string): IdeSearchStartResult {
  return { ok: false, code, message }
}

function failureFrom(err: unknown): IdeSearchStartResult {
  if (err instanceof SearchPatternError) {
    return { ok: false, code: err.code, message: err.message }
  }
  return {
    ok: false,
    code: 'unknown',
    message: err instanceof Error ? err.message : String(err)
  }
}

function stillActive(senderId: number, entry: ActiveSearch): boolean {
  return active.get(senderId) === entry && !entry.controller.signal.aborted
}

function emit(
  input: StartIdeSearchInput,
  entry: ActiveSearch,
  event: IdeSearchStreamEvent
): void {
  if (!stillActive(input.senderId, entry)) return
  if (event.type === 'done' || event.type === 'error') {
    active.delete(input.senderId)
  }
  try {
    input.send(event)
  } catch {
    // 窗口可能刚好被销毁；事件丢掉即可
  }
}

function emitBatch(
  input: StartIdeSearchInput,
  entry: ActiveSearch,
  files: IdeSearchFile[],
  stats: SearchStreamStats,
  fallback: boolean,
  reset: boolean
): void {
  if (files.length === 0 && !reset) return
  emit(input, entry, {
    type: 'batch',
    requestId: entry.requestId,
    files,
    matchCount: stats.matchCount,
    scannedFiles: stats.scannedFiles,
    truncated: stats.truncated,
    ...(stats.note ? { note: stats.note } : {}),
    ...(reset ? { reset: true } : {}),
    ...(fallback ? { fallback: true } : {})
  })
}

function emitDone(
  input: StartIdeSearchInput,
  entry: ActiveSearch,
  stats: SearchStreamStats,
  fallback: boolean
): void {
  emit(input, entry, {
    type: 'done',
    requestId: entry.requestId,
    matchCount: stats.matchCount,
    scannedFiles: stats.scannedFiles,
    truncated: stats.truncated,
    ...(stats.note ? { note: stats.note } : {}),
    ...(fallback ? { fallback: true } : {})
  })
}

function emitError(
  input: StartIdeSearchInput,
  entry: ActiveSearch,
  message: string
): void {
  emit(input, entry, { type: 'error', requestId: entry.requestId, message })
}

/** 内置 JS 引擎；同时用于正则模式、无 rg 和 rg 启动失败的回退 */
function runJsSearch(
  input: StartIdeSearchInput,
  entry: ActiveSearch,
  req: IdeSearchStartRequest,
  fallback: boolean
): void {
  let first = true

  void searchCodeStreaming(req, {
    signal: entry.controller.signal,
    onBatch: (files, stats) => {
      // 回退重跑时清掉 rg 可能已经推过的部分结果
      const reset = first && fallback
      first = false
      emitBatch(input, entry, files, stats, fallback, reset)
    }
  })
    .then((result) => {
      if (!stillActive(input.senderId, entry)) return
      if (!result.ok) {
        emitError(input, entry, result.message)
        return
      }
      const data = result.data
      emitDone(
        input,
        entry,
        {
          matchCount: data.matchCount,
          scannedFiles: data.scannedFiles,
          truncated: data.truncated,
          ...(data.note ? { note: data.note } : {})
        },
        fallback
      )
    })
    .catch((err) => {
      emitError(input, entry, err instanceof Error ? err.message : String(err))
    })
}

function runRg(
  input: StartIdeSearchInput,
  entry: ActiveSearch,
  req: IdeSearchStartRequest,
  search: CompiledSearch,
  globs: CompiledGlobs
): void {
  void runRgSearch({
    cwd: req.cwd,
    search,
    globs,
    signal: entry.controller.signal,
    onBatch: (files, stats) => emitBatch(input, entry, files, stats, false, false),
    onDone: (stats) => emitDone(input, entry, stats, false),
    onError: ({ canFallback }) => {
      if (!stillActive(input.senderId, entry)) return
      if (!canFallback) {
        emitDone(
          input,
          entry,
          { matchCount: 0, scannedFiles: 0, truncated: true, note: t('ideError.searchIncomplete') },
          false
        )
        return
      }
      // 全字匹配需要 PCRE2；打包的 rg 不支持时以后都走内置引擎
      if (search.wholeWord) pcre2Disabled = true
      runJsSearch(input, entry, req, true)
    }
  })
}

export async function startIdeSearch(
  input: StartIdeSearchInput
): Promise<IdeSearchStartResult> {
  const req = input.req
  const requestId = typeof req?.requestId === 'string' ? req.requestId : ''
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) {
    return failure('invalid-query', t('ideError.searchInvalid'))
  }
  if (!req?.cwd || typeof req.cwd !== 'string' || !isAbsolute(req.cwd)) {
    return failure('invalid-path', t('ideError.invalidWorkspace'))
  }

  let search: CompiledSearch
  let globs: CompiledGlobs
  try {
    search = compileSearch(req.query, req.options)
    globs = compileGlobs(req.options)
  } catch (err) {
    return failureFrom(err)
  }

  const seq = (startSeq.get(input.senderId) ?? 0) + 1
  startSeq.set(input.senderId, seq)

  // 先登记活动项，再去做异步校验：这样取消请求在 stat 期间也能真正生效，
  // 而不是等校验完成才发现没东西可取消。
  const prev = active.get(input.senderId)
  if (prev) {
    active.delete(input.senderId)
    prev.controller.abort()
  }
  const entry: ActiveSearch = { requestId, controller: new AbortController() }
  active.set(input.senderId, entry)

  try {
    const st = await fs.stat(req.cwd)
    if (!st.isDirectory()) {
      if (active.get(input.senderId) === entry) active.delete(input.senderId)
      return failure('invalid-path', t('ideError.invalidWorkspace'))
    }
  } catch {
    if (active.get(input.senderId) === entry) active.delete(input.senderId)
    return failure('missing', t('ideError.missing'))
  }

  // 校验期间又来了新查询 / 被取消：让它赢，本次安静退出。
  // 返回成功而不是错误，避免旧请求的 UI 闪一下错误提示。
  if (!stillActive(input.senderId, entry) || startSeq.get(input.senderId) !== seq) {
    if (active.get(input.senderId) === entry) active.delete(input.senderId)
    return { ok: true, data: { mode: 'js', fallback: false } }
  }

  const rgAvailable = resolveRgPath() !== null
  const literal = search.literal
  const multiline = /[\r\n]/.test(search.literalText ?? '')
  const wholeWordNeedsJs = search.wholeWord && pcre2Disabled
  const mode: 'rg' | 'js' = literal && !multiline && !wholeWordNeedsJs && rgAvailable ? 'rg' : 'js'
  const fallback = mode === 'js' && literal && !multiline && !rgAvailable

  if (mode === 'rg') {
    runRg(input, entry, req, search, globs)
  } else {
    runJsSearch(input, entry, req, fallback)
  }

  return { ok: true, data: { mode, fallback } }
}

export function cancelIdeSearch(senderId: number, requestId?: string): void {
  const cur = active.get(senderId)
  if (!cur) return
  if (requestId && cur.requestId !== requestId) return
  active.delete(senderId)
  cur.controller.abort()
}

export function cancelIdeSearchesForSender(senderId: number): void {
  startSeq.delete(senderId)
  cancelIdeSearch(senderId)
}

export function cancelAllIdeSearches(): void {
  for (const entry of active.values()) entry.controller.abort()
  active.clear()
  startSeq.clear()
}

/** 测试用：清空活动搜索和 PCRE2 记忆 */
export function resetIdeSearchService(): void {
  cancelAllIdeSearches()
  resetRgPathState()
  pcre2Disabled = false
}
