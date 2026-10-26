import micromatch from 'micromatch'
import type { IdeSearchOptions } from '../shared/ide'
import { t } from './i18n'

/**
 * IDE 工作区搜索的纯匹配层：不碰 Electron / fs，只负责把 query + options
 * 编译成正则和 glob 判定，以及逐行收集命中、生成片段、展开替换。
 *
 * 搜索和替换共用这里，保证"面板显示多少处"和"实际替换多少处"不会分叉。
 */

const MAX_QUERY_CHARS = 2000
const MAX_GLOB_PATTERNS = 64
const MAX_GLOB_CHARS = 512
/** 全字匹配用的"词字符"：与 JS \w 的 ASCII 部分一致，避免中文被当成词边界 */
const WORD_CHAR = '[A-Za-z0-9_]'

/** 片段窗口：命中前后各留一点上下文 */
const SNIPPET_BEFORE = 60
const SNIPPET_AFTER = 180

export type SearchPatternErrorCode = 'invalid-query' | 'invalid-regex' | 'invalid-glob'

export class SearchPatternError extends Error {
  readonly code: SearchPatternErrorCode

  constructor(code: SearchPatternErrorCode, message: string) {
    super(message)
    this.name = 'SearchPatternError'
    this.code = code
  }
}

export interface CompiledSearch {
  regex: RegExp
  /** true = 字面量模式，替换串不做 $1 展开 */
  literal: boolean
  /** 字面量原文（已 trim）；regex 模式为 undefined */
  literalText?: string
  wholeWord: boolean
  caseSensitive: boolean
}

export interface CompiledGlobs {
  includeCount: number
  excludeCount: number
  test(rel: string): boolean
}

export interface MatchSpan {
  /** 行内 0-based 偏移，UTF-16 */
  index: number
  /** UTF-16 长度 */
  length: number
  match: RegExpExecArray
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 全字匹配的源串。JS 引擎和 rg --pcre2 共用这里，避免搜索和替换对
 * “什么算一个词”产生分歧。
 */
export function wordSource(core: string): string {
  return `(?<!${WORD_CHAR})(?:${core})(?!${WORD_CHAR})`
}

/** 字面量 + 全字匹配：转义后再套 ASCII 词边界 */
export function literalWholeWordSource(text: string): string {
  return wordSource(escapeRegExp(text))
}

/** 把用户输入编译成逐行执行的正则；非法模式抛 SearchPatternError */
export function compileSearch(
  query: unknown,
  options: IdeSearchOptions | undefined
): CompiledSearch {
  if (typeof query !== 'string') {
    throw new SearchPatternError('invalid-query', t('ideError.searchInvalid'))
  }
  if (query.length > MAX_QUERY_CHARS) {
    throw new SearchPatternError(
      'invalid-query',
      t('ideError.searchLong', { n: MAX_QUERY_CHARS })
    )
  }
  if (query.includes('\0')) {
    throw new SearchPatternError('invalid-query', t('ideError.searchInvalid'))
  }

  const regexMode = options?.regex === true
  const wholeWord = options?.wholeWord === true
  const caseSensitive = options?.caseSensitive === true

  // 字面量沿用旧行为：去掉首尾空白；正则模式原样保留，空白可能有意义
  const literalText = regexMode ? undefined : query.trim()
  const core = regexMode ? query : escapeRegExp(literalText ?? '')
  if (!core) {
    throw new SearchPatternError('invalid-query', t('ideError.searchEmpty'))
  }

  // 包一层非捕获组，捕获组编号不受影响；前后用定长 lookaround，Node/Chromium 都支持
  const source = wholeWord ? wordSource(core) : core

  let regex: RegExp
  try {
    regex = new RegExp(source, caseSensitive ? 'g' : 'gi')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new SearchPatternError('invalid-regex', t('ideError.regexInvalid', { detail }))
  }

  return {
    regex,
    literal: !regexMode,
    literalText,
    wholeWord,
    caseSensitive
  }
}

function normalizePatterns(raw: unknown, label: string): string[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw new SearchPatternError('invalid-glob', t('ideError.globNotArray', { label }))
  }
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new SearchPatternError('invalid-glob', t('ideError.globNotString', { label }))
    }
    const p = item.trim().replace(/\\/g, '/')
    if (!p) continue
    if (p.length > MAX_GLOB_CHARS) {
      throw new SearchPatternError(
        'invalid-glob',
        t('ideError.globLong', { label, raw: p.slice(0, 40) + '…' })
      )
    }
    out.push(p)
  }
  if (out.length > MAX_GLOB_PATTERNS) {
    throw new SearchPatternError(
      'invalid-glob',
      t('ideError.globMax', { label, n: MAX_GLOB_PATTERNS })
    )
  }
  return out
}

function compileMatchers(patterns: string[], label: string): ((rel: string) => boolean)[] {
  const opts = {
    dot: true,
    // 排除框是唯一的否定机制，不把 ! 前缀解释成取反
    nonegate: true,
    nocase: process.platform === 'win32'
  }
  return patterns.map((raw) => {
    // 不含斜杠的模式（如 *.ts）按"任意层级"处理，和 VS Code 的直觉一致。
    // 注意不能用 micromatch 的 basename 选项：它会让带斜杠的模式也失效。
    const p = raw.includes('/') ? raw : `**/${raw}`
    try {
      const fn = micromatch.matcher(p, opts)
      if (typeof fn !== 'function') throw new Error(t('ideError.matcherMissing'))
      return fn
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new SearchPatternError('invalid-glob', t('ideError.globInvalid', { label, raw, detail }))
    }
  })
}

/** 编译 include / exclude；工作区相对 POSIX 路径判定 */
export function compileGlobs(options: IdeSearchOptions | undefined): CompiledGlobs {
  const include = normalizePatterns(options?.include, t('ideError.include'))
  const exclude = normalizePatterns(options?.exclude, t('ideError.exclude'))
  const includeFns = compileMatchers(include, t('ideError.include'))
  const excludeFns = compileMatchers(exclude, t('ideError.exclude'))

  return {
    includeCount: includeFns.length,
    excludeCount: excludeFns.length,
    test(rel: string): boolean {
      const norm = rel.replace(/\\/g, '/')
      if (includeFns.length > 0 && !includeFns.some((fn) => fn(norm))) return false
      return !excludeFns.some((fn) => fn(norm))
    }
  }
}

/**
 * 收集一行里所有非空命中。
 *
 * 零长度命中（`^`、`a*`、纯 lookahead）会被跳过：它们没有可高亮的范围，
 * 替换时也会变成难以解释的"每行插一段"。跳过时按 code point 推进 lastIndex，
 * 避免空匹配把循环卡死。
 */
export function collectSpans(
  line: string,
  regex: RegExp
): { spans: MatchSpan[]; skippedEmpty: boolean } {
  regex.lastIndex = 0
  const spans: MatchSpan[] = []
  let skippedEmpty = false

  for (;;) {
    const m = regex.exec(line)
    if (!m) break

    if (m[0].length === 0) {
      skippedEmpty = true
      const cp = line.codePointAt(m.index)
      const step = cp !== undefined && cp > 0xffff ? 2 : 1
      regex.lastIndex = m.index + step
      if (regex.lastIndex > line.length) break
      continue
    }

    spans.push({ index: m.index, length: m[0].length, match: m })
    // g 模式下 exec 会自动推进；这行是防御，防止未来改 flags 后死循环
    if (regex.lastIndex === m.index) regex.lastIndex = m.index + m[0].length
  }

  return { spans, skippedEmpty }
}

/** 命中附近的一小段文本，`offset` 指向 text 里的命中起点 */
export function makeSnippet(
  line: string,
  span: { index: number; length: number }
): { text: string; offset: number } {
  const start = Math.max(0, span.index - SNIPPET_BEFORE)
  const end = Math.min(line.length, span.index + span.length + SNIPPET_AFTER)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < line.length ? '…' : ''
  return {
    text: prefix + line.slice(start, end) + suffix,
    offset: prefix.length + (span.index - start)
  }
}

/**
 * 展开正则替换串。支持 $$、$&、$1..$99、$<name>；未知的 $ 序列原样保留。
 * 刻意不支持 $` 和 $'：它们会把整行前后文反复插入，很容易把文件撑爆。
 */
function expandReplacement(m: RegExpExecArray, template: string): string {
  let out = ''
  for (let i = 0; i < template.length; i++) {
    const ch = template[i]
    if (ch !== '$' || i + 1 >= template.length) {
      out += ch
      continue
    }

    const next = template[i + 1]
    if (next === '$') {
      out += '$'
      i += 1
      continue
    }
    if (next === '&') {
      out += m[0]
      i += 1
      continue
    }
    if (next === '<') {
      const close = template.indexOf('>', i + 2)
      if (close > i + 2 && m.groups && Object.prototype.hasOwnProperty.call(m.groups, template.slice(i + 2, close))) {
        const name = template.slice(i + 2, close)
        out += m.groups[name] ?? ''
        i = close
      } else {
        out += ch
      }
      continue
    }
    if (next >= '0' && next <= '9') {
      const groupCount = m.length - 1
      const two = template.slice(i + 1, i + 3)
      const twoNum = Number(two)
      if (/^\d{2}$/.test(two) && twoNum >= 1 && twoNum <= groupCount) {
        out += m[twoNum] ?? ''
        i += 2
        continue
      }
      const oneNum = Number(next)
      if (oneNum >= 1 && oneNum <= groupCount) {
        out += m[oneNum] ?? ''
        i += 1
        continue
      }
      // 没有这个捕获组：$ 原样保留，数字留给下一轮
      out += '$'
      continue
    }

    out += ch
  }
  return out
}

/** 单行替换；返回替换后的整行和处数（零长度命中不计） */
export function replaceLine(
  line: string,
  compiled: CompiledSearch,
  replacement: string
): { text: string; count: number } {
  const { spans } = collectSpans(line, compiled.regex)
  if (spans.length === 0) return { text: line, count: 0 }

  let out = ''
  let last = 0
  for (const span of spans) {
    out += line.slice(last, span.index)
    out += compiled.literal ? replacement : expandReplacement(span.match, replacement)
    last = span.index + span.length
  }
  out += line.slice(last)
  return { text: out, count: spans.length }
}
