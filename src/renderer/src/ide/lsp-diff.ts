import type { LspPosition, LspRange } from '@shared/lsp'

/**
 * 把一个整段文本变化压成 LSP 的「range + 替换文本」。
 *
 * 服务器大多声明 Incremental 同步；直接把全文塞进 contentChanges[0].text
 * 虽然协议允许，但 rust-analyzer 一类按 range 解析的服务器可能不认。
 * 这里用最长公共前缀 / 后缀求最小变更区间，位置按 UTF-16 code unit 计，
 * 和 LSP / Monaco 的约定一致。
 */

function positionAt(text: string, offset: number): LspPosition {
  const safe = Math.max(0, Math.min(text.length, offset))
  const before = text.slice(0, safe)
  const line = (before.match(/\n/g) ?? []).length
  const lastNewline = before.lastIndexOf('\n')
  return { line, character: safe - lastNewline - 1 }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

export interface LspContentChange {
  range: LspRange
  text: string
}

export function diffChange(oldText: string, newText: string): LspContentChange | null {
  if (oldText === newText) return null
  const oldLen = oldText.length
  const newLen = newText.length
  const max = Math.min(oldLen, newLen)
  let start = 0
  while (start < max && oldText.charCodeAt(start) === newText.charCodeAt(start)) start++
  let oldEnd = oldLen
  let newEnd = newLen
  while (
    oldEnd > start &&
    newEnd > start &&
    oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)
  ) {
    oldEnd--
    newEnd--
  }
  // 不要把代理对劈成两半；否则服务器会把半个 emoji 当成一个字符
  if (
    start > 0 &&
    start < oldLen &&
    isLowSurrogate(oldText.charCodeAt(start)) &&
    isHighSurrogate(oldText.charCodeAt(start - 1))
  ) {
    start--
  }
  if (
    oldEnd < oldLen &&
    oldEnd > start &&
    isLowSurrogate(oldText.charCodeAt(oldEnd)) &&
    isHighSurrogate(oldText.charCodeAt(oldEnd - 1))
  ) {
    oldEnd--
  }
  return {
    range: { start: positionAt(oldText, start), end: positionAt(oldText, oldEnd) },
    text: newText.slice(start, newEnd)
  }
}
