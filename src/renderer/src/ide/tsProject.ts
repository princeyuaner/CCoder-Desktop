import type { IdeFsResult, IdeTextFile } from '@shared/ide'
import {
  getJavaScriptWorker,
  getTypeScriptWorker
} from 'monaco-editor/languages/features/typescript/register'
import { monaco, monacoLanguage } from './monaco-setup'

/**
 * 给 Monaco 的 TypeScript worker 补上「没打开、但被 import 的文件」。
 *
 * standalone 的 ts.worker 只能看到已经创建的 model（getMirrorModels），
 * 所以 `import './server'` 在只打开 main.ts 时解析不到。这里递归读取
 * 相对路径 import 的目标，用 file:// URI 创建隐藏 model；worker 的
 * fileExists / readFile 就能命中它们，跨文件跳转、引用、重命名随之可用。
 *
 * 只处理相对路径（`./` / `../`），不碰 node_modules —— 那需要完整的
 * 模块解析和类型包，属于后续 LSP 的范畴。深度和文件数都有硬上限。
 */

type ReadFile = (cwd: string, rel: string) => Promise<IdeFsResult<IdeTextFile>>

const IMPORT_RE =
  /(?:import\s+(?:[^'"]*?\s+from\s+)?|export\s+[^'"]*?\s+from\s+|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g

const MAX_FILES = 160
const MAX_DEPTH = 2

function posix(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '')
}

function dirOf(rel: string): string {
  const p = posix(rel)
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(0, i) : ''
}

function normalizeRel(rel: string): string | null {
  const parts: string[] = []
  for (const part of posix(rel).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  return parts.join('/')
}

function joinRel(base: string, spec: string): string | null {
  return normalizeRel(base ? `${base}/${spec}` : spec)
}

function absOf(cwd: string, rel: string): string {
  return `${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/${rel}`
}

function uriOf(cwd: string, rel: string): monaco.Uri {
  return monaco.Uri.file(absOf(cwd, rel))
}

function candidates(specRel: string): string[] {
  const last = specRel.split('/').pop() ?? ''
  // NodeNext 项目常写 `import './x.js'`，实际文件是 x.ts
  if (last.endsWith('.js')) {
    const stem = specRel.slice(0, -3)
    return [specRel, `${stem}.ts`, `${stem}.tsx`]
  }
  if (last.endsWith('.mjs')) {
    const stem = specRel.slice(0, -4)
    return [specRel, `${stem}.mts`, `${stem}.ts`]
  }
  if (last.endsWith('.cjs')) {
    const stem = specRel.slice(0, -4)
    return [specRel, `${stem}.cts`, `${stem}.ts`]
  }
  if (last.includes('.')) return [specRel]
  return [
    `${specRel}.ts`,
    `${specRel}.tsx`,
    `${specRel}.js`,
    `${specRel}.jsx`,
    `${specRel}.mjs`,
    `${specRel}.cjs`,
    `${specRel}/index.ts`,
    `${specRel}/index.tsx`,
    `${specRel}/index.js`,
    `${specRel}/index.jsx`
  ]
}

function importsOf(text: string): string[] {
  const out: string[] = []
  const re = new RegExp(IMPORT_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const spec = m[1]
    if (spec.startsWith('.') && !out.includes(spec)) out.push(spec)
  }
  return out.slice(0, 80)
}

async function resolveImport(
  cwd: string,
  fromRel: string,
  spec: string,
  readFile: ReadFile
): Promise<{ rel: string; file: IdeTextFile } | null> {
  const base = dirOf(fromRel)
  const target = joinRel(base, spec)
  if (!target) return null
  for (const candidate of candidates(target)) {
    try {
      const r = await readFile(cwd, candidate)
      if (r.ok) return { rel: candidate, file: r.data }
    } catch {
      // 继续试下一个扩展名
    }
  }
  return null
}

const loaded = new Set<string>()
let scheduled: Promise<void> | null = null
let pendingRoot: { cwd: string; rel: string; text: string; readFile: ReadFile } | null = null

async function run(): Promise<void> {
  const root = pendingRoot
  pendingRoot = null
  if (!root) return
  const { cwd, rel, text, readFile } = root
  let count = 0
  const tsUris: monaco.Uri[] = []
  const jsUris: monaco.Uri[] = []

  const visit = async (fromRel: string, fromText: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || count >= MAX_FILES) return
    for (const spec of importsOf(fromText)) {
      if (count >= MAX_FILES) return
      const resolved = await resolveImport(cwd, fromRel, spec, readFile)
      if (!resolved || resolved.file.binary || resolved.file.truncated) continue
      const ext = resolved.rel.split('.').pop()?.toLowerCase() ?? ''
      // TS worker 只接受脚本；JSON / CSS 等 import 交给各自的 worker
      if (!['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) continue
      count++
      const key = `${cwd}::${resolved.rel}`
      const uri = uriOf(cwd, resolved.rel)
      const existing = monaco.editor.getModel(uri)
      // 已经加载过且 model 还在：不用重复读盘 / 递归，但要带上 URI，
      // 让两个 worker 都有机会补同步（比如上次同步时语言服务还没起来）。
      if (loaded.has(key) && existing) {
        if (existing.getLanguageId() === 'typescript') tsUris.push(existing.uri)
        else if (existing.getLanguageId() === 'javascript') jsUris.push(existing.uri)
        continue
      }
      if (!existing) {
        const lang = monacoLanguage(resolved.file.language, resolved.rel)
        monaco.editor.createModel(resolved.file.text, lang, uri)
        if (lang === 'typescript') tsUris.push(uri)
        else if (lang === 'javascript') jsUris.push(uri)
      }
      loaded.add(key)
      await visit(resolved.rel, resolved.file.text, depth + 1)
    }
  }

  await visit(rel, text, 0)

  /*
   * eagerModelSync 只在 worker 首次创建时快照当时的 model 列表。隐藏 model
   * 往往是之后才建出来的，必须显式让 worker 同步一次，否则
   * getScriptFileNames 里根本没有它们。
   */
  const sync = async (
    getWorker: () => Promise<(...uris: monaco.Uri[]) => Promise<unknown>>,
    uris: monaco.Uri[]
  ): Promise<void> => {
    if (uris.length === 0) return
    const attempt = async (): Promise<void> => {
      const worker = await getWorker()
      await worker(...uris)
    }
    try {
      await attempt()
    } catch {
      // 语言服务还没注册好（模型刚建、onLanguage 还没触发）：稍后重试一次
      try {
        await new Promise((resolve) => setTimeout(resolve, 600))
        await attempt()
      } catch {
        // 下一次扫描 / 打开文件时还会再试
      }
    }
  }
  // 两个 worker 都要知道全部隐藏脚本：TS 文件可以 import JS，反之亦然
  const allUris = [...tsUris, ...jsUris]
  await sync(getTypeScriptWorker, allUris)
  await sync(getJavaScriptWorker, allUris)
}

/**
 * 合并短时间内的多次调用：打字时 import 列表通常不变，不必每个字符
 * 都扫一遍。真正需要重建时（新文件 / 保存）会自然排到下一轮。
 */
export function ensureImportedModels(
  cwd: string,
  rel: string,
  text: string,
  readFile: ReadFile
): void {
  pendingRoot = { cwd, rel, text, readFile }
  if (scheduled) return
  scheduled = new Promise<void>((resolve) => {
    setTimeout(() => {
      scheduled = null
      void run().finally(resolve)
    }, 250)
  })
}

/**
 * 外部 / Agent 改了磁盘上的文件：已经建好的隐藏 model 也要跟着更新，
 * 否则跳转和引用还指向旧内容。只处理已经存在、且没有挂在编辑器上的
 * model（打开着的文件由 MonacoEditor 自己的脏状态逻辑处理）。
 */
export async function refreshImportedModels(
  cwd: string,
  rels: string[],
  readFile: ReadFile,
  /** 已经打开 / 缓存在编辑器里的文件；它们有自己的脏状态逻辑，不能覆盖 */
  openRels: Set<string>
): Promise<void> {
  const attached = new Set(
    monaco.editor
      .getEditors()
      .map((editor) => editor.getModel())
      .filter((model): model is monaco.editor.ITextModel => !!model)
  )
  for (const rel of rels.slice(0, 20)) {
    // 后台标签页的 model 没挂在编辑器上，但它仍可能有未保存修改
    if (openRels.has(rel)) continue
    const uri = uriOf(cwd, rel)
    const model = monaco.editor.getModel(uri)
    if (!model || attached.has(model)) continue
    try {
      const r = await readFile(cwd, rel)
      if (r.ok && !r.data.binary && !r.data.truncated && model.getValue() !== r.data.text) {
        model.setValue(r.data.text)
      }
    } catch {
      // 读不到就保持旧内容；下一次打开会重建
    }
  }
}
