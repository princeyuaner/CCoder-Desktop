/**
 * 代码块着色 —— highlight.js 的词法，经 lowlight 输出 hast AST。
 *
 * ── 为什么不用 highlight.js 的 highlight() ───────────────
 * 它返回的是 HTML 字符串，只能走 dangerouslySetInnerHTML 塞进 DOM。
 * 聊天里的代码来自模型输出，可能被读到的文件内容影响（提示注入），
 * 本项目一直刻意避开这条路径（见 rich.tsx 顶部）。lowlight 用同一套
 * grammar 跑出 hast 树，这里递归转成 React 元素，着色结果与 highlight.js
 * 一致，但全程不经过 innerHTML。
 *
 * ── 为什么不用 shiki ────────────────────────────────────
 * shiki 的初始化是异步的（加载 grammar / theme / WASM），而流式输出时
 * 每个 delta 都会重渲染整条消息，代码块要同步出结果才不闪。highlight.js
 * 的 common 语料已经覆盖 Lua、Go、Rust、Java、SQL、YAML 等常见语言，
 * 体积也小得多。
 */
import { createLowlight, common } from 'lowlight'
import type { ElementContent, RootContent } from 'hast'
import type { ReactNode } from 'react'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import powershell from 'highlight.js/lib/languages/powershell'

/*
 * common 是 highlight.js 官方挑的常用语料（含 lua / go / rust / java /
 * kotlin / sql / yaml / xml …）。dockerfile 和 powershell 不在里面，单独补。
 */
const lowlight = createLowlight(common)
lowlight.register({ dockerfile, powershell })

/**
 * 代码围栏里常见的非标准写法 → highlight.js 的语言名。
 * highlight.js 自己已经带了一批别名（ts/tsx/py/sh/yml/html…），这里只补
 * 它不认识的，以及想显式固定的映射。空串表示按纯文本处理。
 */
const LANG_ALIAS: Record<string, string> = {
  'c#': 'csharp',
  cs: 'csharp',
  'c++': 'cpp',
  'objective-c': 'objectivec',
  objc: 'objectivec',
  golang: 'go',
  rs: 'rust',
  rb: 'ruby',
  kt: 'kotlin',
  kts: 'kotlin',
  py: 'python',
  py3: 'python',
  python3: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  mdx: 'markdown',
  vue: 'xml',
  svelte: 'xml',
  svg: 'xml',
  htm: 'xml',
  jsonc: 'json',
  json5: 'json',
  jsonl: 'json',
  ndjson: 'json',
  docker: 'dockerfile',
  ps1: 'powershell',
  pwsh: 'powershell',
  tex: 'latex',
  text: '',
  txt: '',
  plain: '',
  plaintext: '',
  output: '',
  log: ''
}

/** 超长代码块不着色：正则回溯 + 每次流式重渲染会把渲染进程拖住 */
const MAX_HIGHLIGHT = 60_000
/** 结果缓存条数；流式输出时同一块的每个 delta 都是新 key，靠它兜住重挂载 */
const CACHE_LIMIT = 160
const cache = new Map<string, ReactNode[]>()

function normalizeLang(raw: string): string {
  const lang = raw.trim().toLowerCase()
  if (!lang) return ''
  const mapped = LANG_ALIAS[lang] ?? lang
  return mapped && lowlight.registered(mapped) ? mapped : ''
}

/** hast → React。只处理 element / text，注释之类的节点直接丢掉。 */
function renderNodes(nodes: Array<RootContent | ElementContent>): ReactNode[] {
  return nodes.map((node, i) => {
    if (node.type === 'text') return node.value
    if (node.type !== 'element') return null

    const raw = node.properties?.className
    const className = Array.isArray(raw) ? raw.join(' ') : typeof raw === 'string' ? raw : ''
    return (
      <span key={i} className={className || undefined}>
        {renderNodes(node.children)}
      </span>
    )
  })
}

/**
 * 把一段代码切成带 hljs-* 类名的 React 节点。
 * 语言不认识、代码为空或过长时原样返回，不做任何包装。
 */
export function codeNodes(code: string, lang: string): ReactNode[] {
  const language = normalizeLang(lang)
  if (!language || !code || code.length > MAX_HIGHLIGHT) return [code]

  const key = `${language}\u0000${code}`
  const hit = cache.get(key)
  if (hit) {
    // LRU：命中的挪到队尾，淘汰的总是最久没用的那条
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }

  let nodes: ReactNode[]
  try {
    nodes = renderNodes(lowlight.highlight(language, code).children)
  } catch {
    // grammar 内部抛错时退回纯文本，别让一段代码把整条消息带崩
    nodes = [code]
  }

  if (cache.size >= CACHE_LIMIT) {
    const first = cache.keys().next().value
    if (first !== undefined) cache.delete(first)
  }
  cache.set(key, nodes)
  return nodes
}
