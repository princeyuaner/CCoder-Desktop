import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent
} from 'react'
import type {
  IdeEncoding,
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
import {
  DEFAULT_EDITOR_SETTINGS,
  normalizeEditorSettings,
  type EditorSettings,
  type Settings
} from '@shared/settings'
import { SYNC_BUBBLE_ROWS, type SyncSnapshot } from '@shared/sync'
import {
  formatBinding,
  matchBinding,
  normalizeKeybindings,
  resolveKeybindings,
  type KeybindingOverrides
} from '@shared/keybindings'
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
import { BottomPanel, type BottomTab } from './BottomPanel'
import { CommandPalette, type CommandItem } from './CommandPalette'
import { SettingsDialog, type SettingsSection } from './SettingsDialog'
import { EncodingMenu, ENCODING_LABEL_KEY } from './EncodingMenu'
import { TerminalView } from './TerminalView'
import { OutlineList } from './OutlineList'
import { activeEditor, formatActiveDocument, runEditorAction } from './editor-actions'
import { parseOutline, type OutlineKind, type OutlineSymbol } from './outline'
import { ensureImportedModels, refreshImportedModels } from './tsProject'
import type { MessageKey } from '@shared/i18n'
import { relFromUri, subscribeProblems, type IdeProblem } from './problems'
import { monaco, monacoLanguage } from './monaco-setup'
import { useLsp } from './useLsp'
import { isLspLanguage, type LspOpenDoc } from './lsp-client'
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

/* ── 崩溃恢复：未保存草稿 ──────────────────────────────── */

/** 每个工作区一份草稿；localStorage 在崩溃 / 断电后仍然可读 */
const draftStoreKey = (cwd: string): string => `ccoder:ide:drafts:${cwd}`
/** 单个文件 / 整个工作区的草稿上限，避免把 localStorage 撑爆 */
const DRAFT_FILE_MAX_CHARS = 300_000
const DRAFT_TOTAL_MAX_CHARS = 1_500_000

function readDrafts(cwd: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(draftStoreKey(cwd))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [rel, text] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof text === 'string' && text.length <= DRAFT_FILE_MAX_CHARS) out[rel] = text
    }
    return out
  } catch {
    return {}
  }
}

function writeDrafts(cwd: string, drafts: Record<string, string>): void {
  try {
    if (Object.keys(drafts).length === 0) localStorage.removeItem(draftStoreKey(cwd))
    else localStorage.setItem(draftStoreKey(cwd), JSON.stringify(drafts))
  } catch {
    // 配额满了 / 隐私模式：草稿恢复失效，但不能影响正常编辑
  }
}

interface Tab {
  key: string
  kind: TabKind
  rel: string
  title: string
  /** 固定后留在最左侧，批量关闭时保留 */
  pinned?: boolean
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

interface TabMenuState {
  x: number
  y: number
  key: string
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

const OUTLINE_KIND_KEY: Record<OutlineKind, MessageKey> = {
  function: 'ide.outline.kind.function',
  class: 'ide.outline.kind.class',
  interface: 'ide.outline.kind.interface',
  type: 'ide.outline.kind.type',
  enum: 'ide.outline.kind.enum',
  module: 'ide.outline.kind.module',
  constant: 'ide.outline.kind.constant',
  method: 'ide.outline.kind.method',
  symbol: 'ide.outline.kind.symbol'
}

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

/**
 * 首屏 query 里那一批 diff 文件。
 *
 * 坏数据（不是数组、元素不是字符串）直接当空 —— 这个参数只由主进程
 * 生成，用户改不出来；真有人手改 URL 也不该让 IDE 崩掉。
 */
function parseMoreRels(raw: string | null): string[] {
  if (!raw) return []
  try {
    const list = JSON.parse(raw) as unknown
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * 这个 diff 表示文件被删掉了（没有可打开的文件）。
 *
 * Git 用 `+++ /dev/null`，SVN 用 `+++ x (nonexistent)`；两种都算删除。
 * 被删的文件打不开，「打开文件」入口也就不该出现。
 */
function diffIsDeletion(data: VcsDiffData | undefined): boolean {
  if (!data?.diff) return false
  return /^\+\+\+ (?:\/dev\/null|.* \(nonexistent\))\s*$/m.test(data.diff)
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
  sync: 'M12.5 5A5.5 5.5 0 0 0 3 7M3 3.5V7h3.5M3.5 11A5.5 5.5 0 0 0 13 9M13 12.5V9h-3.5',
  alert: 'M8 2.4 14.4 13H1.6zM8 6v3.2M8 11.2h.01',
  terminal: 'M2.5 3.5h11v9h-11zM4.5 6.2l2 1.8-2 1.8M8.2 10h3.2',
  command: 'M5.5 3.5 10 8l-4.5 4.5',
  settings:
    'M8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6M13 8c0-.3 0-.6-.1-.9l1.2-.9-1.2-2-1.4.5c-.5-.4-1-.6-1.6-.8l-.2-1.4H6.3l-.2 1.4c-.6.2-1.1.5-1.6.8l-1.4-.5-1.2 2 1.2.9c0 .3-.1.6-.1.9s0 .6.1.9l-1.2.9 1.2 2 1.4-.5c.5.4 1 .6 1.6.8l.2 1.4h3.4l.2-1.4c.6-.2 1.1-.5 1.6-.8l1.4.5 1.2-2-1.2-.9c.1-.3.1-.6.1-.9',
  sliders:
    'M2.5 4h4.2M9.8 4h3.7M2.5 8h7.3M13 8h.5M2.5 12h1.7M7.3 12h6.2M8.2 2.5v3M6.7 6.5v3M4.4 10.5v3',
  pin: 'M9.6 2.2 13.8 6.4l-2.1.7-1.8 1.8.2 2-1.1 1.1-3-3-2.8 2.8-.8-.8 2.8-2.8-3-3 1.1-1.1 2 .2 1.8-1.8z'
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
  /** 页签右键菜单 / 拖动排序状态 */
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null)
  const [dragTabKey, setDragTabKey] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ key: string; after: boolean } | null>(null)
  /** 状态栏编码菜单 */
  const [encodingMenuOpen, setEncodingMenuOpen] = useState(false)
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
  /** 快速打开面板的初始查询；'#' 进入工作区符号模式（Ctrl+T） */
  const [quickOpenSeed, setQuickOpenSeed] = useState('')
  /** 命令面板 / 符号选择共用一个浮层；mode 决定列的是命令还是当前文件符号 */
  const [palette, setPalette] = useState<'commands' | 'symbols' | null>(null)
  /** 底部面板：tab 记住上次选择，open 控制显示；终端组件始终挂载以保住会话 */
  const [panelTab, setPanelTab] = useState<BottomTab>('problems')
  const [panelOpen, setPanelOpen] = useState(false)
  const [problems, setProblems] = useState<IdeProblem[]>([])
  const [sidebarOpen, setSidebarOpen] = useState(true)
  /** outlineSymbols 声明在键盘 effect 之后；用 ref 让快捷键能读到最新数量 */
  const outlineCountRef = useRef(0)
  /** 文件导航历史（Alt+← / Alt+→） */
  const navHistoryRef = useRef<{ list: { rel: string; line?: number }[]; index: number }>({
    list: [],
    index: -1
  })
  const [jump, setJump] = useState<{ rel: string; line: number } | null>(null)
  /** 资源管理器当前选中的文件 / 文件夹 */
  const [treeTarget, setTreeTarget] = useState<TreeTarget>({ rel: '', kind: 'dir' })
  /**
   * 「在资源管理器中显示当前文件」：rel + nonce。
   * nonce 让同一个文件连续触发时也能重新展开 / 滚动。
   */
  const [reveal, setReveal] = useState<{ rel: string; nonce: number } | null>(null)
  /** 快捷键覆盖项；默认值在 shared/keybindings.ts */
  const [keybindingOverrides, setKeybindingOverrides] = useState<KeybindingOverrides>({})
  const resolvedKeybindings = useMemo(
    () => resolveKeybindings(keybindingOverrides),
    [keybindingOverrides]
  )
  /** 键盘 effect 只注册一次，通过 ref 读最新的命令表和按键表 */
  const commandsRef = useRef<CommandItem[]>([])
  const keybindingsRef = useRef(resolvedKeybindings)
  keybindingsRef.current = resolvedKeybindings
  const treeTargetRef = useRef(treeTarget)
  treeTargetRef.current = treeTarget
  /** 最近一次从主进程拿到的完整设置；改快捷键时要在它上面打补丁再写回 */
  const settingsRef = useRef<Settings | null>(null)
  /** 设置弹窗：快捷键和编辑器设置共用一个窗口，左侧竖排页签切换 */
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsSection>('keybindings')
  const settingsOpenRef = useRef(false)
  settingsOpenRef.current = settingsOpen
  /** 设置弹窗的保存状态：空转 / 保存中 / 已保存 / 失败 */
  const [settingsSaveState, setSettingsSaveState] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle')
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
  /** 编辑器偏好：主窗口与所有 IDE 窗口共享 settings.editor */
  const [editorPrefs, setEditorPrefs] = useState<EditorSettings>(DEFAULT_EDITOR_SETTINGS)
  /** 语言服务器总开关；设置加载前先按默认值（开）运行 */
  const [lspEnabled, setLspEnabled] = useState(true)
  /** 崩溃恢复：启动时读一次，之后由 ensureTab 在打开文件时应用 */
  const pendingDraftsRef = useRef<Record<string, string>>({})
  const draftsLoadedRef = useRef(false)
  /** 用户明确选择「不保存并关闭」后，beforeunload 不能再把草稿写回去 */
  const discardDraftsRef = useRef(false)
  /** 最近关闭的标签（Ctrl+Shift+T 重新打开）；只在内存里，不跨窗口 */
  const closedTabsRef = useRef<Tab[]>([])
  const vcs = useVcsStatus(cwd)
  const sync = useSync(cwd)
  const [syncLogOpen, setSyncLogOpen] = useState(false)
  const [syncBubble, setSyncBubble] = useState<SyncBubbleData | null>(null)
  const syncBubbleTimer = useRef<number | null>(null)
  const syncAnnounced = useRef<number | null>(null)
  const syncReady = useRef(false)
  const activeTab = tabs.find((t) => t.key === activeKey) ?? null

  /* ── 语言服务器 ───────────────────────────────────────── */
  const {
    syncDocs: syncLspDocs,
    states: lspStates,
    documentSymbols: lspDocumentSymbols,
    workspaceSymbols: lspWorkspaceSymbols
  } = useLsp(cwd, lspEnabled)
  const lspDocs = useMemo<LspOpenDoc[]>(() => {
    const out: LspOpenDoc[] = []
    for (const tab of tabs) {
      if (tab.kind !== 'file') continue
      const file = fileCache[tab.rel]
      if (!file || file.binary || file.truncated) continue
      const language = monacoLanguage(file.language, file.rel)
      if (!isLspLanguage(language)) continue
      out.push({ rel: tab.rel, language, text: file.text })
    }
    return out
  }, [fileCache, tabs])
  useEffect(() => {
    syncLspDocs(lspDocs)
  }, [lspDocs, syncLspDocs])

  const activeLspFile = activeTab?.kind === 'file' ? fileCache[activeTab.rel] : undefined
  const activeLanguage = activeLspFile
    ? monacoLanguage(activeLspFile.language, activeLspFile.rel)
    : null
  const activeLsp = activeLanguage ? lspStates[activeLanguage] : undefined

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

      // 已打开文件的隐藏 import model 也要跟上磁盘变化
      if (api?.ide && batch.rels.length > 0) {
        const openRels = new Set(Object.keys(liveRef.current.fileCache))
        void refreshImportedModels(cwd, batch.rels, api.ide.readFile, openRels)
      }

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

  // 主窗口改语言/主题/字号/缩放/编辑器偏好时，已经开着的 IDE 窗口也跟着变
  useEffect(() => {
    const apply = (s: Settings): void => {
      applyLanguageSetting(s.language)
      applyAppearance(s)
      settingsRef.current = s
      setEditorPrefs(normalizeEditorSettings(s.editor))
      setLspEnabled(s.lsp?.enabled !== false)
      setKeybindingOverrides(normalizeKeybindings(s.keybindings))
    }
    void window.api?.settings
      .get()
      .then(apply)
      .catch(() => undefined)
    const off = window.api?.settings.onChanged(apply)
    return () => off?.()
  }, [])

  // 草稿要在「恢复标签」之前读进 ref —— 否则 active tab 的首次读取会错过草稿
  useEffect(() => {
    pendingDraftsRef.current = readDrafts(cwd)
    draftsLoadedRef.current = true
  }, [cwd])

  // Monaco 的 marker（TS 语法、JSON / CSS / HTML 校验）就是问题面板的数据源
  useEffect(() => subscribeProblems(cwd, setProblems), [cwd])

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
            (t) =>
              t &&
              typeof t.key === 'string' &&
              typeof t.rel === 'string' &&
              (t.kind === 'file' || t.kind === 'image' || t.kind === 'diff')
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
          if (!r.ok) throw new Error(r.message || t('ide.openFailedUnknown'))
          // 崩溃前没来得及保存的草稿优先于磁盘内容；baseText 仍记磁盘文本，
          // 这样标签会保持「未保存」状态，保存时照常走冲突检测。
          const draft = pendingDraftsRef.current[tab.rel]
          const restored =
            typeof draft === 'string' && draft !== r.data.text
              ? { ...r.data, text: draft }
              : r.data
          setFileCache((m) => ({ ...m, [tab.rel]: restored }))
          setBaseText((m) => (tab.rel in m ? m : { ...m, [tab.rel]: r.data.text }))
          // 把相对路径 import 的目标也建进 Monaco，TS worker 才能跨文件解析
          ensureImportedModels(cwd, tab.rel, restored.text, api.ide.readFile)
        } else if (tab.kind === 'image') {
          const r = await api.ide.readImage(cwd, tab.rel)
          if (!r.ok) throw new Error(r.message || t('ide.openFailedUnknown'))
          setImageCache((m) => ({ ...m, [tab.rel]: r.data }))
        } else {
          const r = await api.vcs.diff({ cwd, rel: tab.rel, source: 'head' })
          if (!r.ok) throw new Error(r.error.message || t('ide.openFailedUnknown'))
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
    [api, cwd, fileCache, imageCache, diffCache, t]
  )

  useEffect(() => {
    if (activeTab) void ensureTab(activeTab)
  }, [activeTab, ensureTab])

  const openTab = useCallback((tab: Tab, line?: number) => {
    setTabs((list) => {
      if (list.some((t) => t.key === tab.key)) return list
      if (!tab.pinned) return [...list, tab]
      // 重新打开固定页签时放回固定区末尾，而不是追加到普通页签后面
      const index = list.filter((t) => t.pinned).length
      const next = [...list]
      next.splice(index, 0, tab)
      return next
    })
    setActiveKey(tab.key)
    if (tab.kind === 'file' && line) setJump({ rel: tab.rel, line })
  }, [])

  const openFile = useCallback(
    (rel: string, line?: number, recordHistory = true) => {
      if (recordHistory) {
        const h = navHistoryRef.current
        const last = h.list[h.index]
        if (!last || last.rel !== rel || last.line !== line) {
          h.list = [...h.list.slice(0, h.index + 1), { rel, line }].slice(-50)
          h.index = h.list.length - 1
        }
      }
      setView('files')
      setSidebarOpen(true)
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

  /**
   * 一次打开一批 diff 页签（「审阅本轮改动」）。
   *
   * 和逐个 `openDiff` 的区别只在**激活哪一个**：连开多个页签时每个
   * `openTab` 都会改 activeKey，最后一个赢 —— 用户看到的是清单末尾那个
   * 文件。这里统一插进去，再把焦点放回第一个。
   *
   * 已存在的页签不重复插入（`openTab` 本身也去重），但仍然参与排序：
   * 用户可能已经开着其中几个。
   */
  const openDiffs = useCallback(
    (rels: string[]) => {
      const clean = rels.filter((r, i) => !!r && rels.indexOf(r) === i)
      if (clean.length === 0) return
      const wanted = clean.map((rel) => tabOf('diff', rel))
      setTabs((list) => {
        const known = new Set(list.map((t) => t.key))
        const add = wanted.filter((t) => !known.has(t.key))
        return add.length > 0 ? [...list, ...add] : list
      })
      /*
       * 已经开着的 diff 页签不会走 ensureTab（activeTab 没变，effect 不重跑），
       * 而磁盘在这一轮里可能又变了。直接重拉一遍；新页签由 ensureTab 负责，
       * 这里多拉一次也无害。
       */
      for (const rel of clean) void revalidateDiff(rel)
      setActiveKey(wanted[0].key)
      setView('files')
    },
    [revalidateDiff]
  )

  /*
   * Monaco 默认会在**同一个编辑器实例**里切换 model 来跳转到另一个文件，
   * 但我们的标签 / 状态栏由 React 管理，直接切 model 会让两边对不上。
   * 拦截 openCodeEditor：跨文件跳转走 openFile，打开（或聚焦）真正的标签。
   */
  useEffect(() => {
    const disposable = monaco.editor.registerEditorOpener({
      openCodeEditor(_source, resource, selectionOrPosition) {
        const rel = relFromUri(resource, cwd)
        if (!rel) {
          // 工作区外的目标（node_modules 类型声明、lib.d.ts 等）没有 tab 可开。
          // 放行会让 Monaco 直接换 model，和 React 管理的标签状态对不上。
          showFlash(t('ide.outsideWorkspace'))
          return true
        }
        let line: number | undefined
        if (selectionOrPosition) {
          line =
            'startLineNumber' in selectionOrPosition
              ? selectionOrPosition.startLineNumber
              : selectionOrPosition.lineNumber
        }
        openFile(rel, line)
        return true
      }
    })
    return () => disposable.dispose()
  }, [cwd, openFile, showFlash, t])

  /** 跳转到文件某一行；已经在当前文件时直接动编辑器，避免同一行点两次没反应 */
  const jumpTo = useCallback(
    (rel: string, line: number) => {
      const tab = tabOf(isImageRel(rel) ? 'image' : 'file', rel)
      if (activeKey === tab.key) {
        const editor = activeEditor()
        if (editor) {
          editor.revealLineInCenter(line)
          editor.setPosition({ lineNumber: Math.max(1, line), column: 1 })
          editor.focus()
          return
        }
      }
      openFile(rel, line)
    },
    [activeKey, openFile]
  )

  const goBack = useCallback((): boolean => {
    const h = navHistoryRef.current
    if (h.index <= 0) return false
    h.index -= 1
    const entry = h.list[h.index]
    if (entry) openFile(entry.rel, entry.line, false)
    return true
  }, [openFile])

  const goForward = useCallback((): boolean => {
    const h = navHistoryRef.current
    if (h.index >= h.list.length - 1) return false
    h.index += 1
    const entry = h.list[h.index]
    if (entry) openFile(entry.rel, entry.line, false)
    return true
  }, [openFile])

  const reopenClosedTab = useCallback((): void => {
    const tab = closedTabsRef.current.shift()
    if (!tab) {
      showFlash(t('ide.command.reopenEmpty'))
      return
    }
    openTab(tab)
  }, [openTab, showFlash, t])

  const switchTab = useCallback(
    (delta: number): void => {
      if (tabs.length < 2) return
      const index = tabs.findIndex((x) => x.key === activeKey)
      const next = tabs[(index + delta + tabs.length) % tabs.length]
      if (next) setActiveKey(next.key)
    },
    [activeKey, tabs]
  )

  /** 命令面板 / 空状态 / 右键菜单里显示的当前按键 */
  const displayBindingOf = useCallback(
    (id: string): string | undefined => {
      const binding = resolvedKeybindings[id]
      return binding ? formatBinding(binding) : undefined
    },
    [resolvedKeybindings]
  )

  /**
   * 在资源管理器中显示当前文件：切回文件视图、展开到文件所在目录，
   * 并把该文件选中。TreeDir 根据 reveal.rel 自动展开祖先目录；
   * 目录是异步读的，滚动由下面的 effect 轮询等待。
   */
  const revealInExplorer = useCallback((): void => {
    if (!activeTab || !activeTab.rel) {
      showFlash(t('ide.command.noActiveFile'))
      return
    }
    const rel = activeTab.rel
    setView('files')
    setSidebarOpen(true)
    setTreeTarget({ rel, kind: 'file' })
    setReveal((prev) => ({ rel, nonce: (prev?.nonce ?? 0) + 1 }))
  }, [activeTab, showFlash, t])

  /** 在系统文件管理器里打开当前文件所在目录，并选中当前文件 */
  const openContainingFolder = useCallback((): void => {
    // 当前在设置页签时，退回到文件树里选中的文件
    const rel = activeTab?.rel || (treeTarget.kind === 'file' ? treeTarget.rel : '')
    if (!rel) {
      setNotice(t('ide.command.noActiveFile'))
      return
    }
    const reveal = api?.ide?.revealInOs
    if (!reveal) {
      setNotice(t('ide.command.openContainingFailed'))
      return
    }
    void reveal(cwd, rel)
      .then((r) => {
        if (!r.ok) setNotice(r.message || t('ide.command.openContainingFailed'))
      })
      .catch(() => setNotice(t('ide.command.openContainingFailed')))
  }, [activeTab, api, cwd, t, treeTarget])

  /** 快捷键页签里的改动：先本地生效，再把整份设置写回主进程 */
  /** 把设置补丁写回主进程；编辑器设置和快捷键页签共用 */
  const saveSettingsPatch = useCallback(
    (patch: Partial<Settings>): void => {
      if (patch.keybindings) setKeybindingOverrides(patch.keybindings)
      if (patch.editor) setEditorPrefs(normalizeEditorSettings(patch.editor))
      if (patch.lsp) setLspEnabled(patch.lsp.enabled !== false)

      const base = settingsRef.current
      if (!base || !api?.settings) return
      const next = { ...base, ...patch }
      settingsRef.current = next
      setSettingsSaveState('saving')
      void api.settings
        .save(next)
        .then((fresh) => {
          settingsRef.current = fresh
          setSettingsSaveState('saved')
        })
        .catch(() => {
          setSettingsSaveState('error')
          setNotice(t('ide.editorSettings.failed'))
        })
    },
    [api, t]
  )

  const saveKeybindings = useCallback(
    (next: KeybindingOverrides): void => {
      saveSettingsPatch({ keybindings: next })
    },
    [saveSettingsPatch]
  )

  /** 打开设置弹窗；不传 section 时停留在上次看过的页签 */
  const openSettings = useCallback((section?: SettingsSection): void => {
    setQuickOpen(false)
    setPalette(null)
    if (section) setSettingsTab(section)
    setSettingsOpen(true)
  }, [])

  const closeSettings = useCallback((): void => {
    setSettingsOpen(false)
  }, [])

  useEffect(() => {
    if (!reveal || view !== 'files' || !sidebarOpen) return
    let cancelled = false
    let tries = 0
    const findRow = (): HTMLElement | undefined =>
      Array.from(document.querySelectorAll<HTMLElement>('.ide-trow[data-rel]')).find(
        (el) => el.dataset.rel === reveal.rel
      )
    const tick = (): void => {
      if (cancelled) return
      const row = findRow()
      if (row) {
        row.scrollIntoView({ block: 'nearest' })
        return
      }
      // 目录列表走 IPC，祖先目录展开后行才会出现；最多等约 2 秒
      if (tries++ < 40) window.setTimeout(tick, 50)
    }
    tick()
    return () => {
      cancelled = true
    }
  }, [reveal, sidebarOpen, view])

  const togglePanel = useCallback(
    (tab: BottomTab): void => {
      // 面板属于「文件 / 搜索」工作区；在 VCS / 同步页按快捷键时先切回来，
      // 否则状态栏按钮看起来没反应（面板被藏在上一个工作区里）
      const wasHidden = view !== 'files' && view !== 'search'
      if (wasHidden) setView('files')
      // 从 VCS / 同步页切回来时总是打开；只有已经在文件页才做开关切换
      if (panelTab === tab && !wasHidden) {
        setPanelOpen((v) => !v)
      } else {
        setPanelTab(tab)
        setPanelOpen(true)
      }
    },
    [panelTab, view]
  )

  /*
   * 从聊天窗口的工具卡点过来：主进程把目标放在首屏 query 里
   * （`?file=src/app.ts&line=42`）。只在首次加载时读一次。
   *
   * `diff=1` 是「审阅本轮改动」：按 diff 页签打开，`more` 里是同一批的
   * 其余文件（JSON 数组，见 ide-window 的 rendererUrl）。
   */
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const file = params.get('file')
    if (!file) return
    const n = Number(params.get('line'))
    if (params.get('diff') === '1') {
      const rest = parseMoreRels(params.get('more'))
      openDiffs([file, ...rest])
      return
    }
    openFile(file, Number.isFinite(n) && n > 0 ? n : undefined)
  }, [openDiffs, openFile])

  // 窗口已经开着时走 IPC：在现有标签里直接定位，不再开第二个窗口
  useEffect(() => {
    return window.api?.ide?.onReveal((target) => {
      if (target.diff) openDiffs([target.rel, ...(target.more ?? [])])
      else openFile(target.rel, target.line)
    })
  }, [openDiffs, openFile])

  const closeTabs = useCallback(
    (keys: string[]) => {
      const set = new Set(keys)
      if (set.size === 0) return
      const closing = tabs.filter((t) => set.has(t.key))
      if (closing.length === 0) return

      for (const tab of closing) {
        clearExternal(tab.rel)
        // 关闭 = 放弃这个缓冲区。缓存留着的话，「重新打开」会把已经
        // 明确丢弃的脏内容又带回来，草稿也会被下一次持久化写回去。
        delete pendingDraftsRef.current[tab.rel]
        if (tab.kind === 'file') {
          setFileCache((m) => {
            if (!(tab.rel in m)) return m
            const next = { ...m }
            delete next[tab.rel]
            return next
          })
          setBaseText((m) => {
            if (!(tab.rel in m)) return m
            const next = { ...m }
            delete next[tab.rel]
            return next
          })
        } else if (tab.kind === 'image') {
          setImageCache((m) => {
            const next = { ...m }
            delete next[tab.rel]
            return next
          })
        } else {
          setDiffCache((m) => {
            const next = { ...m }
            delete next[tab.rel]
            return next
          })
        }
      }
      closedTabsRef.current = [...closing, ...closedTabsRef.current].slice(0, 20)

      setTabs((list) => {
        const next = list.filter((t) => !set.has(t.key))
        setActiveKey((cur) => {
          if (!cur || !set.has(cur)) return cur
          const oldIndex = list.findIndex((t) => t.key === cur)
          if (oldIndex < 0) return next[0]?.key ?? null
          // 优先选右侧最近的存活页签，其次左侧；和常见编辑器一致
          for (let d = 1; d < list.length; d++) {
            const after = list[oldIndex + d]
            if (after && !set.has(after.key)) return after.key
            const before = list[oldIndex - d]
            if (before && !set.has(before.key)) return before.key
          }
          return next[0]?.key ?? null
        })
        return next
      })
    },
    [clearExternal, tabs]
  )

  const closeTab = useCallback((key: string) => closeTabs([key]), [closeTabs])

  /* ── 保存 / 脏状态 ───────────────────────────────────── */

  const refresh = useCallback((): void => {
    setTreeVersion((v) => v + 1)
    void vcs.refresh()
  }, [vcs])

  const saveDoc = useCallback(
    async (
      rel: string,
      force = false,
      encoding?: IdeEncoding,
      alwaysWrite = false
    ): Promise<boolean> => {
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
      if (
        !isDirty(rel) &&
        !force &&
        !alwaysWrite &&
        external[extKey(rel)] !== 'deleted'
      ) {
        return true
      }
      // 同一个文件已有保存在飞：等它完成，自动保存会在下一轮看到新的脏状态
      if (!force && (savingRelsRef.current.get(extKey(rel)) ?? 0) > 0) return true

      const savingKey = extKey(rel)
      // 「保存时删除行尾空白」只在写盘前生效一次；编辑器内容同步更新，
      // 撤销栈仍然是 Monaco 自己的，不怕误删。
      const text = editorPrefs.trimTrailingWhitespace
        ? file.text.replace(/[ \t]+$/gm, '')
        : file.text
      if (text !== file.text) {
        setFileCache((m) =>
          m[rel] ? { ...m, [rel]: { ...m[rel], text } } : m
        )
      }
      setSavingRel(rel)
      savingRelsRef.current.set(savingKey, (savingRelsRef.current.get(savingKey) ?? 0) + 1)
      try {
        const r = await api.ide.saveFile({
          cwd,
          rel,
          text,
          expectedMtimeMs: file.mtimeMs,
          eol: file.eol,
          encoding: encoding ?? file.encoding,
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
                    await saveDoc(rel, true, encoding, alwaysWrite)
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
                    await saveDoc(rel, true, encoding, alwaysWrite)
                  }
                }
              ]
            })
          } else {
            setNotice(t('ide.saveFailed', { error: r.message }))
          }
          return false
        }
        // 保存期间用户可能继续输入：这种情况下不能拿磁盘快照覆盖当前缓冲区，
        // 只更新 mtime 等元数据；baseText 用刚写盘的文本，标签继续保持未保存。
        setFileCache((m) => {
          const cur = m[rel]
          if (cur && cur.text !== text) {
            return {
              ...m,
              [rel]: {
                ...cur,
                size: r.data.size,
                mtimeMs: r.data.mtimeMs,
                eol: r.data.eol,
                encoding: r.data.encoding
              }
            }
          }
          return { ...m, [rel]: r.data }
        })
        setBaseText((m) => ({ ...m, [rel]: r.data.text }))
        delete pendingDraftsRef.current[rel]
        clearExternal(rel)
        ensureImportedModels(cwd, rel, r.data.text, api.ide.readFile)
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
    [api, clearExternal, cwd, editorPrefs.trimTrailingWhitespace, external, fileCache, isDirty, showFlash, vcs]
  )

  /** 以指定编码重新读盘；有未保存修改时不允许，避免直接覆盖缓冲区 */
  const reopenWithEncoding = useCallback(
    async (rel: string, encoding: IdeEncoding): Promise<void> => {
      if (!api?.ide) return
      if (isDirty(rel)) {
        setNotice(t('ide.encoding.unsaved'))
        return
      }
      const r = await api.ide.readFile(cwd, rel, encoding)
      if (!r.ok) {
        setNotice(t('ide.openFailed', { error: r.message }))
        return
      }
      setFileCache((m) => ({ ...m, [rel]: r.data }))
      setBaseText((m) => ({ ...m, [rel]: r.data.text }))
      clearExternal(rel)
      ensureImportedModels(cwd, rel, r.data.text, api.ide.readFile)
      showFlash(
        t('ide.encoding.reopened', {
          encoding: t(ENCODING_LABEL_KEY[encoding])
        })
      )
    },
    [api, clearExternal, cwd, isDirty, showFlash, t]
  )

  /** 按指定编码写盘；即使文件没有修改也强制写一次，用于编码转换 */
  const saveWithEncoding = useCallback(
    (rel: string, encoding: IdeEncoding): void => {
      void saveDoc(rel, false, encoding, true)
    },
    [saveDoc]
  )

  const saveAll = useCallback(async (): Promise<boolean> => {
    // 逐个保存：遇到外部改动时只弹一次确认，不把后面的文件也一起覆盖
    for (const rel of dirtyRels) {
      if (!(await saveDoc(rel))) return false
    }
    return true
  }, [dirtyRels, saveDoc])

  /* ── 自动保存 / 崩溃恢复 ─────────────────────────────── */

  const dirtyRelsRef = useRef(dirtyRels)
  dirtyRelsRef.current = dirtyRels
  const saveDocRef = useRef(saveDoc)
  saveDocRef.current = saveDoc

  // 停止输入后自动保存。弹窗 / 新建输入条开着时先让路，避免一次保存
  // 在用户还没处理完冲突时又弹出第二个对话框。
  useEffect(() => {
    if (editorPrefs.autoSave !== 'afterDelay') return
    if (dirtyRels.length === 0 || dialog || prompt || creating) return
    const timer = window.setTimeout(() => {
      void (async () => {
        // 顺序保存：遇到冲突对话框就停下来，不要同时弹好几个
        for (const rel of [...dirtyRelsRef.current]) {
          if (!isDirty(rel)) continue
          if (!(await saveDocRef.current(rel))) break
        }
      })()
    }, editorPrefs.autoSaveDelayMs)
    return () => window.clearTimeout(timer)
  }, [
    creating,
    dialog,
    dirtyRels,
    editorPrefs.autoSave,
    editorPrefs.autoSaveDelayMs,
    isDirty,
    prompt
  ])

  // 窗口失焦时保存（切到浏览器 / 终端再回来，通常比定时保存更符合直觉）
  useEffect(() => {
    if (editorPrefs.autoSave !== 'onFocusChange') return
    const onBlur = (): void => {
      void (async () => {
        for (const rel of [...dirtyRelsRef.current]) {
          if (!isDirty(rel)) continue
          if (!(await saveDocRef.current(rel))) break
        }
      })()
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [editorPrefs.autoSave, isDirty])

  /**
   * 把未保存的草稿写进 localStorage。崩溃 / 断电后下次打开同一个工作区，
   * ensureTab 会用草稿覆盖磁盘文本，但 baseText 仍保留磁盘内容，
   * 所以标签保持「未保存」，保存时照常走冲突检测。
   */
  const persistDrafts = useCallback((): void => {
    if (!draftsLoadedRef.current || discardDraftsRef.current) return
    const { fileCache: cache, baseText: bases } = liveRef.current
    const candidates: Record<string, string> = {}
    // 还没被打开过的标签：保留上次读进来的草稿
    for (const [rel, text] of Object.entries(pendingDraftsRef.current)) {
      if (!(rel in cache)) candidates[rel] = text
    }
    // 已打开的文件：只存真正脏的；用户改回磁盘内容时草稿要消失
    for (const [rel, file] of Object.entries(cache)) {
      if (!file || file.binary || file.truncated) continue
      const base = bases[rel]
      if (base === undefined || file.text === base) continue
      if (file.text.length > DRAFT_FILE_MAX_CHARS) continue
      candidates[rel] = file.text
    }
    const next: Record<string, string> = {}
    let total = 0
    for (const [rel, text] of Object.entries(candidates)) {
      if (total + text.length > DRAFT_TOTAL_MAX_CHARS) break
      next[rel] = text
      total += text.length
    }
    pendingDraftsRef.current = next
    writeDrafts(cwd, next)
  }, [cwd])

  useEffect(() => {
    if (!draftsLoadedRef.current) return
    const timer = window.setTimeout(persistDrafts, 400)
    return () => window.clearTimeout(timer)
  }, [baseText, fileCache, persistDrafts])

  useEffect(() => {
    const flush = (): void => persistDrafts()
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [persistDrafts])

  /* ── 新建 / 重命名 / 删除 ───────────────────────────── */

  const startCreate = useCallback(
    (kind: 'file' | 'dir', target?: TreeTarget) => {
      const t = target ?? treeTarget
      const dirRel = t.kind === 'dir' ? t.rel : dirOfRel(t.rel)
      setMenu(null)
      setView('files')
      setSidebarOpen(true)
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
      // 还没打开过的草稿也按新路径存，否则重命名后恢复不到
      const drafts: Record<string, string> = {}
      for (const [rel, text] of Object.entries(pendingDraftsRef.current)) {
        drafts[remapPath(rel, oldRel, newRel)] = text
      }
      pendingDraftsRef.current = drafts
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

  /** 快捷键 / 命令面板调用的「重命名选中的文件树项」 */
  const renameTreeTarget = useCallback((): void => {
    const target = treeTargetRef.current
    if (!target.rel) return
    setPrompt({
      title: t('ide.renameTitle'),
      message: t('ide.renameMessage'),
      value: target.rel,
      confirmLabel: t('ide.rename'),
      run: (value) => renameTarget(target, value)
    })
  }, [renameTarget, t])

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
      for (const rel of Object.keys(pendingDraftsRef.current)) {
        if (underPath(rel, prefix)) delete pendingDraftsRef.current[rel]
      }
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

  /** 快捷键 / 命令面板调用的「删除选中的文件树项」 */
  const deleteTreeTarget = useCallback((): void => {
    const target = treeTargetRef.current
    if (target.rel) requestDelete(target)
  }, [requestDelete])

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

  /** 拖动页签排序；固定页签始终留在左侧 */
  const reorderTab = useCallback((fromKey: string, toKey: string, after: boolean): void => {
    setTabs((list) => {
      const from = list.find((t) => t.key === fromKey)
      const target = list.find((t) => t.key === toKey)
      if (!from || !target || fromKey === toKey) return list
      const without = list.filter((t) => t.key !== fromKey)
      let index = without.findIndex((t) => t.key === toKey) + (after ? 1 : 0)
      if (!!from.pinned !== !!target.pinned) {
        // 跨固定区拖动时落在分组边界，不把两种页签混在一起
        index = without.filter((t) => t.pinned).length
      }
      const next = [...without]
      next.splice(index, 0, from)
      return next
    })
  }, [])

  const togglePin = useCallback((key: string): void => {
    setTabs((list) => {
      const tab = list.find((t) => t.key === key)
      if (!tab) return list
      const without = list.filter((t) => t.key !== key)
      const pinnedCount = without.filter((t) => t.pinned).length
      const next = [...without]
      next.splice(pinnedCount, 0, { ...tab, pinned: !tab.pinned })
      return next
    })
  }, [])

  /** 批量关闭：有脏文件时先问「保存 / 不保存」 */
  const closeManyWithPrompt = useCallback(
    (keys: string[]): void => {
      const targets = tabs.filter((t) => keys.includes(t.key))
      if (targets.length === 0) return
      const dirty = targets.filter((t) => t.kind === 'file' && isDirty(t.rel))
      if (dirty.length === 0) {
        closeTabs(keys)
        return
      }
      setDialog({
        title: t('ide.tab.closeManyTitle'),
        message: t('ide.tab.closeManyMessage', { n: dirty.length }),
        actions: [
          { label: t('common.cancel'), run: () => undefined },
          {
            label: t('ide.tab.dontSaveAndClose'),
            kind: 'danger',
            run: () => closeTabs(keys)
          },
          {
            label: t('ide.tab.saveAndClose'),
            kind: 'primary',
            run: async () => {
              for (const item of dirty) {
                if (!(await saveDoc(item.rel))) return
              }
              closeTabs(keys)
            }
          }
        ]
      })
    },
    [tabs, isDirty, closeTabs, saveDoc, t]
  )

  const copyTabPath = useCallback(
    (rel: string): void => {
      void navigator.clipboard
        .writeText(rel)
        .then(() => showFlash(t('ide.tab.copied')))
        .catch(() => undefined)
    },
    [showFlash, t]
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
          run: () => {
            // 明确选择「不保存」= 放弃草稿，下次打开不能再恢复出来
            discardDraftsRef.current = true
            pendingDraftsRef.current = {}
            writeDrafts(cwd, {})
            api?.ide?.confirmClose()
          }
        },
        {
          label: t('ide.saveAllAndClose'),
          kind: 'primary',
          run: async () => {
            // 保存成功的文件由 saveDoc 自己删草稿；还没打开过的标签的草稿
            // 要保留，所以这里不设 discard 标记。
            if (await saveAll()) api?.ide?.confirmClose()
          }
        }
      ]
    })
  }, [api, cwd, dirtyCount, saveAll])

  useEffect(() => {
    api?.ide?.setDirty(dirtyCount > 0)
  }, [api, dirtyCount])

  useEffect(() => {
    setEncodingMenuOpen(false)
  }, [activeKey])

  useEffect(() => api?.ide?.onCloseRequest(requestWindowClose), [api, requestWindowClose])

  useEffect(() => {
    /** 终端有焦点时仍然放行的应用级命令；其余按键留给 shell / readline */
    const TERMINAL_GLOBAL = new Set([
      'view.toggleTerminal',
      'view.commandPalette',
      'view.toggleProblems',
      'search.workspace',
      'view.settings'
    ])
    /** 只在文件树有选中项、且焦点不在输入框时响应的命令 */
    const TREE_ONLY = new Set(['explorer.rename', 'explorer.delete'])

    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      const typing =
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'INPUT' ||
        target?.isContentEditable === true

      // 设置弹窗自己有键盘处理（Esc 关闭、快捷键录制），不要再触发编辑器命令
      if (settingsOpenRef.current) return

      if (e.key === 'Escape') {
        setQuickOpen(false)
        setPalette(null)
        setMenu(null)
        return
      }

      const inTerminal = !!(target?.closest?.('.xterm'))
      for (const command of commandsRef.current) {
        const binding = keybindingsRef.current[command.id]
        if (!binding || !matchBinding(binding, e)) continue
        // 终端里的 Ctrl+W / Ctrl+P / Alt+← 等是 shell 的输入，不能抢
        if (inTerminal && !TERMINAL_GLOBAL.has(command.id)) return
        if (
          TREE_ONLY.has(command.id) &&
          (typing || !treeTargetRef.current.rel)
        ) {
          return
        }
        e.preventDefault()
        e.stopPropagation()
        void command.run()
        return
      }
    }
    // 捕获阶段：Ctrl+G / Ctrl+Shift+O 等 Monaco 自己也有绑定，先由应用层
    // 决定用哪个实现，避免两个浮层同时打开。
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const activeFile = activeTab?.kind === 'file' ? fileCache[activeTab.rel] : undefined
  const activeImage = activeTab?.kind === 'image' ? imageCache[activeTab.rel] : undefined
  const activeDiff = activeTab?.kind === 'diff' ? diffCache[activeTab.rel] : undefined

  // 切回一个已经缓存的文件时 ensureTab 不会再读盘，这里补一次 import 扫描。
  // 不在每次敲键时重扫：保存 / 切标签已经覆盖了 import 变化的场景。
  useEffect(() => {
    if (!api?.ide || !activeTab || activeTab.kind !== 'file' || !activeFile) return
    ensureImportedModels(cwd, activeTab.rel, activeFile.text, api.ide.readFile)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.key, api, cwd])

  /** 当前文件的大纲：优先用 LSP，服务器不可用时回落到正则扫描 */
  const [outlineSymbols, setOutlineSymbols] = useState<OutlineSymbol[]>([])
  const outlineRel = activeTab?.kind === 'file' ? activeTab.rel : null
  const outlineText = activeFile?.text
  const outlineLspReady = !!activeLanguage && lspStates[activeLanguage]?.state === 'ready'
  const outlineRelRef = useRef<string | null>(null)
  outlineCountRef.current = outlineSymbols.length
  useEffect(() => {
    if (!outlineRel || outlineText === undefined) {
      outlineRelRef.current = null
      setOutlineSymbols([])
      return
    }

    // 切文件时立刻给出正则结果，避免上一份大纲短暂停留；同一个文件里
    // 打字则走防抖，不要每个按键都扫一遍全文。
    const relChanged = outlineRelRef.current !== outlineRel
    outlineRelRef.current = outlineRel
    if (relChanged) setOutlineSymbols(parseOutline(outlineText, outlineRel))

    if (!lspEnabled || !outlineLspReady) {
      if (relChanged) return
      const timer = window.setTimeout(
        () => setOutlineSymbols(parseOutline(outlineText, outlineRel)),
        180
      )
      return () => window.clearTimeout(timer)
    }

    let cancelled = false
    const timer = window.setTimeout(async () => {
      const model = activeEditor()?.getModel()
      const symbols =
        model && relFromUri(model.uri, cwd) === outlineRel
          ? await lspDocumentSymbols(model)
          : []
      if (!cancelled) {
        // 服务器没给符号（还在索引 / 不支持）时退回正则
        setOutlineSymbols(symbols.length ? symbols : parseOutline(outlineText, outlineRel))
      }
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [
    outlineRel,
    outlineText,
    lspEnabled,
    outlineLspReady,
    cwd,
    lspDocumentSymbols
  ])

  const symbolCommands = useMemo<CommandItem[]>(() => {
    if (!activeTab || activeTab.kind !== 'file') return []
    return outlineSymbols.map((s, i) => ({
      id: `sym:${i}:${s.line}:${s.name}`,
      label: s.name,
      group: t(OUTLINE_KIND_KEY[s.kind]),
      keybinding: String(s.line),
      run: () => jumpTo(activeTab.rel, s.line)
    }))
  }, [activeTab, jumpTo, outlineSymbols, t])

  /** Ctrl+T：把工作区符号结果转成快速打开面板能直接执行的条目 */
  const searchWorkspaceSymbols = useCallback(
    async (query: string): Promise<CommandItem[]> => {
      const symbols = await lspWorkspaceSymbols(query, activeLanguage ?? undefined)
      return symbols.map((s, i) => ({
        id: `wsym:${i}:${s.rel}:${s.line}:${s.column}:${s.name}`,
        label: s.name,
        group: s.containerName ? `${s.containerName} · ${s.rel}` : s.rel,
        keybinding: String(s.line),
        run: () => jumpTo(s.rel, s.line)
      }))
    },
    [activeLanguage, jumpTo, lspWorkspaceSymbols]
  )

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
          {activeFile.binary || activeFile.truncated ? (
            <span>{t(ENCODING_LABEL_KEY[activeFile.encoding])}</span>
          ) : (
            <button
              type="button"
              className="ide-status-encoding"
              title={t('ide.encoding.button')}
              onClick={() => setEncodingMenuOpen(true)}
            >
              {t(ENCODING_LABEL_KEY[activeFile.encoding])}
            </button>
          )}
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

  const problemErrors = problems.filter((p) => p.severity === 'error').length
  const problemWarnings = problems.filter((p) => p.severity === 'warning').length
  const panelVisible = panelOpen && (view === 'files' || view === 'search')

  const commands = useMemo<CommandItem[]>(() => {
    const file = t('ide.command.group.file')
    const edit = t('ide.command.group.edit')
    const view = t('ide.command.group.view')
    const nav = t('ide.command.group.nav')
    return [
      {
        id: 'file.save',
        label: t('ide.command.save'),
        group: file,
        keybinding: displayBindingOf('file.save'),
        run: () => {
          if (activeTab?.kind === 'file') void saveDoc(activeTab.rel)
        }
      },
      {
        id: 'file.saveAll',
        label: t('ide.command.saveAll'),
        group: file,
        keybinding: displayBindingOf('file.saveAll'),
        run: () => void saveAll()
      },
      {
        id: 'file.newFile',
        label: t('ide.command.newFile'),
        group: file,
        keybinding: displayBindingOf('file.newFile'),
        run: () => startCreate('file')
      },
      {
        id: 'file.newFolder',
        label: t('ide.command.newFolder'),
        group: file,
        keybinding: displayBindingOf('file.newFolder'),
        run: () => startCreate('dir')
      },
      {
        id: 'file.quickOpen',
        label: t('ide.command.quickOpen'),
        group: file,
        keybinding: displayBindingOf('file.quickOpen'),
        run: () => {
          setQuickOpenSeed('')
          setQuickOpen(true)
        }
      },
      {
        id: 'file.closeTab',
        label: t('ide.command.closeTab'),
        group: file,
        keybinding: displayBindingOf('file.closeTab'),
        run: () => {
          if (activeKey) requestCloseTab(activeKey)
        }
      },
      {
        id: 'file.reopenTab',
        label: t('ide.command.reopenTab'),
        group: file,
        keybinding: displayBindingOf('file.reopenTab'),
        run: reopenClosedTab
      },
      {
        id: 'file.revealInExplorer',
        label: t('ide.command.revealInExplorer'),
        group: file,
        keybinding: displayBindingOf('file.revealInExplorer'),
        run: revealInExplorer
      },
      {
        id: 'file.openContainingFolder',
        label: t('ide.command.openContainingFolder'),
        group: file,
        keybinding: displayBindingOf('file.openContainingFolder'),
        run: openContainingFolder
      },
      {
        id: 'explorer.rename',
        label: t('ide.command.rename'),
        group: file,
        keybinding: displayBindingOf('explorer.rename'),
        run: renameTreeTarget
      },
      {
        id: 'explorer.delete',
        label: t('ide.command.delete'),
        group: file,
        keybinding: displayBindingOf('explorer.delete'),
        run: deleteTreeTarget
      },
      {
        id: 'search.workspace',
        label: t('ide.command.search'),
        group: edit,
        keybinding: displayBindingOf('search.workspace'),
        run: () => {
          setView('search')
          setSidebarOpen(true)
        }
      },
      {
        id: 'edit.format',
        label: t('ide.command.format'),
        group: edit,
        keybinding: displayBindingOf('edit.format'),
        run: () => {
          void formatActiveDocument().then((ok) => {
            if (!ok) setNotice(t('ide.command.formatUnavailable'))
          })
        }
      },
      {
        id: 'nav.goToLine',
        label: t('ide.command.goToLine'),
        group: nav,
        keybinding: displayBindingOf('nav.goToLine'),
        run: () => {
          if (!runEditorAction('editor.action.gotoLine')) {
            setNotice(t('ide.command.noEditor'))
          }
        }
      },
      {
        id: 'nav.goToSymbol',
        label: t('ide.command.goToSymbol'),
        group: nav,
        keybinding: displayBindingOf('nav.goToSymbol'),
        run: () => {
          if (outlineSymbols.length === 0) {
            showFlash(t('ide.command.symbolEmpty'))
            return
          }
          setPalette('symbols')
        }
      },
      {
        id: 'nav.goToWorkspaceSymbol',
        label: t('ide.command.goToWorkspaceSymbol'),
        group: nav,
        keybinding: displayBindingOf('nav.goToWorkspaceSymbol'),
        run: () => {
          setPalette(null)
          setQuickOpenSeed('#')
          setQuickOpen(true)
        }
      },
      {
        id: 'nav.quickFix',
        label: t('ide.command.quickFix'),
        group: nav,
        keybinding: displayBindingOf('nav.quickFix'),
        run: () => {
          if (!runEditorAction('editor.action.quickFix')) {
            setNotice(t('ide.command.noEditor'))
          }
        }
      },
      {
        id: 'nav.goToDeclaration',
        label: t('ide.command.goToDeclaration'),
        group: nav,
        keybinding: displayBindingOf('nav.goToDeclaration'),
        run: () => {
          if (!runEditorAction('editor.action.revealDeclaration')) {
            setNotice(t('ide.command.noEditor'))
          }
        }
      },
      {
        id: 'nav.goToImplementation',
        label: t('ide.command.goToImplementation'),
        group: nav,
        keybinding: displayBindingOf('nav.goToImplementation'),
        run: () => {
          if (!runEditorAction('editor.action.goToImplementation')) {
            setNotice(t('ide.command.noEditor'))
          }
        }
      },
      {
        id: 'nav.goToTypeDefinition',
        label: t('ide.command.goToTypeDefinition'),
        group: nav,
        keybinding: displayBindingOf('nav.goToTypeDefinition'),
        run: () => {
          if (!runEditorAction('editor.action.goToTypeDefinition')) {
            setNotice(t('ide.command.noEditor'))
          }
        }
      },
      {
        id: 'nav.signatureHelp',
        label: t('ide.command.signatureHelp'),
        group: nav,
        keybinding: displayBindingOf('nav.signatureHelp'),
        run: () => {
          if (!runEditorAction('editor.action.triggerParameterHints')) {
            setNotice(t('ide.command.noEditor'))
          }
        }
      },
      {
        id: 'nav.back',
        label: t('ide.command.navBack'),
        group: nav,
        keybinding: displayBindingOf('nav.back'),
        run: () => {
          if (!goBack()) showFlash(t('ide.command.backEmpty'))
        }
      },
      {
        id: 'nav.forward',
        label: t('ide.command.navForward'),
        group: nav,
        keybinding: displayBindingOf('nav.forward'),
        run: () => {
          if (!goForward()) showFlash(t('ide.command.backEmpty'))
        }
      },
      {
        id: 'view.settings',
        label: t('ide.command.settings'),
        group: view,
        keybinding: displayBindingOf('view.settings'),
        run: () => openSettings()
      },
      {
        id: 'view.commandPalette',
        label: t('ide.command.title'),
        group: view,
        keybinding: displayBindingOf('view.commandPalette'),
        run: () => {
          setQuickOpen(false)
          setPalette('commands')
        }
      },
      {
        id: 'view.toggleSidebar',
        label: t('ide.command.toggleSidebar'),
        group: view,
        keybinding: displayBindingOf('view.toggleSidebar'),
        run: () => setSidebarOpen((v) => !v)
      },
      {
        id: 'view.toggleProblems',
        label: t('ide.command.toggleProblems'),
        group: view,
        keybinding: displayBindingOf('view.toggleProblems'),
        run: () => togglePanel('problems')
      },
      {
        id: 'view.toggleTerminal',
        label: t('ide.command.toggleTerminal'),
        group: view,
        keybinding: displayBindingOf('view.toggleTerminal'),
        run: () => togglePanel('terminal')
      },
      {
        id: 'view.closePanel',
        label: t('ide.command.closePanel'),
        group: view,
        keybinding: displayBindingOf('view.closePanel'),
        run: () => setPanelOpen(false)
      },
      {
        id: 'view.refresh',
        label: t('ide.command.refresh'),
        group: view,
        keybinding: displayBindingOf('view.refresh'),
        run: refresh
      },
      {
        id: 'tab.next',
        label: t('ide.command.tabNext'),
        group: view,
        keybinding: displayBindingOf('tab.next'),
        run: () => switchTab(1)
      },
      {
        id: 'tab.prev',
        label: t('ide.command.tabPrev'),
        group: view,
        keybinding: displayBindingOf('tab.prev'),
        run: () => switchTab(-1)
      }
    ]
  }, [
    activeKey,
    activeTab,
    deleteTreeTarget,
    displayBindingOf,
    goBack,
    goForward,
    outlineSymbols.length,
    openContainingFolder,
    openSettings,
    refresh,
    renameTreeTarget,
    reopenClosedTab,
    requestCloseTab,
    revealInExplorer,
    saveAll,
    saveDoc,
    showFlash,
    startCreate,
    switchTab,
    t,
    togglePanel
  ])

  commandsRef.current = commands

  return (
    <div className="ide-app">
      <IdeTitleBar cwd={cwd} onClose={requestWindowClose} />

      <div className="ide-toolbar">
        <button
          className="ide-quickbtn"
          onClick={() => {
            setQuickOpenSeed('')
            setQuickOpen(true)
          }}
        >
          <IconSearch width={14} height={14} />
          <span>{t('ide.searchPlaceholder')}</span>
          {displayBindingOf('file.quickOpen') && (
            <kbd>{displayBindingOf('file.quickOpen')}</kbd>
          )}
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
          <button
            className="ide-iconbtn ide-settings-btn"
            title={`${t('ide.settings.title')}${
              displayBindingOf('view.settings') ? ` (${displayBindingOf('view.settings')})` : ''
            }`}
            onClick={() => openSettings()}
          >
            <Ico d={P.settings} />
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
          <button
            className={`ide-act ${view === 'files' ? 'on' : ''}`}
            title={t('ide.explorer')}
            onClick={() => {
              setView('files')
              setSidebarOpen(true)
            }}
          >
            <Ico d={P.files} size={17} />
          </button>
          <button
            className={`ide-act ${view === 'search' ? 'on' : ''}`}
            title={t('ide.searchCodeTitle')}
            onClick={() => {
              setView('search')
              setSidebarOpen(true)
            }}
          >
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

        <div className={`ide-files ${view === 'sync' || view === 'vcs' ? 'is-hidden' : ''}`}>
        {sidebarOpen && (
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
              {activeTab?.kind === 'file' && (
                <OutlineList
                  symbols={outlineSymbols}
                  onJump={(line) => {
                    if (activeTab?.kind === 'file') jumpTo(activeTab.rel, line)
                  }}
                />
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
                  revealRel={reveal?.rel ?? null}
                  revealSeq={reveal?.nonce ?? 0}
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
        )}

        <div className="ide-workbench">
        <section className="ide-editor">
          <div className="ide-tabs">
            {tabs.map((tab) => (
              <div
                key={tab.key}
                className={`ide-tab ${tab.key === activeKey ? 'on' : ''}${
                  tab.pinned ? ' is-pinned' : ''
                }${dragTabKey === tab.key ? ' is-dragging' : ''}${
                  dropTarget?.key === tab.key
                    ? dropTarget.after
                      ? ' is-drop-after'
                      : ' is-drop-before'
                    : ''
                }`}
                title={tab.rel}
                draggable
                onClick={() => setActiveKey(tab.key)}
                onAuxClick={(e) => {
                  if (e.button === 1) requestCloseTab(tab.key)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setActiveKey(tab.key)
                  setTabMenu({ x: e.clientX, y: e.clientY, key: tab.key })
                }}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', tab.key)
                  setDragTabKey(tab.key)
                  setDropTarget(null)
                }}
                onDragOver={(e) => {
                  if (!dragTabKey || dragTabKey === tab.key) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  const rect = e.currentTarget.getBoundingClientRect()
                  setDropTarget({
                    key: tab.key,
                    after: e.clientX > rect.left + rect.width / 2
                  })
                }}
                onDragLeave={() => {
                  if (dropTarget?.key === tab.key) setDropTarget(null)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragTabKey && dropTarget) {
                    reorderTab(dragTabKey, dropTarget.key, dropTarget.after)
                  }
                  setDragTabKey(null)
                  setDropTarget(null)
                }}
                onDragEnd={() => {
                  setDragTabKey(null)
                  setDropTarget(null)
                }}
              >
                {tab.kind === 'file' && isDirty(tab.rel) ? (
                  <span className="ide-tab-dirty" title={t('ide.unsavedDot')} />
                ) : (
                  <Ico
                    d={
                      tab.kind === 'image'
                        ? P.image
                        : tab.kind === 'diff'
                          ? P.diff
                          : P.file
                    }
                    size={12}
                  />
                )}
                <span className="ide-tab-title">{tab.title}</span>
                {tab.pinned && (
                  <span className="ide-tab-pin" title={t('ide.tab.pinned')}>
                    <Ico d={P.pin} size={10} />
                  </span>
                )}
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
                {/*
                  从 diff 回到文件本身。审阅时经常是「看差异 → 顺手改」，
                  没有这个入口就只能回文件树里再找一遍（被删掉的文件除外，
                  它打不开）。
                */}
                {activeTab.kind === 'diff' && !diffIsDeletion(activeDiff) && (
                  <button
                    className="ide-linkbtn"
                    onClick={() => openFile(activeTab.rel)}
                    title={t('ide.openFileFromDiff')}
                  >
                    {t('ide.openFile')}
                  </button>
                )}
              </span>
            </div>
          )}

          <div className="ide-content">
            {!activeTab && (
              <EmptyState
                quickOpenKey={displayBindingOf('file.quickOpen')}
                saveKey={displayBindingOf('file.save')}
                searchKey={displayBindingOf('search.workspace')}
              />
            )}
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
                  cwd={cwd}
                  file={activeFile}
                  jumpLine={jump?.rel === activeTab.rel ? jump.line : undefined}
                  prefs={editorPrefs}
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

        <BottomPanel
          open={panelOpen}
          tab={panelTab}
          onTab={setPanelTab}
          onClose={() => setPanelOpen(false)}
          problems={problems}
          onJump={jumpTo}
          terminal={
            <TerminalView
              cwd={cwd}
              active={panelVisible && panelTab === 'terminal'}
              fontSize={editorPrefs.fontSize}
            />
          }
        />
        </div>
        </div>

        {view === 'sync' && (
          <SyncWorkspace
            cwd={cwd}
            sync={sync}
            logOpen={syncLogOpen}
            onOpenLog={() => setSyncLogOpen(true)}
            onCloseLog={() => setSyncLogOpen(false)}
            onNotice={setNotice}
          />
        )}
        {view === 'vcs' && (
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
        <button
          className={`ide-status-btn ${panelVisible && panelTab === 'problems' ? 'on' : ''}`}
          title={t('ide.command.toggleProblems')}
          onClick={() => togglePanel('problems')}
        >
          <Ico d={P.alert} size={11} />
          <em className={problemErrors > 0 ? 'is-error' : undefined}>{problemErrors}</em>
          <em className={problemWarnings > 0 ? 'is-warning' : undefined}>{problemWarnings}</em>
        </button>
        <button
          className={`ide-status-btn ${panelVisible && panelTab === 'terminal' ? 'on' : ''}`}
          title={t('ide.terminal.toggle')}
          onClick={() => togglePanel('terminal')}
        >
          <Ico d={P.terminal} size={11} />
          {t('ide.terminal.title')}
        </button>
        {lspEnabled && activeLsp && (
          <span
            className={`ide-status-lsp is-${activeLsp.state}`}
            title={
              activeLsp.message ??
              (activeLsp.server
                ? t('ide.lsp.serverTip', { server: activeLsp.server })
                : t('ide.lsp.starting'))
            }
          >
            {activeLsp.state === 'ready'
              ? 'LSP'
              : activeLsp.state === 'starting'
                ? t('ide.lsp.starting')
                : t('ide.lsp.error')}
          </span>
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
        <QuickOpen
          key={quickOpenSeed || 'file'}
          cwd={cwd}
          commands={commands}
          symbols={symbolCommands}
          initialQuery={quickOpenSeed}
          searchWorkspaceSymbols={searchWorkspaceSymbols}
          onClose={() => setQuickOpen(false)}
          onOpen={(rel) => {
            setQuickOpen(false)
            openFile(rel)
          }}
        />
      )}

      {palette && (
        <CommandPalette
          commands={palette === 'symbols' ? symbolCommands : commands}
          onClose={() => setPalette(null)}
        />
      )}

      {menu && (
        <TreeMenu
          state={menu}
          renameKey={displayBindingOf('explorer.rename')}
          deleteKey={displayBindingOf('explorer.delete')}
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

      {tabMenu &&
        (() => {
          const tab = tabs.find((item) => item.key === tabMenu.key)
          if (!tab) return null
          const index = tabs.findIndex((item) => item.key === tab.key)
          const others = tabs.filter((item) => item.key !== tab.key && !item.pinned)
          const right = tabs.slice(index + 1).filter((item) => !item.pinned)
          return (
            <TabMenu
              state={tabMenu}
              tab={tab}
              closeKey={displayBindingOf('file.closeTab')}
              reopenKey={displayBindingOf('file.reopenTab')}
              canCloseOthers={others.length > 0}
              canCloseRight={right.length > 0}
              canReopen={closedTabsRef.current.length > 0}
              onClose={() => setTabMenu(null)}
              onCloseTab={() => requestCloseTab(tab.key)}
              onCloseOthers={() => closeManyWithPrompt(others.map((item) => item.key))}
              onCloseRight={() => closeManyWithPrompt(right.map((item) => item.key))}
              onCloseAll={() => closeManyWithPrompt(tabs.map((item) => item.key))}
              onTogglePin={() => togglePin(tab.key)}
              onCopyPath={() => copyTabPath(tab.rel)}
              onReopen={() => reopenClosedTab()}
            />
          )
        })()}

      {encodingMenuOpen && activeTab?.kind === 'file' && activeFile && !activeFile.binary && !activeFile.truncated && (
        <EncodingMenu
          current={activeFile.encoding}
          dirty={isDirty(activeTab.rel)}
          onReopen={(encoding) => void reopenWithEncoding(activeTab.rel, encoding)}
          onSave={(encoding) => saveWithEncoding(activeTab.rel, encoding)}
          onClose={() => setEncodingMenuOpen(false)}
        />
      )}

      {prompt && <PromptDialog state={prompt} onClose={() => setPrompt(null)} />}

      {settingsOpen && (
        <SettingsDialog
          tab={settingsTab}
          onTab={setSettingsTab}
          onClose={closeSettings}
          overrides={keybindingOverrides}
          onKeybindingsChange={saveKeybindings}
          editor={editorPrefs}
          lsp={{ enabled: lspEnabled }}
          saveState={settingsSaveState}
          onEditorChange={saveSettingsPatch}
        />
      )}

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
  revealRel,
  revealSeq = 0,
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
  /** 「在资源管理器中显示」的目标文件：位于本目录下时就自动展开 */
  revealRel?: string | null
  /** 同一个文件重复触发时靠它重新展开已经收起的目录 */
  revealSeq?: number
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
  const revealOpen =
    !!revealRel && (rel === '' || revealRel === rel || revealRel.startsWith(`${rel}/`))

  // 目标文件在更深层目录里：先展开当前层，子目录会各自继续展开
  useEffect(() => {
    if (revealOpen) setOpen(true)
  }, [revealOpen, revealSeq])

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
        data-rel={rel}
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
                revealRel={revealRel}
                revealSeq={revealSeq}
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
      data-rel={entry.rel}
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
  commands,
  symbols,
  initialQuery = '',
  searchWorkspaceSymbols,
  onClose,
  onOpen
}: {
  cwd: string
  commands: CommandItem[]
  symbols: CommandItem[]
  initialQuery?: string
  searchWorkspaceSymbols?: (query: string) => Promise<CommandItem[]>
  onClose: () => void
  onOpen: (rel: string) => void
}): JSX.Element {
  const { t } = useI18n()
  const [q, setQ] = useState(initialQuery)
  const [items, setItems] = useState<FileMatch[]>([])
  const [wsym, setWsym] = useState<CommandItem[]>([])
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState(false)
  const [wsymBusy, setWsymBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const raw = q.trim()
  const mode: 'file' | 'command' | 'symbol' | 'wsymbol' = raw.startsWith('>')
    ? 'command'
    : raw.startsWith('@')
      ? 'symbol'
      : raw.startsWith('#')
        ? 'wsymbol'
        : 'file'
  const term = mode === 'file' ? raw.toLowerCase() : raw.slice(1).trim().toLowerCase()

  const paletteItems = useMemo(() => {
    if (mode === 'file') return []
    const source =
      mode === 'command' ? commands : mode === 'symbol' ? symbols : wsym
    if (!term) return mode === 'wsymbol' ? [] : source.slice(0, 80)
    if (mode === 'wsymbol') return source.slice(0, 80)
    return source
      .filter((c) =>
        `${c.label} ${c.group ?? ''} ${c.keybinding ?? ''}`.toLowerCase().includes(term)
      )
      .slice(0, 80)
  }, [commands, mode, symbols, term, wsym])

  const count = mode === 'file' ? items.length : paletteItems.length

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setActive(0)
  }, [q, mode])

  useEffect(() => {
    if (mode !== 'file') {
      setItems([])
      setBusy(false)
      return
    }
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
  }, [q, cwd, mode])

  /* 工作区符号由语言服务器搜索，输入后防抖再发请求 */
  useEffect(() => {
    if (mode !== 'wsymbol' || !searchWorkspaceSymbols || !term) {
      setWsym([])
      setWsymBusy(false)
      return
    }
    let cancelled = false
    setWsymBusy(true)
    const timer = setTimeout(async () => {
      try {
        const result = await searchWorkspaceSymbols(term)
        if (!cancelled) {
          setWsym(result)
          setActive(0)
        }
      } catch {
        if (!cancelled) setWsym([])
      } finally {
        if (!cancelled) setWsymBusy(false)
      }
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [mode, term, searchWorkspaceSymbols])

  const choose = (m?: FileMatch): void => {
    if (mode !== 'file') {
      const item = paletteItems[active]
      if (!item) return
      onClose()
      void item.run()
      return
    }
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
            placeholder={
              mode === 'command'
                ? t('ide.command.placeholder')
                : mode === 'symbol'
                  ? t('ide.outline.show')
                  : mode === 'wsymbol'
                    ? t('ide.qo.workspaceSymbolPlaceholder')
                    : t('ide.quickOpenPlaceholder')
            }
            spellCheck={false}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(Math.max(0, count - 1), a + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(0, a - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                choose()
              }
            }}
          />
          {(busy || wsymBusy) && <span className="ide-spin" />}
        </div>
        {!q && (
          <div className="ide-qo-hint">{t('ide.quickOpenHint')}</div>
        )}
        <div className="ide-qo-list">
          {mode === 'file' &&
            items.map((m, i) => (
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
          {mode !== 'file' &&
            paletteItems.map((c, i) => (
              <button
                key={c.id}
                className={`ide-qo-row ide-palette-row ${i === active ? 'on' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose()}
              >
                <span className="ide-palette-label">{c.label}</span>
                {c.group && <span className="ide-palette-group">{c.group}</span>}
                {c.keybinding && <kbd>{c.keybinding}</kbd>}
              </button>
            ))}
          {!busy && !wsymBusy && count === 0 && (
            <div className="ide-emptyhint">
              {mode === 'file'
                ? t('ide.noMatchingFiles')
                : mode === 'wsymbol'
                  ? term
                    ? t('ide.qo.noSymbols')
                    : t('ide.qo.workspaceSymbolEmpty')
                  : t('ide.command.empty')}
            </div>
          )}
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
            {menu.sel && (
              <>
                <span className="ide-ctx-sep" />
                <button
                  onClick={() => {
                    const text = window.getSelection()?.toString() ?? ''
                    if (text) void navigator.clipboard?.writeText(text)
                    setMenu(null)
                  }}
                >
                  {t('ide.copy')}
                </button>
              </>
            )}
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
  renameKey,
  deleteKey,
  onClose,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
  onSend
}: {
  state: TreeMenuState
  renameKey?: string
  deleteKey?: string
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
              {renameKey && <kbd>{renameKey}</kbd>}
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
              {deleteKey && <kbd>{deleteKey}</kbd>}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function TabMenu({
  state,
  tab,
  closeKey,
  reopenKey,
  canCloseOthers,
  canCloseRight,
  canReopen,
  onClose,
  onCloseTab,
  onCloseOthers,
  onCloseRight,
  onCloseAll,
  onTogglePin,
  onCopyPath,
  onReopen
}: {
  state: TabMenuState
  tab: Tab
  closeKey?: string
  reopenKey?: string
  canCloseOthers: boolean
  canCloseRight: boolean
  canReopen: boolean
  onClose: () => void
  onCloseTab: () => void
  onCloseOthers: () => void
  onCloseRight: () => void
  onCloseAll: () => void
  onTogglePin: () => void
  onCopyPath: () => void
  onReopen: () => void
}): JSX.Element {
  const { t } = useI18n()
  const left = Math.max(8, Math.min(state.x, window.innerWidth - 208))
  const top = Math.max(8, Math.min(state.y, window.innerHeight - 300))

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

  const run = (fn: () => void) => (): void => {
    onClose()
    fn()
  }

  return (
    <div
      className="ide-ctx-overlay"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <div className="ide-ctx" style={{ left, top }} onMouseDown={(e) => e.stopPropagation()}>
        <button onClick={run(onCloseTab)}>
          <Ico d={P.close} size={13} />
          {t('ide.tab.close')}
          {closeKey && <kbd>{closeKey}</kbd>}
        </button>
        <button disabled={!canCloseOthers} onClick={run(onCloseOthers)}>
          {t('ide.tab.closeOthers')}
        </button>
        <button disabled={!canCloseRight} onClick={run(onCloseRight)}>
          {t('ide.tab.closeRight')}
        </button>
        <button onClick={run(onCloseAll)}>{t('ide.tab.closeAll')}</button>
        <span className="ide-ctx-sep" />
        <button onClick={run(onTogglePin)}>
          <Ico d={P.pin} size={13} />
          {tab.pinned ? t('ide.tab.unpin') : t('ide.tab.pin')}
        </button>
        <button onClick={run(onCopyPath)}>
          <Ico d={P.file} size={13} />
          {t('ide.tab.copyPath')}
        </button>
        <span className="ide-ctx-sep" />
        <button disabled={!canReopen} onClick={run(onReopen)}>
          <Ico d={P.file} size={13} />
          {t('ide.tab.reopen')}
          {reopenKey && <kbd>{reopenKey}</kbd>}
        </button>
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

function EmptyState({
  quickOpenKey,
  saveKey,
  searchKey
}: {
  quickOpenKey?: string
  saveKey?: string
  searchKey?: string
}): JSX.Element {
  const { t } = useI18n()
  return (
    <div className="ide-empty">
      <div className="ide-empty-logo">C</div>
      <div className="ide-empty-t">{t('ide.emptyTitle')}</div>
      <div className="ide-empty-s">
        {quickOpenKey && (
          <div>
            <kbd>{quickOpenKey}</kbd> {t('ide.emptyQuickOpen')}
          </div>
        )}
        {saveKey && (
          <div>
            <kbd>{saveKey}</kbd> {t('ide.emptySave')}
          </div>
        )}
        {searchKey && (
          <div>
            <kbd>{searchKey}</kbd> {t('ide.emptySearch')}
          </div>
        )}
        <div>{t('ide.emptyContextMenu')}</div>
      </div>
    </div>
  )
}
