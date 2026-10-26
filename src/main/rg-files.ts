import { spawn, type ChildProcess } from 'node:child_process'
import { isAbsolute, relative, resolve } from 'node:path'
import type { FileMatch } from '../shared/workspace'
import { killProcessTree } from './kill-process'
import { markRgUnavailable, resolveRgPath } from './rg-path'
import { WORKSPACE_MAX_DEPTH, WORKSPACE_MAX_ENTRIES } from './search-limits'
import { WORKSPACE_IGNORE_GLOBS, isIgnoredWorkspacePath } from './workspace-ignore'

/**
 * 用 `rg --files` 列出工作区条目 —— 纯 Node，不 import Electron。
 *
 * 和 Node 递归扫描相比，rg 会遵循 `.gitignore` / `.ignore`，并且在大型仓库
 * 上快得多。rg 只输出文件，这里反推祖先目录，保证 @ 路径补全仍可用。
 */

export interface RgFileList {
  ok: true
  files: FileMatch[]
  truncated: boolean
  incomplete: boolean
}

export interface RgFileListFailure {
  ok: false
  /** no-rg = 没找到可执行文件；failed = 启动/退出异常 */
  error: 'no-rg' | 'failed'
}

export type RgFileListResult = RgFileList | RgFileListFailure

export interface RgFileListOptions {
  maxEntries?: number
  maxDepth?: number
}

/** stderr 只保留这么多，足够判断“有没有权限错误”，不把整段错误塞进内存 */
const MAX_STDERR = 8 * 1024
/** 单行路径的合理上限；超长说明输出异常 */
const MAX_LINE = 8 * 1024

export function normalizeRel(root: string, raw: string): string | null {
  const line = raw.replace(/\r$/, '')
  if (!line || line.includes('\0')) return null
  const abs = isAbsolute(line) ? line : resolve(root, line)
  let rel = relative(root, abs).replace(/\\/g, '/')
  rel = rel.replace(/^\.\//, '').replace(/\/+$/, '')
  if (!rel || rel === '.' || rel.startsWith('../') || isAbsolute(rel)) return null
  if (rel.split('/').some((part) => part === '..' || part === '')) return null
  return rel
}

function fileEntry(rel: string): FileMatch {
  const parts = rel.split('/')
  return {
    path: rel,
    name: parts[parts.length - 1],
    dir: parts.slice(0, -1).join('/'),
    kind: 'file'
  }
}

function dirEntries(rel: string): FileMatch[] {
  const parts = rel.split('/')
  const out: FileMatch[] = []
  for (let i = 1; i < parts.length; i++) {
    const path = parts.slice(0, i).join('/')
    out.push({
      path,
      name: parts[i - 1],
      dir: parts.slice(0, i - 1).join('/'),
      kind: 'dir'
    })
  }
  return out
}

/**
 * 列出 `cwd` 下的文件和目录。
 *
 * 返回值里的 `truncated` / `incomplete` 语义与 Node 扫描一致：替换在列表
 * 不完整时会整体中止，绝不会静默漏文件。
 */
export function listFilesWithRg(
  cwd: string,
  options: RgFileListOptions = {}
): Promise<RgFileListResult> {
  const rg = resolveRgPath()
  if (!rg) return Promise.resolve({ ok: false, error: 'no-rg' })

  const root = resolve(cwd)
  const maxEntries = Math.max(1, options.maxEntries ?? WORKSPACE_MAX_ENTRIES)
  const maxDepth = Math.max(1, options.maxDepth ?? WORKSPACE_MAX_DEPTH)

  return new Promise((done) => {
    let child: ChildProcess
    try {
      child = spawn(
        rg,
        [
          '--files',
          '--no-config',
          '--no-require-git',
          '--hidden',
          ...WORKSPACE_IGNORE_GLOBS.map((glob) => `--glob=${glob}`),
          ...(process.platform === 'win32' ? ['--glob-case-insensitive'] : []),
          `--max-depth=${maxDepth}`,
          '--',
          '.'
        ],
        {
          cwd: root,
          windowsHide: true,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
    } catch {
      markRgUnavailable()
      done({ ok: false, error: 'no-rg' })
      return
    }

    const files = new Map<string, FileMatch>()
    const dirs = new Map<string, FileMatch>()
    let pending = ''
    let seen = 0
    let truncated = false
    let incomplete = false
    let stderr = ''
    let settled = false
    let killedForLimit = false

    const finish = (result: RgFileListResult): void => {
      if (settled) return
      settled = true
      done(result)
    }

    const stop = (): void => {
      if (killedForLimit) return
      killedForLimit = true
      killProcessTree(child)
    }

    const consume = (line: string): void => {
      if (truncated) return
      if (++seen > maxEntries) {
        truncated = true
        stop()
        return
      }
      const rel = normalizeRel(root, line)
      if (!rel || isIgnoredWorkspacePath(rel)) return
      if (!files.has(rel)) files.set(rel, fileEntry(rel))
      for (const dir of dirEntries(rel)) {
        if (!dirs.has(dir.path)) dirs.set(dir.path, dir)
      }
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      pending += chunk
      for (;;) {
        const nl = pending.indexOf('\n')
        if (nl < 0) break
        const line = pending.slice(0, nl)
        pending = pending.slice(nl + 1)
        if (line.length > MAX_LINE) {
          incomplete = true
          continue
        }
        consume(line)
      }
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.slice(0, MAX_STDERR - stderr.length)
    })

    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EACCES') markRgUnavailable()
      finish({ ok: false, error: code === 'ENOENT' ? 'no-rg' : 'failed' })
    })

    child.on('close', (code) => {
      if (pending) consume(pending)
      if (stderr.trim()) incomplete = true
      // 2 = rg 自身报错（权限、参数、IO）。有部分结果就带着 incomplete 返回，
      // 完全没有结果则让调用方回退 Node 扫描。
      if (code !== 0 && code !== 1) {
        incomplete = true
        if (files.size === 0) {
          finish({ ok: false, error: 'failed' })
          return
        }
      }
      const all = [...files.values(), ...dirs.values()].sort((a, b) =>
        a.path.localeCompare(b.path)
      )
      finish({ ok: true, files: all, truncated, incomplete })
    })
  })
}
