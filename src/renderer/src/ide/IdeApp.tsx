import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from 'react'
import type {
  IdeEncoding,
  IdeEntry,
  IdeEol,
  IdeFsChanged,
  IdeImage,
  IdeListDirOptions,
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
import { SymbolBreadcrumbs } from './SymbolBreadcrumbs'
import { ReviewDock } from './ReviewDock'
import { LanguageMenu } from './LanguageMenu'
import { EolMenu } from './EolMenu'
import type { EditorConfigProperties } from '@shared/editorconfig'
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
import { activeEditor, formatActiveDocument, runEditorAction } from './editor-actions'
import {
  flushEditorText,
  getIdeCursor,
  liveEditorText,
  setIdeCursor,
  useIdeCursor
} from './editor-state'
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

/**
 * 草稿按「工作区 + 文件」分 key 存放。
 *
 * 旧版把整个工作区塞进一个 JSON 对象，每 400ms 就要把所有脏文件序列化
 * 一次（最多 150 万字符，还是同步 API）。拆开之后只写真正变化的文件，
 * 大文件编辑时的停顿会小很多。cwd 经过 encodeURIComponent，避免两个
 * 工作区路径互为前缀时串读。
 */
const draftPrefix = (cwd: string): string =>
  `ccoder:ide:draft:${encodeURIComponent(cwd)}:`
const draftKey = (cwd: string, rel: string): string => `${draftPrefix(cwd)}${rel}`
/** 旧版单键格式，启动时迁移一次 */
const legacyDraftKey = (cwd: string): string => `ccoder:ide:drafts:${cwd}`
/** 单个文件 / 整个工作区的草稿上限，避免把 localStorage 撑爆 */
const DRAFT_FILE_MAX_CHARS = 300_000
const DRAFT_TOTAL_MAX_CHARS = 1_500_000

function writeDraft(cwd: string, rel: string, text: string): boolean {
  try {
    localStorage.setItem(draftKey(cwd, rel), text)
    return true
  } catch {
    // 配额满了 / 隐私模式：草稿恢复失效，但不能影响正常编辑
    return false
  }
}

function removeDraft(cwd: string, rel: string): void {
  try {
    localStorage.removeItem(draftKey(cwd, rel))
  } catch {
    // 忽略
  }
}

function clearDrafts(cwd: string): void {
  const prefix = draftPrefix(cwd)
  const keys: string[] = []
  try {
    // 先收集再删：边遍历边删会改变索引
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key?.startsWith(prefix)) keys.push(key)
    }
    for (const key of keys) localStorage.removeItem(key)
    localStorage.removeItem(legacyDraftKey(cwd))
  } catch {
    // 忽略
  }
}

function readDrafts(cwd: string): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const prefix = draftPrefix(cwd)
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (!key?.startsWith(prefix)) continue
      const rel = key.slice(prefix.length)
      const text = localStorage.getItem(key)
      if (typeof text === 'string' && text.length <= DRAFT_FILE_MAX_CHARS) out[rel] = text
    }
  } catch {
    // 读不到就当没有草稿
  }

  // 从旧版的单键 JSON 迁移；写失败时保留旧键，下次启动再试
  try {
    const raw = localStorage.getItem(legacyDraftKey(cwd))
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object') {
        let migrated = true
        for (const [rel, text] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof text !== 'string' || text.length > DRAFT_FILE_MAX_CHARS) continue
          // 已经有新版分文件草稿时以它为准，不要用旧 blob 覆盖更新的内容
          if (out[rel] === undefined) {
            out[rel] = text
            if (!writeDraft(cwd, rel, text)) migrated = false
          }
        }
        if (migrated) localStorage.removeItem(legacyDraftKey(cwd))
      }
    }
  } catch {
    // 旧格式坏数据：忽略并保留原键
  }
  return out
}

interface Tab {
  key: string
  kind: TabKind
  rel: string
  title: string
  /** 固定后留在最左侧，批量关闭时保留 */
  pinned?: boolean
  /** 未命名缓冲区：rel 是 `untitled:Untitled-N`，保存时走另存为 */
  untitled?: boolean
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
  /** 点遮罩 / Esc / 取消按钮；用于 Promise 化的确认框 */
  onCancel?: () => void
}

interface PromptState {
  title: string
  message: string
  value: string
  confirmLabel: string
  run: (value: string) => void | Promise<void>
  /** 取消 / Esc / 点遮罩；给需要返回值（另存为、覆盖确认）的调用方收尾 */
  onCancel?: () => void
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

/** 未命名缓冲区的 rel 前缀；冒号让它在磁盘路径里不可能出现 */
export const UNTITLED_PREFIX = 'untitled:'

export function untitledTitle(rel: string): string {
  return rel.startsWith(UNTITLED_PREFIX) ? rel.slice(UNTITLED_PREFIX.length) : baseName(rel)
}

/**
 * 另存为的输入清洗：只接受工作区内相对路径。
 *
 * 主进程还会再校验一次；这里提前拦住绝对路径 / `..`，让错误提示停在
 * 对话框旁边，而不是先发一轮 IPC 再弹 notice。
 */
function cleanRelInput(raw: string): string | null {
  const value = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/')
  if (!value) return null
  if (/^([a-zA-Z]:\/|\/\/|\/)/.test(value)) return null
  const parts = value.split('/').filter(Boolean)
  if (parts.length === 0 || parts.includes('..')) return null
  return parts.join('/')
}

/** 某个工作区记住的语言模式覆盖；坏数据静默丢弃 */
function readLanguageOverrides(cwd: string): Record<string, string> {  try {
    const raw = localStorage.getItem(`ccoder:ide:lang:${cwd}`)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [rel, id] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof rel === 'string' && typeof id === 'string' && id.length < 80) out[rel] = id
    }
    return out
  } catch {
    return {}
  }
}

/** Monaco 语言 id → 展示名；找不到时退回 id */
function languageLabel(id: string): string {
  const lang = monaco.languages.getLanguages().find((item) => item.id === id)
  return lang?.aliases?.[0] ?? id
}

interface ExplorerPrefs {
  /** 显示以 `.` 开头的文件 / 目录 */
  showHidden: boolean
  /** 显示 node_modules、dist 等固定忽略目录 */
  showIgnored: boolean
  /** 额外的忽略 glob；匹配文件名或工作区相对路径 */
  ignore: string[]
}

const DEFAULT_EXPLORER_PREFS: ExplorerPrefs = {
  showHidden: true,
  showIgnored: false,
  ignore: []
}

function readExplorerPrefs(cwd: string): ExplorerPrefs {
  try {
    const raw = localStorage.getItem(`ccoder:ide:explorer:${cwd}`)
    if (!raw) return DEFAULT_EXPLORER_PREFS
    const parsed = JSON.parse(raw) as Partial<ExplorerPrefs> | null
    if (!parsed || typeof parsed !== 'object') return DEFAULT_EXPLORER_PREFS
    return {
      showHidden: parsed.showHidden !== false,
      showIgnored: parsed.showIgnored === true,
      ignore: Array.isArray(parsed.ignore)
        ? parsed.ignore.filter(
            (p): p is string => typeof p === 'string' && !!p.trim() && p.length <= 200
          ).slice(0, 100)
        : []
    }
  } catch {
    return DEFAULT_EXPLORER_PREFS
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

/** 状态栏里的行列号：只订阅光标 store，不带着整个 IDE 重渲染 */
function CursorReadout({ rel }: { rel: string }): JSX.Element | null {
  const { t } = useI18n()
  const cursor = useIdeCursor()
  if (!cursor || cursor.rel !== rel) return null
  return <span>{t('ide.cursor', { line: cursor.line, col: cursor.col })}</span>
}

/** 面包屑的光标行同样走外部 store，避免每次移动光标重渲染文件树 */
function Breadcrumbs({
  rel,
  symbols,
  onJump
}: {
  rel: string
  symbols: OutlineSymbol[]
  onJump: (line: number) => void
}): JSX.Element {
  const cursor = useIdeCursor()
  return (
    <SymbolBreadcrumbs
      symbols={symbols}
      line={cursor?.rel === rel ? cursor.line : 1}
      onJump={onJump}
    />
  )
}

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
  review: 'M3 2.5h10v11H3zM5.5 5.5h5M5.5 8h5M5.5 10.5h3',
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
  eye: 'M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8zM8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6',
  eyeOff:
    'M2 2.5l12 11M6.1 4.2A6.6 6.6 0 0 1 8 3.8c4 0 6.2 4.2 6.2 4.2a11 11 0 0 1-2 2.7M9.9 11.8c-.6.3-1.2.4-1.9.4-4 0-6.2-4.2-6.2-4.2a11 11 0 0 1 1.8-2.5',
  filter: 'M2.2 4h11.6M4.4 8h7.2M6.4 12h3.2',
  copy: 'M5.2 5.2h7.6v9.4H5.2zM3.2 1.4h7.6v2M3.2 1.4v9.4h2',
  cut: 'M6.2 9.8 12.8 2.2M9.8 9.8 3.2 2.2M4.4 13.4a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2M11.6 13.4a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2',
  paste: 'M5.2 3.2H3.8v10.2h8.4V3.2h-1.4M6.2 1.6h3.6v2.4H6.2z',
  pin: 'M9.6 2.2 13.8 6.4l-2.1.7-1.8 1.8.2 2-1.1 1.1-3-3-2.8 2.8-.8-.8 2.8-2.8-3-3 1.1-1.1 2 .2 1.8-1.8z',
  history: 'M8 2.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 8 2.2M8 4.8V8l2.3 1.4'
} as const

/* ── 窗口标题栏 ───────────────────────────────────────── */

function IdeTitleBar({
  cwd,
  onClose,
  children
}: {
  cwd: string
  onClose: () => void
  children?: ReactNode
}): JSX.Element {
  const { t } = useI18n()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.api?.isMaximized().then(setMaximized)
    return window.api?.onMaximizedChanged(setMaximized)
  }, [])

  return (
    <div className="ide-titlebar">
      <div className="ide-brand">
        <span className="ide-logo" aria-hidden="true">
          <svg width="17" height="17" viewBox="0 0 20 20" fill="none">
            <path
              d="M5.2 6.1a5.4 5.4 0 1 1 0 7.8"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <path
              d="M11.2 6.1a5.4 5.4 0 1 1 0 7.8"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              opacity=".55"
            />
          </svg>
        </span>
        <span className="ide-brand-name">
          <em>CC</em>oder
        </span>
        <span className="ide-divider" />
        <span className="ide-ws" title={cwd}>
          {baseName(cwd)}
        </span>
        <span className="ide-detach">{t('ide.detach')}</span>
      </div>
      <div className="ide-titlebar-main">{children}</div>
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
  /** 上一次全部替换的撤销信息；放在 IdeApp 里，切到资源管理器再回来仍然可以撤销 */
  const [lastReplace, setLastReplace] = useState<LastReplaceState | null>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeKey, setActiveKey] = useState<string | null>(null)
  /** 页签右键菜单 / 拖动排序状态 */
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null)
  const [dragTabKey, setDragTabKey] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ key: string; after: boolean } | null>(null)
  /** 状态栏编码菜单 */
  const [encodingMenuOpen, setEncodingMenuOpen] = useState(false)
  /** 状态栏语言模式 / 换行符菜单 */
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false)
  const [eolMenuOpen, setEolMenuOpen] = useState(false)
  /** 每个文件手动选过的语言模式（rel → Monaco language id） */
  const [languageOverrides, setLanguageOverrides] = useState<Record<string, string>>(() =>
    readLanguageOverrides(cwd)
  )
  /** 每个打开文件生效的 .editorconfig；打开文件时异步取一次 */
  const [editorConfigs, setEditorConfigs] = useState<Record<string, EditorConfigProperties>>({})
  const untitledSeq = useRef(1)
  const [fileCache, setFileCache] = useState<Record<string, IdeTextFile>>({})
  const [imageCache, setImageCache] = useState<Record<string, IdeImage>>({})
  const [diffCache, setDiffCache] = useState<Record<string, VcsDiffData>>({})
  /** 每个已打开文件在磁盘上的文本，用来判断脏状态 */
  const [baseText, setBaseText] = useState<Record<string, string>>({})
  /** 磁盘上的换行风格；转换行尾后即使文本没变也要算未保存 */
  const [baseEol, setBaseEol] = useState<Record<string, IdeEol>>({})
  const [loadingKey, setLoadingKey] = useState<string | null>(null)
  const [savingRel, setSavingRel] = useState<string | null>(null)
  /**
   * 文件树刷新信号。
   *
   * 以前只有一个全局 version：任何文件变化都会让**所有展开的目录**重新
   * listDir。Agent 连续写文件时（每 250ms 一批），展开 20 个目录就是
   * 每秒几十次 IPC。现在带上受影响的目录集合，只有命中的子树刷新。
   */
  const [treeDirty, setTreeDirty] = useState<{
    version: number
    all: boolean
    dirs: Set<string>
  }>({ version: 0, all: false, dirs: new Set() })
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
  /** 右侧审阅栏；默认展开，和新的工作流一致 */
  const [reviewOpen, setReviewOpen] = useState(true)
  /** 用户手动开合过之后，不再按 VCS 状态自动收起 */
  const reviewTouchedRef = useRef(false)
  /** outlineSymbols 声明在键盘 effect 之后；用 ref 让快捷键能读到最新数量 */
  const outlineCountRef = useRef(0)
  /** 文件导航历史（Alt+← / Alt+→） */
  const navHistoryRef = useRef<{ list: { rel: string; line?: number }[]; index: number }>({
    list: [],
    index: -1
  })
  const [jump, setJump] = useState<{ rel: string; line: number } | null>(null)
  /**
   * 光标位置不放在这里：它变化太频繁，会让整个 IDE 重渲染。实际位置在
   * editor-state 的外部 store 里，只有状态栏和面包屑订阅。
   */
  const activeFileRelRef = useRef<string | null>(null)
  /** 加载新文件时继续显示上一个文件，避免卸载 / 重建整个 Monaco 编辑器 */
  const lastEditorFileRef = useRef<IdeTextFile | null>(null)
  const handleCursor = useCallback((line: number, col: number): void => {
    const rel = activeFileRelRef.current
    if (rel) setIdeCursor({ rel, line, col })
  }, [])
  /** 资源管理器当前选中的文件 / 文件夹 */
  const [treeTarget, setTreeTarget] = useState<TreeTarget>({ rel: '', kind: 'dir' })
  /** 多选：rel 集合；普通点击只有一个，Ctrl / Shift 扩展 */
  const [treeSelection, setTreeSelection] = useState<Set<string>>(new Set())
  const [treeAnchor, setTreeAnchor] = useState<string | null>(null)
  /** 资源管理器显示选项（隐藏文件 / 忽略目录 / 自定义规则），按工作区记忆 */
  const [explorerPrefs, setExplorerPrefs] = useState<ExplorerPrefs>(() =>
    readExplorerPrefs(cwd)
  )
  /** 拖拽中的源路径；用 ref 是因为 drop 事件可能先于 state 更新 */
  const [dragRels, setDragRels] = useState<string[]>([])
  const [dropDir, setDropDir] = useState<string | null>(null)
  const [clipboard, setClipboard] = useState<{ mode: 'copy' | 'cut'; rels: string[] } | null>(
    null
  )
  const clipboardRef = useRef(clipboard)
  clipboardRef.current = clipboard
  const dragRelsRef = useRef<string[]>([])
  dragRelsRef.current = dragRels
  const treeSelectionRef = useRef(treeSelection)
  treeSelectionRef.current = treeSelection
  const treeAnchorRef = useRef(treeAnchor)
  treeAnchorRef.current = treeAnchor
  /** 最近一次鼠标按下的区域；决定 Ctrl+C / Ctrl+V 是给编辑器还是资源管理器 */
  const explorerFocusRef = useRef(false)
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
  const liveRef = useRef({ tabs, fileCache, baseText, baseEol, editorConfigs })
  liveRef.current = { tabs, fileCache, baseText, baseEol, editorConfigs }
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
  /** 已经写进 localStorage 的草稿，用来只更新真正变化的文件 */
  const writtenDraftsRef = useRef<Record<string, string>>({})
  const draftsLoadedRef = useRef(false)
  /** 用户明确选择「不保存并关闭」后，beforeunload 不能再把草稿写回去 */
  const discardDraftsRef = useRef(false)
  /** 最近关闭的标签（Ctrl+Shift+T 重新打开）；只在内存里，不跨窗口 */
  const closedTabsRef = useRef<Tab[]>([])
  /** 标签栏本身：页签溢出时要靠它把当前页签滚进视野 */
  const tabsBarRef = useRef<HTMLDivElement>(null)
  const vcs = useVcsStatus(cwd)
  // 还没手动开合过时，跟着改动数量走：有改动展开，干净 / 非仓库收起
  useEffect(() => {
    if (reviewTouchedRef.current || vcs.loading) return
    setReviewOpen(!!vcs.status && vcs.status.counts.total > 0)
  }, [vcs.status, vcs.loading])
  const sync = useSync(cwd)
  const [syncLogOpen, setSyncLogOpen] = useState(false)
  const [syncBubble, setSyncBubble] = useState<SyncBubbleData | null>(null)
  const syncBubbleTimer = useRef<number | null>(null)
  const syncAnnounced = useRef<number | null>(null)
  const syncReady = useRef(false)
  const activeTab = tabs.find((t) => t.key === activeKey) ?? null
  /** 还开着的文件页签；MonacoEditor 用它回收已关闭文件的 model */
  const openFileRels = useMemo(() => {
    const rels = new Set<string>()
    for (const tab of tabs) {
      if (tab.kind === 'file') rels.add(tab.rel)
    }
    return rels
  }, [tabs])
  /**
   * 编辑器的文本提交是 200ms 节流的。这里不放进 transition：保存 / 格式化
   * 之后会直接写 fileCache，延迟提交的旧文本可能反过来覆盖刚保存的内容。
   * 大块 UI 已经用 memo 挡住了，正常优先级的这一拍开销可以接受。
   */
  const handleEditorChange = useCallback((text: string, rel: string): void => {
    setFileCache((m) => (m[rel] ? { ...m, [rel]: { ...m[rel], text } } : m))
  }, [])
  const activeFile = activeTab?.kind === 'file' ? fileCache[activeTab.rel] : undefined
  const loadingActive = !!activeTab && loadingKey === activeTab.key
  /** 文件页签还没读到内容：可能还没开始 ensureTab，也可能正在读 */
  const showFileLoading = !!activeTab && activeTab.kind === 'file' && !activeFile
  if (activeFile) lastEditorFileRef.current = activeFile
  /**
   * 编辑区实际显示的文件。
   *
   * 打开新文件时 ensureTab 会先进入加载态；此时继续渲染上一个文件，
   * 让 Monaco 编辑器实例保持挂载（model / 撤销栈 / 查找面板都不用重建），
   * 加载完成后再切到新文件，上面盖一层 loading 提示。
   *
   * 注意不能只看 loadingKey：切页签后的第一帧 loadingKey 还是空的，
   * 要等到 effect 里 ensureTab 才置位；这时也不能卸载编辑器。
   */
  const editorFile =
    activeFile ??
    (showFileLoading &&
    lastEditorFileRef.current &&
    lastEditorFileRef.current.rel !== activeTab?.rel &&
    openFileRels.has(lastEditorFileRef.current.rel)
      ? lastEditorFileRef.current
      : undefined)
  activeFileRelRef.current = editorFile?.rel ?? null
  const activeImage = activeTab?.kind === 'image' ? imageCache[activeTab.rel] : undefined
  const activeDiff = activeTab?.kind === 'diff' ? diffCache[activeTab.rel] : undefined
  const explorerListOptions = useMemo<IdeListDirOptions>(
    () => ({
      showHidden: explorerPrefs.showHidden,
      showIgnored: explorerPrefs.showIgnored,
      ignore: explorerPrefs.ignore
    }),
    [explorerPrefs.showHidden, explorerPrefs.showIgnored, explorerPrefs.ignore]
  )

  /*
   * 标签栏横向滚动且隐藏了滚动条：页签多到溢出时，新打开的页签会排在可视
   * 区之外——编辑区明明换了文件，却看不到对应页签。activeKey 变化（或页签
   * 增减、拖动排序）后把当前页签滚进视野。
   */
  useEffect(() => {
    const bar = tabsBarRef.current
    if (!bar || !activeKey) return
    const el = Array.from(bar.children).find(
      (node) => (node as HTMLElement).dataset.tabKey === activeKey
    ) as HTMLElement | undefined
    if (!el) return
    const barRect = bar.getBoundingClientRect()
    const tabRect = el.getBoundingClientRect()
    if (tabRect.left < barRect.left) {
      bar.scrollLeft -= barRect.left - tabRect.left
    } else if (tabRect.right > barRect.right) {
      bar.scrollLeft += tabRect.right - barRect.right
    }
  }, [activeKey, tabs])

  /*
   * 「在目录树中定位打开的文件」：打开或切换页签时，资源管理器展开所在
   * 目录并选中该文件。diff 页签在树里没有对应文件，跳过；设置关掉后就
   * 完全不动目录树。只在当前页签变化时触发，收起 / 展开侧栏不会重置树。
   */
  useEffect(() => {
    if (!editorPrefs.autoRevealInExplorer) return
    if (view !== 'files' || !sidebarOpen) return
    if (!activeTab || activeTab.kind === 'diff' || activeTab.untitled || !activeTab.rel) return
    const rel = activeTab.rel
    setTreeTarget({ rel, kind: 'file' })
    setTreeSelection(new Set([rel]))
    setTreeAnchor(rel)
    setReveal((prev) => ({ rel, nonce: (prev?.nonce ?? 0) + 1 }))
  }, [activeKey, editorPrefs.autoRevealInExplorer])

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
      if (!file || file.binary || file.truncated || file.untitled) continue
      const language =
        languageOverrides[file.rel] ?? monacoLanguage(file.language, file.rel)
      if (!isLspLanguage(language)) continue
      out.push({ rel: tab.rel, language, text: file.text })
    }
    return out
  }, [fileCache, tabs, languageOverrides])
  useEffect(() => {
    syncLspDocs(lspDocs)
  }, [lspDocs, syncLspDocs])

  const activeLspFile = activeTab?.kind === 'file' ? fileCache[activeTab.rel] : undefined
  const activeLanguage = activeLspFile
    ? (languageOverrides[activeLspFile.rel] ??
      monacoLanguage(activeLspFile.language, activeLspFile.rel))
    : null
  const activeLsp = activeLanguage ? lspStates[activeLanguage] : undefined

  const isDirty = useCallback(
    (rel: string): boolean => {
      const f = fileCache[rel]
      if (!f) return false
      // 未命名缓冲区在落盘前始终算未保存（即使还是空文件）
      if (f.untitled) return true
      if (baseText[rel] === undefined) return false
      // 编辑器可能已经产生比 fileCache 更新的文本（200ms 节流窗口内）；
      // 关闭 / 保存前会先 flush，所以这里优先读旁路镜像，避免漏判。
      const text = liveEditorText(rel) ?? f.text
      if (text !== baseText[rel]) return true
      return (f.eol ?? 'lf') !== (baseEol[rel] ?? f.eol ?? 'lf')
    },
    [fileCache, baseText, baseEol]
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
      // 先落掉节流中的输入，下面判断「脏 / 干净」才不会把刚敲的字当成没有
      flushEditorText()
      const seq = (relSeqRef.current.get(rel) ?? 0) + 1
      relSeqRef.current.set(rel, seq)

      let disk: IdeTextFile
      try {
        // 用户手动指定过编码的文件，外部改动后仍按手动编码读；否则重新自动识别
        const cached = liveRef.current.fileCache[rel]
        const forced = cached?.encodingAuto === false ? cached.encoding : undefined
        const r = await api.ide.readFile(cwd, rel, forced)
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
      // 外部内容更新后仍然遵守 .editorconfig 的换行要求；但基准 eol 记磁盘值，
      // 这样「磁盘 LF、配置 CRLF」会继续显示为未保存，保存时再转。
      const cfgEol = liveRef.current.editorConfigs[rel]?.endOfLine
      const adopted = cfgEol ? { ...disk, eol: cfgEol } : disk
      const base = bases[rel]
      const baseEol = liveRef.current.baseEol[rel]
      // await 期间用户可能已经开始输入，必须重新判断脏状态；旁路镜像
      // 可能比已提交的 fileCache 更新，优先用它。
      const currentText = liveEditorText(rel) ?? current.text
      const dirtyNow =
        base !== undefined &&
        (currentText !== base || (current.eol ?? 'lf') !== (baseEol ?? current.eol ?? 'lf'))

      if (!dirtyNow) {
        setFileCache((m) => (m[rel] ? { ...m, [rel]: adopted } : m))
        setBaseText((m) => ({ ...m, [rel]: disk.text }))
        setBaseEol((m) => ({ ...m, [rel]: disk.eol ?? 'lf' }))
        clearExternal(rel)
        return
      }

      if (disk.text === currentText) {
        // 外部写入和草稿恰好一致：采纳磁盘元数据，缓冲区变成干净
        setFileCache((m) => (m[rel] ? { ...m, [rel]: adopted } : m))
        setBaseText((m) => ({ ...m, [rel]: disk.text }))
        setBaseEol((m) => ({ ...m, [rel]: disk.eol ?? 'lf' }))
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

  /** `.editorconfig` 变了：清主进程缓存，再把所有打开文件的生效配置重取一遍 */
  const reloadEditorConfigs = useCallback((): void => {
    const readConfig = api?.ide?.editorConfig
    if (!readConfig) return
    // 先请求一次配置路径本身，主进程据此清缓存
    void readConfig(cwd, '.editorconfig')
      .catch(() => undefined)
      .then(() => {
        const open = liveRef.current.tabs.filter(
          (tab) => tab.kind === 'file' && !tab.untitled
        )
        for (const tab of open) {
          void readConfig(cwd, tab.rel)
            .then((cfg) => {
              setEditorConfigs((m) => ({ ...m, [tab.rel]: cfg }))
              if (cfg.endOfLine) {
                setFileCache((m) => {
                  const cur = m[tab.rel]
                  if (!cur || cur.eol === cfg.endOfLine) return m
                  return { ...m, [tab.rel]: { ...cur, eol: cfg.endOfLine } }
                })
              }
            })
            .catch(() => undefined)
        }
      })
  }, [api, cwd])

  const applyFsBatch = useCallback(
    (batch: IdeFsChanged): void => {
      if (!batch || !Array.isArray(batch.rels)) return
      /*
       * 只把受影响的目录标脏：一条路径会改变它自己的父目录列表
       * （新建 / 删除 / 重命名），也可能意味着它本身是一个目录。
       * 逐级往上加祖先，保证深层文件变化时父目录能立刻看到新条目。
       */
      const all = batch.generic || batch.truncated
      const dirs = new Set<string>()
      if (!all) {
        for (const rel of batch.rels) {
          let cur = rel
          for (;;) {
            const slash = cur.lastIndexOf('/')
            const parent = slash < 0 ? '' : cur.slice(0, slash)
            // Windows 大小写不敏感：和 extKey 用同一套折叠
            dirs.add(extKey(parent))
            dirs.add(extKey(cur))
            if (parent === cur) break
            cur = parent
          }
        }
      }
      setTreeDirty((prev) => ({ version: prev.version + 1, all, dirs }))

      // .editorconfig 改了：所有打开文件的缩进 / 换行配置都要重算
      if (
        all ||
        batch.rels.some((rel) => {
          const base = rel.split('/').pop()
          return base === '.editorconfig'
        })
      ) {
        reloadEditorConfigs()
      }

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
    [revalidateDiff, revalidateFile, revalidateImage, reloadEditorConfigs, vcs.refresh]
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
      // 回到窗口时无法判断期间改了什么，所有展开目录都刷新一次
      setTreeDirty((prev) => ({ version: prev.version + 1, all: true, dirs: prev.dirs }))
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
  const clearAfterWorkspaceWrite = useCallback(
    (changed: number): void => {
      if (changed === 0) return
      const keep = new Set(dirtyRels)
      const onlyDirty = <T,>(rec: Record<string, T>): Record<string, T> =>
        Object.fromEntries(Object.entries(rec).filter(([rel]) => keep.has(rel)))
      setFileCache(onlyDirty)
      setBaseText(onlyDirty)
      setBaseEol((m) => Object.fromEntries(Object.entries(m).filter(([rel]) => keep.has(rel))))
      setImageCache({})
      setDiffCache({})
      const keepExternal = new Set(dirtyRels.map(extKey))
      setExternal((m) =>
        Object.fromEntries(Object.entries(m).filter(([key]) => keepExternal.has(key)))
      )
      // 全部替换 / 撤销可能动了任意多个目录，直接全量刷新
      setTreeDirty((prev) => ({ version: prev.version + 1, all: true, dirs: prev.dirs }))
      void vcs.refresh()
    },
    [dirtyRels, vcs]
  )

  const onWorkspaceReplaced = useCallback(
    (r: IdeReplaceData): void => {
      clearAfterWorkspaceWrite(r.totals.filesChanged)
      if (r.totals.filesChanged === 0) return
      showFlash(
        t('ide.replaceDone', {
          replacements: r.totals.replacements,
          files: r.totals.filesChanged
        })
      )
    },
    [clearAfterWorkspaceWrite, showFlash, t]
  )

  const onWorkspaceRestored = useCallback(
    (files: number): void => {
      clearAfterWorkspaceWrite(files)
      if (files > 0) showFlash(t('ide.undoDone', { files }))
    },
    [clearAfterWorkspaceWrite, showFlash, t]
  )

  // 任务栏/窗口标题跟着工作区走，而不是页面默认的 CCoder
  useEffect(() => {
    document.title = `CCoder IDE — ${baseName(cwd)}`
    // 撤销令牌是按工作区存的；切换工作区后旧令牌没有意义
    setLastReplace(null)
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
    writtenDraftsRef.current = { ...pendingDraftsRef.current }
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
              !t.untitled &&
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
      const persistable = tabs.filter((t) => !t.untitled)
      localStorage.setItem(
        `ccoder:ide:${cwd}`,
        JSON.stringify({ tabs: persistable, active: activeKey })
      )
    } catch {
      // localStorage 满了不影响使用
    }
  }, [cwd, tabs, activeKey])

  // 资源管理器显示选项按工作区记忆
  useEffect(() => {
    try {
      localStorage.setItem(`ccoder:ide:explorer:${cwd}`, JSON.stringify(explorerPrefs))
    } catch {
      // 存不下不影响本次会话
    }
  }, [cwd, explorerPrefs])

  // 选项变了：所有展开目录都要重新列一次（隐藏 / 显示规则可能影响任意层）
  useEffect(() => {
    setTreeDirty((prev) => ({ version: prev.version + 1, all: true, dirs: prev.dirs }))
  }, [explorerPrefs])

  // 记录最后一次鼠标落在资源管理器还是编辑器
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const el = e.target as HTMLElement | null
      explorerFocusRef.current = !!el?.closest?.('.ide-explorer')
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [])

  // 语言模式按工作区记忆；换窗口 / 重开文件后仍是用户上次的选择
  useEffect(() => {
    try {
      if (Object.keys(languageOverrides).length === 0) {
        localStorage.removeItem(`ccoder:ide:lang:${cwd}`)
      } else {
        localStorage.setItem(`ccoder:ide:lang:${cwd}`, JSON.stringify(languageOverrides))
      }
    } catch {
      // 存不下就算了，本次会话仍然生效
    }
  }, [cwd, languageOverrides])

  const ensureTab = useCallback(
    async (tab: Tab) => {
      if (!api?.ide || !api?.vcs) return
      if (tab.kind === 'file' && fileCache[tab.rel]) return
      if (tab.kind === 'image' && imageCache[tab.rel]) return
      if (tab.kind === 'diff' && diffCache[tab.rel]) return

      // 未命名缓冲区不读盘；内容在创建时已经放进 fileCache
      if (tab.kind === 'file' && tab.untitled) {
        setFileCache((m) =>
          m[tab.rel]
            ? m
            : {
                ...m,
                [tab.rel]: {
                  rel: tab.rel,
                  text: '',
                  size: 0,
                  language: 'Text',
                  truncated: false,
                  binary: false,
                  encoding: 'utf8',
                  eol: 'lf',
                  editable: true,
                  untitled: true
                }
              }
        )
        return
      }

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
          setBaseEol((m) => (tab.rel in m ? m : { ...m, [tab.rel]: r.data.eol ?? 'lf' }))
          // 把相对路径 import 的目标也建进 Monaco，TS worker 才能跨文件解析
          ensureImportedModels(cwd, tab.rel, restored.text, api.ide.readFile)
          // .editorconfig 可能改缩进 / 换行；拿到后立刻反映到缓冲区
          if (api.ide.editorConfig) {
            void api.ide
              .editorConfig(cwd, tab.rel)
              .then((cfg) => {
                setEditorConfigs((m) => ({ ...m, [tab.rel]: cfg }))
                if (cfg.endOfLine) {
                  setFileCache((m) => {
                    const cur = m[tab.rel]
                    if (!cur || cur.eol === cfg.endOfLine) return m
                    return { ...m, [tab.rel]: { ...cur, eol: cfg.endOfLine } }
                  })
                }
              })
              .catch(() => undefined)
          }
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

  /** 面包屑跳转：用 ref 取当前文件，避免每次渲染都生成新回调破坏 memo */
  const jumpToActiveLine = useCallback(
    (line: number): void => {
      const rel = activeFileRelRef.current
      if (rel) jumpTo(rel, line)
    },
    [jumpTo]
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
    if (!activeTab || !activeTab.rel || activeTab.untitled) {
      showFlash(t(activeTab?.untitled ? 'ide.untitledNoPath' : 'ide.command.noActiveFile'))
      return
    }
    const rel = activeTab.rel
    setView('files')
    setSidebarOpen(true)
    setTreeTarget({ rel, kind: 'file' })
    setTreeSelection(new Set([rel]))
    setTreeAnchor(rel)
    setReveal((prev) => ({ rel, nonce: (prev?.nonce ?? 0) + 1 }))
  }, [activeTab, showFlash, t])

  /** 在系统文件管理器里打开当前文件所在目录，并选中当前文件 */
  const openContainingFolder = useCallback((): void => {
    // 当前在设置页签时，退回到文件树里选中的文件
    const rel = activeTab?.rel || (treeTarget.kind === 'file' ? treeTarget.rel : '')
    if (!rel || activeTab?.untitled) {
      setNotice(t(activeTab?.untitled ? 'ide.untitledNoPath' : 'ide.command.noActiveFile'))
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
          // 立刻删掉磁盘上的草稿：不必等下一次 400ms 持久化，崩溃也不会复活
          removeDraft(cwd, tab.rel)
          delete writtenDraftsRef.current[tab.rel]
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
          setBaseEol((m) => {
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
      closedTabsRef.current = [
        ...closing.filter((tab) => !tab.untitled),
        ...closedTabsRef.current
      ].slice(0, 20)

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
    // 无法定位具体路径（手动刷新 / VCS 操作），所有展开目录都重新列一次
    setTreeDirty((prev) => ({ version: prev.version + 1, all: true, dirs: prev.dirs }))
    void vcs.refresh()
  }, [vcs])

  /** 当前文件实际使用的 Monaco 语言 id（手动覆盖 > 扩展名推断） */
  const languageFor = useCallback(
    (file: IdeTextFile): string =>
      languageOverrides[file.rel] ?? monacoLanguage(file.language, file.rel),
    [languageOverrides]
  )

  /**
   * 当前文件生效的缩进。
   * 优先级：.editorconfig > 按语言配置 > 全局设置。
   */
  const indentFor = useCallback(
    (file: IdeTextFile): { tabSize: number; insertSpaces: boolean } => {
      let tabSize = editorPrefs.tabSize
      let insertSpaces = editorPrefs.insertSpaces
      const lang = languageFor(file)
      const perLanguage = editorPrefs.languages[lang]
      if (perLanguage) {
        tabSize = perLanguage.tabSize
        insertSpaces = perLanguage.insertSpaces
      }
      const cfg = editorConfigs[file.rel]
      if (cfg?.indentStyle) insertSpaces = cfg.indentStyle === 'space'
      if (typeof cfg?.indentSize === 'number') tabSize = cfg.indentSize
      else if (cfg?.indentSize === 'tab') {
        if (typeof cfg.tabWidth === 'number') tabSize = cfg.tabWidth
      } else if (typeof cfg?.tabWidth === 'number') {
        tabSize = cfg.tabWidth
      }
      return { tabSize, insertSpaces }
    },
    [editorConfigs, editorPrefs, languageFor]
  )

  /** 保存前统一处理行尾空白 / 末尾空行，返回要写盘的内容 */
  const prepareSaveText = useCallback(
    (rel: string, raw: string, cfg?: EditorConfigProperties): string => {
      let text = raw
      const config = cfg ?? editorConfigs[rel]
      if (config?.trimTrailingWhitespace ?? editorPrefs.trimTrailingWhitespace) {
        text = text.replace(/[ \t]+$/gm, '')
      }
      const finalNewline = config?.insertFinalNewline
      if (finalNewline === true && text.length > 0 && !text.endsWith('\n')) text += '\n'
      if (finalNewline === false) text = text.replace(/\n+$/, '')
      return text
    },
    [editorConfigs, editorPrefs.trimTrailingWhitespace]
  )

  /** 另存为 / 未命名保存用的路径输入框，取消时给 null */
  const askPath = useCallback(
    (opts: {
      title: string
      message: string
      value: string
      confirmLabel: string
    }): Promise<string | null> =>
      new Promise((resolve) => {
        setPrompt({
          ...opts,
          run: (value) => resolve(value.trim()),
          onCancel: () => resolve(null)
        })
      }),
    []
  )

  /** Promise 化的确认框；遮罩 / Esc 视为取消 */
  const askConfirm = useCallback(
    (opts: { title: string; message: string; confirmLabel: string }): Promise<boolean> =>
      new Promise((resolve) => {
        setDialog({
          title: opts.title,
          message: opts.message,
          onCancel: () => resolve(false),
          actions: [
            { label: t('common.cancel'), run: () => resolve(false) },
            {
              label: opts.confirmLabel,
              kind: 'danger',
              run: () => resolve(true)
            }
          ]
        })
      }),
    [t]
  )

  const saveAsFileRef = useRef<((rel: string) => Promise<boolean>) | null>(null)

  const saveDoc = useCallback(
    async (
      rel: string,
      force = false,
      encoding?: IdeEncoding,
      alwaysWrite = false
    ): Promise<boolean> => {
      const file = fileCache[rel]
      if (!api?.ide || !file) return false
      // 保存读的是「最新文本」，不是上一拍节流进 state 的文本
      flushEditorText()
      if (file.binary) {
        setNotice(t('ide.binaryCannotSave'))
        return false
      }
      if (file.truncated) {
        setNotice(t('ide.tooLargeCannotSave'))
        return false
      }
      // 未命名缓冲区没有磁盘路径：保存 = 另存为
      if (file.untitled) {
        return (await saveAsFileRef.current?.(rel)) ?? false
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
      /*
       * 保存前格式化只在「这个文件就是当前编辑器里的 model」时做：
       * 格式化动作是 Monaco 编辑器级的，后台文件没法在不切 model 的情况下
       * 跑。自动保存 / 保存全部里的非活动文件保持原样，等切过去再保存。
       */
      let text = liveEditorText(rel) ?? file.text
      if (editorPrefs.formatOnSave && activeKey === `file:${rel}`) {
        const editor = activeEditor()
        const model = editor?.getModel()
        if (editor && model && relFromUri(model.uri, cwd) === rel && model.getValue() === text) {
          const formatted = await formatActiveDocument()
          if (formatted) {
            // 格式化改写 model 后先刷一拍，保证 live 镜像 / state 与 model 一致
            flushEditorText()
            text = liveEditorText(rel) ?? editor.getValue()
            if (text !== file.text) {
              setFileCache((m) => (m[rel] ? { ...m, [rel]: { ...m[rel], text } } : m))
            }
          }
        }
      }
      let relCfg: EditorConfigProperties | undefined = editorConfigs[rel]
      if (!relCfg && api.ide.editorConfig) {
        try {
          relCfg = await api.ide.editorConfig(cwd, rel)
          setEditorConfigs((m) => ({ ...m, [rel]: relCfg ?? {} }))
        } catch {
          relCfg = undefined
        }
      }
      text = prepareSaveText(rel, text, relCfg)
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
          eol: file.eol ?? relCfg?.endOfLine ?? 'lf',
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
        // 普通保存沿用原有的「自动 / 手动」编码来源；只有明确指定编码保存才转为手动。
        const nextAuto = encoding === undefined ? file.encodingAuto : false
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
                encoding: r.data.encoding,
                encodingAuto: nextAuto
              }
            }
          }
          return { ...m, [rel]: { ...r.data, encodingAuto: nextAuto } }
        })
        setBaseText((m) => ({ ...m, [rel]: r.data.text }))
        setBaseEol((m) => ({ ...m, [rel]: r.data.eol ?? 'lf' }))
        delete pendingDraftsRef.current[rel]
        removeDraft(cwd, rel)
        delete writtenDraftsRef.current[rel]
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
    [api, activeKey, clearExternal, cwd, editorConfigs, editorPrefs.formatOnSave, external, fileCache, isDirty, prepareSaveText, showFlash, vcs]
  )

  /**
   * 另存为（未命名缓冲区保存也走这里）。
   *
   * 目标必须是工作区内的相对路径；目标已存在时先确认，之后用它的 mtime
   * 做冲突检测。成功后当前标签切换到新路径，旧路径的缓存和草稿丢弃。
   */
  const saveAsFile = useCallback(
    async (fromRel: string): Promise<boolean> => {
      if (!api?.ide) return false
      const file = fileCache[fromRel]
      if (!file) return false
      if (file.binary || file.truncated) {
        setNotice(t(file.binary ? 'ide.binaryCannotSave' : 'ide.tooLargeCannotSave'))
        return false
      }

      const sourceTab = tabs.find((tab) => tab.kind === 'file' && tab.rel === fromRel)
      const suggested = file.untitled ? untitledTitle(fromRel) : fromRel
      const input = await askPath({
        title: t('ide.saveAsTitle'),
        message: t('ide.saveAsMessage'),
        value: suggested,
        confirmLabel: t('ide.saveAs')
      })
      if (input === null) return false
      const toRel = cleanRelInput(input)
      if (!toRel) {
        setNotice(t('ide.saveAsInvalidPath'))
        return false
      }
      // 普通文件在同一个路径上「另存为」等价于保存
      if (toRel === fromRel && !file.untitled) return saveDoc(fromRel, true)

      const existing = await api.ide.readFile(cwd, toRel)
      let expectedMtimeMs: number | undefined
      let mustCreate = false
      if (existing.ok) {
        const other = tabs.find(
          (tab) => tab.kind === 'file' && tab.rel === toRel && tab.key !== sourceTab?.key
        )
        if (other && fileCache[toRel]?.untitled !== true && isDirty(toRel)) {
          setNotice(t('ide.saveAsTargetOpenDirty'))
          return false
        }
        const confirmed = await askConfirm({
          title: t('ide.saveAsOverwriteTitle'),
          message: t('ide.saveAsOverwriteMessage', { rel: toRel }),
          confirmLabel: t('ide.overwrite')
        })
        if (!confirmed) return false
        expectedMtimeMs = existing.data.mtimeMs
      } else if (existing.code === 'not-file') {
        setNotice(t('ide.saveAsNotFile'))
        return false
      } else if (existing.code !== 'missing') {
        setNotice(t('ide.saveFailed', { error: existing.message }))
        return false
      } else {
        mustCreate = true
      }

      // 目标路径的 .editorconfig 可能和新文件所在目录不同
      let targetCfg: EditorConfigProperties | undefined
      if (api.ide.editorConfig) {
        try {
          targetCfg = await api.ide.editorConfig(cwd, toRel)
          setEditorConfigs((m) => ({ ...m, [toRel]: targetCfg ?? {} }))
        } catch {
          targetCfg = undefined
        }
      }

      flushEditorText()
      let text = liveEditorText(fromRel) ?? file.text
      if (editorPrefs.formatOnSave && activeKey === sourceTab?.key) {
        const editor = activeEditor()
        const model = editor?.getModel()
        if (editor && model && model.getValue() === text) {
          const formatted = await formatActiveDocument()
          if (formatted) {
            flushEditorText()
            text = liveEditorText(fromRel) ?? editor.getValue()
          }
        }
      }
      if (targetCfg?.trimTrailingWhitespace ?? editorPrefs.trimTrailingWhitespace) {
        text = text.replace(/[ \t]+$/gm, '')
      }
      if (targetCfg?.insertFinalNewline === true && text.length > 0 && !text.endsWith('\n')) {
        text += '\n'
      } else if (targetCfg?.insertFinalNewline === false) {
        text = text.replace(/\n+$/, '')
      }
      const eol = targetCfg?.endOfLine ?? file.eol ?? 'lf'

      setSavingRel(fromRel)
      savingRelsRef.current.set(extKey(fromRel), (savingRelsRef.current.get(extKey(fromRel)) ?? 0) + 1)
      // 目标路径的 watcher 事件也要忽略，否则它会把刚写入的磁盘内容当成外部改动
      savingRelsRef.current.set(extKey(toRel), (savingRelsRef.current.get(extKey(toRel)) ?? 0) + 1)
      try {
        const r = await api.ide.saveFile({
          cwd,
          rel: toRel,
          text,
          expectedMtimeMs,
          eol,
          encoding: file.encoding,
          mustCreate
        })
        if (!r.ok) {
          if (r.code === 'exists') setNotice(t('ide.saveAsExists'))
          else setNotice(t('ide.saveFailed', { error: r.message }))
          return false
        }

        // 另存为不改变编码来源：未命名缓冲区默认 UTF-8，仍算自动；
        // 用户手动指定过编码的文件继续保持手动。
        const savedData = { ...r.data, encodingAuto: file.encodingAuto ?? true }

        const nextKey = `file:${toRel}`
        if (sourceTab) {
          const sourceKey = sourceTab.key
          setTabs((list) =>
            list
              .filter(
                (tab) =>
                  tab.key === sourceKey ||
                  !(tab.kind === 'file' && tab.rel === toRel)
              )
              .map((tab) =>
                tab.key === sourceKey
                  ? {
                      ...tab,
                      rel: toRel,
                      key: nextKey,
                      title: baseName(toRel),
                      untitled: false
                    }
                  : tab
              )
          )
          setActiveKey((cur) =>
            cur === sourceKey || cur === nextKey ? nextKey : cur
          )
        }

        if (fromRel !== toRel) {
          setFileCache((m) => {
            const next = { ...m }
            delete next[fromRel]
            next[toRel] = savedData
            return next
          })
          setBaseText((m) => {
            const next = { ...m }
            delete next[fromRel]
            next[toRel] = savedData.text
            return next
          })
          setBaseEol((m) => {
            const next = { ...m }
            delete next[fromRel]
            next[toRel] = savedData.eol ?? 'lf'
            return next
          })
          setEditorConfigs((m) => {
            const next = { ...m }
            delete next[fromRel]
            return next
          })
          setLanguageOverrides((m) => {
            if (!(fromRel in m)) return m
            const next = { ...m }
            const lang = next[fromRel]
            delete next[fromRel]
            next[toRel] = lang
            return next
          })
          delete pendingDraftsRef.current[fromRel]
          removeDraft(cwd, fromRel)
          delete writtenDraftsRef.current[fromRel]
          clearExternal(toRel)
          clearExternal(fromRel)
          const cursorNow = getIdeCursor()
          if (cursorNow && cursorNow.rel === fromRel) {
            setIdeCursor({ ...cursorNow, rel: toRel })
          }
          setJump((j) => (j && j.rel === fromRel ? { ...j, rel: toRel } : j))
          ensureImportedModels(cwd, toRel, savedData.text, api.ide.readFile)
        } else {
          setFileCache((m) => ({ ...m, [toRel]: savedData }))
          setBaseText((m) => ({ ...m, [toRel]: savedData.text }))
          setBaseEol((m) => ({ ...m, [toRel]: savedData.eol ?? 'lf' }))
        }

        refresh()
        void vcs.refresh()
        showFlash(t('ide.saved', { name: baseName(toRel) }))
        return true
      } catch (err) {
        setNotice(
          t('ide.saveFailed', { error: err instanceof Error ? err.message : String(err) })
        )
        return false
      } finally {
        const key = extKey(fromRel)
        const left = (savingRelsRef.current.get(key) ?? 1) - 1
        if (left > 0) savingRelsRef.current.set(key, left)
        else savingRelsRef.current.delete(key)
        // 目标路径的计数在成功分支才会增加；失败时删掉也无副作用
        const targetKey = extKey(toRel)
        const targetLeft = (savingRelsRef.current.get(targetKey) ?? 1) - 1
        if (targetLeft > 0) savingRelsRef.current.set(targetKey, targetLeft)
        else savingRelsRef.current.delete(targetKey)
        setSavingRel((cur) => (cur === fromRel ? null : cur))
      }
    },
    [
      activeKey,
      api,
      askConfirm,
      askPath,
      clearExternal,
      cwd,
      editorPrefs.formatOnSave,
      editorPrefs.trimTrailingWhitespace,
      fileCache,
      isDirty,
      refresh,
      saveDoc,
      showFlash,
      t,
      tabs,
      vcs
    ]
  )
  saveAsFileRef.current = saveAsFile

  /** 新建一个未命名缓冲区（Ctrl+N）；保存时再选路径 */
  const newUntitled = useCallback((): void => {
    let n = untitledSeq.current
    let rel = `${UNTITLED_PREFIX}Untitled-${n}`
    while (tabs.some((tab) => tab.rel === rel)) {
      n += 1
      rel = `${UNTITLED_PREFIX}Untitled-${n}`
    }
    untitledSeq.current = n + 1
    const title = t('ide.untitledName', { n })
    setFileCache((m) => ({
      ...m,
      [rel]: {
        rel,
        text: '',
        size: 0,
        language: 'Text',
        truncated: false,
        binary: false,
        encoding: 'utf8',
        eol: 'lf',
        editable: true,
        untitled: true
      }
    }))
    setTabs((list) => [
      ...list,
      { key: rel, kind: 'file', rel, title, untitled: true }
    ])
    setActiveKey(rel)
    setView('files')
    setSidebarOpen(true)
  }, [t, tabs])

  /** 命令面板 / 快捷键调用的「另存为」 */
  const saveActiveAs = useCallback((): void => {
    if (activeTab?.kind !== 'file' || !activeFile) {
      showFlash(t('ide.command.noActiveFile'))
      return
    }
    void saveAsFile(activeTab.rel)
  }, [activeFile, activeTab, saveAsFile, showFlash, t])

  const setLanguageMode = useCallback(
    (rel: string, languageId: string): void => {
      setLanguageOverrides((m) => ({ ...m, [rel]: languageId }))
      showFlash(t('ide.language.changed', { language: languageLabel(languageId) }))
    },
    [showFlash, t]
  )

  const setEolMode = useCallback(
    (rel: string, eol: IdeEol): void => {
      setFileCache((m) => (m[rel] ? { ...m, [rel]: { ...m[rel], eol } } : m))
      showFlash(t('ide.eol.changed', { eol: eol === 'crlf' ? 'CRLF' : 'LF' }))
    },
    [showFlash, t]
  )

  /** 以指定编码（省略 = 自动识别）重新读盘；有未保存修改时不允许 */
  const reopenWithEncoding = useCallback(
    async (rel: string, encoding?: IdeEncoding): Promise<void> => {
      if (!api?.ide) return
      if (fileCache[rel]?.untitled) {
        setNotice(t('ide.untitledNoPath'))
        return
      }
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
      setBaseEol((m) => ({ ...m, [rel]: r.data.eol ?? 'lf' }))
      clearExternal(rel)
      ensureImportedModels(cwd, rel, r.data.text, api.ide.readFile)
      const label = t(ENCODING_LABEL_KEY[r.data.encoding])
      showFlash(
        encoding
          ? t('ide.encoding.reopened', { encoding: label })
          : t('ide.encoding.reopenedAuto', { encoding: label })
      )
    },
    [api, clearExternal, cwd, fileCache, isDirty, showFlash, t]
  )

  /** 按指定编码写盘；即使文件没有修改也强制写一次，用于编码转换 */
  const saveWithEncoding = useCallback(
    (rel: string, encoding: IdeEncoding): void => {
      void saveDoc(rel, false, encoding, true)
    },
    [saveDoc]
  )

  const saveAll = useCallback(async (): Promise<boolean> => {
    // 先刷出节流中的输入，再按实时脏状态生成列表（render 里的 dirtyRels 可能慢一拍）
    flushEditorText()
    const rels = Object.keys(fileCache).filter((rel) => isDirty(rel))
    // 逐个保存：遇到外部改动时只弹一次确认，不把后面的文件也一起覆盖
    for (const rel of rels) {
      if (!(await saveDoc(rel))) return false
    }
    return true
  }, [fileCache, isDirty, saveDoc])

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
          if (!isDirty(rel) || liveRef.current.fileCache[rel]?.untitled) continue
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
      // 先同步刷出编辑器里的最后一拍输入，再等一拍让 React 提交
      // dirtyRelsRef，否则「打完字立刻切窗口」可能漏掉这个文件。
      flushEditorText()
      window.setTimeout(() => {
        void (async () => {
          for (const rel of [...dirtyRelsRef.current]) {
            if (!isDirty(rel) || liveRef.current.fileCache[rel]?.untitled) continue
            if (!(await saveDocRef.current(rel))) break
          }
        })()
      }, 0)
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
    // 草稿要包含节流窗口里最后几个字符
    flushEditorText()
    const { fileCache: cache, baseText: bases } = liveRef.current
    const candidates: Record<string, string> = {}
    // 还没被打开过的标签：保留上次读进来的草稿
    for (const [rel, text] of Object.entries(pendingDraftsRef.current)) {
      if (!(rel in cache)) candidates[rel] = text
    }
    // 已打开的文件：只存真正脏的；用户改回磁盘内容时草稿要消失
    for (const [rel, file] of Object.entries(cache)) {
      if (!file || file.binary || file.truncated || file.untitled) continue
      const base = bases[rel]
      const text = liveEditorText(rel) ?? file.text
      if (base === undefined || text === base) continue
      if (text.length > DRAFT_FILE_MAX_CHARS) continue
      candidates[rel] = text
    }
    const next: Record<string, string> = {}
    let total = 0
    for (const [rel, text] of Object.entries(candidates)) {
      if (total + text.length > DRAFT_TOTAL_MAX_CHARS) break
      next[rel] = text
      total += text.length
    }

    // 只写文本真的变了的文件；已经不再脏 / 已关闭的文件把 key 删掉。
    // 写失败（配额满）时不记入 written，下一次 persist 会自然重试。
    const previous = writtenDraftsRef.current
    const written: Record<string, string> = {}
    for (const [rel, text] of Object.entries(next)) {
      if (previous[rel] === text) {
        written[rel] = text
        continue
      }
      if (writeDraft(cwd, rel, text)) written[rel] = text
    }
    for (const rel of Object.keys(previous)) {
      if (!(rel in written)) removeDraft(cwd, rel)
    }
    writtenDraftsRef.current = written
    pendingDraftsRef.current = next
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
    setTreeSelection(new Set([r.data.entry.rel]))
    setTreeAnchor(r.data.entry.rel)
    refresh()
    if (r.data.entry.kind === 'file') openFile(r.data.entry.rel)
    showFlash(c.kind === 'dir' ? t('ide.folderCreated') : t('ide.fileCreated'))
  }, [api, cwd, creating, openFile, refresh, showFlash])

  /**
   * 把一批路径映射应用到所有打开状态（页签、缓存、草稿、光标、选择等）。
   * 重命名单项和拖拽移动多项共用；一次性处理，避免多次 setState 互相覆盖。
   */
  const applyPathRemaps = useCallback(
    (pairs: { from: string; to: string }[]): void => {
      const clean = pairs.filter((p) => p.from && p.to && p.from !== p.to)
      if (clean.length === 0) return
      const mapRel = (rel: string): string => {
        for (const pair of clean) {
          if (rel === pair.from || rel.startsWith(`${pair.from}/`)) {
            return pair.to + rel.slice(pair.from.length)
          }
        }
        return rel
      }
      const underAny = (rel: string): boolean =>
        clean.some((pair) => underPath(rel, pair.from))

      // 还没打开过的草稿也按新路径存，否则重命名 / 移动后恢复不到
      const drafts: Record<string, string> = {}
      for (const [rel, text] of Object.entries(pendingDraftsRef.current)) {
        drafts[mapRel(rel)] = text
        if (mapRel(rel) !== rel) {
          // 旧路径的持久化草稿立即清掉，避免崩溃后被当成另一份文件恢复
          removeDraft(cwd, rel)
          delete writtenDraftsRef.current[rel]
        }
      }
      pendingDraftsRef.current = drafts

      setTabs((list) =>
        list.map((t) => {
          const rel = mapRel(t.rel)
          if (rel === t.rel) return t
          return {
            ...t,
            rel,
            key: `${t.kind}:${rel}`,
            title: t.kind === 'diff' ? `${baseName(rel)} (diff)` : baseName(rel)
          }
        })
      )
      setActiveKey((cur) => {
        const tab = tabs.find((t) => t.key === cur)
        return tab ? `${tab.kind}:${mapRel(tab.rel)}` : cur
      })

      const remapRecord = <T,>(rec: Record<string, T>): Record<string, T> => {
        const next: Record<string, T> = {}
        for (const [key, value] of Object.entries(rec)) {
          next[mapRel(key)] = value
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
      setBaseEol(remapRecord)
      setLanguageOverrides((m) => {
        let changed = false
        const next: Record<string, string> = {}
        for (const [rel, id] of Object.entries(m)) {
          const mapped = mapRel(rel)
          if (mapped !== rel) changed = true
          next[mapped] = id
        }
        return changed ? next : m
      })
      setEditorConfigs((m) => {
        let changed = false
        const next: Record<string, EditorConfigProperties> = {}
        for (const [rel, cfg] of Object.entries(m)) {
          const mapped = mapRel(rel)
          if (mapped !== rel) changed = true
          next[mapped] = cfg
        }
        return changed ? next : m
      })
      setImageCache((m) => {
        const next = remapRecord(m)
        for (const [key, value] of Object.entries(next)) {
          if (value.rel !== key) next[key] = { ...value, rel: key }
        }
        return next
      })
      // diff 是按旧路径取的，路径变了就丢掉，下次打开时重新拉
      setDiffCache((m) =>
        Object.fromEntries(Object.entries(m).filter(([key]) => !underAny(key)))
      )
      const cursorNow = getIdeCursor()
      if (cursorNow && underAny(cursorNow.rel)) {
        setIdeCursor({ ...cursorNow, rel: mapRel(cursorNow.rel) })
      }
      setJump((j) => (j && underAny(j.rel) ? { ...j, rel: mapRel(j.rel) } : j))
      setTreeTarget((t) => (underAny(t.rel) ? { ...t, rel: mapRel(t.rel) } : t))
      setTreeSelection((sel) => {
        if (sel.size === 0) return sel
        const next = new Set([...sel].map(mapRel))
        return next
      })
      setTreeAnchor((a) => (a ? mapRel(a) : a))
    },
    [tabs]
  )

  const applyRename = useCallback(
    (oldRel: string, newRel: string): void => {
      applyPathRemaps([{ from: oldRel, to: newRel }])
    },
    [applyPathRemaps]
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
      setTreeSelection(new Set([r.data.entry.rel]))
      setTreeAnchor(r.data.entry.rel)
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

  /** 执行一批移动 / 复制，并在成功后同步页签、缓存和选择 */
  const runTransfer = useCallback(
    async (
      rels: string[],
      targetDir: string,
      mode: 'move' | 'copy',
      kinds: Map<string, 'file' | 'dir'>
    ): Promise<{ ok: number; failed: number } | null> => {
      const ideApi = api?.ide
      if (!ideApi) return null
      const unique = [...new Set(rels.filter(Boolean))]
      if (unique.length === 0) return null
      try {
        const r = await ideApi.transferEntries({ cwd, rels: unique, targetDir, mode })
        if (!r.ok) {
          setNotice(t('ide.explorer.transferFailed', { error: r.message }))
          return null
        }
        const good = r.data.items.filter((item) => item.ok)
        const failed = r.data.items.filter((item) => !item.ok)
        if (mode === 'move') {
          applyPathRemaps(
            good
              .filter((item) => item.to && item.to !== item.from)
              .map((item) => ({ from: item.from, to: item.to! }))
          )
        }
        const destinations = good.map((item) => item.to).filter((x): x is string => !!x)
        if (destinations.length > 0) {
          setTreeSelection(new Set(destinations))
          setTreeAnchor(destinations[0])
          setTreeTarget({
            rel: destinations[0],
            kind: kinds.get(good[0]?.from ?? '') ?? 'file'
          })
        }
        refresh()
        void vcs.refresh()
        if (failed.length > 0) {
          setNotice(
            t('ide.explorer.transferPartial', {
              n: failed.length,
              error: failed[0]?.message ?? ''
            })
          )
        } else if (good.length > 0) {
          showFlash(
            t(mode === 'move' ? 'ide.explorer.moved' : 'ide.explorer.copied', {
              n: good.length
            })
          )
        }
        return { ok: good.length, failed: failed.length }
      } catch (err) {
        setNotice(
          t('ide.explorer.transferFailed', {
            error: err instanceof Error ? err.message : String(err)
          })
        )
        return null
      }
    },
    [api, applyPathRemaps, cwd, refresh, setNotice, showFlash, t, vcs]
  )

  /* ── 资源管理器：多选 / 拖拽 / 剪贴板 ─────────────────── */

  /** 可见行按 DOM 顺序；Shift 连选用 */
  const visibleTreeRels = useCallback((): string[] => {
    return Array.from(document.querySelectorAll<HTMLElement>('.ide-trow[data-rel]'))
      .map((el) => el.dataset.rel ?? '')
      .filter(Boolean)
  }, [])

  const kindOfVisibleRel = useCallback((rel: string): 'file' | 'dir' => {
    const row = Array.from(document.querySelectorAll<HTMLElement>('.ide-trow[data-rel]')).find(
      (el) => el.dataset.rel === rel
    )
    return row?.classList.contains('is-dir') ? 'dir' : 'file'
  }, [])

  /** 普通点击单选；Ctrl/Cmd 切换；Shift 从锚点连选 */
  const selectTreeTarget = useCallback(
    (target: TreeTarget, e: ReactMouseEvent): void => {
      setTreeTarget(target)
      if (e.shiftKey) {
        const anchor = treeAnchorRef.current
        if (anchor) {
          const rels = visibleTreeRels()
          const a = rels.indexOf(anchor)
          const b = rels.indexOf(target.rel)
          if (a >= 0 && b >= 0) {
            setTreeSelection(new Set(rels.slice(Math.min(a, b), Math.max(a, b) + 1)))
            return
          }
        }
      }
      if (e.ctrlKey || e.metaKey) {
        setTreeSelection((prev) => {
          const next = new Set(prev)
          if (target.rel) {
            if (next.has(target.rel)) next.delete(target.rel)
            else next.add(target.rel)
          }
          return next
        })
        setTreeAnchor(target.rel || null)
        return
      }
      setTreeSelection(new Set(target.rel ? [target.rel] : []))
      setTreeAnchor(target.rel || null)
    },
    [visibleTreeRels]
  )

  const selectAllTree = useCallback((): void => {
    const rels = visibleTreeRels()
    setTreeSelection(new Set(rels))
    setTreeAnchor(rels[0] ?? null)
  }, [visibleTreeRels])

  /** 当前多选对应的目标；空选择时退回最后点击的单项 */
  const selectedTreeTargets = useCallback((): TreeTarget[] => {
    const rels = [...treeSelectionRef.current].filter(Boolean)
    if (rels.length === 0) {
      return treeTargetRef.current.rel ? [treeTargetRef.current] : []
    }
    return rels.map((rel) =>
      rel === treeTargetRef.current.rel
        ? treeTargetRef.current
        : { rel, kind: kindOfVisibleRel(rel) }
    )
  }, [kindOfVisibleRel])

  const beginTreeDrag = useCallback((target: TreeTarget, e: ReactDragEvent): void => {
    const selection = treeSelectionRef.current
    const rels = (
      selection.has(target.rel) && selection.size > 0 ? [...selection] : [target.rel]
    ).filter(Boolean)
    if (rels.length === 0) return
    dragRelsRef.current = rels
    setDragRels(rels)
    e.dataTransfer.effectAllowed = 'copyMove'
    e.dataTransfer.setData('application/x-ccoder-tree', JSON.stringify(rels))
    e.dataTransfer.setData('text/plain', rels.join('\n'))
  }, [])

  const endTreeDrag = useCallback((): void => {
    dragRelsRef.current = []
    setDragRels([])
    setDropDir(null)
  }, [])

  /**
   * 文件树右键菜单。必须保持稳定引用：TreeDir 是 memo 组件，
   * 内联箭头函数会让整棵树在每次输入提交时都重渲染。
   */
  const openTreeMenu = useCallback((target: TreeTarget, e: ReactMouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (!treeSelectionRef.current.has(target.rel)) {
      setTreeSelection(new Set(target.rel ? [target.rel] : []))
      setTreeAnchor(target.rel || null)
    }
    setTreeTarget(target)
    setMenu({ x: e.clientX, y: e.clientY, target })
  }, [])

  /** 审阅栏是 memo 组件，入口回调必须稳定 */
  const openScmView = useCallback((): void => setView('vcs'), [])
  const closeReviewDock = useCallback((): void => setReviewOpen(false), [])

  const canDropInto = useCallback((targetDir: string): boolean => {
    const rels = dragRelsRef.current
    if (rels.length === 0) return false
    return !rels.some((rel) => targetDir === rel || targetDir.startsWith(`${rel}/`))
  }, [])

  const dragOverTreeDir = useCallback(
    (targetDir: string, e: ReactDragEvent): void => {
      if (!canDropInto(targetDir)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = e.ctrlKey || e.altKey ? 'copy' : 'move'
      setDropDir((cur) => (cur === targetDir ? cur : targetDir))
    },
    [canDropInto]
  )

  const dragLeaveTreeDir = useCallback((targetDir: string): void => {
    setDropDir((cur) => (cur === targetDir ? null : cur))
  }, [])

  const dropOnTreeDir = useCallback(
    (targetDir: string, e: ReactDragEvent): void => {
      if (!canDropInto(targetDir)) return
      e.preventDefault()
      e.stopPropagation()
      const rels = [...dragRelsRef.current]
      const mode = e.ctrlKey || e.altKey ? 'copy' : 'move'
      const kinds = new Map(rels.map((rel) => [rel, kindOfVisibleRel(rel)] as const))
      endTreeDrag()
      void runTransfer(rels, targetDir, mode, kinds)
    },
    [canDropInto, endTreeDrag, kindOfVisibleRel, runTransfer]
  )

  const copyTreeSelection = useCallback(
    (cut: boolean): void => {
      const rels = [...treeSelectionRef.current].filter(Boolean)
      if (rels.length === 0) {
        if (treeTargetRef.current.rel) rels.push(treeTargetRef.current.rel)
        else return
      }
      setClipboard({ mode: cut ? 'cut' : 'copy', rels })
      showFlash(
        t(cut ? 'ide.explorer.cutDone' : 'ide.explorer.copyDone', { n: rels.length })
      )
    },
    [showFlash, t]
  )

  const pasteTreeClipboard = useCallback((): void => {
    const clip = clipboardRef.current
    if (!clip) return
    const target = treeTargetRef.current
    const dir = target.kind === 'dir' ? target.rel : dirOfRel(target.rel)
    const kinds = new Map(clip.rels.map((rel) => [rel, kindOfVisibleRel(rel)] as const))
    void runTransfer(clip.rels, dir, clip.mode === 'cut' ? 'move' : 'copy', kinds).then(
      (outcome) => {
        if (clip.mode === 'cut' && outcome && outcome.failed === 0 && outcome.ok > 0) {
          setClipboard(null)
        }
      }
    )
  }, [kindOfVisibleRel, runTransfer])

  const editIgnoreRules = useCallback((): void => {
    setPrompt({
      title: t('ide.explorer.ignoreTitle'),
      message: t('ide.explorer.ignoreMessage'),
      value: explorerPrefs.ignore.join(', '),
      confirmLabel: t('ide.explorer.ignoreSave'),
      run: (value) => {
        const patterns = splitGlobList(value)
        setExplorerPrefs((prev) => ({ ...prev, ignore: patterns }))
      }
    })
  }, [explorerPrefs.ignore, t])

  const toggleHiddenFiles = useCallback((): void => {
    setExplorerPrefs((prev) => ({ ...prev, showHidden: !prev.showHidden }))
  }, [])

  const toggleIgnoredDirs = useCallback((): void => {
    setExplorerPrefs((prev) => ({ ...prev, showIgnored: !prev.showIgnored }))
  }, [])

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
        if (underPath(rel, prefix)) {
          delete pendingDraftsRef.current[rel]
          removeDraft(cwd, rel)
          delete writtenDraftsRef.current[rel]
        }
      }
      const drop = <T,>(rec: Record<string, T>): Record<string, T> =>
        Object.fromEntries(Object.entries(rec).filter(([key]) => !underPath(key, prefix)))
      setFileCache(drop)
      setBaseText(drop)
      setBaseEol(drop)
      setLanguageOverrides(drop)
      setEditorConfigs(drop)
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
      const cursorNow = getIdeCursor()
      if (cursorNow && underPath(cursorNow.rel, prefix)) setIdeCursor(null)
      setJump((j) => (j && underPath(j.rel, prefix) ? null : j))
      setTreeTarget((t) => (underPath(t.rel, prefix) ? { rel: '', kind: 'dir' } : t))
      setTreeSelection((sel) => {
        if (sel.size === 0) return sel
        return new Set([...sel].filter((rel) => !underPath(rel, prefix)))
      })
      setTreeAnchor((a) => (a && underPath(a, prefix) ? null : a))
    },
    [activeKey, tabs]
  )

  const requestDelete = useCallback(
    (input: TreeTarget | TreeTarget[]) => {
      setMenu(null)
      const list = (Array.isArray(input) ? input : [input])
        .filter((target) => !!target.rel)
        .sort((a, b) => a.rel.length - b.rel.length)
      const targets = list.filter(
        (target, i) =>
          !list.some(
            (other, j) =>
              j < i && (target.rel === other.rel || target.rel.startsWith(`${other.rel}/`))
          )
      )
      if (targets.length === 0) return

      const single = targets.length === 1 ? targets[0] : null
      const affected = tabs.filter(
        (t) =>
          t.kind === 'file' &&
          targets.some((target) => underPath(t.rel, target.rel))
      )
      const dirty = affected.filter((t) => t.kind === 'file' && isDirty(t.rel))
      const dirtySuffix = dirty.length
        ? t('ide.deleteDirtySuffix', { n: dirty.length })
        : ''
      const what =
        single?.kind === 'dir' ? t('ide.deleteDirWhat') : t('ide.deleteFileWhat')
      setDialog({
        title: single
          ? single.kind === 'dir'
            ? t('ide.deleteDirTitle')
            : t('ide.deleteFileTitle')
          : t('ide.deleteManyTitle'),
        message: single
          ? t('ide.deleteMessage', { what, rel: single.rel }) + dirtySuffix
          : t('ide.deleteManyMessage', { n: targets.length }) + dirtySuffix,
        actions: [
          { label: t('common.cancel'), run: () => undefined },
          {
            label: t('ide.delete'),
            kind: 'danger',
            run: async () => {
              if (!api?.ide) return
              const done: TreeTarget[] = []
              let firstError: string | null = null
              for (const target of targets) {
                const r = await api.ide.deleteEntry({ cwd, rel: target.rel })
                if (r.ok) {
                  done.push(target)
                } else if (!firstError) {
                  firstError = r.message
                }
              }
              for (const target of done) dropTabsUnder(target.rel)
              refresh()
              if (done.length > 0) {
                showFlash(
                  done.length === 1
                    ? t('ide.deleted')
                    : t('ide.deletedMany', { n: done.length })
                )
              }
              if (firstError) {
                setNotice(t('ide.deleteFailed', { error: firstError }))
              }
            }
          }
        ]
      })
    },
    [api, cwd, dropTabsUnder, isDirty, refresh, showFlash, tabs, t]
  )

  /** 快捷键 / 命令面板调用的「删除选中的文件树项」 */
  const deleteTreeTarget = useCallback((): void => {
    const targets = selectedTreeTargets()
    if (targets.length > 0) requestDelete(targets)
  }, [requestDelete, selectedTreeTargets])

  /** 右键菜单删除：目标在多选里就整批删，否则只删右键那一项 */
  const deleteForTarget = useCallback(
    (target: TreeTarget): void => {
      const selection = treeSelectionRef.current
      if (target.rel && selection.has(target.rel) && selection.size > 1) {
        requestDelete(selectedTreeTargets())
      } else {
        requestDelete(target)
      }
    },
    [requestDelete, selectedTreeTargets]
  )

  const requestCloseTab = useCallback(
    (key: string) => {
      // 节流窗口里的最后几个字符也要算进未保存判断
      flushEditorText()
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
      // 批量关闭前也落一次节流中的输入，避免漏掉最后一个脏文件
      flushEditorText()
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
      if (rel.startsWith(UNTITLED_PREFIX)) {
        showFlash(t('ide.untitledNoPath'))
        return
      }
      void navigator.clipboard
        .writeText(rel)
        .then(() => showFlash(t('ide.tab.copied')))
        .catch(() => undefined)
    },
    [showFlash, t]
  )

  const requestWindowClose = useCallback(() => {
    // 先落掉节流中的输入，再按旁路镜像重新算脏文件数（不是上一帧的 dirtyCount）
    flushEditorText()
    const liveDirty = Object.keys(fileCache).filter((rel) => isDirty(rel)).length
    if (liveDirty === 0) {
      api?.ide?.confirmClose()
      return
    }
    setDialog({
      title: t('ide.unsavedTitle'),
      message: t('ide.unsavedMultiMessage', { n: liveDirty }),
      actions: [
        { label: t('common.cancel'), run: () => undefined },
        {
          label: t('ide.dontSaveAndClose'),
          kind: 'danger',
          run: () => {
            // 明确选择「不保存」= 放弃草稿，下次打开不能再恢复出来
            discardDraftsRef.current = true
            pendingDraftsRef.current = {}
            writtenDraftsRef.current = {}
            clearDrafts(cwd)
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
  }, [api, cwd, fileCache, isDirty, saveAll])

  useEffect(() => {
    api?.ide?.setDirty(dirtyCount > 0)
  }, [api, dirtyCount])

  useEffect(() => {
    setEncodingMenuOpen(false)
    setLanguageMenuOpen(false)
    setEolMenuOpen(false)
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
    /** 和编辑器 / 终端抢快捷键的命令：只在最后一次鼠标落在资源管理器时响应 */
    const EXPLORER_KEYS = new Set([
      'explorer.copy',
      'explorer.cut',
      'explorer.paste',
      'explorer.selectAll'
    ])

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
      const inEditor = !!(target?.closest?.('.monaco-editor'))
      for (const command of commandsRef.current) {
        const binding = keybindingsRef.current[command.id]
        if (!binding || !matchBinding(binding, e)) continue
        // 终端里的 Ctrl+W / Ctrl+P / Alt+← 等是 shell 的输入，不能抢
        if (inTerminal && !TERMINAL_GLOBAL.has(command.id)) return
        if (EXPLORER_KEYS.has(command.id)) {
          if (!explorerFocusRef.current || typing || inTerminal || inEditor) return
          if (
            (command.id === 'explorer.copy' || command.id === 'explorer.cut') &&
            treeSelectionRef.current.size === 0 &&
            !treeTargetRef.current.rel
          ) {
            return
          }
          if (command.id === 'explorer.paste' && !clipboardRef.current) return
        }
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

  const activeFileLanguage = activeFile ? languageFor(activeFile) : undefined
  const activeFileIndent = activeFile ? indentFor(activeFile) : undefined
  // 加载期间编辑器显示的是上一个文件，语言 / 缩进也要跟着它
  const editorFileLanguage = editorFile ? languageFor(editorFile) : undefined
  const editorFileIndent = editorFile ? indentFor(editorFile) : undefined

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
    // 可能刚敲完就点发送：先落掉节流中的输入
    flushEditorText()
    const text = liveEditorText(file.rel) ?? file.text
    setSendDraft({ refs: [buildIdeRef(file, cwd, 'file', text)], anchor })
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
      setBaseEol((m) => (rel in m ? m : { ...m, [rel]: r.data.eol ?? 'lf' }))
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
          <CursorReadout rel={activeTab.rel} />
          <button
            type="button"
            className="ide-status-lang"
            title={t('ide.language.title')}
            onClick={() => setLanguageMenuOpen(true)}
          >
            {languageLabel(activeFileLanguage ?? activeFile.language)}
          </button>
          <span>{t('ide.lines', { n: activeFile.text.split('\n').length })}</span>
          <button
            type="button"
            className="ide-status-eol"
            title={t('ide.eol.title')}
            onClick={() => setEolMenuOpen(true)}
          >
            {activeFile.eol === 'crlf' ? 'CRLF' : 'LF'}
          </button>
          {activeFile.untitled || activeFile.binary || activeFile.truncated ? (
            <span>{t(ENCODING_LABEL_KEY[activeFile.encoding])}</span>
          ) : (
            <button
              type="button"
              className="ide-status-encoding"
              title={
                activeFile.encodingAuto !== false
                  ? t('ide.encoding.autoTitle')
                  : t('ide.encoding.button')
              }
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
        id: 'file.newUntitled',
        label: t('ide.command.newUntitled'),
        group: file,
        keybinding: displayBindingOf('file.newUntitled'),
        run: newUntitled
      },
      {
        id: 'file.saveAs',
        label: t('ide.command.saveAs'),
        group: file,
        keybinding: displayBindingOf('file.saveAs'),
        run: saveActiveAs
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
        id: 'explorer.copy',
        label: t('ide.command.copy'),
        group: file,
        keybinding: displayBindingOf('explorer.copy'),
        run: () => copyTreeSelection(false)
      },
      {
        id: 'explorer.cut',
        label: t('ide.command.cut'),
        group: file,
        keybinding: displayBindingOf('explorer.cut'),
        run: () => copyTreeSelection(true)
      },
      {
        id: 'explorer.paste',
        label: t('ide.command.paste'),
        group: file,
        keybinding: displayBindingOf('explorer.paste'),
        run: pasteTreeClipboard
      },
      {
        id: 'explorer.selectAll',
        label: t('ide.command.selectAll'),
        group: file,
        keybinding: displayBindingOf('explorer.selectAll'),
        run: selectAllTree
      },
      {
        id: 'explorer.toggleHidden',
        label: t('ide.command.toggleHidden'),
        group: view,
        keybinding: displayBindingOf('explorer.toggleHidden'),
        run: toggleHiddenFiles
      },
      {
        id: 'explorer.toggleIgnored',
        label: t('ide.command.toggleIgnored'),
        group: view,
        keybinding: displayBindingOf('explorer.toggleIgnored'),
        run: toggleIgnoredDirs
      },
      {
        id: 'explorer.editIgnore',
        label: t('ide.command.editIgnore'),
        group: view,
        keybinding: displayBindingOf('explorer.editIgnore'),
        run: editIgnoreRules
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
    newUntitled,
    saveActiveAs,
    copyTreeSelection,
    pasteTreeClipboard,
    selectAllTree,
    toggleHiddenFiles,
    toggleIgnoredDirs,
    editIgnoreRules,
    togglePanel
  ])

  commandsRef.current = commands

  return (
    <div className="ide-app">
      <IdeTitleBar cwd={cwd} onClose={requestWindowClose}>
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
      </IdeTitleBar>

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
            <span className="ide-act-label">{t('ide.rail.files')}</span>
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
            <span className="ide-act-label">{t('ide.rail.search')}</span>
          </button>
          <button
            className={`ide-act ${view === 'vcs' ? 'on' : ''}`}
            title={t('ide.scmTitle')}
            onClick={() => setView('vcs')}
          >
            <Ico d={P.diff} size={17} />
            <span className="ide-act-label">{t('ide.rail.vcs')}</span>
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
            <span className="ide-act-label">{t('ide.rail.sync')}</span>
            {(syncSnap?.failed ?? 0) > 0 && (
              <span className="ide-act-badge is-bad">{syncSnap?.failed}</span>
            )}
          </button>
          <button
            className={`ide-act ${reviewOpen ? 'is-open' : ''}`}
            title={t('ide.review.title')}
            onClick={() => {
              reviewTouchedRef.current = true
              setReviewOpen((v) => !v)
            }}
          >
            <Ico d={P.review} size={17} />
            <span className="ide-act-label">{t('ide.rail.review')}</span>
            {vcs.status && vcs.status.counts.total > 0 && (
              <span className="ide-act-badge">{vcs.status.counts.total}</span>
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
                  <button
                    className={`ide-iconbtn ${explorerPrefs.showHidden ? 'is-on' : ''}`}
                    data-action="toggle-hidden"
                    title={t(
                      explorerPrefs.showHidden
                        ? 'ide.explorer.hideHidden'
                        : 'ide.explorer.showHidden'
                    )}
                    onClick={toggleHiddenFiles}
                  >
                    <Ico d={explorerPrefs.showHidden ? P.eye : P.eyeOff} size={13} />
                  </button>
                  <button
                    className={`ide-iconbtn ${explorerPrefs.showIgnored ? 'is-on' : ''}`}
                    data-action="toggle-ignored"
                    title={t(
                      explorerPrefs.showIgnored
                        ? 'ide.explorer.hideIgnored'
                        : 'ide.explorer.showIgnored'
                    )}
                    onClick={toggleIgnoredDirs}
                  >
                    <Ico d={P.filter} size={13} />
                  </button>
                  <button
                    className="ide-iconbtn"
                    data-action="edit-ignore"
                    title={t('ide.explorer.ignoreTitle')}
                    onClick={editIgnoreRules}
                  >
                    <Ico d={P.sliders} size={13} />
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
              <div
                className={`ide-tree ${dropDir === '' && dragRels.length > 0 ? 'is-drop' : ''}`}
                onDragOver={(e) => dragOverTreeDir('', e)}
                onDragLeave={() => dragLeaveTreeDir('')}
                onDrop={(e) => dropOnTreeDir('', e)}
              >
                <TreeDir
                  key={cwd}
                  cwd={cwd}
                  rel=""
                  name={baseName(cwd)}
                  depth={0}
                  version={treeDirty.version}
                  dirtyAll={treeDirty.all}
                  dirtyDirs={treeDirty.dirs}
                  defaultOpen
                  git={gitMap}
                  selectedRels={treeSelection}
                  explorer={explorerListOptions}
                  dropDir={dropDir}
                  revealRel={reveal?.rel ?? null}
                  revealSeq={reveal?.nonce ?? 0}
                  onSelect={selectTreeTarget}
                  onMenu={openTreeMenu}
                  onOpen={openFile}
                  onDragStart={beginTreeDrag}
                  onDragEnd={endTreeDrag}
                  onDragOverDir={dragOverTreeDir}
                  onDragLeaveDir={dragLeaveTreeDir}
                  onDropDir={dropOnTreeDir}
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
              onRestored={onWorkspaceRestored}
              lastReplace={lastReplace}
              onLastReplace={setLastReplace}
              askConfirm={setDialog}
            />
          )}
        </aside>
        )}

        <div className="ide-workbench">
        <section className="ide-editor">
          <div className="ide-tabs" ref={tabsBarRef}>
            {tabs.map((tab) => (
              <div
                key={tab.key}
                data-tab-key={tab.key}
                className={`ide-tab ${tab.key === activeKey ? 'on' : ''}${
                  tab.pinned ? ' is-pinned' : ''
                }${dragTabKey === tab.key ? ' is-dragging' : ''}${
                  dropTarget?.key === tab.key
                    ? dropTarget.after
                      ? ' is-drop-after'
                      : ' is-drop-before'
                    : ''
                }`}
                title={tab.untitled ? tab.title : tab.rel}
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
                {activeTab.untitled
                  ? <b>{activeTab.title}</b>
                  : activeTab.rel.split('/').map((seg, i, arr) => (
                      <span key={`${seg}-${i}`}>
                        <b>{seg}</b>
                        {i < arr.length - 1 && <i>›</i>}
                      </span>
                    ))}
              </span>
              {activeTab.kind === 'file' && !activeTab.untitled && activeFile && (
                <Breadcrumbs
                  rel={activeTab.rel}
                  symbols={outlineSymbols}
                  onJump={jumpToActiveLine}
                />
              )}
              <span className="ide-crumb-right">
                {activeTab.kind === 'file' && !activeTab.untitled && activeFile && (
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
            {activeTab && showFileLoading && (
              <div className={editorFile ? 'ide-loading ide-loading-overlay' : 'ide-loading'}>
                {t('ide.loadingFile', { rel: activeTab.rel })}
              </div>
            )}
            {activeTab && activeTab.kind !== 'file' && loadingActive && (
              <div className="ide-loading">{t('ide.loadingFile', { rel: activeTab.rel })}</div>
            )}
            {activeTab && activeTab.kind === 'file' && editorFile && (
              editorFile.binary || editorFile.truncated ? (
                <TextViewer
                  file={editorFile}
                  jumpLine={jump?.rel === editorFile.rel ? jump.line : undefined}
                  onSendSelection={openSelectionDraft}
                  onSendFile={() => sendDraftFromFile(editorFile, null)}
                />
              ) : (
                <MonacoEditor
                  cwd={cwd}
                  file={editorFile}
                  jumpLine={jump?.rel === editorFile.rel ? jump.line : undefined}
                  prefs={editorPrefs}
                  languageId={editorFileLanguage}
                  indent={editorFileIndent}
                  openRels={openFileRels}
                  readOnly={showFileLoading}
                  onCursor={handleCursor}
                  onChange={handleEditorChange}
                  onSendSelection={openSelectionDraft}
                  onSendFile={() => sendDraftFromFile(editorFile, null)}
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
              fontSize={editorPrefs.terminalFontSize}
              lineHeight={editorPrefs.terminalLineHeight}
            />
          }
        />
        </div>
        {reviewOpen && (
          <ReviewDock
            cwd={cwd}
            status={vcs.status}
            activeRel={activeTab?.kind === 'file' ? activeTab.rel : undefined}
            onOpenDiff={openDiff}
            onOpenScm={openScmView}
            onClose={closeReviewDock}
          />
        )}
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
              setBaseEol((m) =>
                Object.fromEntries(Object.entries(m).filter(([rel]) => keep.has(rel)))
              )
              setImageCache({})
              setDiffCache({})
              const keepExternal = new Set(dirtyRels.map(extKey))
              setExternal((m) =>
                Object.fromEntries(Object.entries(m).filter(([key]) => keepExternal.has(key)))
              )
              // VCS 操作波及范围未知，全量刷新目录
              setTreeDirty((prev) => ({
                version: prev.version + 1,
                all: true,
                dirs: prev.dirs
              }))
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
          {view !== 'vcs' && activeTab && (
            <span className="ide-status-rel">
              {activeTab.untitled ? activeTab.title : activeTab.rel}
            </span>
          )}
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
          copyKey={displayBindingOf('explorer.copy')}
          cutKey={displayBindingOf('explorer.cut')}
          pasteKey={displayBindingOf('explorer.paste')}
          selectedCount={treeSelection.size}
          canPaste={!!clipboard}
          clipboardMode={clipboard?.mode ?? null}
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
          onDelete={deleteForTarget}
          onCopy={() => copyTreeSelection(false)}
          onCut={() => copyTreeSelection(true)}
          onPaste={() => pasteTreeClipboard()}
          onSelectAll={selectAllTree}
          onEditIgnore={editIgnoreRules}
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
          autoDetected={activeFile.encodingAuto !== false}
          dirty={isDirty(activeTab.rel)}
          onReopen={(encoding) => void reopenWithEncoding(activeTab.rel, encoding)}
          onReopenAuto={() => void reopenWithEncoding(activeTab.rel)}
          onSave={(encoding) => saveWithEncoding(activeTab.rel, encoding)}
          onClose={() => setEncodingMenuOpen(false)}
        />
      )}

      {languageMenuOpen && activeTab?.kind === 'file' && activeFile && (
        <LanguageMenu
          current={activeFileLanguage ?? activeFile.language}
          onPick={(id) => setLanguageMode(activeTab.rel, id)}
          onClose={() => setLanguageMenuOpen(false)}
        />
      )}

      {eolMenuOpen && activeTab?.kind === 'file' && activeFile && (
        <EolMenu
          current={activeFile.eol ?? 'lf'}
          onPick={(eol) => setEolMode(activeTab.rel, eol)}
          onClose={() => setEolMenuOpen(false)}
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
          onClose={() => {
            const cancel = dialog.onCancel
            setDialog(null)
            cancel?.()
          }}
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

function TreeDirView({
  cwd,
  rel,
  name,
  depth,
  version,
  dirtyAll,
  dirtyDirs,
  defaultOpen = false,
  git,
  selectedRels,
  explorer,
  dropDir,
  revealRel,
  revealSeq = 0,
  onSelect,
  onMenu,
  onOpen,
  onDragStart,
  onDragEnd,
  onDragOverDir,
  onDragLeaveDir,
  onDropDir
}: {
  cwd: string
  rel: string
  name: string
  depth: number
  version: number
  /** true = 这一批变化无法定位路径，所有展开目录都刷新 */
  dirtyAll: boolean
  /** 受影响的目录 rel 集合；只有命中的目录才重新 listDir */
  dirtyDirs: Set<string>
  defaultOpen?: boolean
  git: Record<string, VcsChange>
  selectedRels: ReadonlySet<string>
  explorer: IdeListDirOptions
  dropDir: string | null
  /** 「在资源管理器中显示」的目标文件：位于本目录下时就自动展开 */
  revealRel?: string | null
  /** 同一个文件重复触发时靠它重新展开已经收起的目录 */
  revealSeq?: number
  onSelect: (target: TreeTarget, e: ReactMouseEvent) => void
  onMenu: (target: TreeTarget, e: ReactMouseEvent) => void
  onOpen: (rel: string, line?: number) => void
  onDragStart: (target: TreeTarget, e: ReactDragEvent) => void
  onDragEnd: () => void
  onDragOverDir: (dir: string, e: ReactDragEvent) => void
  onDragLeaveDir: (dir: string) => void
  onDropDir: (dir: string, e: ReactDragEvent) => void
}): JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(defaultOpen)
  const [entries, setEntries] = useState<IdeEntry[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [loadedVersion, setLoadedVersion] = useState(-1)
  const target: TreeTarget = { rel, kind: 'dir' }
  const selected = selectedRels.has(rel)
  const revealOpen =
    !!revealRel && (rel === '' || revealRel === rel || revealRel.startsWith(`${rel}/`))

  // 目标文件在更深层目录里：先展开当前层，子目录会各自继续展开
  useEffect(() => {
    if (revealOpen) setOpen(true)
  }, [revealOpen, revealSeq])

  /** 收起期间目录内容可能变了，重新展开时必须无条件列一次 */
  const wasOpen = useRef(false)
  const dirty = dirtyAll || dirtyDirs.has(extKey(rel))
  const ignoreKey = (explorer.ignore ?? []).join('\n')

  useEffect(() => {
    if (!open) {
      wasOpen.current = false
      return
    }
    const reopened = !wasOpen.current
    wasOpen.current = true
    if (!reopened) {
      if (loadedVersion === version) return
      // 这一批变化不涉及本目录：不列目录，等真正命中时再刷
      if (loadedVersion !== -1 && !dirty) return
    }

    let cancelled = false
    setFailed(false)
    const pending = window.api?.ide?.listDir(cwd, rel, explorer)
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
    // ignoreKey 让规则变化时即使 version 没变也重新列
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, version, loadedVersion, cwd, rel, dirty, explorer.showHidden, explorer.showIgnored, ignoreKey])

  return (
    <div className="ide-tnode">
      <div
        className={`ide-trow is-dir ${depth === 0 ? 'is-root' : ''} ${
          selected ? 'is-sel' : ''
        } ${dropDir === rel ? 'is-drop-target' : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        title={rel || cwd}
        data-rel={rel}
        data-kind="dir"
        draggable={rel !== ''}
        onClick={(e) => {
          onSelect(target, e)
          if (!e.ctrlKey && !e.metaKey && !e.shiftKey) setOpen((o) => !o)
        }}
        onContextMenu={(e) => onMenu(target, e)}
        onDragStart={(e) => rel && onDragStart(target, e)}
        onDragEnd={onDragEnd}
        onDragOver={(e) => rel && onDragOverDir(rel, e)}
        onDragLeave={() => rel && onDragLeaveDir(rel)}
        onDrop={(e) => {
          if (!rel) return
          e.stopPropagation()
          onDropDir(rel, e)
        }}
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
                dirtyAll={dirtyAll}
                dirtyDirs={dirtyDirs}
                git={git}
                selectedRels={selectedRels}
                explorer={explorer}
                dropDir={dropDir}
                revealRel={revealRel}
                revealSeq={revealSeq}
                onSelect={onSelect}
                onMenu={onMenu}
                onOpen={onOpen}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                onDragOverDir={onDragOverDir}
                onDragLeaveDir={onDragLeaveDir}
                onDropDir={onDropDir}
              />
            ) : (
              <FileRow
                key={e.rel}
                entry={e}
                depth={depth + 1}
                status={git[e.rel]}
                selected={selectedRels.has(e.rel)}
                onSelect={onSelect}
                onMenu={onMenu}
                onOpen={onOpen}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
              />
            )
          )}
        </div>
      )}
    </div>
  )
}

/** 文件树节点：props 稳定时整棵子树跳过重渲染（输入 / 光标变化都不再波及） */
const TreeDir = memo(TreeDirView)

function FileRowView({
  entry,
  depth,
  status,
  selected,
  onSelect,
  onMenu,
  onOpen,
  onDragStart,
  onDragEnd
}: {
  entry: IdeEntry
  depth: number
  status?: VcsChange
  selected: boolean
  onSelect: (target: TreeTarget, e: ReactMouseEvent) => void
  onMenu: (target: TreeTarget, e: ReactMouseEvent) => void
  onOpen: (rel: string, line?: number) => void
  onDragStart: (target: TreeTarget, e: ReactDragEvent) => void
  onDragEnd: () => void
}): JSX.Element {
  const target: TreeTarget = { rel: entry.rel, kind: 'file' }
  return (
    <div
      className={`ide-trow is-file ${selected ? 'is-sel' : ''}`}
      style={{ paddingLeft: 26 + depth * 12 }}
      title={entry.rel}
      data-rel={entry.rel}
      data-kind="file"
      draggable
      onClick={(e) => {
        onSelect(target, e)
        if (!e.ctrlKey && !e.metaKey && !e.shiftKey) onOpen(entry.rel)
      }}
      onContextMenu={(e) => onMenu(target, e)}
      onDragStart={(e) => onDragStart(target, e)}
      onDragEnd={onDragEnd}
    >
      <Ico d={isImageRel(entry.rel) ? P.image : P.file} size={13} />
      <span className="ide-tname">{entry.name}</span>
      {status && <em className={`ide-gitst is-${status === '?' ? 'u' : status.toLowerCase()}`}>{status}</em>}
    </div>
  )
}

const FileRow = memo(FileRowView)

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

/** 搜索历史按工作区存在 localStorage 里；只存查询条件，不存结果 */
interface SearchHistoryEntry {
  q: string
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  include: string
  exclude: string
}

const SEARCH_HISTORY_MAX = 20

function searchHistoryKey(cwd: string): string {
  return `ccoder:ide:search-history:${cwd}`
}

function readSearchHistory(cwd: string): SearchHistoryEntry[] {
  try {
    const raw = localStorage.getItem(searchHistoryKey(cwd))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (v): v is SearchHistoryEntry =>
          !!v &&
          typeof v === 'object' &&
          typeof (v as SearchHistoryEntry).q === 'string' &&
          ((v as SearchHistoryEntry).q as string).trim().length > 0
      )
      .map((v) => ({
        q: v.q,
        caseSensitive: v.caseSensitive === true,
        wholeWord: v.wholeWord === true,
        regex: v.regex === true,
        include: typeof v.include === 'string' ? v.include : '',
        exclude: typeof v.exclude === 'string' ? v.exclude : ''
      }))
      .slice(0, SEARCH_HISTORY_MAX)
  } catch {
    return []
  }
}

function writeSearchHistory(cwd: string, entries: SearchHistoryEntry[]): void {
  try {
    if (entries.length === 0) localStorage.removeItem(searchHistoryKey(cwd))
    else localStorage.setItem(searchHistoryKey(cwd), JSON.stringify(entries))
  } catch {
    // localStorage 满了不影响搜索
  }
}

function sameSearch(a: SearchHistoryEntry, b: SearchHistoryEntry): boolean {
  return (
    a.q === b.q &&
    a.caseSensitive === b.caseSensitive &&
    a.wholeWord === b.wholeWord &&
    a.regex === b.regex &&
    a.include.trim() === b.include.trim() &&
    a.exclude.trim() === b.exclude.trim()
  )
}

interface SearchPreviewState {
  data: IdeReplaceData
  req: {
    query: string
    replacement: string
    options: IdeSearchOptions
    dirtyRels: string[]
  }
}

interface LastReplaceState {
  summary: string
  undoToken?: string
  undoFiles: number
}

const SearchPanel = memo(function SearchPanel({
  cwd,
  onOpen,
  dirtyRels,
  onReplaced,
  onRestored,
  lastReplace,
  onLastReplace,
  askConfirm
}: {
  cwd: string
  onOpen: (rel: string, line?: number) => void
  dirtyRels: string[]
  onReplaced: (r: IdeReplaceData) => void
  onRestored: (files: number) => void
  lastReplace: LastReplaceState | null
  onLastReplace: (state: LastReplaceState | null) => void
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
  const [previewBusy, setPreviewBusy] = useState(false)
  const [preview, setPreview] = useState<SearchPreviewState | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  /** 本次结果是否来自内置搜索（rg 不可用 / 启动失败） */
  const [fallback, setFallback] = useState(false)
  /** 折叠起来的文件（按 rel）；新搜索会清空，默认全部展开 */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [history, setHistory] = useState<SearchHistoryEntry[]>(() => readSearchHistory(cwd))
  const [historyOpen, setHistoryOpen] = useState(false)
  const historyBoxRef = useRef<HTMLDivElement>(null)
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

  useEffect(() => {
    setHistory(readSearchHistory(cwd))
    setHistoryOpen(false)
  }, [cwd])

  const rememberSearch = useCallback(
    (entry: SearchHistoryEntry): void => {
      setHistory((prev) => {
        const next = [entry, ...prev.filter((e) => !sameSearch(e, entry))].slice(
          0,
          SEARCH_HISTORY_MAX
        )
        writeSearchHistory(cwd, next)
        return next
      })
    },
    [cwd]
  )

  useEffect(() => {
    if (!historyOpen) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (historyBoxRef.current?.contains(target)) return
      if (target.closest('.ide-shistory-toggle')) return
      setHistoryOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setHistoryOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [historyOpen])

  useEffect(() => {
    if (!preview) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !replacing) setPreview(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview, replacing])

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
      setCollapsed(new Set())

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
        rememberSearch({
          q,
          caseSensitive,
          wholeWord,
          regex,
          include: includeText.trim(),
          exclude: excludeText.trim()
        })
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
  }, [
    cwd,
    q,
    options,
    refreshTick,
    usable,
    caseSensitive,
    wholeWord,
    regex,
    includeText,
    excludeText,
    rememberSearch
  ])

  const total = results.reduce((n, f) => n + f.matches.length, 0)
  const allCollapsed =
    results.length > 0 && results.every((f) => collapsed.has(f.rel))
  const toggleFile = (rel: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(rel)) next.delete(rel)
      else next.add(rel)
      return next
    })
  }
  const toggleAllCollapsed = (): void => {
    setCollapsed(allCollapsed ? new Set() : new Set(results.map((f) => f.rel)))
  }
  const canReplace =
    searched && !busy && !replacing && !previewBusy && total > 0 && !error && usable

  const doReplace = async (req: SearchPreviewState['req']): Promise<void> => {
    setReplacing(true)
    setError(null)
    try {
      const api = window.api
      if (!api?.ide) {
        setError(t('ide.replaceUnsupported'))
        return
      }
      const r = await api.ide.replaceInWorkspace({
        cwd,
        query: req.query,
        replacement: req.replacement,
        options: req.options,
        dirtyRels: req.dirtyRels
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
      onLastReplace({
        summary: t('ide.replaced', { summary: parts.join(' · ') }),
        undoToken: d.undoToken,
        undoFiles: d.undoFiles ?? 0
      })
      setPreview(null)

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

  /** 先跑一次不写盘的替换，拿到逐文件示例再让用户确认 */
  const openReplacePreview = async (): Promise<void> => {
    if (!canReplace) return
    setPreviewBusy(true)
    setError(null)
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
        dirtyRels,
        preview: true
      })
      if (!r.ok) {
        setError(r.message)
        return
      }
      if (r.data.aborted) {
        setError(r.data.message ?? t('ide.replaceAborted'))
        return
      }
      setPreview({
        data: r.data,
        req: { query: q, replacement, options, dirtyRels }
      })
    } catch (err) {
      setError(
        t('ide.replaceFailed', {
          error: err instanceof Error ? err.message : String(err)
        })
      )
    } finally {
      setPreviewBusy(false)
    }
  }

  const doUndo = async (token: string): Promise<void> => {
    setReplacing(true)
    setError(null)
    try {
      const api = window.api
      if (!api?.ide) {
        setError(t('ide.replaceUnsupported'))
        return
      }
      const r = await api.ide.undoReplace({ cwd, token })
      if (!r.ok) {
        setError(t('ide.undoFailed', { error: r.message }))
        return
      }
      const skipped = r.data.files.length - r.data.restoredFiles
      onRestored(r.data.restoredFiles)
      onLastReplace(
        skipped > 0
          ? {
              summary: t('ide.undoPartial', {
                files: r.data.restoredFiles,
                skipped
              }),
              undoFiles: 0
            }
          : null
      )
      setRefreshTick((x) => x + 1)
    } catch (err) {
      setError(
        t('ide.undoFailed', {
          error: err instanceof Error ? err.message : String(err)
        })
      )
    } finally {
      setReplacing(false)
    }
  }

  const onUndo = (token: string): void => {
    askConfirm({
      title: t('ide.undoReplaceTitle'),
      message: t('ide.undoReplaceMessage', {
        files: lastReplace?.undoFiles ?? 0
      }),
      actions: [
        { label: t('common.cancel'), run: () => undefined },
        { label: t('ide.undoReplace'), kind: 'danger', run: () => doUndo(token) }
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
        <button
          type="button"
          className={`ide-shistory-toggle ${historyOpen ? 'is-on' : ''}`}
          aria-expanded={historyOpen}
          title={t('ide.searchHistory')}
          onClick={() => setHistoryOpen((v) => !v)}
        >
          <Ico d={P.history} size={12} />
        </button>
      </div>

      {historyOpen && (
        <div className="ide-shistory" ref={historyBoxRef}>
          <div className="ide-shistory-head">
            <span>{t('ide.searchHistory')}</span>
            {history.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setHistory([])
                  writeSearchHistory(cwd, [])
                }}
              >
                {t('ide.searchHistoryClear')}
              </button>
            )}
          </div>
          {history.length === 0 ? (
            <div className="ide-shistory-empty">{t('ide.searchHistoryEmpty')}</div>
          ) : (
            history.map((entry, i) => {
              const flags = [
                entry.caseSensitive ? 'Aa' : '',
                entry.wholeWord ? t('ide.wholeWordShort') : '',
                entry.regex ? '.*' : '',
                entry.include || entry.exclude ? t('ide.filter') : ''
              ].filter(Boolean)
              return (
                <div className="ide-shistory-row" key={`${entry.q}-${i}`}>
                  <button
                    type="button"
                    className="ide-shistory-main"
                    title={entry.q}
                    onClick={() => {
                      setQ(entry.q)
                      setCaseSensitive(entry.caseSensitive)
                      setWholeWord(entry.wholeWord)
                      setRegex(entry.regex)
                      setIncludeText(entry.include)
                      setExcludeText(entry.exclude)
                      if (entry.include || entry.exclude) setShowFilters(true)
                      setHistoryOpen(false)
                      // 即使查询条件完全相同，也重新跑一次（磁盘可能已经变了）
                      setRefreshTick((x) => x + 1)
                    }}
                  >
                    <span>{entry.q}</span>
                    {flags.length > 0 && <em>{flags.join(' · ')}</em>}
                  </button>
                  <button
                    type="button"
                    className="ide-shistory-del"
                    title={t('ide.searchHistoryRemove')}
                    onClick={() => {
                      const next = history.filter((_, j) => j !== i)
                      setHistory(next)
                      writeSearchHistory(cwd, next)
                    }}
                  >
                    <Ico d={P.close} size={9} />
                  </button>
                </div>
              )
            })
          )}
        </div>
      )}

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
            onClick={() => void openReplacePreview()}
            title={t('ide.replacePreviewTitle')}
          >
            {replacing || previewBusy ? <span className="ide-spin" /> : t('ide.replaceAll')}
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
        <span className="ide-searchsum-text">
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
        </span>
        {searched && results.length > 0 && !error && (
          <button
            type="button"
            className="ide-scollapse-all"
            onClick={toggleAllCollapsed}
            title={
              allCollapsed ? t('ide.searchExpandAll') : t('ide.searchCollapseAll')
            }
          >
            {allCollapsed ? t('ide.searchExpandAll') : t('ide.searchCollapseAll')}
          </button>
        )}
      </div>
      {note && !error && <div className="ide-searchnote">{note}</div>}
      {fallback && !note && !error && (
        <div className="ide-searchnote">{t('ide.searchFallback')}</div>
      )}
      {lastReplace && (
        <div className="ide-searchsum is-done ide-sundobar">
          <span className="ide-searchsum-text">{lastReplace.summary}</span>
          {lastReplace.undoToken && (
            <button
              type="button"
              className="ide-sundo"
              data-action="undo-replace"
              disabled={replacing}
              onClick={() => onUndo(lastReplace.undoToken as string)}
            >
              {t('ide.undoReplace')}
            </button>
          )}
        </div>
      )}

      <div className="ide-searchres">
        {results.map((f) => {
          const folded = collapsed.has(f.rel)
          return (
            <div key={f.rel} className="ide-sfile">
              <button
                type="button"
                className="ide-sfhead"
                aria-expanded={!folded}
                title={f.rel}
                onClick={() => toggleFile(f.rel)}
              >
                <Ico d={folded ? P.chevron : P.down} size={10} />
                <Ico d={P.file} size={12} />
                <span>{f.name}</span>
                <em>{f.matches.length}</em>
              </button>
              {!folded &&
                f.matches.map((m, i) => (
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
          )
        })}
        {searched && results.length === 0 && !busy && !error && (
          <div className="ide-emptyhint">{t('ide.noMatches')}</div>
        )}
      </div>

      {preview &&
        (() => {
          const files = preview.data.preview ?? []
          const skippedDirty = preview.data.totals.filesSkippedDirty
          const skippedOther =
            preview.data.totals.filesSkippedBinary + preview.data.totals.filesSkippedLarge
          return (
            <div
              className="ide-preview-overlay"
              onMouseDown={() => {
                if (!replacing) setPreview(null)
              }}
            >
              <div
                className="ide-preview"
                role="dialog"
                aria-modal="true"
                aria-label={t('ide.replacePreviewTitle')}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div className="ide-preview-title">
                  <span>{t('ide.replacePreviewTitle')}</span>
                  <button
                    type="button"
                    className="ide-preview-close"
                    disabled={replacing}
                    onClick={() => setPreview(null)}
                    title={t('common.cancel')}
                  >
                    <Ico d={P.close} size={11} />
                  </button>
                </div>
                <div className="ide-preview-summary">
                  {t('ide.replacePreviewSummary', {
                    files: files.length,
                    total: preview.data.totals.replacements
                  })}
                </div>
                {(skippedDirty > 0 || skippedOther > 0) && (
                  <div className="ide-preview-notes">
                    {skippedDirty > 0 &&
                      t('ide.replaceSkippedDirty', { n: skippedDirty })}
                    {skippedDirty > 0 && skippedOther > 0 ? ' · ' : ''}
                    {skippedOther > 0 &&
                      t('ide.replaceIgnored', { n: skippedOther })}
                  </div>
                )}
                <div className="ide-preview-list">
                  {files.length === 0 ? (
                    <div className="ide-preview-empty">
                      {t('ide.replacePreviewEmpty')}
                    </div>
                  ) : (
                    files.map((f) => (
                      <div key={f.rel} className="ide-preview-file">
                        <div className="ide-preview-filehead" title={f.rel}>
                          <span>{f.rel}</span>
                          <em>{f.replacements}</em>
                        </div>
                        {f.samples.map((s, i) => (
                          <div className="ide-preview-sample" key={`${f.rel}-${s.line}-${i}`}>
                            <span className="ide-preview-line">{s.line}</span>
                            <div className="ide-preview-lines">
                              <div className="is-before">{s.before}</div>
                              <div className="is-after">{s.after}</div>
                            </div>
                          </div>
                        ))}
                        {f.more && (
                          <div className="ide-preview-more">
                            {t('ide.replacePreviewMore', {
                              n: Math.max(0, f.replacements - f.samples.length)
                            })}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
                {preview.data.previewTruncated && (
                  <div className="ide-preview-note">
                    {t('ide.replacePreviewTruncated', { files: files.length })}
                  </div>
                )}
                <div className="ide-preview-actions">
                  <button
                    type="button"
                    className="ide-preview-cancel"
                    disabled={replacing}
                    onClick={() => setPreview(null)}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    className="ide-preview-apply"
                    disabled={replacing || files.length === 0}
                    onClick={() => void doReplace(preview.req)}
                  >
                    {replacing ? <span className="ide-spin" /> : t('ide.replaceAll')}
                  </button>
                </div>
              </div>
            </div>
          )
        })()}
    </div>
  )
})

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
  copyKey,
  cutKey,
  pasteKey,
  selectedCount,
  canPaste,
  clipboardMode,
  onClose,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
  onCopy,
  onCut,
  onPaste,
  onSelectAll,
  onEditIgnore,
  onSend
}: {
  state: TreeMenuState
  renameKey?: string
  deleteKey?: string
  copyKey?: string
  cutKey?: string
  pasteKey?: string
  selectedCount: number
  canPaste: boolean
  clipboardMode: 'copy' | 'cut' | null
  onClose: () => void
  onNewFile: (target: TreeTarget) => void
  onNewFolder: (target: TreeTarget) => void
  onRename: (target: TreeTarget) => void
  onDelete: (target: TreeTarget) => void
  onCopy: () => void
  onCut: () => void
  onPaste: () => void
  onSelectAll: () => void
  onEditIgnore: () => void
  onSend: (target: TreeTarget) => void
}): JSX.Element {
  const { t } = useI18n()
  const target = state.target
  const dir: TreeTarget =
    target.kind === 'dir' ? target : { rel: dirOfRel(target.rel), kind: 'dir' }
  const left = Math.max(8, Math.min(state.x, window.innerWidth - 196))
  const top = Math.max(8, Math.min(state.y, window.innerHeight - 340))
  const count = Math.max(1, selectedCount)

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
        <span className="ide-ctx-sep" />
        <button
          disabled={!target.rel && selectedCount === 0}
          onClick={() => {
            onClose()
            onCopy()
          }}
        >
          <Ico d={P.copy} size={13} />
          {t('ide.explorer.copy')}
          {copyKey && <kbd>{copyKey}</kbd>}
        </button>
        <button
          disabled={!target.rel && selectedCount === 0}
          onClick={() => {
            onClose()
            onCut()
          }}
        >
          <Ico d={P.cut} size={13} />
          {t('ide.explorer.cut')}
          {cutKey && <kbd>{cutKey}</kbd>}
        </button>
        <button
          disabled={!canPaste}
          onClick={() => {
            onClose()
            onPaste()
          }}
        >
          <Ico d={P.paste} size={13} />
          {clipboardMode === 'cut'
            ? t('ide.explorer.pasteMove')
            : t('ide.explorer.paste')}
          {pasteKey && <kbd>{pasteKey}</kbd>}
        </button>
        <button
          onClick={() => {
            onClose()
            onSelectAll()
          }}
        >
          <Ico d={P.files} size={13} />
          {t('ide.explorer.selectAll')}
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
              {count > 1
                ? t('ide.explorer.deleteCount', { n: count })
                : t('ide.delete')}
              {deleteKey && <kbd>{deleteKey}</kbd>}
            </button>
          </>
        )}
        <span className="ide-ctx-sep" />
        <button
          onClick={() => {
            onClose()
            onEditIgnore()
          }}
        >
          <Ico d={P.sliders} size={13} />
          {t('ide.explorer.ignoreTitle')}
        </button>
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

  const cancel = (): void => {
    onClose()
    state.onCancel?.()
  }

  return (
    <div className="ide-dialog-overlay" onMouseDown={cancel}>
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
              cancel()
            }
          }}
        />
        <div className="ide-dialog-actions">
          <button onClick={cancel}>{t('common.cancel')}</button>
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
