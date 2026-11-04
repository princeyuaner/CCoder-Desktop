/**
 * 主进程侧的 `.editorconfig` 发现与缓存。
 *
 * 从文件所在目录一路向上读到工作区根，遇到 `root = true` 提前停止。
 * 只读普通文件；读不到 / 解析失败都当成「没有配置」，不影响打开文件。
 */

import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import {
  parseEditorConfig,
  resolveEditorConfig,
  type EditorConfigProperties,
  type EditorConfigSource
} from '../shared/editorconfig'

interface CacheEntry {
  mtimeMs: number
  text: string
}

const cache = new Map<string, CacheEntry | null>()

function posix(p: string): string {
  return p.replace(/\\/g, '/')
}

function normalizeRel(rel: string): string {
  return posix(rel || '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/^\.\//, '')
}

/** 只做字面越界检查；配置读取不跟随符号链接做写入，不需要 realpath */
function inside(root: string, abs: string): boolean {
  const r = relative(root, abs)
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

async function readConfig(
  abs: string
): Promise<{ mtimeMs: number; text: string } | null> {
  try {
    const st = await fs.stat(abs)
    if (!st.isFile()) return null
    const cached = cache.get(abs)
    if (cached && cached.mtimeMs === st.mtimeMs) return cached
    const text = (await fs.readFile(abs, 'utf8')).replace(/^﻿/, '')
    const entry = { mtimeMs: st.mtimeMs, text }
    cache.set(abs, entry)
    return entry
  } catch {
    cache.set(abs, null)
    return null
  }
}

/**
 * 返回某个工作区相对路径最终生效的 editorconfig 属性。
 *
 * 主进程对每个文件都会被调用一次；缓存按 mtime 失效，改 `.editorconfig`
 * 后下一次读取自然拿到新内容。
 */
export async function editorConfigFor(
  cwd: string,
  rel: string
): Promise<EditorConfigProperties> {
  const root = resolve(cwd)
  const fileRel = normalizeRel(rel)
  if (!fileRel) return {}
  const abs = resolve(root, fileRel)
  if (!inside(root, abs)) return {}

  const sources: EditorConfigSource[] = []
  let dir = dirname(abs)

  for (;;) {
    if (!inside(root, dir)) break
    const configPath = resolve(dir, '.editorconfig')
    const read = await readConfig(configPath)
    if (read) {
      const parsed = parseEditorConfig(read.text)
      const dirRel = posix(relative(root, dir))
      sources.push({ dirRel, text: read.text })
      if (parsed.root) break
    }
    if (dir === root) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // 根目录的配置先应用，越靠近文件的越后应用
  sources.reverse()
  return resolveEditorConfig(fileRel, sources)
}

/** 配置文件本身变了：清掉所有缓存，下一次读取重新解析 */
export function invalidateEditorConfigCache(): void {
  cache.clear()
}
