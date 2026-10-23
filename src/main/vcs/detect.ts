import { realpath } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import type { VcsCapabilities, VcsDetectData, VcsRepo } from '../../shared/vcs'
import { runGit, runSvn, runSvnVersion } from './exec'
import { posix } from './paths'

const GIT_CAPS: VcsCapabilities = {
  stage: true,
  unstage: true,
  discard: true,
  revert: false,
  resolve: true,
  fetch: true,
  pull: true,
  push: true,
  update: false,
  amend: true,
  log: true,
  commitDetail: true,
  branches: true,
  worktrees: true
}

const SVN_CAPS: VcsCapabilities = {
  stage: true, // 语义是 svn add
  unstage: false,
  discard: false,
  revert: true,
  resolve: true,
  fetch: false,
  pull: false,
  push: false,
  update: true,
  amend: false,
  log: true,
  commitDetail: true,
  branches: false,
  worktrees: false
}

const cache = new Map<string, { at: number; data: VcsDetectData }>()
const TTL = 5_000

function keyOf(cwd: string): string {
  const p = resolve(cwd).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? p.toLowerCase() : p
}

export function invalidateDetect(cwd?: string): void {
  if (!cwd) cache.clear()
  else cache.delete(keyOf(cwd))
}

async function hasGit(cwd: string): Promise<boolean> {
  try {
    const r = await runGit(cwd, ['--version'], { timeoutMs: 5_000 })
    return r.code === 0
  } catch {
    return false
  }
}

async function hasSvn(cwd: string): Promise<boolean> {
  try {
    const r = await runSvn(cwd, ['--version', '--quiet'], { timeoutMs: 5_000 })
    return r.code === 0
  } catch {
    return false
  }
}

async function detectGit(cwd: string): Promise<VcsRepo | null> {
  try {
    const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'], { timeoutMs: 5_000 })
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null

    const top = await runGit(cwd, ['rev-parse', '--show-toplevel'], { timeoutMs: 5_000 })
    const root = top.stdout.trim()
    if (!root) return null

    const [branchR, headR, shortR, upR, remoteR, originR] = await Promise.all([
      runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5_000 }),
      runGit(cwd, ['rev-parse', 'HEAD'], { timeoutMs: 5_000 }),
      runGit(cwd, ['rev-parse', '--short', 'HEAD'], { timeoutMs: 5_000 }),
      runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
        timeoutMs: 5_000
      }),
      runGit(cwd, ['remote'], { timeoutMs: 5_000 }),
      runGit(cwd, ['remote', 'get-url', 'origin'], { timeoutMs: 5_000 })
    ])

    let branchRaw = branchR.code === 0 ? branchR.stdout.trim() : ''
    // 空仓库没有 HEAD，rev-parse 会失败；symbolic-ref 仍能读出 unborn 分支名
    if (!branchRaw) {
      const sym = await runGit(cwd, ['symbolic-ref', '--short', 'HEAD'], { timeoutMs: 5_000 })
      if (sym.code === 0) branchRaw = sym.stdout.trim()
    }
    const detached = !branchRaw || branchRaw === 'HEAD'
    const upstream = upR.code === 0 ? upR.stdout.trim() : undefined
    let ahead = 0
    let behind = 0
    if (upstream) {
      const ab = await runGit(cwd, ['rev-list', '--left-right', '--count', '@{u}...HEAD'], {
        timeoutMs: 8_000
      })
      const m = /^(\d+)\s+(\d+)/.exec(ab.stdout.trim())
      if (m) {
        behind = Number(m[1])
        ahead = Number(m[2])
      }
    }

    // origin 是 push/pull 的默认远端；没有 origin 时才退回第一个 remote 名字
    const remote =
      originR.code === 0
        ? 'origin'
        : remoteR.code === 0
          ? remoteR.stdout.trim().split('\n')[0] || undefined
          : undefined
    const prefix = posix(relative(resolve(root), resolve(cwd))).replace(/^\.$/, '')

    return {
      kind: 'git',
      root,
      workspacePrefix: prefix,
      branch: detached ? 'detached' : branchRaw,
      head: headR.code === 0 ? headR.stdout.trim() : '',
      headShort: shortR.code === 0 ? shortR.stdout.trim() : '',
      ahead,
      behind,
      detached,
      upstream: upstream || undefined,
      remote,
      capabilities: GIT_CAPS
    }
  } catch {
    return null
  }
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
}

function firstOpenTag(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}\\b([^>]*)>`).exec(xml)
  return m?.[1] ?? ''
}

function attr(attrs: string, name: string): string {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)
  return m ? decodeXml(m[1]) : ''
}

function textTag(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml)
  return m ? decodeXml(m[1].trim()) : ''
}

async function detectSvn(cwd: string): Promise<VcsRepo | null> {
  try {
    const r = await runSvn(cwd, ['info', '--xml'], { timeoutMs: 6_000 })
    if (r.code !== 0) return null
    const xml = r.stdout
    const entry = firstOpenTag(xml, 'entry')
    if (!entry) return null

    const wcRevision = Number(attr(entry, 'revision')) || 0
    const url = textTag(xml, 'url')
    const repositoryRoot = textTag(xml, 'root')
    const wcRoot = textTag(xml, 'wcroot-abspath')
    const root = wcRoot || cwd
    const relUrl = repositoryRoot && url.startsWith(repositoryRoot)
      ? url.slice(repositoryRoot.length) || '/'
      : url

    // 混合修订的工作副本根目录经常是 r0（只提交了文件、没更新根）。
    // svnversion 是本地命令，能给出 “0:12” 这样的范围；取最高值显示。
    let headRevision = wcRevision
    try {
      const vr = await runSvnVersion(root, [root], { timeoutMs: 6_000 })
      if (vr.code === 0) {
        const nums = vr.stdout.match(/\d+/g)?.map(Number) ?? []
        if (nums.length) headRevision = Math.max(headRevision, ...nums)
      }
    } catch {
      // svnversion 不存在或工作副本异常时退回 info 的 revision
    }

    const prefix = posix(relative(resolve(root), resolve(cwd))).replace(/^\.$/, '')

    return {
      kind: 'svn',
      root,
      workspacePrefix: prefix,
      branch: relUrl || '/',
      head: `r${headRevision}`,
      headShort: `r${headRevision}`,
      ahead: 0,
      behind: 0,
      detached: false,
      url,
      repositoryRoot,
      revision: headRevision,
      capabilities: SVN_CAPS
    }
  } catch {
    return null
  }
}

export async function detectVcs(cwd: string): Promise<VcsDetectData> {
  const canonical = await realpath(cwd).catch(() => resolve(cwd))
  const key = keyOf(canonical)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.data

  const [git, svn] = await Promise.all([hasGit(canonical), hasSvn(canonical)])
  let repo: VcsRepo | null = null
  if (git) repo = await detectGit(canonical)
  if (!repo && svn) repo = await detectSvn(canonical)

  const data: VcsDetectData = {
    repo,
    available: { git, svn },
    reason: repo ? undefined : git || svn ? 'no-repo' : 'no-cli'
  }
  cache.set(key, { at: Date.now(), data })
  return data
}
