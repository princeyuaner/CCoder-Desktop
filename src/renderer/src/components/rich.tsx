/**
 * 模型输出的 Markdown 渲染 —— 每个块一张卡片（方案 D）。
 *
 * **全部产出 React 元素，不用 innerHTML。**
 * 这是刻意选的：模型输出可能被读到的文件内容影响（提示注入），
 * 走 `dangerouslySetInnerHTML` 就等于把那串东西直接塞进 DOM。
 * 自己解析虽然多写几十行，但天然没有 XSS 面，也不用再挂一层 sanitizer。
 *
 * 支持：标题 / 段落 / 无序·有序列表 / 围栏代码块 / 表格 / 分隔线，
 * 行内：`code`、**粗体**、*斜体*、[链接](url)。
 */
import { useMemo, useState, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import { notify } from '../notice'
import { codeNodes } from './code-highlight'

/* ── 行内 ───────────────────────────────────────────────── */

/**
 * 把链接交给主进程打开。
 *
 * 渲染层不做路径判断：相对路径要用会话 cwd 才能解析，而且必须由主进程
 * 拦住可执行文件 —— 链接目标可能来自模型读到的文件内容（提示注入）。
 */
function openLinkedTarget(cwd: string, target: string): void {
  if (!target) return
  void window.api?.workspace
    ?.openPath(cwd, target)
    .then((r) => {
      if (!r?.ok && r?.error) notify(r.error)
    })
    .catch((err) => notify(err instanceof Error ? err.message : String(err)))
}

export { openLinkedTarget }

function inlineNodes(text: string, key: string, cwd = ''): ReactNode[] {
  // **每次新建**，不能用模块级共享的 g 正则 —— 这个函数会递归（粗体里还有行内代码），
  // 递归会把共享正则的 lastIndex 重置掉，外层的游标跟着回到 0，直接死循环。
  const re =
    /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\n]+\))|(<br\s*\/?>)/gi
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  let m: RegExpExecArray | null

  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    const k = `${key}-${n++}`

    if (m[1]) {
      out.push(
        <code key={k} className="ic">
          {tok.slice(1, -1)}
        </code>
      )
    } else if (m[2]) {
      out.push(<strong key={k}>{inlineNodes(tok.slice(2, -2), k, cwd)}</strong>)
    } else if (m[3]) {
      out.push(<em key={k}>{inlineNodes(tok.slice(1, -1), k, cwd)}</em>)
    } else if (m[4]) {
      /*
       * 不给 href：点击由主进程打开。直接放 `<a href>` 的话，`file:` 链接
       * 会把整个应用窗口导航走；`javascript:` 更不用说了。
       */
      const cut = tok.lastIndexOf('](')
      const target = tok.slice(cut + 2, -1).trim()
      out.push(
        <span
          key={k}
          className="lnk"
          role="link"
          tabIndex={0}
          title={target}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            // 拖选文字时也会触发 click；别让"复制一段话"变成打开链接
            if (window.getSelection()?.toString()) return
            openLinkedTarget(cwd, target)
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            openLinkedTarget(cwd, target)
          }}
        >
          {inlineNodes(tok.slice(1, cut), k, cwd)}
        </span>
      )
    } else {
      // 模型偶尔会在表格单元格里用 <br> 换行；只认这一个安全标签
      out.push(<br key={k} />)
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/* ── 块级解析 ───────────────────────────────────────────── */

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: string[] }
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'hr' }

const RE_FENCE = /^(`{3,}|~{3,})(.*)$/
const RE_HEADING = /^(#{1,6})\s+(.*)$/
const RE_HR = /^(-{3,}|\*{3,}|_{3,})$/
const RE_LIST = /^\s*([-*+]|\d+[.)])\s+(.*)$/
const RE_TABLE_SEP = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((s) => s.trim())
}

/** 这一行是不是某个块的开始 —— 段落靠它判断什么时候收尾 */
function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i] ?? ''
  const t = line.trim()
  if (!t) return true
  if (RE_FENCE.test(t) || RE_HEADING.test(t) || RE_HR.test(t) || RE_LIST.test(line)) return true
  // 表格头：当前行含 |，下一行是 |---| 分隔行。少了这条，紧跟在
  // 加粗/正文后面的表格会被段落整段吞掉，界面上只剩一堆竖线。
  return t.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const t = line.trim()

    if (!t) {
      i++
      continue
    }

    // ── 围栏代码块 ──
    const fence = RE_FENCE.exec(t)
    if (fence) {
      const mark = fence[1][0]
      const len = fence[1].length
      const closeRe = new RegExp(`^\\${mark}{${len},}$`)
      const lang = (fence[2].trim().split(/\s+/)[0] ?? '').replace(/[^\w+#.-]/g, '')
      const buf: string[] = []
      i++
      while (i < lines.length) {
        const c = lines[i].trim()
        if (c.startsWith(mark) && closeRe.test(c)) {
          i++
          break
        }
        buf.push(lines[i])
        i++
      }
      out.push({ kind: 'code', lang, code: buf.join('\n') })
      continue
    }

    // ── 标题 ──
    const h = RE_HEADING.exec(t)
    if (h) {
      out.push({ kind: 'heading', level: h[1].length, text: h[2].trim() })
      i++
      continue
    }

    // ── 分隔线 ──
    if (RE_HR.test(t)) {
      out.push({ kind: 'hr' })
      i++
      continue
    }

    // ── 表格：当前行带头，下一行是 |---|---| 分隔 ──
    if (t.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
      const head = cells(t)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(cells(lines[i]))
        i++
      }
      out.push({ kind: 'table', head, rows })
      continue
    }

    // ── 列表 ──
    const li = RE_LIST.exec(line)
    if (li) {
      const ordered = /\d/.test(li[1])
      // 保留起始序号：从 3. 开始的列表，DOM 上也得从 3 显示
      const first = Number.parseInt(li[1], 10)
      const start = ordered && Number.isFinite(first) ? first : 1
      const items: string[] = []
      while (i < lines.length) {
        const m = RE_LIST.exec(lines[i])
        if (!m || /\d/.test(m[1]) !== ordered) break
        let text = m[2].trim()
        i++
        // 缩进的续行属于这一项。模型经常把一条写成两三行；
        // 不收进来的话，续行会掉出去变成独立段落。
        while (i < lines.length && /^\s+\S/.test(lines[i]) && !startsBlock(lines, i)) {
          text += `\n${lines[i].trim()}`
          i++
        }
        items.push(text)
        /*
         * 松散列表：项目之间空一行是合法 Markdown，仍然属于同一个列表。
         * 以前遇到空行就 break，后面的项会被解析成新的 <ol>，而 HTML 的
         * <ol> 默认从 1 开始 —— 界面上就变成「1. 1. 1.」。
         *
         * 空行后面不是同类型列表项时才结束；没有空行则直接回到循环顶部，
         * 由它判断下一行（紧凑列表就是这么接上的）。
         */
        let j = i
        while (j < lines.length && !lines[j].trim()) j++
        if (j > i) {
          const nextItem = j < lines.length ? RE_LIST.exec(lines[j]) : null
          if (!nextItem || /\d/.test(nextItem[1]) !== ordered) break
          i = j
        }
      }
      out.push({ kind: 'list', ordered, start, items })
      continue
    }

    // ── 段落：吃到下一个块开始或空行为止 ──
    const buf: string[] = [line]
    i++
    while (i < lines.length && !startsBlock(lines, i)) buf.push(lines[i++])
    out.push({ kind: 'para', text: buf.join('\n').trim() })
  }

  return out
}

/* ── 渲染 ───────────────────────────────────────────────── */

export function CodeCard({ lang, code }: { lang: string; code: string }): JSX.Element {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)

  // 流式输出时每个 delta 都会重渲染；codeNodes 内部还有 LRU 缓存，这里
  // 只是把同一段代码的查表也省掉。
  const nodes = useMemo(() => codeNodes(code, lang), [code, lang])

  const copy = (): void => {
    void navigator.clipboard
      ?.writeText(code)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => undefined)
  }

  return (
    <div className="codebox">
      <span className="codebox__lang">{lang || 'text'}</span>
      <button className="codebox__cp" onClick={copy}>
        {copied ? t('common.copied') : t('common.copy')}
      </button>
      <pre className="code">{nodes}</pre>
    </div>
  )
}

/**
 * 方案 H：**不画框**。
 * 层次全靠背景明度 —— 段落透明、代码深一档、表格浅一档。
 * 因此这里每个块直接是 `.md` 的子元素（没有 wrapper），块间节奏交给 `.md > * + *`。
 */
function BlockView({ b, i, cwd }: { b: Block; i: number; cwd: string }): JSX.Element {
  const k = `b${i}`

  switch (b.kind) {
    case 'heading': {
      const Tag = (b.level <= 2 ? 'h2' : b.level === 3 ? 'h3' : 'h4') as 'h2' | 'h3' | 'h4'
      return <Tag className="md-h">{inlineNodes(b.text, k, cwd)}</Tag>
    }

    case 'para':
      return <p className="md-p">{inlineNodes(b.text, k, cwd)}</p>

    case 'list': {
      const items = b.items.map((it, j) => (
        <li key={j}>{inlineNodes(it, `${k}-${j}`, cwd)}</li>
      ))
      // start 只对 <ol> 有意义；分开写，别把非法属性塞给 <ul>
      return b.ordered ? (
        <ol className="md-list" start={b.start}>
          {items}
        </ol>
      ) : (
        <ul className="md-list">{items}</ul>
      )
    }

    case 'code':
      return <CodeCard lang={b.lang} code={b.code} />

    case 'table':
      return (
        <div className="tblwrap">
          <table className="md-table">
            <thead>
              <tr>
                {b.head.map((h, j) => (
                  <th key={j}>{inlineNodes(h, `${k}-h${j}`, cwd)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, j) => (
                    <td key={j}>{inlineNodes(cell, `${k}-${r}-${j}`, cwd)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )

    case 'hr':
      return <hr className="md-hr" />
  }
}

export function RichText({ text, cwd = '' }: { text: string; cwd?: string }): JSX.Element {
  // 流式时每个 delta 都会重渲染，解析结果没变的话别重复做
  const blocks = useMemo(() => parseBlocks(text), [text])

  return (
    <div className="md selectable">
      {blocks.map((b, i) => (
        <BlockView key={i} b={b} i={i} cwd={cwd} />
      ))}
    </div>
  )
}
