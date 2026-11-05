import type { VcsRepo } from '../../shared/vcs'
import { runGit, runSvn } from './exec'
import { readCapped } from './read'

/**
 * 整文件 diff 的两侧完整文本。
 *
 * 和 unified diff 不同，这个视图需要把未修改的行也铺出来。这里只负责
 * 从工作区 / Git blob / SVN revision 取文本，不做对齐；行号对齐在渲染层
 * 用 hunk 头完成。
 *
 * 读不到时返回 `omitted`，调用方会让前端回落到原来的差异块视图 ——
 * 宁可少一个视图，也不要把半截文本拼成一份错的 diff。
 */

export const MAX_FULL_TEXT_BYTES = 2 * 1024 * 1024

export interface FullText {
  text?: string
  omitted?: 'binary' | 'large' | 'unavailable'
}

/** 两侧统一成 LF；CRLF 文件也能和 diff 的行号对上 */
export function normalizeFullText(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** 工作区文件；文件不存在按空文本处理（删除 / 新增的另一侧） */
export async function readWorkingFullText(abs: string): Promise<FullText> {
  try {
    const f = await readCapped(abs, MAX_FULL_TEXT_BYTES)
    if (f.directory) return { omitted: 'unavailable' }
    if (f.binary) return { omitted: 'binary' }
    if (f.truncated) return { omitted: 'large' }
    return { text: normalizeFullText(f.text) }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { text: '' }
    return { omitted: 'unavailable' }
  }
}

/** `git show <rev>:<path>`；路径在该 revision 不存在时按空文本处理 */
export async function gitBlobFullText(repo: VcsRepo, spec: string): Promise<FullText> {
  let r
  try {
    r = await runGit(repo.root, ['show', spec], {
      timeoutMs: 10_000,
      maxStdoutBytes: MAX_FULL_TEXT_BYTES
    })
  } catch {
    return { omitted: 'unavailable' }
  }
  if (r.code !== 0) {
    // 新增 / 删除 / 重命名会走到这里：另一侧本来就没有这个路径。
    // 超时、仓库损坏之类才当作 unavailable，交给前端回落。
    const missing =
      /does not exist|exists on disk, but not in|unknown revision|bad revision|not in the working tree/i.test(
        r.stderr
      )
    return missing ? { text: '' } : { omitted: 'unavailable' }
  }
  if (r.stdoutTruncated) return { omitted: 'large' }
  if (r.stdout.includes('\0')) return { omitted: 'binary' }
  return { text: normalizeFullText(r.stdout) }
}

/** `svn cat -r <rev> <wc-path>`；该 revision 没有这个路径时按空文本处理 */
export async function svnCatFullText(
  repo: VcsRepo,
  abs: string,
  rev: string
): Promise<FullText> {
  let r
  try {
    r = await runSvn(repo.root, ['cat', '-r', rev, '--', abs], {
      timeoutMs: 10_000,
      maxStdoutBytes: MAX_FULL_TEXT_BYTES
    })
  } catch {
    return { omitted: 'unavailable' }
  }
  if (r.code !== 0) {
    // E200009 / E160013 / "path not found" 都表示这个 revision 没有该路径
    const missing = /E200009|E160013|path not found|does not exist|not under version control/i.test(
      `${r.stderr}\n${r.stdout}`
    )
    return missing ? { text: '' } : { omitted: 'unavailable' }
  }
  if (r.stdoutTruncated) return { omitted: 'large' }
  if (r.stdout.includes('\0')) return { omitted: 'binary' }
  return { text: normalizeFullText(r.stdout) }
}

/** 两侧必须同时可用，否则整份回落；空字符串是合法文本 */
export function combineFullTexts(
  before: FullText,
  after: FullText
): { beforeText?: string; afterText?: string; fullTextOmitted?: 'binary' | 'large' | 'unavailable' } {
  if (before.text !== undefined && after.text !== undefined) {
    return { beforeText: before.text, afterText: after.text }
  }
  return { fullTextOmitted: before.omitted ?? after.omitted ?? 'unavailable' }
}
