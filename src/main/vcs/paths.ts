import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { VcsRepo } from '../../shared/vcs'
import { VcsOpError } from './exec'

export function posix(p: string): string {
  return p.replace(/\\/g, '/')
}

/** 校验工作区相对路径：不许绝对路径、NUL、换行和 `..` 越界 */
export function normRel(rel: string): string {
  const raw = typeof rel === 'string' ? rel : ''
  if (!raw || raw.includes('\0') || /[\r\n]/.test(raw)) {
    throw new VcsOpError('invalid-path', '文件路径不合法')
  }
  const p = posix(raw).replace(/^\/+|\/+$/g, '')
  if (isAbsolute(raw) || p.split('/').some((seg) => seg === '..')) {
    throw new VcsOpError('invalid-path', '文件路径不在工作区内', raw)
  }
  return p
}

/** 工作区相对路径 → 仓库根相对路径（Git 命令用） */
export function rootRel(repo: VcsRepo, rel: string): string {
  const r = normRel(rel)
  return repo.workspacePrefix ? `${repo.workspacePrefix}/${r}` : r
}

/** 工作区相对路径 → 绝对路径（SVN / fs 用） */
export function absPath(repo: VcsRepo, rel: string): string {
  return resolve(repo.root, rootRel(repo, rel))
}

/**
 * 仓库根相对路径 → 工作区相对路径。
 * 返回 null 表示这个文件不在当前工作区里（例如工作区是仓库子目录）。
 */
export function toWorkspaceRel(repo: VcsRepo, rootPath: string): string | null {
  const p = posix(rootPath).replace(/^\/+/, '')
  if (!repo.workspacePrefix) return p
  if (p === repo.workspacePrefix) return ''
  const pre = `${repo.workspacePrefix}/`
  return p.startsWith(pre) ? p.slice(pre.length) : null
}

export function nameOf(rel: string): string {
  const p = posix(rel)
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

export function dirOf(rel: string): string {
  const p = posix(rel)
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(0, i) : ''
}

/** 只接受明确的 revision / commit，不把任意字符串交给 CLI 当前缀参数 */
export function checkRevision(kind: 'git' | 'svn', value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  if (kind === 'svn') {
    if (!/^\d{1,12}$/.test(value)) throw new VcsOpError('invalid-path', 'revision 不合法')
    return value
  }
  if (/^(HEAD|FETCH_HEAD)([~^]\d*)?$/.test(value) || /^[0-9a-fA-F]{4,64}$/.test(value)) {
    return value
  }
  throw new VcsOpError('invalid-path', 'commit 不合法')
}

export function countDiff(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

/**
 * 真实路径也必须在仓库根内 —— 防止工作区里的符号链接把读取引到外面。
 * 只用于确实存在的路径；缺失文件走纯字面检查。
 */
export async function assertRealInside(root: string, abs: string): Promise<void> {
  const [rootReal, real] = await Promise.all([realpath(resolve(root)), realpath(abs)])
  const r = relative(rootReal, real)
  if (r.startsWith('..') || isAbsolute(r)) {
    throw new VcsOpError('invalid-path', '路径不在仓库内', abs)
  }
}

/** 用于防止把仓库根之外的路径交给 fs */
export function assertInside(root: string, abs: string): string {
  const r = relative(resolve(root), resolve(abs))
  if (!r || r.startsWith('..') || isAbsolute(r)) {
    throw new VcsOpError('invalid-path', '路径不在仓库内', abs)
  }
  return abs
}
