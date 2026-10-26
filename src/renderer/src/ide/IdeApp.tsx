import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent
} from 'react'
import type {
  IdeEntry,
  IdeFsChanged,
  IdeImage,
  IdeReplaceData,
  IdeSearchFile,
  IdeSearchMatch,
  IdeSearchOptions,
  IdeTextFile
} from '@shared/ide'
import type { VcsChange, VcsDiffData } from '@shared/vcs'
import type { ChatTargetInfo } from '@shared/ide-chat'
import type { FileMatch } from '@shared/workspace'
import { SYNC_BUBBLE_ROWS, type SyncSnapshot } from '@shared/sync'
import { baseName } from '@shared/path'
import { IconFolder, IconSearch } from '../components/Icons'
import { applyAppearance } from '../appearance'
import { applyLanguageSetting, type I18nApi } from '../i18n'
import { diffStat } from './diff'
import { highlight, toLines } from './highlight'
import { buildIdeRef, MAX_REF_LINES } from './ref'
import { SendToChat, type SendAnchor, type SendDraft } from './SendToChat'
import { MonacoEditor, type EditorSelection } from './MonacoEditor'
import { VcsWorkspace } from './VcsWorkspace'
import { SyncWorkspace } from './SyncWorkspace'
import { SyncBubble, type SyncBubbleData, type SyncBubbleRow } from './SyncBubble'
import { useSync } from './useSync'
import { useI18n } from '../i18n'
import { VcsDiffView } from './VcsDiffView'
import { useVcsStatus } from './useVcsStatus'
import '../styles/ide.css'
import '../styles/sync.css'

/**
 * 独立 IDE 窗口。
 *
 * 资源管理器 + 可编辑的文本查看器 + 图片/Diff 预览 + 代码搜索。
 * 版本控制（Git / SVN）在独立的「源代码管理」工作区里完成暂存、提交、
 * 还原和同步。
 */

type View = 'files' | 'search' | 'vcs' | 'sync'
type TabKind = 'file' | 'image' | 'diff'

/** 打开中的文件在磁盘上发生了外部变化 */
type ExternalChange = 'modified' | 'deleted'

/** 外部变化标记的键：Windows 上路径大小写不敏感 */
function extKey(rel: string): string {
  return window.api?.platform === 'win32' ? rel.toLowerCase() : rel
}

interface Tab {
  key: string
  kind: TabKind
  rel: string
  title: string
}

interface TreeTarget {
  rel: string
  kind: 'file' | 'dir'
}

interface CreateState {
  dirRel: string
  kind: 'file' | 'dir'
  value: string
}

interface TreeMenuState {
  x: number
  y: number
  target: TreeTarget
}

interface DialogAction {
  label: string
  kind?: 'primary' | 'danger' | 'plain'
  run: () => void | Promise<void>
}

interface DialogState {
  title: string
  message: string
  actions: DialogAction[]
}

interface PromptState {
  title: string
  message: string
  value: string
  confirmLabel: string
  run: (value: string) => void | Promise<void>
}

interface CursorPos {
  rel: string
  line: number
  col: number
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif'])

function posixPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

function dirOfRel(rel: string): string {
  const p = posixPath(rel)
  const i = p.lastIndexOf('/')
  return i > 0 ? p.slice(0, i) : ''
}

function joinRel(base: string, name: string): string {
  const b = posixPath(base)
  const n = name.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  return b ? `${b}/${n}` : n
}

function underPath(rel: string, prefix: string): boolean {
  return rel === prefix || rel.startsWith(`${prefix}/`)
}

/** 把旧路径（文件或整个目录）下的 tab / 缓存 key 换到新路径 */
function remapPath(rel: string, oldRel: string, newRel: string): string {
  if (rel === oldRel) return newRel
  return rel.startsWith(`${oldRel}/`) ? `${newRel}${rel.slice(oldRel.length)}` : rel
}

function isImageRel(rel: string): boolean {
  const ext = rel.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXT.has(ext)
}

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

function tabOf(kind: TabKind, rel: string): Tab {
  const name = baseName(rel)
  return {
    key: `${kind}:${rel}`,
    kind,
    rel,
    title: kind === 'diff' ? `${name} (diff)` : name
  }
}

/* ── 小图标 ───────────────────────────────────────────── */

function Ico({ d, size = 15 }: { d: string; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="ide-ico" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

const P = {
  files: 'M4 2h5l3 3v9H4zM9 2v3h3',
  file: 'M4 1.8h5l3 3v9.4H4zM9 1.8v3h3',
  search: 'M10.4 10.4L14 14',
  git: 'M4 4.9v6.2M12 6.5c0 2.8-2.6 3.1-4.5 3.6',
  refresh: 'M13 8a5 5 0 1 1-1.6-3.7M13 2.5V5h-2.5',
  diff: 'M4 3v10M4 13l-2-2M4 13l2-2M9 4h4M9 8h4M9 12h2',
  image: 'M3 4.5h10v7H3zM5.5 6.6h.01M4 10l3-2.6 2 1.8 1.8-1.6 1.4 1.3',
  close: 'M4 4l8 8M12 4l-8 8',
  chevron: 'M6 3.5L10.5 8 6 12.5',
  down: 'M3.5 6L8 10.5 12.5 6',
  plane: 'M2.4 8.1 13.4 3.4 10.7 13.3 8 9.1zM8 9.1l5.4-5.7',
  newFile: 'M4 1.8h5l3 3v9.4H4zM9 1.8v3h3M8 7.2v4.2M5.9 9.3h4.2',
  newFolder: 'M2 4.2h4.2l1.4 1.8H14v7.2H2zM10.2 7.8v4M8.2 9.8h4',
  rename: 'M3 12.5l6.6-6.6 2.5 2.5-6.6 6.6H3zM9.2 5.7l1.5-1.5 2.5 2.5-1.5 1.5',
  trash: 'M2.8 4.2h10.4M5.8 4.2V2.3h4.4v1.9M4.2 4.2l.6 9.2h6.4l.6-9.2M6.6 6.6v4.4M9.4 6.6v4.4',
  more: 'M3.4 8h.01M8 8h.01M12.6 8h.01',
  sync: 'M12.5 5A5.5 5.5 0 0 0 3 7M3 3.5V7h3.5M3.5 11A5.5 5.5 0 0 0 13 9M13 12.5V9h-3.5'
} as const

/* ── 窗口标题栏 ───────────────────────────────────────── */

function IdeTitleBar({ cwd, onClose }: { cwd: string; onClose: () => void }): JSX.Element {
  const { t } = useI18n()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.api?.isMaximized().then(setMaximized)
    return window.api?.onMaximizedChanged(setMaximized)
  }, [])

  return (
    <div className="ide-titlebar">
      <div className="ide-brand">
        <span className="ide-logo">C</span>
        <span>CCoder IDE</span>
        <span className="ide-divider" />
        <span className="ide-ws">{baseName(cwd)}</span>
        <span className="ide-detach">{t('ide.detach')}</span>
      </div>
      <div className="ide-wctl">
        <button className="ide-wc" title={t('titlebar.minimize')} onClick={() => window.api?.minimize()}>
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button
          className="ide-wc"
          title={maximized ? t('titlebar.restore') : t('titlebar.maximize')}
          onClick={() => window.api?.toggleMaximize()}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
              <rect x="0.5" y="2.5" width="7" height="7" />
              <path d="M2.5 2.5V0.5h7v7h-2" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
              <rect x="0.5" y="0.5" width="9" height="9" />
            </svg>
          )}
        </button>
        <button className="ide-wc ide-wc--close" title={t('titlebar.close')} onClick={onClose}>
          <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor">
            <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
          </svg>
        </button>
      </div>
    </div>
  )
}

/* ── 目录同步：气泡 / 时间 ────────────────────────────── */

function sameWorkspace(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  return window.api?.platform === 'win32'
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b)
}

function clockOf(ms: number): string {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}

function makeSyncBubble(snapshot: SyncSnapshot, t: I18nApi['t']): SyncBubbleData | null {
  const copies = snapshot.copied
  const deletes = snapshot.deleted
  const failed = snapshot.failed
  if (copies === 0 && deletes === 0 && failed === 0) return null

  const cost = snapshot.lastCostMs ?? 0
  const costText =
    cost >= 1000
      ? t('sync.time.sec', { n: (cost / 1000).toFixed(1) })
      : t('sync.time.ms', { n: Math.round(cost) })

  let title: string
  let failedText: string | null = null
  if (copies === 0 && deletes === 0) {
    title = `${t('sync.bubble.failed', { n: failed })} · ${costText}`
  } else {
    const head =
      copies > 0 && deletes > 0
        ? `${t('sync.bubble.copied', { n: copies })} · ${t('sync.bubble.deleted', { n: deletes })}`
        : copies > 0
          ? t('sync.bubble.copied', { n: copies })
          : t('sync.bubble.deleted', { n: deletes })
    title = `${head} · ${costText}`
    if (failed > 0) failedText = t('sync.bubble.failed', { n: failed })
  }

  const rows: SyncBubbleRow[] = []
  for (const rel of snapshot.copiedNames.slice(0, SYNC_BUBBLE_ROWS)) rows.push({ text: rel })
  for (const rel of snapshot.deletedNames.slice(0, SYNC_BUBBLE_ROWS - rows.length)) {
    rows.push({ text: rel, deleted: true })
  }
  const hidden = copies + deletes - rows.length
  return {
    title,
    failed: failedText,
    rows,
    more: hidden > 0 ? t('sync.bubble.more', { n: hidden }) : null
  }
}

/* ── 主组件 ───────────────────────────────────────────── */

export function IdeApp({ cwd }: { cwd: string }): JSX.Element {
  const { t } = useI18n()
  const [view, setView] = useState<View>('files')
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [fileCache, setFileCache] = useState<Record<string, IdeTextFile>>({})
  const [imageCache, setImageCache] = useState<Record<string, IdeImage>>({})
  const [diffCache, setDiffCache] = useState<Record<string, VcsDiffData>>({})
  /** 每个已打开文件在磁盘上的文本，用来判断脏状态 */
  const [baseText, setBaseText] = useState<Record<string, string>>({})
  const [loadingKey, setLoadingKey] = useState<string | null>(null)
  const [savingRel, setSavingRel] = useState<string | null>(null)
  const [treeVersion, setTreeVersion] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [quickOpen, setQuickOpen] = useState(false)
  const [jump, setJump] = useState<{ rel: string; line: number } | null>(null)
  /** 资源管理器当前选中的文件 / 文件夹 */
  const [treeTarget, setTreeTarget] = useState<TreeTarget>({ rel: '', kind: 'dir' })
  /** 正在{t('ide.newFile')} / 文件夹时顶部的输入条 */
  const [creating, setCreating] = useState<CreateState | null>(null)
  const [menu, setMenu] = useState<TreeMenuState | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [cursor, setCursor] = useState<CursorPos | null>(null)
  const restored = useRef(false)
  /** 发送确认层；null = 没开 */
  const [sendDraft, setSendDraft] = useState<SendDraft | null>(null)
  /** 发送成功后的轻提示，2 秒自己消失 */
  const [flash, setFlash] = useState<string | null>(null)
  const flashTimer = useRef<number | null>(null)
  /** 磁盘上的外部变化；键是 extKey(rel) */
  const [external, setExternal] = useState<Record<string, ExternalChange>>({})
  /**
   * 异步回调里要读最新的标签 / 缓存，但不能让订阅 effect 依赖这些 state
   * （否则每敲一个字都会重订阅）。每帧把最新值放进 ref。
   */
  const liveRef = useRef({ tabs, fileCache, baseText })
  liveRef.current = { tabs, fileCache, baseText }
  /** 正在保存的 rel；watcher 事件不能把“自己刚写盘”误判成外部修改 */
  const savingRelsRef = useRef(new Map<string, number>())
  /** 每个 rel 的读取序号，后到的旧结果不能覆盖新结果 */
  const relSeqRef = useRef(new Map<string, number>())
  const vcsRefreshTimer = useRef<number | null>(null)

  const api = window.api
  const vcs = useVcsStatus(cwd)
  const sync = useSync(cwd)
  const [syncLogOpen, setSyncLogOpen] = useState(false)
  const [syncBubble, setSyncBubble] = useState<SyncBubbleData | null>(null)
  const syncBubbleTimer = useRef<number | null>(null)
  const syncAnnounced = useRef<number | null>(null)
  const syncReady = useRef(false)
  const activeTab = tabs.find((t) => t.key === activeKey) ?? null

  const isDirty = useCallback(
    (rel: string): boolean => {
      const f = fileCache[rel]
      return !!f && baseText[rel] !== undefined && f.text !== baseText[rel]
    },
    [fileCache, baseText]
  )
  const dirtyRels = useMemo(
    () => Object.keys(fileCache).filter((rel) => isDirty(rel)),
    [fileCache, isDirty]
  )
  const dirtyCount = dirtyRels.length

  const clearExternal = useCallback((rel: string): void => {
    const key = extKey(rel)
    setExternal((m) => {
      if (!(key in m)) return m
      const next = { ...m }
      delete next[key]
      return next
    })
  }, [])

  const markExternal = useCallback((rel: string, change: ExternalChange): void => {
    const key = extKey(rel)
    setExternal((m) => (m[key] === change ? m : { ...m, [key]: change }))
  }, [])

  /**
   * 重新读取一个打开的文件。
   *
   * 干净的缓冲区直接换掉；脏缓冲区只在磁盘内容恰好等于草稿时采纳元数据，
   * 否则只打标记，绝不覆盖用户正在编辑的内容。
   */
  const revalidateFile = useCallback(
    async (rel: string): Promise<void> => {
      if (!api?.ide) return
      const seq = (relSeqRef.current.get(rel) ?? 0) + 1
      relSeqRef.current.set(rel, seq)

      let disk: IdeTextFile
      try {
        const r = await api.ide.readFile(cwd, rel)
        if (relSeqRef.current.get(rel) !== seq) return
        // 删除 / 变成非文件用结构化 code 判断，绝不匹配错误文案
        if (!r.ok) {
          if (r.code === 'missing' || r.code === 'not-file') {
            markExternal(rel, 'deleted')
          }
          return
        }
        disk = r.data
      } catch {
        // IPC 层意外失败（窗口销毁等）：等下一次事件或窗口聚焦再试
        return
      }
      if (relSeqRef.current.get(rel) !== seq) return

      const { fileCache: cache, baseText: bases } = liveRef.current
      const current = cache[rel]
      if (!current) return
      const base = bases[rel]
      // await 期间用户可能已经开始输入，必须重新判断脏状态
      const dirtyNow = base !== undefined && current.text !== base

      if (!dirtyNow) {
        setFileCache((m) => (m[rel] ? { ...m, [rel]: disk } : m))
        setBaseText((m) => ({ ...m, [rel]: disk.text }))
        clearExternal(rel)
        return
      }

      if (disk.text === current.text) {
        // 外部写入和草稿恰好一致：采纳磁盘元数据，缓冲区变成干净
        setFileCache((m) => (m[rel] ? { ...m, [rel]: disk } : m))
        setBaseText((m) => ({ ...m, [rel]: disk.text }))
        clearExternal(rel)
        return
      }

      // 不覆盖草稿，也不更新 mtime —— 保存时仍会走现有的冲突对话框
      markExternal(rel, 'modified')
    },
    [api, clearExternal, cwd, markExternal]
  )

  const revalidateImage = useCallback(
    async (rel: string): Promise<void> => {
      if (!api?.ide) return
      try {
        const r = await api.ide.readImage(cwd, rel)
        if (!r.ok) {
          if (r.code === 'missing' || r.code === 'not-file') {
            markExternal(rel, 'deleted')
          }
          return
        }
        setImageCache((m) => (rel in m ? { ...m, [rel]: r.data } : m))
        clearExternal(rel)
      } catch {
        // IPC 层意外失败：等下一次事件再试
      }
    },
    [api, clearExternal, cwd, markExternal]
  )

  const revalidateDiff = useCallback(
    async (rel: string): Promise<void> => {
      if (!api?.vcs) return
      try {
        const r = await api.vcs.diff({ cwd, rel, source: 'head' })
        if (!r.ok) return
        setDiffCache((m) => (rel in m ? { ...m, [rel]: r.data } : m))
      } catch {
        // 只读预览，读不到就保持原样
      }
    },
    [api, cwd]
  )

  const applyFsBatch = useCallback(
    (batch: IdeFsChanged): void => {
      if (!batch || !Array.isArray(batch.rels)) return
      setTreeVersion((v) => v + 1)
      // git status 比列目录贵；连续写入时合并成一次
      if (vcsRefreshTimer.current) window.clearTimeout(vcsRefreshTimer.current)
      vcsRefreshTimer.current = window.setTimeout(() => {
        vcsRefreshTimer.current = null
        void vcs.refresh()
      }, 600)

      const all = batch.generic || batch.truncated
      const changed = batch.rels.map(extKey)
      const touches = (rel: string): boolean => {
        if (all) return true
        const key = extKey(rel)
        return changed.some((c) => key === c || key.startsWith(`${c}/`))
      }

      const seen = new Set<string>()
      for (const tab of liveRef.current.tabs) {
        if (!touches(tab.rel)) continue
        if (tab.kind === 'file') {
          if (seen.has(tab.rel)) continue
          seen.add(tab.rel)
          if ((savingRelsRef.current.get(extKey(tab.rel)) ?? 0) > 0) continue
          void revalidateFile(tab.rel)
        } else if (tab.kind === 'image') {
          void revalidateImage(tab.rel)
        } else {
          void revalidateDiff(tab.rel)
        }
      }
    },
    [revalidateDiff, revalidateFile, revalidateImage, vcs.refresh]
  )

  useEffect(() => {
    return window.api?.ide?.onFsChanged(applyFsBatch)
  }, [applyFsBatch])

  // 外部 git 只改 .git（add / commit / 切分支元数据）时不会有文件事件
  useEffect(() => {
    let last = 0
    const onFocus = (): void => {
      const now = Date.now()
      if (now - last < 2000) return
      last = now
      setTreeVersion((v) => v + 1)
      void vcs.refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [vcs.refresh])

  useEffect(() => {
    return () => {
      if (vcsRefreshTimer.current) window.clearTimeout(vcsRefreshTimer.current)
    }
  }, [])

  /** 绿色轻提示。和错误用的 notice 分开：错误要留到用户点掉，成功只闪 2 秒 */
  const showFlash = useCallback((message: string): void => {
    setFlash(message)
    if (flashTimer.current) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlash(null), 2000)
  }, [])

  useEffect(() => {
    return () => {
      if (flashTimer.current) window.clearTimeout(flashTimer.current)
    }
  }, [])

  /**
   * 工作区替换完成后刷新 IDE 状态。
   *
   * 主进程只跳过脏文件，所以被改动的都是磁盘上的干净文件 —— 把它们的
   * 缓存丢掉，ensureTab 会在激活时重新读取；脏草稿原样保留，绝不能被
   * 磁盘内容覆盖。
   */
  const onWorkspaceReplaced = useCallback(
    (r: IdeReplaceData): void => {
      if (r.totals.filesChanged === 0) return
      const keep = new Set(dirtyRels)
      const onlyDirty = <T,>(rec: Record<string, T>): Record<string, T> =>
        Object.fromEntries(Object.entries(rec).filter(([rel]) => keep.has(rel)))
      setFileCache(onlyDirty)
      setBaseText(onlyDirty)
      setImageCache({})
      setDiffCache({})
      const keepExternal = new Set(dirtyRels.map(extKey))
      setExternal((m) =>
        Object.fromEntries(Object.entries(m).filter(([key]) => keepExternal.has(key)))
      )
      setTreeVersion((v) => v + 1)
      void vcs.refresh()
      showFlash(
        t('ide.replaceDone', {
          replacements: r.totals.replacements,
          files: r.totals.filesChanged
        })
      )
    },
    [dirtyRels, showFlash, vcs]
  )

  // 任务栏/窗口标题跟着工作区走，而不是页面默认的 CCoder
  useEffect(() => {
    document.title = `CCoder IDE — ${baseName(cwd)}`
  }, [cwd])

  // 主窗口改语言/主题/字号/缩放时，已经开着的 IDE 窗口也跟着变
  useEffect(() => {
    const off = window.api?.settings.onChanged((s) => {
      applyLanguageSetting(s.language)
      applyAppearance(s)
    })
    return () => off?.()
  }, [])

  /* ── 目录同步：通知点击 / 气泡 ─────────────────────────── */
  useEffect(() => {
    return api?.sync?.onFocus((payload) => {
      if (!sameWorkspace(payload.cwd, cwd)) return
      setView('sync')
      setSyncLogOpen(payload.openLog)
    })
  }, [api, cwd])

  useEffect(() => {
    if (view !== 'sync') setSyncLogOpen(false)
  }, [view])

  const syncSnap = sync.state?.snapshot
  useEffect(() => {
    if (!syncSnap) return
    // 首次挂载时已有的那一轮不冒泡（用户刚打开窗口，不该被历史通知打扰）
    if (!syncReady.current) {
      syncReady.current = true
      syncAnnounced.current = syncSnap.lastRoundAtMs
      return
    }
    const at = syncSnap.lastRoundAtMs
    if (!at || at === syncAnnounced.current) return
    syncAnnounced.current = at
    if (view === 'sync') return
    const data = makeSyncBubble(syncSnap, t)
    if (!data) return
    setSyncBubble(data)
    if (syncBubbleTimer.current) window.clearTimeout(syncBubbleTimer.current)
    syncBubbleTimer.current = window.setTimeout(() => {
      syncBubbleTimer.current = null
      setSyncBubble(null)
    }, 3000)
  }, [syncSnap, t, view])

  useEffect(() => {
    return () => {
      if (syncBubbleTimer.current) window.clearTimeout(syncBubbleTimer.current)
    }
  }, [])

  // 进入同步工作区时收掉气泡：那边有完整的状态与日志，再叠一层是噪音。
  useEffect(() => {
    if (view !== 'sync' || !syncBubble) return
    setSyncBubble(null)
    if (syncBubbleTimer.current) {
      window.clearTimeout(syncBubbleTimer.current)
      syncBubbleTimer.current = null
    }
  }, [view, syncBubble])

  /** VCS 变更映射，文件树靠它显示 M/A/D */
  const gitMap = useMemo(() => {
    const m: Record<string, VcsChange> = {}
    for (const f of vcs.status?.files ?? []) m[f.rel] = f.status
    return m
  }, [vcs.status])

  /* 恢复上次打开的标签；只在这个窗口自己的 localStorage 里 */
  useEffect(() => {
    const key = `ccoder:ide:${cwd}`
    try {
      const raw = localStorage.getItem(key)
      if (raw) {
        const saved = JSON.parse(raw) as { tabs?: Tab[]; active?: string | null }
        if (Array.isArray(saved.tabs)) {
          const valid = saved.tabs.filter(
            (t) => t && typeof t.key === 'string' && typeof t.rel === 'string'
          )
          setTabs(valid)
          setActiveKey(valid.some((t) => t.key === saved.active) ? saved.active ?? null : valid[0]?.key ?? null)
        }
      }
    } catch {
      // 坏数据直接忽略
    }
    restored.current = true
  }, [cwd])

  useEffect(() => {
    if (!restored.current) return
    try {
      localStorage.setItem(`ccoder:ide:${cwd}`, JSON.stringify({ tabs, active: activeKey }))
    } catch {
      // localStorage 满了不影响使用
    }
  }, [cwd, tabs, activeKey])

  const ensureTab = useCallback(
    async (tab: Tab) => {
      if (!api?.ide || !api?.vcs) return
      if (tab.kind === 'file' && fileCache[tab.rel]) return
      if (tab.kind === 'image' && imageCache[tab.rel]) return
      if (tab.kind === 'diff' && diffCache[tab.rel]) return

      setLoadingKey(tab.key)
      try {
        if (tab.kind === 'file') {
          const r = await api.ide.readFile(cwd, tab.rel)
          if (!r.ok) throw new Error(r.message)
          setFileCache((m) => ({ ...m, [tab.rel]: r.data }))
          setBaseText((m) => (tab.rel in m ? m : { ...m, [tab.rel]: r.data.text }))
        } else if (tab.kind === 'image') {
          const r = await api.ide.readImage(cwd, tab.rel)
          if (!r.ok) throw new Error(r.message)
          setImageCache((m) => ({ ...m, [tab.rel]: r.data }))
        } else {
          const r = await api.vcs.diff({ cwd, rel: tab.rel, source: 'head' })
          if (!r.ok) throw new Error(r.error.message)
          setDiffCache((m) => ({ ...m, [tab.rel]: r.data }))
        }
      } catch (err) {
        setNotice(
          t('ide.openFailed', {
            error: err instanceof Error ? err.message : String(err)
          })
        )
        setTabs((list) => list.filter((t) => t.key !== tab.key))
        setActiveKey((cur) => (cur === tab.key ? null : cur))
      } finally {
        setLoadingKey((k) => (k === tab.key ? null : k))
      }
    },
    [api, cwd, fileCache, imageCache, diffCache]
  )

  useEffect(() => {
    if (activeTab) void ensureTab(activeTab)
  }, [activeTab, ensureTab])

  const openTab = useCallback((tab: Tab, line?: number) => {
    setTabs((list) => (list.some((t) => t.key === tab.key) ? list : [...list, tab]))
    setActiveKey(tab.key)
    if (tab.kind === 'file' && line) setJump({ rel: tab.rel, line })
  }, [])

  const openFile = useCallback(
    (rel: string, line?: number) => {
      setView('files')
      openTab(tabOf(isImageRel(rel) ? 'image' : 'file', rel), line)
    },
    [openTab]
  )

  const openDiff = useCallback(
    (rel: string) => {
      openTab(tabOf('diff', rel))
    },
    [openTab]
  )

  /*
   * 从聊天窗口的工具卡点过来：主进程把目标放在首屏 query 里
   * （`?file=src/app.ts&line=42`）。只在首次加载时读一次。
   */
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const file = params.get('file')
    if (!file) return
    const n = Number(params.get('line'))
    openFile(file, Number.isFinite(n) && n > 0 ? n : undefined)
  }, [openFile])

  // 窗口已经开着时走 IPC：在现有标签里直接定位，不再开第二个窗口
  useEffect(() => {
    return window.api?.ide?.onReveal((t) => openFile(t.rel, t.line))
  }, [openFile])

  const closeTab = useCallback(
    (key: string) => {
      const closing = tabs.find((t) => t.key === key)
      if (closing) clearExternal(closing.rel)
      setTabs((list) => {
        const i = list.findIndex((t) => t.key === key)
        const next = list.filter((t) => t.key !== key)
        setActiveKey((cur) => {
          if (cur !== key) return cur
          const fallback = next[i] ?? next[i - 1] ?? null
          return fallback?.key ?? null
        })
        return next
      })
    },
    [clearExternal, tabs]
  )

  /* ── 保存 / 脏状态 ───────────────────────────────────── */

  const refresh = useCallback((): void => {
    setTreeVersion((v) => v + 1)
    void vcs.refresh()
  }, [vcs])

  const saveDoc = useCallback(
    async (rel: string, force = false): Promise<boolean> => {
      const file = fileCache[rel]
      if (!api?.ide || !file) return false
      if (file.binary) {
        setNotice(t('ide.binaryCannotSave'))
        return false
      }
      if (file.truncated) {
        setNotice(t('ide.tooLargeCannotSave'))
        return false
      }
      // 磁盘上已删除的干净缓冲区也要走 saveFile，才能弹出现有的“重新创建”
      if (!isDirty(rel) && !force && external[extKey(rel)] !== 'deleted') return true

      const savingKey = extKey(rel)
      setSavingRel(rel)
      savingRelsRef.current.set(savingKey, (savingRelsRef.current.get(savingKey) ?? 0) + 1)
      try {
        const r = await api.ide.saveFile({
          cwd,
          rel,
          text: file.text,
          expectedMtimeMs: file.mtimeMs,
          eol: file.eol,
          force
        })
        if (!r.ok) {
          if (r.code === 'conflict' && !force) {
            setDialog({
              title: t('ide.externalModifiedTitle'),
              message: t('ide.externalModifiedMessage', { rel }),
              actions: [
                { label: t('common.cancel'), run: () => undefined },
                {
                  label: t('ide.overwrite'),
                  kind: 'danger',
                  run: async () => {
                    await saveDoc(rel, true)
                  }
                }
              ]
            })
          } else if (r.code === 'missing' && !force) {
            setDialog({
              title: t('ide.deletedTitle'),
              message: t('ide.deletedMessage', { rel }),
              actions: [
                { label: t('common.cancel'), run: () => undefined },
                {
                  label: t('ide.recreate'),
                  kind: 'primary',
                  run: async () => {
                    await saveDoc(rel, true)
                  }
                }
              ]
            })
          } else {
            setNotice(t('ide.saveFailed', { error: r.message }))
          }
          return false
        }
        setFileCache((m) => ({ ...m, [rel]: r.data }))
        setBaseText((m) => ({ ...m, [rel]: r.data.text }))
        clearExternal(rel)
        showFlash(t('ide.saved', { name: baseName(rel) }))
        void vcs.refresh()
        return true
      } catch (err) {
        setNotice(
          t('ide.saveFailed', {
            error: err instanceof Error ? err.message : String(err)
          })
        )
        return false
      } finally {
        const left = (savingRelsRef.current.get(savingKey) ?? 1) - 1
        if (left > 0) savingRelsRef.current.set(savingKey, left)
        else savingRelsRef.current.delete(savingKey)
        setSavingRel((cur) => (cur === rel ? null : cur))
      }
    },
    [api, clearExternal, cwd, external, fileCache, isDirty, showFlash, vcs]
  )

  const saveAll = useCallback(async (): Promise<boolean> => {
    // 逐个保存：遇到外部改动时只弹一次确认，不把后面的文件也一起覆盖
    for (const rel of dirtyRels) {
      if (!(await saveDoc(rel))) return false
    }
    return true
  }, [dirtyRels, saveDoc])

  /* ── 新建 / 重命名 / 删除 ───────────────────────────── */

  const startCreate = useCallback(
    (kind: 'file' | 'dir', target?: TreeTarget) => {
      const t = target ?? treeTarget
      const dirRel = t.kind === 'dir' ? t.rel : dirOfRel(t.rel)
      setMenu(null)
      setView('files')
      setCreating({ dirRel, kind, value: '' })
    },
    [treeTarget]
  )

  const submitCreate = useCallback(async (): Promise<void> => {
    const c = creating
    if (!c) return
    const name = c.value.trim()
    if (!name) return
    const rel = joinRel(c.dirRel, name)
    if (!api?.ide) return
    const r = await api.ide.createEntry({ cwd, rel, kind: c.kind })
    if (!r.ok) {
      setNotice(t('ide.createFailed', { error: r.message }))
      return
    }
    setCreating(null)
    setTreeTarget({ rel: r.data.entry.rel, kind: r.data.entry.kind })
    refresh()
    if (r.data.entry.kind === 'file') openFile(r.data.entry.rel)
    showFlash(c.kind === 'dir' ? t('ide.folderCreated') : t('ide.fileCreated'))
  }, [api, cwd, creating, openFile, refresh, showFlash])

  const applyRename = useCallback(
    (oldRel: string, newRel: string): void => {
      setTabs((list) =>
        list.map((t) => {
          const rel = remapPath(t.rel, oldRel, newRel)
          if (rel === t.rel) return t
          return {
            ...t,
            rel,
            key: `${t.kind}:${rel}`,
            title: t.kind === 'diff' ? `${baseName(rel)} (diff)` : baseName(rel)
          }
        })
      )
      const active = tabs.find((t) => t.key === activeKey)
      if (active) setActiveKey(`${active.kind}:${remapPath(active.rel, oldRel, newRel)}`)

      const remapRecord = <T,>(rec: Record<string, T>): Record<string, T> => {
        const next: Record<string, T> = {}
        for (const [key, value] of Object.entries(rec)) {
          next[remapPath(key, oldRel, newRel)] = value
        }
        return next
      }
      setFileCache((m) => {
        const next = remapRecord(m)
        for (const [key, value] of Object.entries(next)) {
          if (value.rel !== key) next[key] = { ...value, rel: key }
        }
        return next
      })
      setBaseText(remapRecord)
      setImageCache((m) => {
        const next = remapRecord(m)
        for (const [key, value] of Object.entries(next)) {
          if (value.rel !== key) next[key] = { ...value, rel: key }
        }
        return next
      })
      // diff 是按旧路径取的，重命名后直接丢掉，下次打开时重新拉
      setDiffCache((m) =>
        Object.fromEntries(Object.entries(m).filter(([key]) => !underPath(key, oldRel)))
      )
      setCursor((c) =>
        c && underPath(c.rel, oldRel) ? { ...c, rel: remapPath(c.rel, oldRel, newRel) } : c
      )
      setJump((j) =>
        j && underPath(j.rel, oldRel) ? { ...j, rel: remapPath(j.rel, oldRel, newRel) } : j
      )
      setTreeTarget((t) =>
        underPath(t.rel, oldRel)
          ? { ...t, rel: remapPath(t.rel, oldRel, newRel) }
          : t
      )
    },
    [activeKey, tabs]
  )

  const renameTarget = useCallback(
    async (target: TreeTarget, value: string): Promise<void> => {
      const to = value.trim().replace(/\\/g, '/')
      if (!to || to === target.rel) return
      if (!api?.ide) return
      const r = await api.ide.renameEntry({ cwd, rel: target.rel, to })
      if (!r.ok) {
        setNotice(t('ide.renameFailed', { error: r.message }))
        return
      }
      applyRename(target.rel, r.data.entry.rel)
      setTreeTarget({ rel: r.data.entry.rel, kind: r.data.entry.kind })
      refresh()
      showFlash(t('ide.renamed'))
    },
    [api, applyRename, cwd, refresh, showFlash]
  )

  const dropTabsUnder = useCallback(
    (prefix: string): void => {
      const active = tabs.find((t) => t.key === activeKey)
      setTabs((list) => {
        const index = list.findIndex((t) => t.key === activeKey)
        const next = list.filter((t) => !underPath(t.rel, prefix))
        if (active && underPath(active.rel, prefix)) {
          const fallback = next[Math.min(index, next.length - 1)] ?? null
          setActiveKey(fallback?.key ?? null)
        }
        return next
      })
      const drop = <T,>(rec: Record<string, T>): Record<string, T> =>
        Object.fromEntries(Object.entries(rec).filter(([key]) => !underPath(key, prefix)))
      setFileCache(drop)
      setBaseText(drop)
      setImageCache(drop)
      setDiffCache(drop)
      const prefixKey = extKey(prefix)
      setExternal((m) => {
        const next: Record<string, ExternalChange> = {}
        let changed = false
        for (const [key, value] of Object.entries(m)) {
          if (key === prefixKey || key.startsWith(`${prefixKey}/`)) {
            changed = true
            continue
          }
          next[key] = value
        }
        return changed ? next : m
      })
      setCursor((c) => (c && underPath(c.rel, prefix) ? null : c))
      setJump((j) => (j && underPath(j.rel, prefix) ? null : j))
      setTreeTarget((t) => (underPath(t.rel, prefix) ? { rel: '', kind: 'dir' } : t))
    },
    [activeKey, tabs]
  )

  const requestDelete = useCallback(
    (target: TreeTarget) => {
      setMenu(null)
      const affected = tabs.filter(
        (t) => t.kind === 'file' && underPath(t.rel, target.rel)
      )
      const dirty = affected.filter((t) => t.kind === 'file' && isDirty(t.rel))
      const what =
        target.kind === 'dir' ? t('ide.deleteDirWhat') : t('ide.deleteFileWhat')
      setDialog({
        title:
          target.kind === 'dir' ? t('ide.deleteDirTitle') : t('ide.deleteFileTitle'),
        message:
          t('ide.deleteMessage', { what, rel: target.rel }) +
          (dirty.length ? t('ide.deleteDirtySuffix', { n: dirty.length }) : ''),
        actions: [
          { label: t('common.cancel'), run: () => undefined },
          {
            label: t('ide.delete'),
            kind: 'danger',
            run: async () => {
              if (!api?.ide) return
              const r = await api.ide.deleteEntry({ cwd, rel: target.rel })
              if (!r.ok) {
                setNotice(t('ide.deleteFailed', { error: r.message }))
                return
              }
              dropTabsUnder(target.rel)
              refresh()
              showFlash(t('ide.deleted'))
            }
          }
        ]
      })
    },
    [api, cwd, dropTabsUnder, isDirty, refresh, showFlash, tabs]
  )

  const requestCloseTab = useCallback(
    (key: string) => {
      const tab = tabs.find((t) => t.key === key)
      if (!tab || tab.kind !== 'file' || !isDirty(tab.rel)) {
        closeTab(key)
        return
      }
      setDialog({
        title: t('ide.unsavedTitle'),
        message: t('ide.unsavedFileMessage', { rel: tab.rel }),
        actions: [
          { label: t('common.cancel'), run: () => undefined },
          { label: t('ide.dontSave'), kind: 'danger', run: () => closeTab(key) },
          {
            label: t('ide.saveAndClose'),
            kind: 'primary',
            run: async () => {
              if (await saveDoc(tab.rel)) closeTab(key)
            }
          }
        ]
      })
    },
    [tabs, isDirty, closeTab, saveDoc]
  )

  const requestWindowClose = useCallback(() => {
    if (dirtyCount === 0) {
      api?.ide?.confirmClose()
      return
    }
    setDialog({
      title: t('ide.unsavedTitle'),
      message: t('ide.unsavedMultiMessage', { n: dirtyCount }),
      actions: [
        { label: t('common.cancel'), run: () => undefined },
        {
          label: t('ide.dontSaveAndClose'),
          kind: 'danger',
          run: () => api?.ide?.confirmClose()
        },
        {
          label: t('ide.saveAllAndClose'),
          kind: 'primary',
          run: async () => {
            if (await saveAll()) api?.ide?.confirmClose()
          }
        }
      ]
    })
  }, [api, dirtyCount, saveAll])

  useEffect(() => {
    api?.ide?.setDirty(dirtyCount > 0)
  }, [api, dirtyCount])

  useEffect(() => api?.ide?.onCloseRequest(requestWindowClose), [api, requestWindowClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      const target = e.target as HTMLElement | null
      const typing =
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'INPUT' ||
        target?.isContentEditable === true
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setQuickOpen(true)
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setView('search')
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (activeTab?.kind === 'file') void saveDoc(activeTab.rel)
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        if (activeKey) requestCloseTab(activeKey)
      } else if (!typing && e.key === 'F2' && treeTarget.rel) {
        e.preventDefault()
        const target = treeTarget
        setPrompt({
          title: t('ide.renameTitle'),
          message: t('ide.renameMessage'),
          value: target.rel,
          confirmLabel: t('ide.rename'),
          run: (value) => renameTarget(target, value)
        })
      } else if (!typing && e.key === 'Delete' && treeTarget.rel) {
        e.preventDefault()
        requestDelete(treeTarget)
      } else if (e.key === 'Escape') {
        setQuickOpen(false)
        setMenu(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeKey, activeTab, requestCloseTab, saveDoc, treeTarget, requestDelete, renameTarget])

  const activeFile = activeTab?.kind === 'file' ? fileCache[activeTab.rel] : undefined
  const activeImage = activeTab?.kind === 'image' ? imageCache[activeTab.rel] : undefined
  const activeDiff = activeTab?.kind === 'diff' ? diffCache[activeTab.rel] : undefined

  /* ── IDE → 聊天 ───────────────────────────────────────── */

  const sendDraftFromFile = (file: IdeTextFile, anchor: SendAnchor | null): void => {
    if (file.binary) {
      setNotice(t('ide.binarySendUnsupported'))
      return
    }
    setSendDraft({ refs: [buildIdeRef(file, cwd, 'file', file.text)], anchor })
  }

  const openSelectionDraft = (sel: EditorSelection): void => {
    if (!activeFile) return
    if (sel.endLine - sel.startLine + 1 > MAX_REF_LINES) {
      setSendDraft({
        refs: [],
        oversized: { file: activeFile, startLine: sel.startLine, endLine: sel.endLine },
        anchor: sel.rect
      })
      return
    }
    setSendDraft({
      refs: [buildIdeRef(activeFile, cwd, 'selection', sel.code, sel.startLine, sel.endLine)],
      anchor: sel.rect
    })
  }

  /** 右键菜单 / 编辑器动作发送文件：文件可能还没读进缓存 */
  const openFileForSend = async (
    rel: string,
    anchor: SendAnchor | null = null
  ): Promise<void> => {
    const cached = fileCache[rel]
    if (cached) {
      sendDraftFromFile(cached, anchor)
      return
    }
    if (!api?.ide) return
    try {
      const r = await api.ide.readFile(cwd, rel)
      if (!r.ok) {
        setNotice(r.message)
        return
      }
      setFileCache((m) => ({ ...m, [rel]: r.data }))
      setBaseText((m) => (rel in m ? m : { ...m, [rel]: r.data.text }))
      sendDraftFromFile(r.data, anchor)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSent = (target: ChatTargetInfo): void => {
    setSendDraft(null)
    showFlash(t('ide.attachedToChat', { title: target.title }))
  }

  const syncRun = syncSnap?.run
  const showSyncChip =
    !!syncSnap && (syncRun === 'running' || syncRun === 'failed' || syncRun === 'occupied')
  const syncChipText =
    syncRun === 'failed'
      ? t('sync.statusBar.failed')
      : syncRun === 'occupied'
        ? t('sync.statusBar.occupied')
        : t('sync.statusBar.running')
  const syncChipTip = (() => {
    if (!syncSnap) return ''
    if (syncRun === 'occupied') {
      return t('sync.statusBar.occupiedTip', { workspace: syncSnap.occupiedBy ?? '' })
    }
    if (!syncSnap.lastRoundAtMs) return t('sync.statusBar.notYetTip')
    return t('sync.statusBar.tip', {
      time: clockOf(syncSnap.lastRoundAtMs),
      copied: syncSnap.copied,
      deleted: syncSnap.deleted,
      failed: syncSnap.failed
    })
  })()

  const statusRight = (() => {
    if (!activeTab) return null
    if (activeTab.kind === 'file' && activeFile) {
      return (
        <>
          {isDirty(activeTab.rel) && <span className="ide-dirtyhint">{t('ide.unsavedDot')}</span>}
          {external[extKey(activeTab.rel)] && (
            <span className={`ide-exthint is-${external[extKey(activeTab.rel)]}`}>
              {external[extKey(activeTab.rel)] === 'deleted'
                ? t('ide.externalDeletedShort')
                : t('ide.externalModifiedShort')}
            </span>
          )}
          {savingRel === activeTab.rel && <span>{t('ide.saving')}</span>}
          {cursor?.rel === activeTab.rel && (
            <span>
              {t('ide.cursor', { line: cursor.line, col: cursor.col })}
            </span>
          )}
          <span>{activeFile.language}</span>
          <span>{t('ide.lines', { n: activeFile.text.split('\n').length })}</span>
          <span>{activeFile.eol === 'crlf' ? 'CRLF' : 'LF'}</span>
          <span>UTF-8</span>
        </>
      )
    }
    if (activeTab.kind === 'image' && activeImage) {
      return (
        <>
          <span>{activeImage.mime.replace('image/', '').toUpperCase()}</span>
          <span>{fmtSize(activeImage.size)}</span>
        </>
      )
    }
    if (activeTab.kind === 'diff') {
      return <span>Diff</span>
    }
    return null
  })()

  return (
    <div className="ide-app">
      <IdeTitleBar cwd={cwd} onClose={requestWindowClose} />

      <div className="ide-toolbar">
        <button className="ide-quickbtn" onClick={() => setQuickOpen(true)}>
          <IconSearch width={14} height={14} />
          <span>{t('ide.searchPlaceholder')}</span>
          <kbd>Ctrl P</kbd>
        </button>
        <div className="ide-toolbar-right">
          <span
            className={`ide-branch ${vcs.status?.repo ? '' : 'is-off'}`}
            title={vcs.status?.repo ? t('ide.branchTitle') : t('ide.noVcsTitle')}
          >
            <Ico d={P.git} />
            {vcs.status?.repo
              ? vcs.status.repo.kind === 'git'
                ? vcs.status.repo.branch || t('ide.noBranch')
                : vcs.status.repo.headShort
              : t('ide.noVcs')}
          </span>
          {vcs.status && (
            <span className="ide-changes" title={t('ide.changesTitle')}>
              {t('ide.changesCount', { n: vcs.status.counts.total })}
            </span>
          )}
          <button className="ide-iconbtn" title={t('ide.refresh')} onClick={refresh}>
            <Ico d={P.refresh} />
          </button>
          {dirtyCount > 0 ? (
            <button
              className="ide-savebtn"
              title={t('ide.saveTitle')}
              onClick={() => activeTab?.kind === 'file' && void saveDoc(activeTab.rel)}
            >
              {savingRel ? t('ide.saving') : t('ide.saveButton', { n: dirtyCount })}
            </button>
          ) : (
            <span
              className="ide-readonly"
              title={
                activeFile && (activeFile.binary || activeFile.truncated)
                  ? t('ide.readOnlyBannerBinary')
                  : t('ide.editableBanner')
              }
            >
              {activeFile && (activeFile.binary || activeFile.truncated)
                ? t('ide.readOnly')
                : t('ide.editable')}
            </span>
          )}
        </div>
      </div>

      <div className="ide-body">
        <nav className="ide-activity">
          <button className={`ide-act ${view === 'files' ? 'on' : ''}`} title={t('ide.explorer')} onClick={() => setView('files')}>
            <Ico d={P.files} size={17} />
          </button>
          <button className={`ide-act ${view === 'search' ? 'on' : ''}`} title={t('ide.searchCodeTitle')} onClick={() => setView('search')}>
            <Ico d={P.search} size={17} />
          </button>
          <button
            className={`ide-act ${view === 'vcs' ? 'on' : ''}`}
            title={t('ide.scmTitle')}
            onClick={() => setView('vcs')}
          >
            <Ico d={P.diff} size={17} />
            {vcs.status && vcs.status.counts.total > 0 && (
              <span className="ide-act-badge">{vcs.status.counts.total}</span>
            )}
          </button>
          <button
            className={`ide-act ${view === 'sync' ? 'on' : ''}`}
            title={t('ide.syncTitle')}
            onClick={() => setView('sync')}
          >
            <Ico d={P.sync} size={17} />
            {(syncSnap?.failed ?? 0) > 0 && (
              <span className="ide-act-badge is-bad">{syncSnap?.failed}</span>
            )}
          </button>
        </nav>

        {view === 'sync' ? (
          <SyncWorkspace
            cwd={cwd}
            sync={sync}
            logOpen={syncLogOpen}
            onOpenLog={() => setSyncLogOpen(true)}
            onCloseLog={() => setSyncLogOpen(false)}
            onNotice={setNotice}
          />
        ) : view === 'vcs' ? (
          <VcsWorkspace
            cwd={cwd}
            detect={vcs.detect}
            status={vcs.status}
            loading={vcs.loading}
            error={vcs.error}
            onRefresh={() => void vcs.refresh()}
            onMutated={(filesChanged) => {
              if (!filesChanged) return
              // 不冲掉有未保存修改的草稿；下次保存会按 mtime 发现磁盘已变
              const keep = new Set(dirtyRels)
              const onlyDirty = <T,>(rec: Record<string, T>): Record<string, T> =>
                Object.fromEntries(Object.entries(rec).filter(([rel]) => keep.has(rel)))
              setFileCache(onlyDirty)
              setBaseText(onlyDirty)
              setImageCache({})
              setDiffCache({})
              const keepExternal = new Set(dirtyRels.map(extKey))
              setExternal((m) =>
                Object.fromEntries(Object.entries(m).filter(([key]) => keepExternal.has(key)))
              )
              setTreeVersion((v) => v + 1)
            }}
            onNotice={showFlash}
            onOpenFile={(rel) => openFile(rel)}
          />
        ) : (
          <>
        <aside className={`ide-side ${view === 'search' ? 'is-search' : ''}`}>
          {view === 'files' && (
            <div className="ide-explorer">
              <div className="ide-side-head">
                <span>{t('ide.explorer')}</span>
                <div className="ide-side-actions">
                  <button
                    className="ide-iconbtn"
                    title={t('ide.newFile')}
                    onClick={() => startCreate('file')}
                  >
                    <Ico d={P.newFile} size={13} />
                  </button>
                  <button
                    className="ide-iconbtn"
                    title={t('ide.newFolder')}
                    onClick={() => startCreate('dir')}
                  >
                    <Ico d={P.newFolder} size={13} />
                  </button>
                  <button className="ide-iconbtn" title={t('ide.refreshShort')} onClick={refresh}>
                    <Ico d={P.refresh} size={13} />
                  </button>
                </div>
              </div>
              {creating && (
                <form
                  className="ide-createbar"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void submitCreate()
                  }}
                >
                  <div className="ide-createpath">
                    {creating.dirRel ? `${creating.dirRel}/` : './'}
                    <input
                      autoFocus
                      value={creating.value}
                      placeholder={
                        creating.kind === 'dir'
                          ? t('ide.folderNamePlaceholder')
                          : t('ide.fileNamePlaceholder')
                      }
                      spellCheck={false}
                      onChange={(e) => setCreating({ ...creating, value: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.preventDefault()
                          setCreating(null)
                        }
                      }}
                    />
                  </div>
                  <div className="ide-createfoot">
                    <span>
                      {t('ide.createHint', {
                        kind:
                          creating.kind === 'dir'
                            ? t('ide.newFolder')
                            : t('ide.newFile')
                      })}
                    </span>
                    <button type="button" onClick={() => setCreating(null)}>
                      {t('common.cancel')}
                    </button>
                    <button
                      type="submit"
                      className="is-primary"
                      disabled={!creating.value.trim()}
                    >
                      {t('ide.create')}
                    </button>
                  </div>
                </form>
              )}
              <div className="ide-tree">
                <TreeDir
                  key={cwd}
                  cwd={cwd}
                  rel=""
                  name={baseName(cwd)}
                  depth={0}
                  version={treeVersion}
                  defaultOpen
                  git={gitMap}
                  selectedRel={treeTarget.rel}
                  onSelect={setTreeTarget}
                  onMenu={(target, e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setTreeTarget(target)
                    setMenu({ x: e.clientX, y: e.clientY, target })
                  }}
                  onOpen={openFile}
                />
              </div>
            </div>
          )}
          {view === 'search' && (
            <SearchPanel
              cwd={cwd}
              onOpen={openFile}
              dirtyRels={dirtyRels}
              onReplaced={onWorkspaceReplaced}
              askConfirm={setDialog}
            />
          )}
        </aside>

        <section className="ide-editor">
          <div className="ide-tabs">
            {tabs.map((tab) => (
              <div
                key={tab.key}
                className={`ide-tab ${tab.key === activeKey ? 'on' : ''}`}
                title={tab.rel}
                onClick={() => setActiveKey(tab.key)}
                onAuxClick={(e) => {
                  if (e.button === 1) requestCloseTab(tab.key)
                }}
              >
                {tab.kind === 'file' && isDirty(tab.rel) ? (
                  <span className="ide-tab-dirty" title={t('ide.unsavedDot')} />
                ) : (
                  <Ico
                    d={tab.kind === 'image' ? P.image : tab.kind === 'diff' ? P.diff : P.file}
                    size={12}
                  />
                )}
                <span className="ide-tab-title">{tab.title}</span>
                {external[extKey(tab.rel)] && (
                  <span
                    className={`ide-tab-ext is-${external[extKey(tab.rel)]}`}
                    title={
                      external[extKey(tab.rel)] === 'deleted'
                        ? t('ide.deletedBanner')
                        : t('ide.externalBanner')
                    }
                  >
                    {external[extKey(tab.rel)] === 'deleted' ? '×' : '!'}
                  </span>
                )}
                <button
                  className="ide-tab-x"
                  title={t('common.close')}
                  onClick={(e) => {
                    e.stopPropagation()
                    requestCloseTab(tab.key)
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            {tabs.length === 0 && <div className="ide-tab-empty">{t('ide.noOpenFiles')}</div>}
          </div>

          {activeTab && (
            <div className="ide-crumbbar">
              <span className="ide-crumb-path">
                {activeTab.rel.split('/').map((seg, i, arr) => (
                  <span key={`${seg}-${i}`}>
                    <b>{seg}</b>
                    {i < arr.length - 1 && <i>›</i>}
                  </span>
                ))}
              </span>
              <span className="ide-crumb-right">
                {activeTab.kind === 'file' && activeFile && (
                  <button className="ide-linkbtn" onClick={() => openDiff(activeTab.rel)}>
                    {t('diff.head')}
                  </button>
                )}
                {activeTab.kind === 'diff' && activeDiff && (() => {
                  const s = diffStat(activeDiff.diff)
                  return (
                    <>
                      {s.added > 0 && <em className="ide-add">+{s.added}</em>}
                      {s.removed > 0 && <em className="ide-del">−{s.removed}</em>}
                    </>
                  )
                })()}
              </span>
            </div>
          )}

          <div className="ide-content">
            {!activeTab && <EmptyState />}
            {activeTab && loadingKey === activeTab.key && (
              <div className="ide-loading">
                {t('ide.loadingFile', { rel: activeTab.rel })}
              </div>
            )}
            {activeTab && loadingKey !== activeTab.key && activeTab.kind === 'file' && activeFile && (
              activeFile.binary || activeFile.truncated ? (
                <TextViewer
                  file={activeFile}
                  jumpLine={jump?.rel === activeTab.rel ? jump.line : undefined}
                  onSendSelection={openSelectionDraft}
                  onSendFile={() => sendDraftFromFile(activeFile, null)}
                />
              ) : (
                <MonacoEditor
                  file={activeFile}
                  jumpLine={jump?.rel === activeTab.rel ? jump.line : undefined}
                  onCursor={(line, col) =>
                    setCursor({ rel: activeTab.rel, line, col })
                  }
                  onChange={(text) =>
                    setFileCache((m) =>
                      m[activeTab.rel]
                        ? { ...m, [activeTab.rel]: { ...m[activeTab.rel], text } }
                        : m
                    )
                  }
                  onSendSelection={openSelectionDraft}
                  onSendFile={() => sendDraftFromFile(activeFile, null)}
                />
              )
            )}
            {activeTab && loadingKey !== activeTab.key && activeTab.kind === 'image' && activeImage && (
              <ImageViewer image={activeImage} />
            )}
            {activeTab && loadingKey !== activeTab.key && activeTab.kind === 'diff' && activeDiff && (
              <DiffViewer diff={activeDiff} />
            )}
          </div>

        </section>
          </>
        )}
      </div>

      <div className="ide-status">
        <span className="ide-status-branch">
          <Ico d={P.git} size={11} />
          {vcs.status?.repo
            ? vcs.status.repo.kind === 'git'
              ? vcs.status.repo.branch || 'detached'
              : vcs.status.repo.headShort
            : t('ide.noVcs')}
        </span>
        {vcs.status && (
          <span className="ide-status-changes">
            {t('ide.changesShort', { n: vcs.status.counts.total })}
          </span>
        )}
        {showSyncChip && (
          <button
            className={`ide-sync-chip ${
              syncRun === 'failed' ? 'is-bad' : syncRun === 'occupied' ? 'is-warn' : 'is-run'
            }`}
            title={syncChipTip}
            onClick={() => setView('sync')}
          >
            <Ico d={P.sync} size={11} />
            {syncChipText}
            {syncSnap?.lastRoundAtMs && <em>{clockOf(syncSnap.lastRoundAtMs)}</em>}
          </button>
        )}
        <span className="ide-status-right">
          {view !== 'vcs' && activeTab && <span className="ide-status-rel">{activeTab.rel}</span>}
          {view !== 'vcs' && statusRight}
        </span>
      </div>

      {syncBubble && (
        <SyncBubble
          data={syncBubble}
          onOpen={() => {
            setSyncBubble(null)
            if (syncBubbleTimer.current) {
              window.clearTimeout(syncBubbleTimer.current)
              syncBubbleTimer.current = null
            }
            setView('sync')
            setSyncLogOpen(true)
          }}
          onClose={() => {
            setSyncBubble(null)
            if (syncBubbleTimer.current) {
              window.clearTimeout(syncBubbleTimer.current)
              syncBubbleTimer.current = null
            }
          }}
        />
      )}

      {flash && (
        <div className="ide-toast is-ok" style={{ top: notice ? 92 : 48 }} role="status" aria-live="polite">
          <span className="ide-toast__ok">✓</span>
          <span>{flash}</span>
        </div>
      )}

      {sendDraft && (
        <SendToChat
          cwd={cwd}
          draft={sendDraft}
          onClose={() => setSendDraft(null)}
          onSent={handleSent}
        />
      )}

      {notice && (
        <div className="ide-toast">
          <span>{notice}</span>
          <button className="ide-iconbtn" title={t('common.close')} onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}

      {quickOpen && (
        <QuickOpen cwd={cwd} onClose={() => setQuickOpen(false)} onOpen={(rel) => { setQuickOpen(false); openFile(rel) }} />
      )}

      {menu && (
        <TreeMenu
          state={menu}
          onClose={() => setMenu(null)}
          onNewFile={(target) => startCreate('file', target)}
          onNewFolder={(target) => startCreate('dir', target)}
          onRename={(target) =>
            setPrompt({
              title: t('ide.renameTitle'),
              message: t('ide.renameMessage'),
              value: target.rel,
              confirmLabel: t('ide.rename'),
              run: (value) => renameTarget(target, value)
            })
          }
          onDelete={requestDelete}
          onSend={(target) =>
            void openFileForSend(target.rel, {
              left: menu.x,
              top: menu.y,
              right: menu.x,
              bottom: menu.y,
              width: 0,
              height: 0
            })
          }
        />
      )}

      {prompt && <PromptDialog state={prompt} onClose={() => setPrompt(null)} />}

      {dialog && (
        <ConfirmDialog
          state={dialog}
          onClose={() => setDialog(null)}
          onAction={(action) => {
            setDialog(null)
            void action.run()
          }}
        />
      )}
    </div>
  )
}

/* ── 文件树 ───────────────────────────────────────────── */

function TreeDir({
  cwd,
  rel,
  name,
  depth,
  version,
  defaultOpen = false,
  git,
  selectedRel,
  onSelect,
  onMenu,
  onOpen
}: {
  cwd: string
  rel: string
  name: string
  depth: number
  version: number
  defaultOpen?: boolean
  git: Record<string, VcsChange>
  selectedRel: string
  onSelect: (target: TreeTarget) => void
  onMenu: (target: TreeTarget, e: ReactMouseEvent) => void
  onOpen: (rel: string, line?: number) => void
}): JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(defaultOpen)
  const [entries, setEntries] = useState<IdeEntry[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [loadedVersion, setLoadedVersion] = useState(-1)
  const target: TreeTarget = { rel, kind: 'dir' }

  useEffect(() => {
    if (!open || loadedVersion === version) return
    let cancelled = false
    setFailed(false)
    const pending = window.api?.ide?.listDir(cwd, rel)
    if (!pending) {
      setFailed(true)
      return
    }
    pending
      .then((list) => {
        if (!cancelled) {
          setEntries(list)
          setLoadedVersion(version)
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [open, version, loadedVersion, cwd, rel])

  return (
    <div className="ide-tnode">
      <div
        className={`ide-trow is-dir ${depth === 0 ? 'is-root' : ''} ${
          selectedRel === rel ? 'is-sel' : ''
        }`}
        style={{ paddingLeft: 8 + depth * 12 }}
        title={rel || cwd}
        onClick={() => {
          onSelect(target)
          setOpen((o) => !o)
        }}
        onContextMenu={(e) => onMenu(target, e)}
      >
        <span className={`ide-chev ${open ? 'is-open' : ''}`}>
          <Ico d={open ? P.down : P.chevron} size={10} />
        </span>
        <IconFolder width={14} height={14} className="ide-folder" />
        <span className="ide-tname">{name}</span>
      </div>
      {open && (
        <div>
          {entries === null && !failed && (
            <div className="ide-tempty" style={{ paddingLeft: 30 + depth * 12 }}>
              {t('ide.loading')}
            </div>
          )}
          {failed && (
            <div className="ide-tempty" style={{ paddingLeft: 30 + depth * 12 }}>
              {t('ide.unreadable')}
            </div>
          )}
          {entries?.length === 0 && (
            <div className="ide-tempty" style={{ paddingLeft: 30 + depth * 12 }}>
              {t('ide.emptyDir')}
            </div>
          )}
          {entries?.map((e) =>
            e.kind === 'dir' ? (
              <TreeDir
                key={e.rel}
                cwd={cwd}
                rel={e.rel}
                name={e.name}
                depth={depth + 1}
                version={version}
                git={git}
                selectedRel={selectedRel}
                onSelect={onSelect}
                onMenu={onMenu}
                onOpen={onOpen}
              />
            ) : (
              <FileRow
                key={e.rel}
                entry={e}
                depth={depth + 1}
                status={git[e.rel]}
                selected={selectedRel === e.rel}
                onSelect={onSelect}
                onMenu={onMenu}
                onOpen={onOpen}
              />
            )
          )}
        </div>
      )}
    </div>
  )
}

function FileRow({
  entry,
  depth,
  status,
  selected,
  onSelect,
  onMenu,
  onOpen
}: {
  entry: IdeEntry
  depth: number
  status?: VcsChange
  selected: boolean
  onSelect: (target: TreeTarget) => void
  onMenu: (target: TreeTarget, e: ReactMouseEvent) => void
  onOpen: (rel: string, line?: number) => void
}): JSX.Element {
  const target: TreeTarget = { rel: entry.rel, kind: 'file' }
  return (
    <div
      className={`ide-trow is-file ${selected ? 'is-sel' : ''}`}
      style={{ paddingLeft: 26 + depth * 12 }}
      title={entry.rel}
      onClick={() => {
        onSelect(target)
        onOpen(entry.rel)
      }}
      onContextMenu={(e) => onMenu(target, e)}
    >
      <Ico d={isImageRel(entry.rel) ? P.image : P.file} size={13} />
      <span className="ide-tname">{entry.name}</span>
      {status && <em className={`ide-gitst is-${status === '?' ? 'u' : status.toLowerCase()}`}>{status}</em>}
    </div>
  )
}

/* ── 搜索 ─────────────────────────────────────────────── */

/** 用后端给的 offset/length 高亮；不要在渲染层重跑一次子串搜索 */
function highlightMatch(text: string, m: IdeSearchMatch): JSX.Element {
  const start = Math.max(0, Math.min(m.offset, text.length))
  const end = Math.min(text.length, start + m.length)
  return (
    <>
      {text.slice(0, start)}
      <mark>{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  )
}

/** 逗号 / 换行分隔 glob，但别把 `{ts,tsx}` 里的逗号拆开 */
function splitGlobList(raw: string): string[] {
  const out: string[] = []
  let cur = ''
  let depth = 0
  for (const ch of raw) {
    if (ch === '{') depth++
    else if (ch === '}' && depth > 0) depth--
    if ((ch === ',' || ch === '\n') && depth === 0) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** 搜索请求序号：时间戳 + 自增，避免同一毫秒内重复 */
let searchSeq = 0

/** 合并流式批次：同一个文件只保留最新的一份 */
function mergeSearchFiles(prev: IdeSearchFile[], next: IdeSearchFile[]): IdeSearchFile[] {
  if (next.length === 0) return prev
  const map = new Map(prev.map((f) => [f.rel, f]))
  for (const f of next) map.set(f.rel, f)
  return [...map.values()]
}

function SearchPanel({
  cwd,
  onOpen,
  dirtyRels,
  onReplaced,
  askConfirm
}: {
  cwd: string
  onOpen: (rel: string, line?: number) => void
  dirtyRels: string[]
  onReplaced: (r: IdeReplaceData) => void
  askConfirm: (state: DialogState) => void
}): JSX.Element {
  const { t, tn } = useI18n()
  const [q, setQ] = useState('')
  const [replacement, setReplacement] = useState('')
  const [showReplace, setShowReplace] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [includeText, setIncludeText] = useState('')
  const [excludeText, setExcludeText] = useState('')
  const [results, setResults] = useState<IdeSearchFile[]>([])
  const [busy, setBusy] = useState(false)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [replacing, setReplacing] = useState(false)
  const [lastReplace, setLastReplace] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  /** 本次结果是否来自内置搜索（rg 不可用 / 启动失败） */
  const [fallback, setFallback] = useState(false)
  /** 当前有效的 requestId；旧请求的迟到事件一律丢弃 */
  const activeRef = useRef('')

  const options = useMemo<IdeSearchOptions>(
    () => ({
      caseSensitive,
      wholeWord,
      regex,
      include: splitGlobList(includeText),
      exclude: splitGlobList(excludeText)
    }),
    [caseSensitive, wholeWord, regex, includeText, excludeText]
  )

  // 正则至少 1 个字符；字面量沿用旧 UI 的「至少 2 个字符」，避免扫全库
  const usable = regex ? q.length >= 1 : q.trim().length >= 2

  // 主进程按 requestId 推送批次；旧请求的事件直接丢弃
  useEffect(() => {
    const off = window.api?.ide?.onSearchEvent((ev) => {
      if (ev.requestId !== activeRef.current) return

      if (ev.type === 'batch') {
        setResults((prev) => mergeSearchFiles(ev.reset ? [] : prev, ev.files))
        if (ev.fallback !== undefined) setFallback(ev.fallback)
        setNote(ev.truncated ? (ev.note ?? t('ide.resultTruncated')) : null)
        setSearched(true)
        return
      }

      if (ev.type === 'done') {
        setResults((prev) => [...prev].sort((a, b) => a.rel.localeCompare(b.rel)))
        setNote(ev.truncated ? (ev.note ?? t('ide.resultTruncated')) : null)
        if (ev.fallback !== undefined) setFallback(ev.fallback)
        setSearched(true)
        setBusy(false)
        return
      }

      setError(ev.message)
      setSearched(true)
      setBusy(false)
    })

    return off
  }, [t])

  useEffect(() => {
    if (!usable) {
      activeRef.current = ''
      setResults([])
      setSearched(false)
      setBusy(false)
      setError(null)
      setNote(null)
      setFallback(false)
      return
    }

    const requestId = `s${Date.now().toString(36)}_${++searchSeq}`
    // 立刻认领新请求：旧请求的迟到事件从这一刻起就不再影响界面
    activeRef.current = requestId
    const timer = setTimeout(async () => {
      const api = window.api?.ide
      if (!api) return

      setResults([])
      setBusy(true)
      setSearched(false)
      setError(null)
      setNote(null)
      setFallback(false)

      try {
        const r = await api.startSearch({ cwd, query: q, options, requestId })
        if (activeRef.current !== requestId) {
          api.cancelSearch(requestId)
          return
        }
        if (!r.ok) {
          setError(r.message)
          setSearched(true)
          setBusy(false)
          return
        }
        setFallback(r.data.fallback)
      } catch (err) {
        if (activeRef.current === requestId) {
          setError(err instanceof Error ? err.message : String(err))
          setSearched(true)
          setBusy(false)
        }
      }
    }, 350)

    return () => {
      clearTimeout(timer)
      // 新查询 / 面板卸载时立刻让主进程停掉旧搜索，而不是只丢弃结果
      window.api?.ide?.cancelSearch(requestId)
    }
  }, [cwd, q, options, refreshTick, usable])

  const total = results.reduce((n, f) => n + f.matches.length, 0)
  const canReplace = searched && !busy && !replacing && total > 0 && !error && usable

  const doReplace = async (): Promise<void> => {
    setReplacing(true)
    setError(null)
    setLastReplace(null)
    try {
      const api = window.api
      if (!api?.ide) {
        setError(t('ide.replaceUnsupported'))
        return
      }
      const r = await api.ide.replaceInWorkspace({
        cwd,
        query: q,
        replacement,
        options,
        dirtyRels
      })
      if (!r.ok) {
        setError(r.message)
        return
      }
      const d = r.data
      if (d.aborted) {
        setError(d.message ?? t('ide.replaceAborted'))
        return
      }

      const totals = d.totals
      const parts = [
        t('ide.replaceCount', { n: totals.replacements }),
        tn('count.files', totals.filesChanged)
      ]
      if (totals.filesSkippedDirty) {
        parts.push(t('ide.replaceSkippedDirty', { n: totals.filesSkippedDirty }))
      }
      if (totals.filesConflicted) {
        parts.push(t('ide.replaceConflicts', { n: totals.filesConflicted }))
      }
      if (totals.filesErrored) {
        parts.push(t('ide.replaceErrors', { n: totals.filesErrored }))
      }
      if (totals.filesSkippedBinary || totals.filesSkippedLarge) {
        parts.push(
          t('ide.replaceIgnored', {
            n: totals.filesSkippedBinary + totals.filesSkippedLarge
          })
        )
      }
      setLastReplace(t('ide.replaced', { summary: parts.join(' · ') }))

      onReplaced(d)
      // 重新搜索，让面板显示替换后的磁盘内容
      setRefreshTick((x) => x + 1)
    } catch (err) {
      setError(
        t('ide.replaceFailed', {
          error: err instanceof Error ? err.message : String(err)
        })
      )
    } finally {
      setReplacing(false)
    }
  }

  const onReplaceAll = (): void => {
    if (!canReplace) return
    const dirtyNote = dirtyRels.length
      ? t('ide.dirtySkipNote', { n: dirtyRels.length })
      : ''
    const truncatedNote = note ? t('ide.panelTruncatedNote') : ''
    askConfirm({
      title: t('ide.replaceDialogTitle'),
      message: t('ide.replaceDialogMessage', {
        total,
        replacement: replacement || '',
        files: results.length,
        notes: dirtyNote + truncatedNote
      }),
      actions: [
        { label: t('common.cancel'), run: () => undefined },
        {
          label: t('ide.replaceAll'),
          kind: 'danger',
          run: doReplace
        }
      ]
    })
  }

  return (
    <div className="ide-searchview">
      <div className="ide-side-head">
        <span>{t('ide.search')}</span>
      </div>

      <div className="ide-searchbox">
        <button
          className="ide-sreplace-toggle"
          aria-expanded={showReplace}
          title={showReplace ? t('ide.collapseReplace') : t('ide.expandReplace')}
          onClick={() => setShowReplace((v) => !v)}
        >
          <Ico d={showReplace ? P.down : P.chevron} size={11} />
        </button>
        <IconSearch width={13} height={13} />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={
            regex ? t('ide.searchRegexPlaceholder') : t('ide.searchWorkspacePlaceholder')
          }
          spellCheck={false}
          disabled={replacing}
        />
        {busy && <span className="ide-spin" />}
      </div>

      {showReplace && (
        <div className="ide-searchbox ide-searchbox--replace">
          <input
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            placeholder={
              regex ? t('ide.replaceRegexPlaceholder') : t('ide.replacePlaceholder')
            }
            spellCheck={false}
            disabled={replacing}
          />
          <button
            className="ide-replaceall"
            disabled={!canReplace}
            onClick={onReplaceAll}
            title={t('ide.replaceDialogTitle')}
          >
            {replacing ? <span className="ide-spin" /> : t('ide.replaceAll')}
          </button>
        </div>
      )}

      <div className="ide-sopts">
        <button
          className={`ide-sopt ${caseSensitive ? 'is-on' : ''}`}
          aria-pressed={caseSensitive}
          title={t('ide.caseSensitive')}
          onClick={() => setCaseSensitive((v) => !v)}
        >
          Aa
        </button>
        <button
          className={`ide-sopt ${wholeWord ? 'is-on' : ''}`}
          aria-pressed={wholeWord}
          title={t('ide.wholeWord')}
          onClick={() => setWholeWord((v) => !v)}
        >
          {t('ide.wholeWordShort')}
        </button>
        <button
          className={`ide-sopt ${regex ? 'is-on' : ''}`}
          aria-pressed={regex}
          title={t('ide.regex')}
          onClick={() => setRegex((v) => !v)}
        >
          .*
        </button>
        <button
          className={`ide-sopt ${showFilters ? 'is-on' : ''}`}
          aria-pressed={showFilters}
          title={t('ide.filterTitle')}
          onClick={() => setShowFilters((v) => !v)}
        >
          {t('ide.filter')}
        </button>
      </div>

      {showFilters && (
        <div className="ide-sglob">
          <input
            value={includeText}
            onChange={(e) => setIncludeText(e.target.value)}
            placeholder={t('ide.includePlaceholder')}
            spellCheck={false}
            disabled={replacing}
          />
          <input
            value={excludeText}
            onChange={(e) => setExcludeText(e.target.value)}
            placeholder={t('ide.excludePlaceholder')}
            spellCheck={false}
            disabled={replacing}
          />
        </div>
      )}

      <div className={`ide-searchsum ${error ? 'is-error' : ''}`}>
        {error
          ? error
          : searched
            ? t('ide.results', {
                n: total,
                files: results.length,
                truncated: note ? t('ide.resultsTruncated') : ''
              })
            : regex
              ? t('ide.enterRegex')
              : t('ide.enterTwoChars')}
      </div>
      {note && !error && <div className="ide-searchnote">{note}</div>}
      {fallback && !note && !error && (
        <div className="ide-searchnote">{t('ide.searchFallback')}</div>
      )}
      {lastReplace && <div className="ide-searchsum is-done">{lastReplace}</div>}

      <div className="ide-searchres">
        {results.map((f) => (
          <div key={f.rel} className="ide-sfile">
            <div className="ide-sfhead" title={f.rel}>
              <Ico d={P.file} size={12} />
              <span>{f.name}</span>
              <em>{f.matches.length}</em>
            </div>
            {f.matches.map((m, i) => (
              <button
                key={`${f.rel}-${m.line}-${m.column}-${i}`}
                className="ide-smatch"
                title={`${f.rel}:${m.line}:${m.column}`}
                onClick={() => onOpen(f.rel, m.line)}
              >
                <span className="ide-sline">{m.line}</span>
                <span className="ide-snip">{highlightMatch(m.text, m)}</span>
              </button>
            ))}
          </div>
        ))}
        {searched && results.length === 0 && !busy && !error && (
          <div className="ide-emptyhint">{t('ide.noMatches')}</div>
        )}
      </div>
    </div>
  )
}

/* ── 快速打开 ─────────────────────────────────────────── */

function QuickOpen({
  cwd,
  onClose,
  onOpen
}: {
  cwd: string
  onClose: () => void
  onOpen: (rel: string) => void
}): JSX.Element {
  const { t } = useI18n()
  const [q, setQ] = useState('')
  const [items, setItems] = useState<FileMatch[]>([])
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      setBusy(true)
      try {
        const r = (await window.api?.workspace?.searchFiles(cwd, q, 50)) ?? []
        if (!cancelled) {
          setItems(r.filter((f) => f.kind === 'file'))
          setActive(0)
        }
      } catch {
        if (!cancelled) setItems([])
      } finally {
        if (!cancelled) setBusy(false)
      }
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [q, cwd])

  const choose = (m?: FileMatch): void => {
    const item = m ?? items[active]
    if (item) onOpen(item.path)
  }

  return (
    <div className="ide-overlay" onMouseDown={onClose}>
      <div className="ide-qo" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ide-qo-input">
          <IconSearch width={14} height={14} />
          <input
            ref={inputRef}
            value={q}
            placeholder={t('ide.quickOpenPlaceholder')}
            spellCheck={false}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(items.length - 1, a + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(0, a - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                choose()
              }
            }}
          />
          {busy && <span className="ide-spin" />}
        </div>
        <div className="ide-qo-list">
          {items.map((m, i) => (
            <button
              key={m.path}
              className={`ide-qo-row ${i === active ? 'on' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(m)}
            >
              <Ico d={P.file} size={13} />
              <span className="ide-qo-name">{m.name}</span>
              <span className="ide-qo-dir">{m.dir}</span>
            </button>
          ))}
          {!busy && items.length === 0 && <div className="ide-emptyhint">{t('ide.noMatchingFiles')}</div>}
        </div>
        <div className="ide-qo-foot">
          <span>{t('ide.keySelect')}</span>
          <span>{t('ide.keyOpen')}</span>
          <span>{t('ide.keyClose')}</span>
        </div>
      </div>
    </div>
  )
}

/* ── 文本 / 图片 / diff ───────────────────────────────── */

/**
 * 可编辑文本区。
 *
 * 用 textarea 接收输入，下面垫一层同样字号/行高的高亮 pre，textarea 的文字
 * 透明、只保留光标和选区。这样既保留轻量语法着色，又不用自己实现光标和 IME。
 * 行号用一条 pre 文本渲染，避免几千个 span。
 */
function TextViewer({
  file,
  jumpLine,
  onSendSelection,
  onSendFile
}: {
  file: IdeTextFile
  jumpLine?: number
  onSendSelection: (sel: EditorSelection) => void
  onSendFile: () => void
}): JSX.Element {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{
    x: number
    y: number
    sel: EditorSelection | null
  } | null>(null)
  const lines = useMemo(() => toLines(highlight(file.text, file.language)), [file])
  const shown = lines.slice(0, 5000)

  useEffect(() => {
    if (!jumpLine) return
    const el = ref.current?.querySelector(`[data-line="${jumpLine}"]`)
    el?.scrollIntoView({ block: 'center' })
  }, [jumpLine, file.rel])

  /*
   * 选区 → 行号 + 代码。只在右键时算一次，不再跟着 selectionchange 跑。
   *
   * 跨行时直接用文件原文的整行，而不是 Selection.toString() —— 后者会
   * 受渲染结构影响（行号、token span、换行）拼出脏文本，发给模型的代码
   * 必须是文件里的原样。单行选区保留精确选中内容。
   */
  const currentSelection = (): EditorSelection | null => {
    const root = ref.current
    const sel = window.getSelection()
    if (!root || !sel || sel.isCollapsed || sel.rangeCount === 0) return null
    const range = sel.getRangeAt(0)
    if (!root.contains(range.commonAncestorContainer)) return null

    const lineOf = (node: Node): Element | null => {
      const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
      return el?.closest('.ide-line') ?? null
    }
    const a = lineOf(range.startContainer)
    const b = lineOf(range.endContainer)
    if (!a || !b) return null
    const l1 = Number(a.getAttribute('data-line'))
    const l2 = Number(b.getAttribute('data-line'))
    if (!l1 || !l2) return null

    const startLine = Math.min(l1, l2)
    const endLine = Math.max(l1, l2)
    const text = file.text.replace(/\r\n?/g, '\n')
    const code =
      startLine === endLine
        ? sel.toString().replace(/\r\n?/g, '\n').replace(/\s+$/, '')
        : text
            .split('\n')
            .slice(startLine - 1, endLine)
            .join('\n')
            .replace(/\s+$/, '')
    if (!code.trim()) return null

    const r = range.getBoundingClientRect()
    return {
      startLine,
      endLine,
      code,
      rect: {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height
      }
    }
  }

  const openMenu = (e: ReactMouseEvent): void => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, sel: currentSelection() })
  }

  if (file.binary) {
    return (
      <div className="ide-binary">
        <div className="ide-binary-t">{t('ide.binaryPreviewUnsupported')}</div>
        <div className="ide-binary-s">{file.rel} · {fmtSize(file.size)}</div>
      </div>
    )
  }

  return (
    <div className="ide-textwrap" ref={ref} onContextMenu={openMenu}>
      {file.truncated && (
        <div className="ide-banner">{t('ide.fileTooLargeBanner')}</div>
      )}
      <div className="ide-code">
        {shown.map((toks, i) => {
          const n = i + 1
          return (
            <div
              key={n}
              data-line={n}
              className={`ide-line ${jumpLine === n ? 'is-jump' : ''}`}
            >
              <span className="ide-ln">{n}</span>
              <span className="ide-src">
                {toks.length > 0
                  ? toks.map((t, j) => (
                      <span key={j} className={t.cls}>
                        {t.text}
                      </span>
                    ))
                  : ' '}
              </span>
            </div>
          )
        })}
      </div>
      {lines.length > 5000 && (
        <div className="ide-banner">
          {t('ide.fileLongBanner', { n: lines.length })}
        </div>
      )}
      {menu && (
        <div
          className="ide-ctx-overlay"
          onMouseDown={() => setMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setMenu(null)
          }}
        >
          <div
            className="ide-ctx"
            style={{
              left: Math.max(8, Math.min(menu.x, window.innerWidth - 196)),
              top: Math.max(8, Math.min(menu.y, window.innerHeight - 140))
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {menu.sel && (
              <>
                <button
                  onClick={() => {
                    const text = window.getSelection()?.toString() ?? ''
                    if (text) void navigator.clipboard?.writeText(text)
                    setMenu(null)
                  }}
                >
                  {t('ide.copy')}
                </button>
                <span className="ide-ctx-sep" />
              </>
            )}
            {menu.sel && (
              <button
                onClick={() => {
                  const sel = menu.sel
                  setMenu(null)
                  if (sel) onSendSelection(sel)
                }}
              >
                <Ico d={P.plane} size={13} />
                {t('ide.sendSelection')}
              </button>
            )}
            <button
              onClick={() => {
                setMenu(null)
                onSendFile()
              }}
            >
              <Ico d={P.plane} size={13} />
              {t('ide.sendFileToChat')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function ImageViewer({ image }: { image: IdeImage }): JSX.Element {
  const [zoom, setZoom] = useState(1)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)

  const setZ = (z: number): void => setZoom(Math.min(4, Math.max(0.2, Math.round(z * 10) / 10)))

  return (
    <div className="ide-imagewrap">
      <div className="ide-imagetools">
        <button className="ide-zbtn" onClick={() => setZ(zoom - 0.1)}>−</button>
        <span className="ide-zval">{Math.round(zoom * 100)}%</span>
        <button className="ide-zbtn" onClick={() => setZ(zoom + 0.1)}>＋</button>
        <button className="ide-zbtn wide" onClick={() => setZ(1)}>1:1</button>
        <span className="ide-spacer" />
        <span>{dims ? `${dims.w} × ${dims.h}` : ''} · {fmtSize(image.size)}</span>
      </div>
      <div className="ide-canvas">
        <img
          src={image.dataUrl}
          alt={image.rel}
          style={{ transform: `scale(${zoom})` }}
          onLoad={(e) =>
            setDims({
              w: e.currentTarget.naturalWidth,
              h: e.currentTarget.naturalHeight
            })
          }
        />
      </div>
      <div className="ide-imagemeta">
        <span>{image.rel}</span>
        <span>{image.mime}</span>
      </div>
    </div>
  )
}

function DiffViewer({ diff }: { diff: VcsDiffData }): JSX.Element {
  return <VcsDiffView data={diff} />
}

/* ── 资源管理器右键菜单 / 通用弹层 ─────────────────────── */

function TreeMenu({
  state,
  onClose,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
  onSend
}: {
  state: TreeMenuState
  onClose: () => void
  onNewFile: (target: TreeTarget) => void
  onNewFolder: (target: TreeTarget) => void
  onRename: (target: TreeTarget) => void
  onDelete: (target: TreeTarget) => void
  onSend: (target: TreeTarget) => void
}): JSX.Element {
  const { t } = useI18n()
  const target = state.target
  const dir: TreeTarget =
    target.kind === 'dir' ? target : { rel: dirOfRel(target.rel), kind: 'dir' }
  const left = Math.max(8, Math.min(state.x, window.innerWidth - 196))
  const top = Math.max(8, Math.min(state.y, window.innerHeight - 260))

  useEffect(() => {
    const close = (): void => onClose()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      className="ide-ctx-overlay"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <div
        className="ide-ctx"
        style={{ left, top }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {target.kind === 'file' && (
          <>
            <button
              onClick={() => {
                onClose()
                onSend(target)
              }}
            >
              <Ico d={P.plane} size={13} />
              {t('ide.sendToChat')}
            </button>
            <span className="ide-ctx-sep" />
          </>
        )}
        <button onClick={() => onNewFile(dir)}>
          <Ico d={P.newFile} size={13} />
          {t('ide.newFile')}
        </button>
        <button onClick={() => onNewFolder(dir)}>
          <Ico d={P.newFolder} size={13} />
          {t('ide.newFolder')}
        </button>
        {target.rel && (
          <>
            <span className="ide-ctx-sep" />
            <button
              onClick={() => {
                onClose()
                onRename(target)
              }}
            >
              <Ico d={P.rename} size={13} />
              {t('ide.rename')}
              <kbd>F2</kbd>
            </button>
            <button
              className="is-danger"
              onClick={() => {
                onClose()
                onDelete(target)
              }}
            >
              <Ico d={P.trash} size={13} />
              {t('ide.delete')}
              <kbd>Del</kbd>
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function PromptDialog({
  state,
  onClose
}: {
  state: PromptState
  onClose: () => void
}): JSX.Element {
  const { t } = useI18n()
  const [value, setValue] = useState(state.value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const submit = (): void => {
    const v = value.trim()
    if (!v) return
    onClose()
    void state.run(v)
  }

  return (
    <div className="ide-dialog-overlay" onMouseDown={onClose}>
      <div className="ide-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ide-dialog-title">{state.title}</div>
        <div className="ide-dialog-msg">{state.message}</div>
        <input
          ref={inputRef}
          className="ide-dialog-input"
          value={value}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
        />
        <div className="ide-dialog-actions">
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button className="is-primary" disabled={!value.trim()} onClick={submit}>
            {state.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function ConfirmDialog({
  state,
  onClose,
  onAction
}: {
  state: DialogState
  onClose: () => void
  onAction: (action: DialogAction) => void
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="ide-dialog-overlay" onMouseDown={onClose}>
      <div className="ide-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ide-dialog-title">{state.title}</div>
        <div className="ide-dialog-msg">{state.message}</div>
        <div className="ide-dialog-actions">
          {state.actions.map((action) => (
            <button
              key={action.label}
              className={
                action.kind === 'primary'
                  ? 'is-primary'
                  : action.kind === 'danger'
                    ? 'is-danger'
                    : undefined
              }
              onClick={() => onAction(action)}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function EmptyState(): JSX.Element {
  const { t } = useI18n()
  return (
    <div className="ide-empty">
      <div className="ide-empty-logo">C</div>
      <div className="ide-empty-t">{t('ide.emptyTitle')}</div>
      <div className="ide-empty-s">
        <div><kbd>Ctrl P</kbd> {t('ide.emptyQuickOpen')}</div>
        <div><kbd>Ctrl S</kbd> {t('ide.emptySave')}</div>
        <div><kbd>Ctrl Shift F</kbd> {t('ide.emptySearch')}</div>
        <div>{t('ide.emptyContextMenu')}</div>
      </div>
    </div>
  )
}
