import { resolve } from 'node:path'

/**
 * 每个工作区一条写操作队列。
 *
 * git 的 index.lock 和 svn 的 wc.db 都不允许两个写命令同时进来；读操作
 * 不进队列，已经在跑的读也不会被挡住。
 */
const chains = new Map<string, Promise<unknown>>()

export function vcsKey(cwd: string): string {
  const p = resolve(cwd).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? p.toLowerCase() : p
}

export function enqueue<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const key = vcsKey(cwd)
  const prev = chains.get(key) ?? Promise.resolve()
  // 前一个失败也要继续跑后一个，否则一次失败会把队列永久卡死
  const run = prev.then(fn, fn)
  const stored = run.catch(() => undefined)
  chains.set(key, stored)
  void stored.finally(() => {
    if (chains.get(key) === stored) chains.delete(key)
  })
  return run
}
