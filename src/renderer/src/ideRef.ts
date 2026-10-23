import type { IdeCodeRef } from '@shared/ide-chat'
import { tr } from './i18n'

/**
 * 代码引用在消息正文里的编码 / 解码。
 *
 * 为什么不用普通 Markdown 代码块：要能从 CLI 写回的 jsonl 里把「引用」
 * 和用户原话重新拆开，纯代码块没有边界信息。这里用一层 XML 标签包住
 * 围栏代码块，模型读得懂，渲染层也能稳定还原。
 *
 * 围栏长度按内容里最长的一串反引号动态决定，代码里带 ``` 也不会截断。
 */

const OPEN = /<ide_reference\s+([^>]*)>\s*(`{3,})([^\n]*)\n([\s\S]*?)\n\2\s*<\/ide_reference>/g

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function unescapeAttr(s: string): string {
  return s.replace(/&(amp|quot|lt|gt);/g, (_m, k: string) => {
    switch (k) {
      case 'amp':
        return '&'
      case 'quot':
        return '"'
      case 'lt':
        return '<'
      default:
        return '>'
    }
  })
}

function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([\w-]+)="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) out[m[1]] = unescapeAttr(m[2])
  return out
}

/** 比代码里最长的一段反引号再长一个，保证围栏不会被内容撞断 */
function fenceFor(code: string): string {
  let max = 0
  const re = /`+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) max = Math.max(max, m[0].length)
  return '`'.repeat(Math.max(3, max + 1))
}

export function formatIdeRef(ref: IdeCodeRef): string {
  const lang = ref.lang || 'text'
  const fence = fenceFor(ref.code)
  const range =
    ref.kind === 'file'
      ? 'full'
      : `${ref.startLine ?? 1}-${ref.endLine ?? ref.totalLines}`
  const attrs = [
    `path="${escapeAttr(ref.rel)}"`,
    `lines="${range}"`,
    `lang="${escapeAttr(lang)}"`,
    ...(ref.kind === 'file' ? ['whole="1"'] : [])
  ].join(' ')
  const body = ref.code.replace(/\r\n?/g, '\n').replace(/\s+$/, '')
  return `<ide_reference ${attrs}>\n${fence}${lang}\n${body}\n${fence}\n</ide_reference>`
}

/** 用户输入 + 引用 → 真正发给 CLI 的正文 */
export function composeIdeMessage(text: string, refs: IdeCodeRef[]): string {
  const t = text.trim()
  if (refs.length === 0) return t
  const lead = t || tr('ide.ref.defaultLead')
  return `${lead}\n\n${refs.map(formatIdeRef).join('\n\n')}`
}

export interface ParsedIdeRef {
  /** 相对工作区路径 */
  rel: string
  /** 'full' 或 '464-476' */
  lines: string
  lang: string
  whole: boolean
  code: string
}

/**
 * 从消息正文里拆出代码引用。历史回放和实时发送共用 —— 正文本身就是
 * CLI 存下来的那份，所以刷新/重开之后还能还原成引用卡。
 */
export function parseIdeRefs(text: string): { text: string; refs: ParsedIdeRef[] } {
  const src = text.replace(/\r\n?/g, '\n')
  const refs: ParsedIdeRef[] = []
  const re = new RegExp(OPEN.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const attrs = parseAttrs(m[1])
    refs.push({
      rel: attrs.path || '',
      lines: attrs.lines || 'full',
      lang: (attrs.lang || m[3] || 'text').trim(),
      whole: attrs.whole === '1' || attrs.lines === 'full',
      code: m[4]
    })
  }
  const clean = src.replace(re, '').replace(/\n{3,}/g, '\n\n').trim()
  return { text: clean, refs }
}

/** 展示用：`L464–476` / `全文` */
export function refRangeLabel(ref: { whole: boolean; lines: string }): string {
  if (ref.whole) return tr('ide.ref.whole')
  const [a, b] = ref.lines.split('-')
  if (!a) return tr('ide.ref.selection')
  return a === b ? `L${a}` : `L${a}–${b}`
}
