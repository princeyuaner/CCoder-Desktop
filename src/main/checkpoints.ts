import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve, sep } from 'node:path'
import type {
  CheckpointFileChange,
  SessionCheckpointInfo,
  SessionCheckpointList,
  SessionCheckpointPreview,
  SessionCheckpointRestore
} from '../shared/session'
import { WORKSPACE_IGNORE_DIRS } from './workspace-ignore'
import { isSameOrInside, pathKey } from './path-key'
import { runGit, runGitShadow, VcsOpError } from './vcs/exec'
import { logMain } from './crash-log'
import { t } from './i18n'

/**
 * 文件检查点（每轮开始前的工作区快照）。
 *
 * 设计取舍：
 *  - **不碰用户自己的 Git 仓库**。每个工作区在应用数据目录里有一个独立的
 *    bare 仓库，对象和索引都属于应用；不会改 HEAD、index，也不会产生 stash。
 *  - 工作区不必是 Git 仓库 —— 独立 git dir + work-tree 一样能 add / checkout。
 *  - `.gitignore` 和应用自己的忽略表（node_modules、构建产物、.env、密钥等）
 *    会被遵守，快照不会偷偷把依赖目录或凭据存进应用数据。
 *  - 每个工作区一个仓库、串行执行：同一工作区可以并行跑多条会话，
 *    共享索引必须排队，否则两次 add 会互相覆盖。
 *  - 快照只覆盖会话工作目录；`--add-dir` 里的附加目录不在范围内。
 */

/** 单次 git 操作的硬上限。首次快照大仓库可能慢，之后都是增量的。 */
const GIT_TIMEOUT_MS = 30_000
const INIT_TIMEOUT_MS = 10_000
/** 每个会话保留多少条普通检查点 / 恢复前备份 */
const KEEP_CHECKPOINTS = 60
const KEEP_BACKUPS = 5
/** 预览最多回多少条路径（恢复仍处理全部） */
const PREVIEW_LIMIT = 300
const PROMPT_LIMIT = 160
const MAX_PROMPT_SOURCE = 20_000
/** checkout 分批，避开 Windows 命令行长度限制 */
const CHECKOUT_BATCH = 120

interface StoredCheckpoint extends SessionCheckpointInfo {
  /** git tree 对象；用于恢复和预览 */
  tree: string
}

interface StoredSession {
  /** 当前进程里的 Live id；重启后失效，仅用于把新捕获的条目归到这条会话 */
  liveId: string
  /** CLI 自己的会话 id；跨重启稳定 */
  providerId: string | null
  cli: string
  cwd: string
  checkpoints: StoredCheckpoint[]
}

interface StoreFile {
  v: 1
  sessions: Record<string, StoredSession>
}

interface Repo {
  gitDir: string
  cwd: string
  /** 同一工作区的所有 git 操作串行执行 */
  chain: Promise<void>
  /** 初始化 / 首次快照失败后不再重试，避免每轮都卡一次超时 */
  disabled: string | null
}

export interface CaptureInput {
  liveId: string
  cli: string
  cwd: string
  providerId: string | null
  prompt: string
}

const EMPTY_STORE = (): StoreFile => ({ v: 1, sessions: {} })

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

function cleanPrompt(raw: string): string {
  const head = raw.slice(0, MAX_PROMPT_SOURCE)
  return head
    .replace(/<ide_reference\b[\s\S]*?<\/ide_reference>/gi, ' ')
    .replace(/<ide_reference\b[\s\S]*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PROMPT_LIMIT)
}

function keyFor(cli: string, cwd: string, providerId: string): string {
  return JSON.stringify([cli, pathKey(cwd), providerId])
}

function liveKey(liveId: string): string {
  return JSON.stringify(['live', liveId])
}

function repoHash(cwd: string): string {
  return createHash('sha1').update(pathKey(cwd)).digest('hex').slice(0, 20)
}

function safeEntry(raw: unknown): StoredCheckpoint | null {
  const o = obj(raw)
  if (!o) return null
  const id = str(o.id)
  const tree = str(o.tree)
  const at = num(o.at)
  if (!id || !/^[0-9a-f]{40,64}$/i.test(tree) || at <= 0) return null
  const kind = o.kind === 'restore-backup' ? 'restore-backup' : 'turn'
  return {
    id: id.slice(0, 80),
    tree,
    at,
    turn: Math.max(1, Math.floor(num(o.turn))),
    prompt: str(o.prompt).slice(0, PROMPT_LIMIT),
    kind
  }
}

/** 检查点里只需要展示的字段；`tree` 留在主进程 */
function checkpointInfo(c: StoredCheckpoint): SessionCheckpointInfo {
  return {
    id: c.id,
    turn: c.turn,
    at: c.at,
    prompt: c.prompt,
    kind: c.kind
  }
}

export class CheckpointStore {
  private readonly repoRoot: string
  private readonly excludesFile: string
  private readonly repos = new Map<string, Promise<Repo>>()
  /** liveId → StoreFile.sessions 的 key；bind 之后指向 provider 稳定键 */
  private readonly liveOwner = new Map<string, string>()
  private data: StoreFile = EMPTY_STORE()
  private loaded = false
  private loadPromise: Promise<void> | null = null
  private saveChain: Promise<void> = Promise.resolve()
  /** 每个工作区最近一次失败原因；跨会话不能互相串味 */
  private readonly errors = new Map<string, string>()
  /** 环境级不可用（例如没有 git）：后续轮次直接跳过，不必反复探测 */
  private unavailable: string | null = null
  /** liveId → cwd；list 在还没有检查点记录时也要能定位工作区 */
  private readonly liveCwd = new Map<string, string>()
  /** 每个工作区只记一次失败日志，避免主目录会话每轮刷屏 */
  private readonly logged = new Set<string>()

  constructor(baseDir: string) {
    this.repoRoot = join(baseDir, 'repos')
    this.excludesFile = join(baseDir, 'excludes')
  }

  /* ── 元数据 ─────────────────────────────────────────────── */

  private async load(): Promise<void> {
    if (this.loaded) return
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = (async () => {
      try {
        const raw = JSON.parse(await readFile(join(this.repoRoot, '..', 'index.json'), 'utf8'))
        const root = obj(raw)
        const sessions = obj(root?.sessions)
        const out: StoreFile = EMPTY_STORE()
        if (root?.v === 1 && sessions) {
          for (const [key, value] of Object.entries(sessions)) {
            const s = obj(value)
            if (!s) continue
            const providerId = str(s.providerId) || null
            const cli = str(s.cli)
            const cwd = str(s.cwd)
            if (!cli || !cwd) continue
            const list = Array.isArray(s.checkpoints) ? s.checkpoints : []
            const checkpoints = list
              .map(safeEntry)
              .filter((c): c is StoredCheckpoint => c !== null)
              .sort((a, b) => a.at - b.at)
            if (checkpoints.length === 0) continue
            out.sessions[key] = {
              liveId: str(s.liveId),
              providerId,
              cli,
              cwd,
              checkpoints
            }
          }
        }
        this.data = out
      } catch {
        // 文件不存在 / 损坏都当空；检查点只是辅助能力，不能影响会话
        this.data = EMPTY_STORE()
      } finally {
        this.loaded = true
        this.loadPromise = null
      }
    })()
    return this.loadPromise
  }

  private async persist(): Promise<void> {
    const body = JSON.stringify(this.data, null, 2)
    this.saveChain = this.saveChain.then(async () => {
      const target = join(this.repoRoot, '..', 'index.json')
      const tmp = `${target}.tmp`
      await mkdir(dirname(target), { recursive: true })
      await writeFile(tmp, body, 'utf8')
      await rename(tmp, target)
    })
    try {
      await this.saveChain
    } catch (err) {
      // 元数据写不进去时，本次运行仍然能恢复；只是下次启动会丢
      logMain('checkpoints.persist', err)
    }
  }

  private recordFor(liveId: string, input?: CaptureInput): StoredSession | null {
    const owner = this.liveOwner.get(liveId)
    if (owner) {
      const hit = this.data.sessions[owner]
      if (hit) return hit
    }
    // 还没 bind 的新会话：先挂在 live 键下，session_started 后合并到稳定键
    const live = this.data.sessions[liveKey(liveId)]
    if (live) return live
    if (!input) return null
    if (!input.providerId) return null
    const key = keyFor(input.cli, input.cwd, input.providerId)
    return this.data.sessions[key] ?? null
  }

  private recordForWrite(input: CaptureInput): StoredSession {
    const ownerKey = this.liveOwner.get(input.liveId)
    const stableKey = input.providerId
      ? keyFor(input.cli, input.cwd, input.providerId)
      : null
    const key = ownerKey ?? stableKey ?? liveKey(input.liveId)
    let record = this.data.sessions[key]
    if (!record) {
      record = {
        liveId: input.liveId,
        providerId: input.providerId,
        cli: input.cli,
        cwd: input.cwd,
        checkpoints: []
      }
      this.data.sessions[key] = record
    } else {
      record.liveId = input.liveId
      if (input.providerId) record.providerId = input.providerId
    }
    this.liveOwner.set(input.liveId, key)
    return record
  }

  /**
   * 把当前 Live 绑定到 CLI 的稳定 session id。
   *
   * 新建会话的第一轮在 `session_started` 之前就拍了快照，那时只能挂在
   * live 键下；这里把条目并到 `(cli, cwd, providerId)` 的稳定记录里，
   * 应用重启后打开旧会话还能看到这些检查点。
   */
  async bind(liveId: string, cli: string, cwd: string, providerId: string | null): Promise<void> {
    if (!liveId || !providerId) return
    await this.load()
    this.liveCwd.set(liveId, cwd)
    this.liveOwner.set(liveId, keyFor(cli, cwd, providerId))

    const live = this.data.sessions[liveKey(liveId)]
    if (!live) return

    const key = keyFor(cli, cwd, providerId)
    const target = this.data.sessions[key] ?? {
      liveId,
      providerId,
      cli,
      cwd,
      checkpoints: []
    }
    target.liveId = liveId
    target.providerId = providerId
    target.cli = cli || target.cli
    target.cwd = cwd || target.cwd

    const seen = new Set(target.checkpoints.map((c) => c.id))
    for (const c of live.checkpoints) {
      if (!seen.has(c.id)) target.checkpoints.push(c)
    }
    target.checkpoints.sort((a, b) => a.at - b.at)
    renumber(target)
    this.data.sessions[key] = target
    delete this.data.sessions[liveKey(liveId)]
    await this.persist()
  }

  /**
   * 会话被删除时清掉它的检查点记录（git 对象暂不主动回收）。
   *
   * 删除调用方只拿得到 CLI 的 provider id，不知道 cli / cwd，所以按
   * providerId 扫一遍记录；会话数量不大，这点成本可以接受。
   */
  async forgetProvider(providerId: string, cwd?: string): Promise<void> {
    if (!providerId) return
    await this.load()
    const wantCwd = cwd ? pathKey(cwd) : null
    let changed = false
    for (const [key, record] of Object.entries(this.data.sessions)) {
      if (record.providerId !== providerId) continue
      if (wantCwd && pathKey(record.cwd) !== wantCwd) continue
      delete this.data.sessions[key]
      changed = true
      const repo = await this.repoFor(record.cwd).catch(() => null)
      if (!repo) continue
      for (const c of record.checkpoints) {
        await runGitShadow(repo.gitDir, repo.cwd, ['update-ref', '-d', `refs/ccoder/${c.id}`], {
          timeoutMs: GIT_TIMEOUT_MS
        }).catch(() => undefined)
      }
    }
    if (changed) await this.persist()
  }

  /* ── 快照 ───────────────────────────────────────────────── */

  private async repoFor(cwdRaw: string): Promise<Repo> {
    const cwd = resolve(cwdRaw)
    const key = pathKey(cwd)
    let pending = this.repos.get(key)
    if (pending) return pending

    pending = this.initRepo(cwd)
    this.repos.set(key, pending)
    pending.catch(() => {
      this.repos.delete(key)
    })
    return pending
  }

  private async initRepo(cwd: string): Promise<Repo> {
    const root = parse(cwd).root
    if (pathKey(cwd) === pathKey(root)) {
      throw new Error(t('checkpoint.error.root'))
    }
    if (pathKey(cwd) === pathKey(homedir())) {
      throw new Error(t('checkpoint.error.home'))
    }
    // cwd 不存在时 spawn 也会报 ENOENT，会被误判成“没装 git”；先单独挡掉
    const st = await stat(cwd).catch(() => null)
    if (!st?.isDirectory()) {
      throw new Error(t('checkpoint.error.cwd'))
    }

    await mkdir(this.repoRoot, { recursive: true })
    await this.writeExcludes()

    const gitDir = join(this.repoRoot, `${repoHash(cwd)}.git`)
    const repo: Repo = { gitDir, cwd, chain: Promise.resolve(), disabled: null }

    // 让 VcsOpError 原样冒泡：capture / warm 据此识别 no-cli，避免反复探测
    const probe = await runGit(cwd, ['--version'], { timeoutMs: INIT_TIMEOUT_MS })
    if (probe.code !== 0) {
      throw new Error(t('checkpoint.error.git'))
    }

    if (!existsSync(join(gitDir, 'HEAD'))) {
      const init = await runGit(cwd, ['init', '--bare', '-q', gitDir], {
        timeoutMs: INIT_TIMEOUT_MS
      })
      if (init.code !== 0) {
        throw new Error(t('checkpoint.error.init', { detail: init.stderr.trim().slice(-300) }))
      }
    }

    // 忽略表由应用统一维护；用户自己的 .gitignore 仍然照常生效
    await runGitShadow(
      gitDir,
      cwd,
      ['config', 'core.excludesFile', this.excludesFile],
      { timeoutMs: INIT_TIMEOUT_MS }
    ).catch(() => undefined)

    return repo
  }

  private async writeExcludes(): Promise<void> {
    const lines: string[] = [
      '# CCoder 检查点忽略表（自动生成，修改会在下次启动时被覆盖）'
    ]
    for (const dir of WORKSPACE_IGNORE_DIRS) lines.push(`${dir}/`)
    // linked worktree 里 `.git` 是文件不是目录，`dir/` 匹配不到；单独挡一次
    lines.push('.git')
    lines.push(
      '*.egg-info/',
      '*.dist-info/',
      '.DS_Store',
      'Thumbs.db',
      'ehthumbs.db',
      'desktop.ini',
      '.env',
      '.env.*',
      '*.log',
      '*.pem',
      '*.p12',
      '*.pfx',
      '*.key',
      '*.p8',
      '*.jks',
      '*.keystore',
      'id_rsa*',
      'id_ed25519*',
      'id_ecdsa*'
    )
    const body = `${lines.join('\n')}\n`
    try {
      const prev = await readFile(this.excludesFile, 'utf8')
      if (prev === body) return
    } catch {
      // 不存在就写
    }
    await writeFile(this.excludesFile, body, 'utf8')
  }

  /** 同一工作区的 git 操作串行化 */
  private runExclusive<T>(repo: Repo, fn: () => Promise<T>): Promise<T> {
    const next = repo.chain.then(fn, fn)
    repo.chain = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private async addAll(repo: Repo): Promise<void> {
    const r = await runGitShadow(repo.gitDir, repo.cwd, ['add', '-A'], {
      timeoutMs: GIT_TIMEOUT_MS
    })
    if (r.code !== 0) {
      throw new Error(t('checkpoint.error.add', { detail: r.stderr.trim().slice(-300) }))
    }
  }

  private async treeOf(repo: Repo): Promise<string> {
    const r = await runGitShadow(repo.gitDir, repo.cwd, ['write-tree'], {
      timeoutMs: GIT_TIMEOUT_MS
    })
    const tree = r.stdout.trim()
    if (r.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(tree)) {
      throw new Error(t('checkpoint.error.tree', { detail: r.stderr.trim().slice(-300) }))
    }
    return tree
  }

  /**
   * 提前把 shadow 仓库的索引建好。
   *
   * 打开会话时在后台跑，用户输入第一条消息前的几秒通常足够完成首次
   * `git add`。这样轮开始时的 capture 只是一次增量扫描（实测这个仓库
   * 首次 4.4s，预热后 0.1s），不会让「发送」明显变慢。
   */
  async warm(liveId: string, cwd: string): Promise<void> {
    if (!cwd || this.unavailable) return
    if (liveId) this.liveCwd.set(liveId, cwd)
    let repo: Repo | null = null
    try {
      repo = await this.repoFor(cwd)
      if (repo.disabled) return
      const st = await stat(repo.cwd).catch(() => null)
      if (!st?.isDirectory()) return
      await this.runExclusive(repo, async () => {
        await this.addAll(repo!)
      })
      this.errors.delete(pathKey(cwd))
    } catch (err) {
      // 预热失败不影响会话；真正的 capture 会再试一次。
      // 但超时 / 没有 git 要先标记，避免第一次发送再傻等一遍。
      const code = err instanceof VcsOpError ? err.code : ''
      const detail = err instanceof Error ? err.message : String(err)
      if (code === 'no-cli') this.unavailable = detail
      else this.errors.set(pathKey(cwd), detail)
      if (code === 'timeout' && repo) repo.disabled = detail
    }
  }

  /**
   * 拍一张当前工作区快照，并记一条检查点。
   *
   * 用户主动发送的一轮会 **await** 这里，保证模型动文件之前快照已经落盘；
   * CLI 自主续跑的一轮没有调用方可等，只能在后台尽快拍。失败不影响会话。
   */
  async capture(input: CaptureInput): Promise<SessionCheckpointInfo | null> {
    if (!input.liveId || !input.cwd || this.unavailable) return null
    this.liveCwd.set(input.liveId, input.cwd)
    let repo: Repo | null = null
    try {
      repo = await this.repoFor(input.cwd)
      if (repo.disabled) return null
      const st = await stat(repo.cwd).catch(() => null)
      if (!st?.isDirectory()) throw new Error(t('checkpoint.error.cwd'))
      return await this.runExclusive(repo, async () => {
        try {
          await this.load()
          await this.addAll(repo!)
          const tree = await this.treeOf(repo!)
          const id = randomUUID()
          await this.createRef(repo!, tree, id)
          const record = this.recordForWrite(input)
          const turn = nextTurn(record)
          const entry: StoredCheckpoint = {
            id,
            tree,
            turn,
            at: Date.now(),
            prompt: cleanPrompt(input.prompt),
            kind: 'turn'
          }
          record.checkpoints.push(entry)
          await this.prune(repo!, record)
          this.errors.delete(pathKey(input.cwd))
          await this.persist()
          return checkpointInfo(entry)
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          this.errors.set(pathKey(input.cwd), detail)
          throw err
        }
      })
    } catch (err) {
      // 超时 / 无 git：不要每轮都再卡一次
      const code = err instanceof VcsOpError ? err.code : ''
      if (code === 'no-cli') this.unavailable = err instanceof Error ? err.message : String(err)
      if (repo && code === 'timeout') {
        repo.disabled = err instanceof Error ? err.message : String(err)
      }
      const detail =
        err instanceof Error ? err.message : t('checkpoint.error.capture', { detail: String(err) })
      this.errors.set(pathKey(input.cwd), detail)
      const key = pathKey(input.cwd)
      if (!this.logged.has(key)) {
        this.logged.add(key)
        logMain('checkpoints.capture', { cwd: input.cwd, error: detail })
      }
      return null
    }
  }

  private async createRef(repo: Repo, tree: string, id: string): Promise<void> {
    const commit = await runGitShadow(
      repo.gitDir,
      repo.cwd,
      [
        '-c',
        'user.name=CCoder',
        '-c',
        'user.email=ccoder@localhost',
        'commit-tree',
        tree,
        '-m',
        `checkpoint ${id}`
      ],
      { timeoutMs: GIT_TIMEOUT_MS }
    )
    if (commit.code !== 0) {
      throw new Error(t('checkpoint.error.commit', { detail: commit.stderr.trim().slice(-300) }))
    }
    const hash = commit.stdout.trim()
    await runGitShadow(repo.gitDir, repo.cwd, ['update-ref', `refs/ccoder/${id}`, hash], {
      timeoutMs: GIT_TIMEOUT_MS
    })
  }

  /** 删掉超出保留上限的条目，并同步删 ref。 */
  private async prune(repo: Repo, record: StoredSession): Promise<void> {
    const drop = new Set<string>()
    const turns = record.checkpoints.filter((c) => c.kind === 'turn')
    if (turns.length > KEEP_CHECKPOINTS) {
      for (const c of turns.slice(0, turns.length - KEEP_CHECKPOINTS)) drop.add(c.id)
    }
    const backups = record.checkpoints.filter((c) => c.kind === 'restore-backup')
    if (backups.length > KEEP_BACKUPS) {
      for (const c of backups.slice(0, backups.length - KEEP_BACKUPS)) drop.add(c.id)
    }
    if (drop.size === 0) return
    record.checkpoints = record.checkpoints.filter((c) => !drop.has(c.id))
    for (const id of drop) {
      await runGitShadow(repo.gitDir, repo.cwd, ['update-ref', '-d', `refs/ccoder/${id}`], {
        timeoutMs: GIT_TIMEOUT_MS
      }).catch(() => undefined)
    }
  }

  /* ── 查询与恢复 ─────────────────────────────────────────── */

  async list(liveId: string): Promise<SessionCheckpointList> {
    await this.load()
    const record = this.recordFor(liveId)
    const checkpoints = record
      ? [...record.checkpoints]
          .sort((a, b) => b.at - a.at)
          .map(checkpointInfo)
      : []
    const cwd = record?.cwd ?? this.liveCwd.get(liveId) ?? ''
    const reason = this.unavailable ?? (cwd ? this.errors.get(pathKey(cwd)) : undefined)
    return {
      ok: true,
      checkpoints,
      ...(checkpoints.length === 0 && reason ? { message: reason } : {})
    }
  }

  private find(liveId: string, id: string): { record: StoredSession; entry: StoredCheckpoint } | null {
    const record = this.recordFor(liveId)
    if (!record) return null
    const entry = record.checkpoints.find((c) => c.id === id)
    return entry ? { record, entry } : null
  }

  /** 预览恢复会改动哪些文件。方向：相对**目标快照**。 */
  async preview(liveId: string, id: string): Promise<SessionCheckpointPreview> {
    await this.load()
    const found = this.find(liveId, id)
    if (!found) {
      return {
        ok: false,
        files: [],
        total: 0,
        truncated: false,
        message: t('checkpoint.error.notFound')
      }
    }
    try {
      const repo = await this.repoFor(found.record.cwd)
      if (repo.disabled) {
        return {
          ok: false,
          files: [],
          total: 0,
          truncated: false,
          message: repo.disabled
        }
      }
      const st = await stat(repo.cwd).catch(() => null)
      if (!st?.isDirectory()) {
        return {
          ok: false,
          files: [],
          total: 0,
          truncated: false,
          message: t('checkpoint.error.cwd')
        }
      }
      return await this.runExclusive(repo, async () => {
        await this.addAll(repo)
        const files = await this.diff(repo, found.entry.tree)
        return {
          ok: true,
          files: files.slice(0, PREVIEW_LIMIT),
          total: files.length,
          truncated: files.length > PREVIEW_LIMIT
        }
      })
    } catch (err) {
      return {
        ok: false,
        files: [],
        total: 0,
        truncated: false,
        message: t('checkpoint.error.preview', {
          detail: err instanceof Error ? err.message : String(err)
        })
      }
    }
  }

  /** 工作区相对目标 tree 的差异：A = 快照后新增（恢复时删除），D = 快照后删除（恢复时找回）。 */
  private async diff(repo: Repo, tree: string): Promise<CheckpointFileChange[]> {
    const r = await runGitShadow(
      repo.gitDir,
      repo.cwd,
      ['diff', '--name-status', '--no-renames', '-z', tree],
      { timeoutMs: GIT_TIMEOUT_MS }
    )
    if (r.code !== 0) {
      throw new Error(t('checkpoint.error.diff', { detail: r.stderr.trim().slice(-300) }))
    }
    const parts = r.stdout.split('\0')
    const out: CheckpointFileChange[] = []
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i]
      const path = parts[i + 1]
      if (!status || !path) continue
      const code = status[0]
      if (code === 'A') out.push({ path, status: 'added' })
      else if (code === 'D') out.push({ path, status: 'deleted' })
      else if (code === 'M' || code === 'T' || code === 'R' || code === 'C') {
        out.push({ path, status: 'modified' })
      }
    }
    // 防御：git 输出理论上只会是工作区内的相对路径，仍然挡一次路径穿越
    for (const f of out) {
      if (!isSameOrInside(resolve(repo.cwd, f.path), repo.cwd)) {
        throw new Error(t('checkpoint.error.outside'))
      }
      if (f.path.split(/[\\/]/).includes('..')) {
        throw new Error(t('checkpoint.error.outside'))
      }
    }
    return out
  }

  /**
   * 恢复到指定检查点。先把当前状态拍成 `restore-backup`，恢复错了还能再回来。
   *
   * 调用方（SessionManager）负责确认会话不在运行。这里只做文件操作。
   */
  async restore(liveId: string, id: string): Promise<SessionCheckpointRestore> {
    await this.load()
    const found = this.find(liveId, id)
    if (!found) {
      return { ok: false, restored: 0, deleted: 0, message: t('checkpoint.error.notFound') }
    }
    const { record, entry } = found
    let repo: Repo | null = null
    try {
      repo = await this.repoFor(record.cwd)
      if (repo.disabled) {
        return { ok: false, restored: 0, deleted: 0, message: repo.disabled }
      }
      const st = await stat(repo.cwd).catch(() => null)
      if (!st?.isDirectory()) {
        return { ok: false, restored: 0, deleted: 0, message: t('checkpoint.error.cwd') }
      }
      return await this.runExclusive(repo, async () => {
        await this.addAll(repo!)
        // 先备份“现在”，这是恢复的后悔药
        const backupTree = await this.treeOf(repo!)
        const backupId = randomUUID()
        await this.createRef(repo!, backupTree, backupId)
        const backup: StoredCheckpoint = {
          id: backupId,
          tree: backupTree,
          turn: nextTurn(record),
          at: Date.now(),
          prompt: '',
          kind: 'restore-backup'
        }
        record.checkpoints.push(backup)
        /*
         * 先把备份落盘再改文件：哪怕恢复中途失败 / 应用被杀，用户仍然
         * 能在列表里看到「恢复前备份」并恢复回来。
         */
        await this.prune(repo!, record)
        await this.persist()

        const changes = await this.diff(repo!, entry.tree)
        const restorePaths = changes.filter((c) => c.status !== 'added').map((c) => c.path)
        const deletePaths = changes.filter((c) => c.status === 'added').map((c) => c.path)

        for (const rel of deletePaths) {
          const full = resolve(repo!.cwd, rel)
          if (!isSameOrInside(full, repo!.cwd)) continue
          try {
            await unlink(full)
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code
            // 已经不在 / 是被占用的目录：跳过，别把整次恢复拖垮
            if (code !== 'ENOENT' && code !== 'EISDIR' && code !== 'EPERM') throw err
          }
          await this.removeEmptyParents(repo!.cwd, dirname(full))
        }

        for (let i = 0; i < restorePaths.length; i += CHECKOUT_BATCH) {
          const batch = restorePaths.slice(i, i + CHECKOUT_BATCH)
          const r = await runGitShadow(
            repo!.gitDir,
            repo!.cwd,
            ['checkout', entry.tree, '--', ...batch],
            { timeoutMs: GIT_TIMEOUT_MS }
          )
          if (r.code !== 0) {
            throw new Error(t('checkpoint.error.checkout', { detail: r.stderr.trim().slice(-300) }))
          }
        }

        // 索引同步到目标 tree：下一轮的 add -A 不会把恢复前的条目再算一遍
        const read = await runGitShadow(repo!.gitDir, repo!.cwd, ['read-tree', entry.tree], {
          timeoutMs: GIT_TIMEOUT_MS
        })
        if (read.code !== 0) {
          throw new Error(t('checkpoint.error.index', { detail: read.stderr.trim().slice(-300) }))
        }

        return {
          ok: true,
          restored: restorePaths.length,
          deleted: deletePaths.length,
          backupId
        }
      })
    } catch (err) {
      return {
        ok: false,
        restored: 0,
        deleted: 0,
        message: t('checkpoint.error.restore', {
          detail: err instanceof Error ? err.message : String(err)
        })
      }
    }
  }

  /** 删文件后逐级清理空目录；到工作区根就停，不碰非空目录。 */
  private async removeEmptyParents(root: string, start: string): Promise<void> {
    let dir = start
    const rootKey = pathKey(root)
    for (let depth = 0; depth < 40; depth++) {
      if (pathKey(dir) === rootKey || !isSameOrInside(dir, root)) return
      try {
        const entries = await readdir(dir)
        if (entries.length > 0) return
      } catch {
        return
      }
      try {
        await rmdir(dir)
      } catch {
        return
      }
      const parent = dirname(dir)
      if (parent === dir || parent.endsWith(`..${sep}`)) return
      dir = parent
    }
  }
}

function nextTurn(record: StoredSession): number {
  let max = 0
  for (const c of record.checkpoints) {
    if (c.kind === 'turn' && c.turn > max) max = c.turn
  }
  return max + 1
}

/** bind 合并后按时间重排轮次，避免两个 live 记录各自从 1 开始 */
function renumber(record: StoredSession): void {
  let n = 0
  for (const c of record.checkpoints) {
    if (c.kind === 'turn') {
      n += 1
      c.turn = n
    } else {
      c.turn = n + 1
    }
  }
}
