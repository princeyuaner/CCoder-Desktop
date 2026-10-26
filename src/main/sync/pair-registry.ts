import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { logMain } from '../crash-log'
import { pathKey } from '../path-key'

/**
 * 同一对目录只允许一个同步服务。
 *
 * 两层：
 *  - 进程内的一张表，挡住同一应用里两个 IDE 窗口抢同一对目录；
 *  - `userData/sync/claims/` 下的认领文件，挡住两个应用实例。文件里记
 *    pid + 工作区；进程崩了留下的文件靠 `pid` 是否还活着来判断过期。
 *
 * 两个写者同时跑会互相删掉对方刚写的文件，所以这一层不能省。
 */

interface Claim {
  pid: number
  workspace: string
  at: number
}

const owners = new Map<string, string>()
/** 这个工作区自己写下的认领文件；release 时要删干净。 */
const claimsByWorkspace = new Map<string, Set<string>>()

function pairKey(src: string, dst: string): string {
  return `${pathKey(src)}\0${pathKey(dst)}`
}

function claimFile(src: string, dst: string): string {
  const hash = createHash('sha1')
    .update(pairKey(src, dst))
    .digest('hex')
    .slice(0, 20)
  return join(app.getPath('userData'), 'sync', 'claims', `${hash}.json`)
}

function readClaim(path: string): Claim | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Claim>
    if (
      typeof raw.pid !== 'number' ||
      !Number.isInteger(raw.pid) ||
      typeof raw.workspace !== 'string'
    ) {
      return null
    }
    return { pid: raw.pid, workspace: raw.workspace, at: Number(raw.at) || 0 }
  } catch {
    return null
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM = 进程存在但当前用户没权限发信号；其它错误一律当已退出
    return (e as NodeJS.ErrnoException | undefined)?.code === 'EPERM'
  }
}

export type AcquireResult =
  | { ok: true }
  | { ok: false; by: string }

export function acquirePair(
  workspace: string,
  src: string,
  dst: string
): AcquireResult {
  const ws = pathKey(workspace)
  const key = pairKey(src, dst)
  const inProcess = owners.get(key)
  if (inProcess && inProcess !== ws) return { ok: false, by: inProcess }

  const file = claimFile(src, dst)
  try {
    mkdirSync(dirname(file), { recursive: true })
  } catch (e) {
    // 认领目录建不起来时不能把同步整个挡住；退化为进程内锁
    logMain('sync.claim.dir', e)
    owners.set(key, ws)
    return { ok: true }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const claim: Claim = { pid: process.pid, workspace: ws, at: Date.now() }
      writeFileSync(file, JSON.stringify(claim), { encoding: 'utf8', flag: 'wx' })
      owners.set(key, ws)
      let mine = claimsByWorkspace.get(ws)
      if (!mine) {
        mine = new Set()
        claimsByWorkspace.set(ws, mine)
      }
      mine.add(file)
      return { ok: true }
    } catch (e) {
      if ((e as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') {
        // 写不了认领文件（权限 / 磁盘）时退化为进程内锁，别让功能不可用
        logMain('sync.claim.write', e)
        owners.set(key, ws)
        return { ok: true }
      }

      const claim = readClaim(file)
      if (!claim) {
        // 坏文件 / 写到一半：删掉重试一次
        removeQuietly(file)
        continue
      }
      if (claim.pid === process.pid) {
        // 同一个进程里没有对应的内存记录（上次清理漏了），当过期处理
        removeQuietly(file)
        continue
      }
      if (processAlive(claim.pid)) {
        return { ok: false, by: claim.workspace }
      }
      // 另一个实例崩了：清掉过期认领再试
      removeQuietly(file)
    }
  }

  // 两次都没抢到（极端的并发），按被占用处理
  const claim = readClaim(file)
  return { ok: false, by: claim?.workspace ?? 'another window' }
}

export function releasePair(workspace: string): void {
  const ws = pathKey(workspace)
  for (const [key, owner] of owners) {
    if (owner === ws) owners.delete(key)
  }
  const mine = claimsByWorkspace.get(ws)
  if (mine) {
    for (const file of mine) {
      const claim = readClaim(file)
      // 只删自己写的；文件可能已经被别的实例接管
      if (claim && claim.pid === process.pid && claim.workspace === ws) {
        removeQuietly(file)
      }
    }
    claimsByWorkspace.delete(ws)
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // 已经没了 / 被占用，下一轮/下次启动再处理
  }
}
