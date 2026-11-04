import { useSyncExternalStore } from 'react'

/**
 * 编辑器与 IDE 外壳之间的高频状态桥。
 *
 * 光标位置和正在输入的文本都会以远高于普通 UI 状态的频率变化。如果直接
 * 放进 IdeApp 的 useState，每敲一个键 / 每移动一次光标都会让整个 IDE
 * （文件树、审阅栏、搜索面板……）重渲染一次。这里把它们放在 React 树
 * 外面：
 *
 *  - 光标用 useSyncExternalStore，只让真正显示行列号的面包屑 / 状态栏
 *    重新渲染；
 *  - 文本按 200ms 节流写进 liveTexts，并同步触发一次普通的 onChange，
 *    IdeApp 只在这个节奏上更新 fileCache。保存、关闭、外部改动判断等
 *    需要「最新文本」的场景先调用 flushEditorText()，拿到的一定是最新值。
 */

export interface IdeCursor {
  rel: string
  line: number
  col: number
}

let cursor: IdeCursor | null = null
const cursorListeners = new Set<() => void>()

export function getIdeCursor(): IdeCursor | null {
  return cursor
}

export function setIdeCursor(next: IdeCursor | null): void {
  if (
    next === cursor ||
    (next &&
      cursor &&
      next.rel === cursor.rel &&
      next.line === cursor.line &&
      next.col === cursor.col) ||
    (!next && !cursor)
  ) {
    return
  }
  cursor = next
  for (const listener of cursorListeners) listener()
}

function subscribeCursor(listener: () => void): () => void {
  cursorListeners.add(listener)
  return () => {
    cursorListeners.delete(listener)
  }
}

export function useIdeCursor(): IdeCursor | null {
  return useSyncExternalStore(subscribeCursor, getIdeCursor, getIdeCursor)
}

/* ── 文本旁路镜像 ───────────────────────────────────────── */

const liveTexts = new Map<string, string>()

/** 编辑器已经产生、但可能还没提交到 fileCache 的最新文本 */
export function setLiveEditorText(rel: string, text: string): void {
  liveTexts.set(rel, text)
}

export function liveEditorText(rel: string): string | undefined {
  return liveTexts.get(rel)
}

/** 页签关闭 / model 释放后清掉，避免下次重新打开时读到旧缓冲 */
export function forgetLiveEditorText(rel: string): void {
  liveTexts.delete(rel)
}

/**
 * 当前被 MonacoEditor 持有（页签里打开着）的 model URI。
 *
 * tsProject 的隐藏 model 有 LRU 上限，淘汰时必须跳过这些 model ——
 * 后台页签里的 model 没有挂在编辑器上，单看 getEditors() 判断不出来。
 */
const openModelUris = new Set<string>()

export function markModelOpen(uri: string): void {
  openModelUris.add(uri)
}

export function markModelClosed(uri: string): void {
  openModelUris.delete(uri)
}

export function isModelOpen(uri: string): boolean {
  return openModelUris.has(uri)
}

let flusher: (() => void) | null = null

/** MonacoEditor 挂载时注册；同一时刻 IDE 只有一个编辑器实例 */
export function registerEditorTextFlusher(fn: () => void): () => void {
  flusher = fn
  return () => {
    if (flusher === fn) flusher = null
  }
}

/**
 * 立刻把编辑器里待发送的文本写出去。
 *
 * 保存 / 关闭 / 外部改动检测之前调用，保证 liveEditorText(rel) 和
 * 随后的 onChange 都是最新的；没有挂载编辑器时是空操作。
 */
export function flushEditorText(): void {
  flusher?.()
}
