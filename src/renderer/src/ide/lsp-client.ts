import type { LspDiagnosticsEvent, LspPosition, LspRange, LspStateEvent } from '@shared/lsp'
import { monaco, setTsWorkerMode } from './monaco-setup'
import { diffChange } from './lsp-diff'
import { relFromUri } from './problems'
import type { OutlineKind } from './outline'

/**
 * 渲染层这一侧的 LSP 客户端。
 *
 * 它只做三件事：
 *   1. 把打开的文件同步给主进程（didOpen / didChange / didClose）；
 *   2. 把 Monaco provider 的请求转成 LSP 方法；
 *   3. 把 publishDiagnostics 转成 Monaco marker（问题面板会自动汇总）。
 *
 * 没有把 LSP 的完整类型搬进来：只定义实际用到的字段，未知字段一律忽略。
 */

const OWNER = 'ccoder-lsp'

/** Monaco 语言 id → LSP languageId */
const LSP_LANGUAGE_ID: Record<string, string> = {
  typescript: 'typescript',
  javascript: 'javascript',
  python: 'python',
  go: 'go',
  rust: 'rust',
  c: 'c',
  cpp: 'cpp',
  yaml: 'yaml',
  shell: 'shellscript',
  lua: 'lua'
}

export function isLspLanguage(language: string): boolean {
  return language in LSP_LANGUAGE_ID
}

export interface LspOpenDoc {
  rel: string
  language: string
  text: string
}

export interface LspStateInfo {
  state: 'starting' | 'ready' | 'error'
  server?: string
  message?: string
}

interface LspTextEdit {
  range: LspRange
  newText: string
}

interface LspLocationShape {
  uri?: unknown
  range?: unknown
  targetUri?: unknown
  targetRange?: unknown
  targetSelectionRange?: unknown
}

interface CompletionShape {
  label?: unknown
  kind?: unknown
  detail?: unknown
  documentation?: unknown
  sortText?: unknown
  filterText?: unknown
  preselect?: unknown
  insertText?: unknown
  insertTextFormat?: unknown
  textEdit?: unknown
  additionalTextEdits?: unknown
  commitCharacters?: unknown
  tags?: unknown
  deprecated?: unknown
}

interface DocState {
  rel: string
  language: string
  uri: string
  text: string
  version: number
  opened: boolean
  lastText: string
  timer: number | null
  model: monaco.editor.ITextModel | null
}

interface SessionState {
  status: 'starting' | 'ready' | 'error'
  server?: string
  message?: string
  failedAt?: number
  promise?: Promise<boolean>
  /** initialize 返回的能力；语义着色要读 semanticTokensProvider.legend */
  capabilities?: unknown
}

const CHANGE_DEBOUNCE_MS = 250
const SESSION_RETRY_MS = 30_000

function absOf(cwd: string, rel: string): string {
  return `${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/${rel}`
}

function uriOf(cwd: string, rel: string): string {
  return monaco.Uri.file(absOf(cwd, rel)).toString()
}

function safeUri(text: unknown): monaco.Uri | null {
  if (typeof text !== 'string' || !text) return null
  try {
    return monaco.Uri.parse(text)
  } catch {
    return null
  }
}

function lspPosition(position: monaco.IPosition): LspPosition {
  return {
    line: Math.max(0, position.lineNumber - 1),
    character: Math.max(0, position.column - 1)
  }
}

function monacoRange(range: LspRange): monaco.Range {
  return new monaco.Range(
    Math.max(1, range.start.line + 1),
    Math.max(1, range.start.character + 1),
    Math.max(1, range.end.line + 1),
    Math.max(1, range.end.character + 1)
  )
}

function rangeOf(raw: unknown): monaco.Range | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as {
    start?: { line?: unknown; character?: unknown }
    end?: { line?: unknown; character?: unknown }
  }
  if (
    !r.start ||
    !r.end ||
    typeof r.start.line !== 'number' ||
    typeof r.start.character !== 'number' ||
    typeof r.end.line !== 'number' ||
    typeof r.end.character !== 'number'
  ) {
    return null
  }
  return monacoRange(r as LspRange)
}

function markdownContents(raw: unknown): monaco.IMarkdownString[] {
  const out: monaco.IMarkdownString[] = []
  const push = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value) out.push({ value })
      return
    }
    if (!value || typeof value !== 'object') return
    const item = value as { kind?: unknown; value?: unknown; language?: unknown }
    if (typeof item.value !== 'string' || !item.value) return
    if (typeof item.language === 'string' && item.language) {
      out.push({ value: `\`\`\`${item.language}\n${item.value}\n\`\`\`` })
    } else {
      out.push({ value: item.value })
    }
  }
  if (Array.isArray(raw)) for (const item of raw) push(item)
  else push(raw)
  return out
}

const COMPLETION_KIND: Record<number, monaco.languages.CompletionItemKind> = {
  1: monaco.languages.CompletionItemKind.Text,
  2: monaco.languages.CompletionItemKind.Method,
  3: monaco.languages.CompletionItemKind.Function,
  4: monaco.languages.CompletionItemKind.Constructor,
  5: monaco.languages.CompletionItemKind.Field,
  6: monaco.languages.CompletionItemKind.Variable,
  7: monaco.languages.CompletionItemKind.Class,
  8: monaco.languages.CompletionItemKind.Interface,
  9: monaco.languages.CompletionItemKind.Module,
  10: monaco.languages.CompletionItemKind.Property,
  11: monaco.languages.CompletionItemKind.Unit,
  12: monaco.languages.CompletionItemKind.Value,
  13: monaco.languages.CompletionItemKind.Enum,
  14: monaco.languages.CompletionItemKind.Keyword,
  15: monaco.languages.CompletionItemKind.Snippet,
  16: monaco.languages.CompletionItemKind.Color,
  17: monaco.languages.CompletionItemKind.File,
  18: monaco.languages.CompletionItemKind.Reference,
  19: monaco.languages.CompletionItemKind.Folder,
  20: monaco.languages.CompletionItemKind.EnumMember,
  21: monaco.languages.CompletionItemKind.Constant,
  22: monaco.languages.CompletionItemKind.Struct,
  23: monaco.languages.CompletionItemKind.Event,
  24: monaco.languages.CompletionItemKind.Operator,
  25: monaco.languages.CompletionItemKind.TypeParameter
}

function completionKind(raw: unknown): monaco.languages.CompletionItemKind {
  return typeof raw === 'number'
    ? (COMPLETION_KIND[raw] ?? monaco.languages.CompletionItemKind.Text)
    : monaco.languages.CompletionItemKind.Text
}

function toLocations(raw: unknown): monaco.languages.Location[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  const out: monaco.languages.Location[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const loc = entry as LspLocationShape
    const uriText = typeof loc.targetUri === 'string' ? loc.targetUri : loc.uri
    const rangeRaw =
      loc.targetSelectionRange ?? loc.targetRange ?? loc.range
    const uri = safeUri(uriText)
    const range = rangeOf(rangeRaw)
    if (uri && range) out.push({ uri, range })
  }
  return out
}

function asWorkspaceEdit(raw: unknown): monaco.languages.WorkspaceEdit | null {
  if (!raw || typeof raw !== 'object') return null
  const edits: monaco.languages.IWorkspaceTextEdit[] = []

  const push = (uriText: unknown, list: unknown): void => {
    if (typeof uriText !== 'string' || !Array.isArray(list)) return
    const resource = safeUri(uriText)
    if (!resource) return
    for (const rawEdit of list) {
      if (!rawEdit || typeof rawEdit !== 'object') continue
      const edit = rawEdit as { range?: unknown; newText?: unknown }
      const range = rangeOf(edit.range)
      if (!range || typeof edit.newText !== 'string') continue
      edits.push({
        resource,
        textEdit: { range, text: edit.newText },
        versionId: undefined
      })
    }
  }

  const edit = raw as {
    changes?: unknown
    documentChanges?: unknown
  }
  if (edit.changes && typeof edit.changes === 'object') {
    for (const [uri, list] of Object.entries(edit.changes as Record<string, unknown>)) {
      push(uri, list)
    }
  }
  if (Array.isArray(edit.documentChanges)) {
    for (const change of edit.documentChanges) {
      if (!change || typeof change !== 'object') continue
      const docChange = change as {
        textDocument?: { uri?: unknown }
        edits?: unknown
      }
      push(docChange.textDocument?.uri, docChange.edits)
    }
  }
  return edits.length ? { edits } : null
}

function toTextEdits(raw: unknown): monaco.languages.TextEdit[] | null {
  if (!Array.isArray(raw)) return null
  const out: monaco.languages.TextEdit[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const edit = entry as { range?: unknown; newText?: unknown }
    const range = rangeOf(edit.range)
    if (!range || typeof edit.newText !== 'string') continue
    out.push({ range, text: edit.newText })
  }
  return out.length ? out : null
}

/* ── 符号 ─────────────────────────────────────────────── */

const SYMBOL_KIND: Record<number, monaco.languages.SymbolKind> = {
  1: monaco.languages.SymbolKind.File,
  2: monaco.languages.SymbolKind.Module,
  3: monaco.languages.SymbolKind.Namespace,
  4: monaco.languages.SymbolKind.Package,
  5: monaco.languages.SymbolKind.Class,
  6: monaco.languages.SymbolKind.Method,
  7: monaco.languages.SymbolKind.Property,
  8: monaco.languages.SymbolKind.Field,
  9: monaco.languages.SymbolKind.Constructor,
  10: monaco.languages.SymbolKind.Enum,
  11: monaco.languages.SymbolKind.Interface,
  12: monaco.languages.SymbolKind.Function,
  13: monaco.languages.SymbolKind.Variable,
  14: monaco.languages.SymbolKind.Constant,
  15: monaco.languages.SymbolKind.String,
  16: monaco.languages.SymbolKind.Number,
  17: monaco.languages.SymbolKind.Boolean,
  18: monaco.languages.SymbolKind.Array,
  19: monaco.languages.SymbolKind.Object,
  20: monaco.languages.SymbolKind.Key,
  21: monaco.languages.SymbolKind.Null,
  22: monaco.languages.SymbolKind.EnumMember,
  23: monaco.languages.SymbolKind.Struct,
  24: monaco.languages.SymbolKind.Event,
  25: monaco.languages.SymbolKind.Operator,
  26: monaco.languages.SymbolKind.TypeParameter
}

interface RawSymbol {
  name?: unknown
  detail?: unknown
  kind?: unknown
  tags?: unknown
  range?: unknown
  selectionRange?: unknown
  children?: unknown
  location?: unknown
  containerName?: unknown
}

function symbolKindOf(raw: unknown): monaco.languages.SymbolKind {
  return typeof raw === 'number'
    ? (SYMBOL_KIND[raw] ?? monaco.languages.SymbolKind.Variable)
    : monaco.languages.SymbolKind.Variable
}

function symbolTagsOf(raw: unknown): monaco.languages.SymbolTag[] {
  return Array.isArray(raw) && raw.includes(1) ? [monaco.languages.SymbolTag.Deprecated] : []
}

function isHierarchicalSymbols(list: unknown[]): boolean {
  return list.some((item) => !!item && typeof item === 'object' && 'selectionRange' in item)
}

function documentSymbolOf(raw: unknown, depth = 0): monaco.languages.DocumentSymbol | null {
  if (!raw || typeof raw !== 'object' || depth > 16) return null
  const s = raw as RawSymbol
  if (typeof s.name !== 'string' || !s.name) return null
  const range = rangeOf(s.range)
  const selection = rangeOf(s.selectionRange) ?? range
  if (!range || !selection) return null
  const children = Array.isArray(s.children)
    ? s.children
        .map((child) => documentSymbolOf(child, depth + 1))
        .filter((x): x is monaco.languages.DocumentSymbol => !!x)
    : []
  return {
    name: s.name,
    detail: typeof s.detail === 'string' ? s.detail : '',
    kind: symbolKindOf(s.kind),
    tags: symbolTagsOf(s.tags),
    range,
    selectionRange: selection,
    ...(children.length ? { children } : {})
  }
}

/** textDocument/documentSymbol 的两种返回形状：层级 DocumentSymbol 或扁平 SymbolInformation */
function documentSymbolsOf(raw: unknown, docUri: string): monaco.languages.DocumentSymbol[] {
  const list = Array.isArray(raw) ? raw : []
  if (isHierarchicalSymbols(list)) {
    return list
      .map((item) => documentSymbolOf(item))
      .filter((x): x is monaco.languages.DocumentSymbol => !!x)
  }

  const out: monaco.languages.DocumentSymbol[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const s = item as RawSymbol
    const loc = s.location as { uri?: unknown; range?: unknown } | undefined
    if (!loc || typeof loc.uri !== 'string' || loc.uri !== docUri) continue
    const range = rangeOf(loc.range)
    if (!range || typeof s.name !== 'string' || !s.name) continue
    out.push({
      name: s.name,
      detail: typeof s.containerName === 'string' ? s.containerName : '',
      kind: symbolKindOf(s.kind),
      tags: symbolTagsOf(s.tags),
      range,
      selectionRange: range
    })
  }
  return out
}

/** 侧栏大纲用的轻量形状，和 outline.ts 的 OutlineSymbol 兼容 */
export interface LspOutlineSymbol {
  name: string
  kind: OutlineKind
  line: number
  column: number
  depth: number
}

function outlineKindOf(raw: unknown): OutlineKind {
  switch (raw) {
    case 2:
    case 3:
    case 4:
      return 'module'
    case 5:
    case 23:
      return 'class'
    case 6:
    case 9:
      return 'method'
    case 10:
      return 'enum'
    case 11:
      return 'interface'
    case 12:
      return 'function'
    case 13:
    case 14:
      return 'constant'
    case 26:
      return 'type'
    default:
      return 'symbol'
  }
}

export function outlineSymbolsOf(raw: unknown, docUri: string): LspOutlineSymbol[] {
  const out: LspOutlineSymbol[] = []
  const list = Array.isArray(raw) ? raw : []

  const walk = (item: unknown, depth: number): void => {
    if (!item || typeof item !== 'object' || out.length >= 2_000) return
    const s = item as RawSymbol
    const pos = rangeOf(s.selectionRange) ?? rangeOf(s.range)
    if (typeof s.name === 'string' && s.name && pos) {
      out.push({
        name: s.name,
        kind: outlineKindOf(s.kind),
        line: pos.startLineNumber,
        column: pos.startColumn,
        depth
      })
    }
    if (Array.isArray(s.children)) {
      for (const child of s.children) walk(child, depth + 1)
    }
  }

  if (isHierarchicalSymbols(list)) {
    for (const item of list) walk(item, 0)
    return out
  }

  for (const item of list) {
    if (!item || typeof item !== 'object' || out.length >= 2_000) continue
    const s = item as RawSymbol
    const loc = s.location as { uri?: unknown; range?: unknown } | undefined
    if (!loc || typeof loc.uri !== 'string' || loc.uri !== docUri) continue
    const range = rangeOf(loc.range)
    if (!range || typeof s.name !== 'string' || !s.name) continue
    out.push({
      name: s.name,
      kind: outlineKindOf(s.kind),
      line: range.startLineNumber,
      column: range.startColumn,
      depth: 0
    })
  }
  return out
}

export interface LspWorkspaceSymbol {
  name: string
  containerName?: string
  kind: number
  rel: string
  /** 1-based */
  line: number
  /** 1-based */
  column: number
}

function workspaceSymbolsOf(raw: unknown, cwd: string): LspWorkspaceSymbol[] {
  const list = Array.isArray(raw) ? raw : []
  const out: LspWorkspaceSymbol[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object' || out.length >= 500) continue
    const s = item as RawSymbol
    if (typeof s.name !== 'string' || !s.name) continue
    const loc = s.location as { uri?: unknown; range?: unknown } | undefined
    if (!loc || typeof loc.uri !== 'string') continue
    const uri = safeUri(loc.uri)
    if (!uri) continue
    const rel = relFromUri(uri, cwd)
    if (!rel) continue
    const range = rangeOf(loc.range)
    out.push({
      name: s.name,
      ...(typeof s.containerName === 'string' && s.containerName
        ? { containerName: s.containerName }
        : {}),
      kind: typeof s.kind === 'number' ? s.kind : 0,
      rel,
      line: range ? range.startLineNumber : 1,
      column: range ? range.startColumn : 1
    })
  }
  return out
}

/* ── 签名 / 高亮 / 代码操作 ─────────────────────────────── */

function documentationOf(raw: unknown): monaco.IMarkdownString | undefined {
  const docs = markdownContents(raw)
  return docs.length ? { value: docs.map((d) => d.value).join('\n\n') } : undefined
}

function signatureHelpOf(raw: unknown): monaco.languages.SignatureHelpResult | null {
  if (!raw || typeof raw !== 'object') return null
  const help = raw as {
    signatures?: unknown
    activeSignature?: unknown
    activeParameter?: unknown
  }
  if (!Array.isArray(help.signatures)) return null

  const signatures: monaco.languages.SignatureInformation[] = []
  for (const entry of help.signatures) {
    if (!entry || typeof entry !== 'object') continue
    const sig = entry as {
      label?: unknown
      documentation?: unknown
      parameters?: unknown
      activeParameter?: unknown
    }
    // Monaco 只接受字符串 label；LSP 的签名 label 也是字符串，
    // 参数 label 可能是 [start, end] 偏移，用签名文本切出来。
    if (typeof sig.label !== 'string') continue
    const label = sig.label
    const parameters: monaco.languages.ParameterInformation[] = []
    if (Array.isArray(sig.parameters)) {
      for (const rawParam of sig.parameters) {
        if (!rawParam || typeof rawParam !== 'object') continue
        const p = rawParam as { label?: unknown; documentation?: unknown }
        let paramLabel: string | null = null
        if (typeof p.label === 'string') {
          paramLabel = p.label
        } else if (
          Array.isArray(p.label) &&
          typeof p.label[0] === 'number' &&
          typeof p.label[1] === 'number'
        ) {
          paramLabel = label.slice(p.label[0], p.label[1])
        }
        if (paramLabel === null) continue
        const doc = documentationOf(p.documentation)
        parameters.push({ label: paramLabel, ...(doc ? { documentation: doc } : {}) })
      }
    }
    const doc = documentationOf(sig.documentation)
    signatures.push({
      label,
      parameters,
      ...(doc ? { documentation: doc } : {}),
      ...(typeof sig.activeParameter === 'number'
        ? { activeParameter: sig.activeParameter }
        : {})
    })
  }
  if (signatures.length === 0) return null

  return {
    value: {
      signatures,
      activeSignature:
        typeof help.activeSignature === 'number'
          ? Math.max(0, help.activeSignature)
          : 0,
      activeParameter:
        typeof help.activeParameter === 'number' ? Math.max(0, help.activeParameter) : 0
    },
    dispose: () => {}
  }
}

function highlightsOf(raw: unknown): monaco.languages.DocumentHighlight[] | null {
  if (!Array.isArray(raw)) return null
  const out: monaco.languages.DocumentHighlight[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const h = entry as { range?: unknown; kind?: unknown }
    const range = rangeOf(h.range)
    if (!range) continue
    const kind =
      h.kind === 2
        ? monaco.languages.DocumentHighlightKind.Read
        : h.kind === 3
          ? monaco.languages.DocumentHighlightKind.Write
          : monaco.languages.DocumentHighlightKind.Text
    out.push({ range, kind })
  }
  return out.length ? out : null
}

function lspSeverityOf(severity: monaco.MarkerSeverity): number {
  if (severity === monaco.MarkerSeverity.Error) return 1
  if (severity === monaco.MarkerSeverity.Warning) return 2
  if (severity === monaco.MarkerSeverity.Info) return 3
  return 4
}

/** Monaco marker → LSP Diagnostic，代码操作请求要把当前诊断一起带上 */
function diagnosticOf(marker: monaco.editor.IMarkerData): Record<string, unknown> {
  const code =
    typeof marker.code === 'string'
      ? marker.code
      : marker.code && typeof marker.code === 'object'
        ? marker.code.value
        : undefined
  return {
    range: {
      start: { line: marker.startLineNumber - 1, character: marker.startColumn - 1 },
      end: { line: marker.endLineNumber - 1, character: marker.endColumn - 1 }
    },
    severity: lspSeverityOf(marker.severity),
    message: marker.message,
    ...(code !== undefined ? { code } : {}),
    ...(marker.source ? { source: marker.source } : {}),
    ...(marker.tags && marker.tags.length ? { tags: marker.tags } : {})
  }
}

/**
 * LSP CodeAction → Monaco CodeAction。
 *
 * 服务器只给 data 不给 edit 时（惰性解析），把原始 action 记在 pending 里，
 * 等用户真正选中时再走 codeAction/resolve。只返回 command 的动作无法在
 * 渲染层执行，直接跳过，避免菜单里出现点了没反应的项。
 */
function codeActionOf(
  raw: unknown,
  pending: WeakMap<monaco.languages.CodeAction, unknown>
): monaco.languages.CodeAction | null {
  if (!raw || typeof raw !== 'object') return null
  const action = raw as {
    title?: unknown
    kind?: unknown
    edit?: unknown
    data?: unknown
    isPreferred?: unknown
    disabled?: unknown
  }
  if (typeof action.title !== 'string' || !action.title) return null

  const edit = asWorkspaceEdit(action.edit)
  const disabled =
    action.disabled && typeof action.disabled === 'object'
      ? (action.disabled as { reason?: unknown }).reason
      : undefined
  const mapped: monaco.languages.CodeAction = {
    title: action.title,
    ...(typeof action.kind === 'string' ? { kind: action.kind } : {}),
    ...(action.isPreferred === true ? { isPreferred: true } : {}),
    ...(typeof disabled === 'string' && disabled ? { disabled } : {}),
    ...(edit ? { edit } : {})
  }
  if (!edit) {
    if (action.data === undefined || action.data === null) return null
    pending.set(mapped, raw)
  }
  return mapped
}

/* ── 语义着色（semantic tokens） ────────────────────────── */

/**
 * 客户端固定 legend。
 *
 * 每个服务器的 legend 顺序都不一样（Pyright 只给 24 种，其他服务器可能更多），
 * 所以这里用一份超集注册给 Monaco，再把服务器返回的 tokenType / modifier
 * 按名字映射到这份 legend 的下标。
 */
const SEMANTIC_TOKEN_TYPES = [
  'namespace',
  'type',
  'class',
  'enum',
  'interface',
  'struct',
  'typeParameter',
  'parameter',
  'variable',
  'property',
  'enumMember',
  'event',
  'function',
  'method',
  'macro',
  'keyword',
  'modifier',
  'comment',
  'string',
  'number',
  'regexp',
  'operator',
  'decorator',
  'label',
  'angleBracket',
  'arithmetic',
  'attribute',
  'bitwise',
  'boolean',
  'brace',
  'bracket',
  'builtinType',
  'character',
  'colon',
  'comma',
  'comparison',
  'deprecated',
  'escapeSequence',
  'formatSpecifier',
  'lifetime',
  'logical',
  'parenthesis',
  'punctuation',
  'selfKeyword',
  'selfTypeKeyword',
  'semicolon',
  'stringEscape',
  'toolCommand',
  'typeArgument'
]

const SEMANTIC_TOKEN_MODIFIERS = [
  'declaration',
  'definition',
  'readonly',
  'static',
  'deprecated',
  'abstract',
  'async',
  'modification',
  'documentation',
  'defaultLibrary'
]

export const SEMANTIC_LEGEND: monaco.languages.SemanticTokensLegend = {
  tokenTypes: [...SEMANTIC_TOKEN_TYPES],
  tokenModifiers: [...SEMANTIC_TOKEN_MODIFIERS]
}

const SEMANTIC_TYPE_INDEX = new Map(
  SEMANTIC_TOKEN_TYPES.map((name, index) => [name, index] as const)
)
const SEMANTIC_MODIFIER_INDEX = new Map(
  SEMANTIC_TOKEN_MODIFIERS.map((name, index) => [name, index] as const)
)

interface SemanticServerLegend {
  tokenTypes: string[]
  tokenModifiers: string[]
}

function semanticLegendOf(capabilities: unknown): SemanticServerLegend | null {
  if (!capabilities || typeof capabilities !== 'object') return null
  const provider = (capabilities as { semanticTokensProvider?: unknown })
    .semanticTokensProvider
  if (!provider || typeof provider !== 'object') return null
  const p = provider as { full?: unknown; legend?: unknown }
  if (!p.full) return null
  if (!p.legend || typeof p.legend !== 'object') return null
  const legend = p.legend as { tokenTypes?: unknown; tokenModifiers?: unknown }
  const tokenTypes = Array.isArray(legend.tokenTypes)
    ? legend.tokenTypes.filter((x): x is string => typeof x === 'string')
    : []
  const tokenModifiers = Array.isArray(legend.tokenModifiers)
    ? legend.tokenModifiers.filter((x): x is string => typeof x === 'string')
    : []
  return tokenTypes.length ? { tokenTypes, tokenModifiers } : null
}

function semanticTokensOf(
  raw: unknown,
  legend: SemanticServerLegend
): monaco.languages.SemanticTokens | null {
  if (!raw || typeof raw !== 'object') return null
  const data = (raw as { data?: unknown }).data
  if (!data || typeof data !== 'object' || !('length' in data)) return null
  const values = data as ArrayLike<number>
  if (values.length < 5) return null

  const typeMap = legend.tokenTypes.map((name) => SEMANTIC_TYPE_INDEX.get(name) ?? -1)
  const modMap = legend.tokenModifiers.map(
    (name) => SEMANTIC_MODIFIER_INDEX.get(name) ?? -1
  )
  const out: number[] = []
  let line = 0
  let character = 0
  let lastLine = 0
  let lastCharacter = 0

  for (let i = 0; i + 4 < values.length; i += 5) {
    const deltaLine = values[i] | 0
    const deltaStart = values[i + 1] | 0
    const length = values[i + 2] | 0
    const typeIndex = values[i + 3] | 0
    const modifiers = values[i + 4] | 0

    line += deltaLine
    character = deltaLine === 0 ? character + deltaStart : deltaStart

    const mappedType = typeMap[typeIndex] ?? -1
    if (mappedType < 0 || length <= 0) continue

    let mappedModifiers = 0
    for (let bit = 0; bit < modMap.length; bit++) {
      if ((modifiers & (1 << bit)) === 0) continue
      const target = modMap[bit] ?? -1
      if (target >= 0 && target < 32) mappedModifiers |= 1 << target
    }

    // 被丢弃的 token 不能破坏后续 token 的相对偏移，按绝对位置重新计算
    const outLine = line - lastLine
    const outStart = outLine === 0 ? character - lastCharacter : character
    out.push(outLine, outStart, length, mappedType, mappedModifiers)
    lastLine = line
    lastCharacter = character
  }

  return out.length ? { data: Uint32Array.from(out) } : null
}

function wordRangeAt(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition
): monaco.IRange {
  const word = model.getWordUntilPosition(position)
  return {
    startLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endLineNumber: position.lineNumber,
    endColumn: word.endColumn
  }
}

function markerSeverity(raw: unknown): monaco.MarkerSeverity {
  if (raw === 2) return monaco.MarkerSeverity.Warning
  if (raw === 3) return monaco.MarkerSeverity.Info
  if (raw === 4) return monaco.MarkerSeverity.Hint
  return monaco.MarkerSeverity.Error
}

function markerTags(raw: unknown): monaco.MarkerTag[] {
  if (!Array.isArray(raw)) return []
  const out: monaco.MarkerTag[] = []
  for (const tag of raw) {
    if (tag === 1) out.push(monaco.MarkerTag.Unnecessary)
    else if (tag === 2) out.push(monaco.MarkerTag.Deprecated)
  }
  return out
}

export class LspController {
  private readonly cwd: string
  private readonly onState: (language: string, info: LspStateInfo) => void
  private readonly docs = new Map<string, DocState>()
  private readonly sessions = new Map<string, SessionState>()
  private readonly diagnostics = new Map<string, monaco.editor.IMarkerData[]>()
  private readonly disposables: (() => void)[] = []
  private disposed = false
  private workerOff = false
  /** 会话就绪 / 停止时由 installLspProviders 挂载 / 卸载语义着色 */
  onSessionReady?: (language: string, capabilities: unknown) => void
  onSessionStopped?: (language: string) => void

  constructor(cwd: string, onState: (language: string, info: LspStateInfo) => void) {
    this.cwd = cwd
    this.onState = onState

    const api = window.api?.lsp
    if (api) {
      this.disposables.push(
        api.onDiagnostics((event) => this.applyDiagnostics(event)),
        api.onState((event) => this.onSessionState(event))
      )
    }
    const modelListener = monaco.editor.onDidCreateModel((model) => {
      const rel = relFromUri(model.uri, this.cwd)
      if (!rel) return
      const cached = this.diagnostics.get(rel)
      if (cached) monaco.editor.setModelMarkers(model, OWNER, cached)
      const doc = this.docs.get(rel)
      if (doc) doc.model = model
    })
    this.disposables.push(() => modelListener.dispose())
  }

  /**
   * 用当前打开的标签刷新同步状态。
   *
   * 每次调用都做 diff：新文件 didOpen，已打开的按文本变化做 didChange，
   * 关掉的 didClose。打字时 fileCache 每帧都变，但这里只有内容真的
   * 不同才会排队，不会每个字符都发一条 IPC。
   */
  sync(openDocs: LspOpenDoc[]): void {
    if (this.disposed) return
    const desired = new Map<string, LspOpenDoc>()
    for (const doc of openDocs) {
      if (!isLspLanguage(doc.language)) continue
      desired.set(doc.rel, doc)
    }

    for (const [rel, doc] of [...this.docs]) {
      if (!desired.has(rel)) {
        this.closeDoc(doc)
        this.docs.delete(rel)
      }
    }

    for (const [rel, next] of desired) {
      let doc = this.docs.get(rel)
      if (doc && doc.language !== next.language) {
        this.closeDoc(doc)
        this.docs.delete(rel)
        doc = undefined
      }
      if (!doc) {
        doc = {
          rel,
          language: next.language,
          uri: uriOf(this.cwd, rel),
          text: next.text,
          version: 0,
          opened: false,
          lastText: '',
          timer: null,
          model: monaco.editor.getModel(monaco.Uri.parse(uriOf(this.cwd, rel)))
        }
        this.docs.set(rel, doc)
        this.applyCachedDiagnostics(doc)
        const created = doc
        void this.ensureSession(next.language).then((ok) => {
          if (ok) this.openDoc(created)
        })
        continue
      }
      doc.text = next.text
      if (doc.opened && doc.text !== doc.lastText) this.scheduleChange(doc)
    }
  }

  /** Monaco provider 用：确保文档已打开、会话就绪，再发请求 */
  async request(
    model: monaco.editor.ITextModel,
    method: string,
    params: unknown,
    timeoutMs = 20_000
  ): Promise<unknown | null> {
    if (this.disposed) return null
    const language = model.getLanguageId()
    if (!isLspLanguage(language)) return null
    const doc = this.docForModel(model)
    if (!doc) return null

    const ready = await this.ensureSession(language)
    if (!ready || this.disposed) return null
    this.openDoc(doc)
    // 位置类请求必须基于服务器已经看到的文本
    this.flushChange(doc)

    return this.requestForLanguage(language, method, params, timeoutMs)
  }

  /** 不依赖某个 model 的请求：workspace/symbol、codeAction/resolve 用 */
  async requestForLanguage(
    language: string,
    method: string,
    params: unknown,
    timeoutMs = 20_000
  ): Promise<unknown | null> {
    if (this.disposed || !isLspLanguage(language)) return null
    const api = window.api?.lsp
    if (!api) return null
    try {
      const response = await api.request({
        cwd: this.cwd,
        language,
        method,
        params,
        timeoutMs
      })
      return response.ok ? response.result : null
    } catch {
      return null
    }
  }

  /** 侧栏大纲：优先用语言服务器的 documentSymbol，调用方失败时回落到正则扫描 */
  async documentSymbols(model: monaco.editor.ITextModel): Promise<LspOutlineSymbol[]> {
    const result = await this.request(
      model,
      'textDocument/documentSymbol',
      { textDocument: textDocumentOf(model) },
      10_000
    )
    return outlineSymbolsOf(result, model.uri.toString())
  }

  /**
   * 语义着色：拿服务器的 semantic tokens，并按客户端固定 legend 重新编码。
   * 服务器不支持 / 会话未就绪时返回 null，Monaco 会回落到语法着色。
   */
  async semanticTokens(
    model: monaco.editor.ITextModel
  ): Promise<monaco.languages.SemanticTokens | null> {
    const language = model.getLanguageId()
    if (!isLspLanguage(language)) return null
    const session = this.sessions.get(language)
    if (!session || session.status !== 'ready') return null
    const legend = semanticLegendOf(session.capabilities)
    if (!legend) return null

    const result = await this.request(
      model,
      'textDocument/semanticTokens/full',
      { textDocument: textDocumentOf(model) },
      10_000
    )
    return semanticTokensOf(result, legend)
  }

  /**
   * 工作区符号（Ctrl+T）。
   *
   * 查询所有已就绪的语言服务器；seedLanguage 用于在还没有任何会话时
   * 先按当前文件的语言拉起一个，避免刚打开窗口搜索时永远为空。
   */
  async workspaceSymbols(query: string, seedLanguage?: string): Promise<LspWorkspaceSymbol[]> {
    if (this.disposed) return []
    if (seedLanguage) await this.ensureSession(seedLanguage)
    if (this.disposed) return []

    const languages: string[] = []
    const seenServers = new Set<string>()
    for (const [language, session] of this.sessions) {
      if (session.status !== 'ready') continue
      // TS / JS 共用同一个服务器：只问一次，避免重复查询
      const serverKey = session.server ?? language
      if (seenServers.has(serverKey)) continue
      seenServers.add(serverKey)
      languages.push(language)
    }
    if (languages.length === 0) return []

    const batches = await Promise.all(
      languages.map((language) =>
        this.requestForLanguage(language, 'workspace/symbol', { query }, 10_000)
      )
    )

    const out: LspWorkspaceSymbol[] = []
    const seen = new Set<string>()
    for (const batch of batches) {
      for (const symbol of workspaceSymbolsOf(batch, this.cwd)) {
        const key = `${symbol.rel}\u0000${symbol.line}\u0000${symbol.column}\u0000${symbol.name}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(symbol)
        if (out.length >= 200) return out
      }
    }
    return out
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const close of this.disposables) {
      try {
        close()
      } catch {
        // 订阅清理失败不影响窗口关闭
      }
    }
    this.disposables.length = 0
    for (const language of this.sessions.keys()) this.onSessionStopped?.(language)
    this.sessions.clear()
    this.onSessionReady = undefined
    this.onSessionStopped = undefined
    for (const doc of [...this.docs.values()]) this.closeDoc(doc)
    this.docs.clear()
    this.diagnostics.clear()
    if (this.workerOff) {
      this.workerOff = false
      setTsWorkerMode(true)
    }
    try {
      window.api?.lsp?.stop(this.cwd)
    } catch {
      // 主进程可能已经在退出
    }
  }

  private docForModel(model: monaco.editor.ITextModel): DocState | null {
    const rel = relFromUri(model.uri, this.cwd)
    if (!rel) return null
    const language = model.getLanguageId()
    if (!isLspLanguage(language)) return null
    let doc = this.docs.get(rel)
    if (!doc) {
      doc = {
        rel,
        language,
        uri: uriOf(this.cwd, rel),
        text: model.getValue(),
        version: 0,
        opened: false,
        lastText: '',
        timer: null,
        model
      }
      this.docs.set(rel, doc)
      this.applyCachedDiagnostics(doc)
      const created = doc
      void this.ensureSession(language).then((ok) => {
        if (ok) this.openDoc(created)
      })
    } else {
      doc.model = model
      this.applyCachedDiagnostics(doc)
      if (doc.text !== model.getValue()) {
        doc.text = model.getValue()
        if (doc.opened) this.scheduleChange(doc)
      }
    }
    return doc
  }

  private ensureSession(language: string): Promise<boolean> {
    if (this.disposed || !isLspLanguage(language)) return Promise.resolve(false)
    const current = this.sessions.get(language)
    if (current?.status === 'ready') return Promise.resolve(true)
    if (current?.promise) return current.promise
    if (
      current?.status === 'error' &&
      current.failedAt &&
      Date.now() - current.failedAt < SESSION_RETRY_MS
    ) {
      return Promise.resolve(false)
    }

    const api = window.api?.lsp
    if (!api) return Promise.resolve(false)

    const state: SessionState = { status: 'starting' }
    this.sessions.set(language, state)
    this.emit(language, { state: 'starting' })
    state.promise = api
      .start({ cwd: this.cwd, language })
      .then((result) => {
        if (this.disposed) return false
        if (result.ok) {
          this.sessions.set(language, {
            status: 'ready',
            server: result.server,
            capabilities: result.capabilities
          })
          this.emit(language, { state: 'ready', server: result.server })
          this.onSessionReady?.(language, result.capabilities)
          this.updateWorkerMode()
          for (const doc of this.docs.values()) {
            if (doc.language === language) this.openDoc(doc)
          }
          return true
        }
        this.sessions.set(language, {
          status: 'error',
          message: result.error,
          failedAt: Date.now()
        })
        this.emit(language, { state: 'error', message: result.error })
        this.onSessionStopped?.(language)
        return false
      })
      .catch((err: unknown) => {
        if (this.disposed) return false
        const message = err instanceof Error ? err.message : String(err)
        this.sessions.set(language, { status: 'error', message, failedAt: Date.now() })
        this.emit(language, { state: 'error', message })
        this.onSessionStopped?.(language)
        return false
      })
    return state.promise
  }

  private onSessionState(event: LspStateEvent): void {
    if (this.disposed || event.cwd !== this.cwd) return
    if (event.state === 'ready') {
      const existing = this.sessions.get(event.language)
      const capabilities = event.capabilities ?? existing?.capabilities
      this.sessions.set(event.language, {
        status: 'ready',
        server: event.server,
        ...(capabilities ? { capabilities } : {})
      })
      this.emit(event.language, {
        state: 'ready',
        ...(event.server ? { server: event.server } : {}),
        ...(capabilities ? { capabilities } : {})
      })
      this.onSessionReady?.(event.language, capabilities)
      this.updateWorkerMode()
      // 崩溃 / 重启后把该语言的文档重新 didOpen；文本用当前缓冲区
      for (const doc of this.docs.values()) {
        if (doc.language === event.language) this.openDoc(doc)
      }
      return
    }
    if (event.state === 'error' || event.state === 'stopped') {
      this.sessions.set(event.language, {
        status: 'error',
        ...(event.server ? { server: event.server } : {}),
        ...(event.message ? { message: event.message } : {}),
        failedAt: Date.now()
      })
      this.emit(event.language, {
        state: 'error',
        ...(event.server ? { server: event.server } : {}),
        ...(event.message ? { message: event.message } : {})
      })
      this.onSessionStopped?.(event.language)
      for (const doc of this.docs.values()) {
        if (doc.language === event.language) doc.opened = false
      }
      this.clearLanguageDiagnostics(event.language)
      this.updateWorkerMode()
    }
  }

  private updateWorkerMode(): void {
    const hasLsp =
      this.sessions.get('typescript')?.status === 'ready' ||
      this.sessions.get('javascript')?.status === 'ready'
    if (hasLsp !== this.workerOff) {
      this.workerOff = hasLsp
      setTsWorkerMode(!hasLsp)
      // worker 已经被关掉，但它之前产生的 marker 不会自己消失；
      // 不清掉会和 LSP 的诊断叠在一起（同一处两个红波浪线）。
      if (hasLsp) this.clearMarkersByOwner((owner) => owner !== OWNER)
    }
  }

  /** 清掉 TS / JS model 上指定 owner 的 marker；语言服务器切换时用 */
  private clearMarkersByOwner(match: (owner: string) => boolean): void {
    for (const model of monaco.editor.getModels()) {
      if (model.isDisposed()) continue
      const language = model.getLanguageId()
      if (language !== 'typescript' && language !== 'javascript') continue
      const owners = new Set(
        monaco.editor
          .getModelMarkers({ resource: model.uri })
          .map((marker) => marker.owner)
      )
      for (const owner of owners) {
        if (match(owner)) monaco.editor.setModelMarkers(model, owner, [])
      }
    }
  }

  /** 会话崩溃 / 停止后，旧诊断不应继续挂在问题面板里 */
  private clearLanguageDiagnostics(language: string): void {
    for (const rel of [...this.diagnostics.keys()]) {
      const doc = this.docs.get(rel)
      const model = this.modelForRel(rel)
      const effective = doc?.language ?? model?.getLanguageId()
      if (effective !== language) continue
      if (model) monaco.editor.setModelMarkers(model, OWNER, [])
      this.diagnostics.delete(rel)
    }
  }

  private emit(language: string, info: LspStateInfo): void {
    this.onState(language, info)
  }

  private openDoc(doc: DocState): void {
    if (this.disposed || doc.opened || this.docs.get(doc.rel) !== doc) return
    const session = this.sessions.get(doc.language)
    if (session?.status !== 'ready') return
    const api = window.api?.lsp
    if (!api) return

    doc.version = 1
    doc.opened = true
    doc.lastText = doc.text
    api.notify({
      cwd: this.cwd,
      language: doc.language,
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri: doc.uri,
          languageId: LSP_LANGUAGE_ID[doc.language] ?? doc.language,
          version: doc.version,
          text: doc.text
        }
      }
    })
  }

  private scheduleChange(doc: DocState): void {
    if (doc.timer !== null) window.clearTimeout(doc.timer)
    doc.timer = window.setTimeout(() => {
      doc.timer = null
      this.flushChange(doc)
    }, CHANGE_DEBOUNCE_MS)
  }

  private flushChange(doc: DocState): void {
    if (this.disposed || !doc.opened || doc.text === doc.lastText) return
    const api = window.api?.lsp
    if (!api) return
    const change = diffChange(doc.lastText, doc.text)
    doc.lastText = doc.text
    if (!change) return
    doc.version += 1
    api.notify({
      cwd: this.cwd,
      language: doc.language,
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri: doc.uri, version: doc.version },
        contentChanges: [{ range: change.range, text: change.text }]
      }
    })
  }

  private closeDoc(doc: DocState): void {
    if (doc.timer !== null) {
      window.clearTimeout(doc.timer)
      doc.timer = null
    }
    if (doc.opened) {
      window.api?.lsp?.notify({
        cwd: this.cwd,
        language: doc.language,
        method: 'textDocument/didClose',
        params: { textDocument: { uri: doc.uri } }
      })
      doc.opened = false
    }
    this.diagnostics.delete(doc.rel)
    const model = this.modelForRel(doc.rel)
    if (model) monaco.editor.setModelMarkers(model, OWNER, [])
  }

  private applyCachedDiagnostics(doc: DocState): void {
    const markers = this.diagnostics.get(doc.rel)
    const model = doc.model
    if (markers && model && !model.isDisposed()) {
      monaco.editor.setModelMarkers(model, OWNER, markers)
    }
  }

  private modelForRel(rel: string): monaco.editor.ITextModel | null {
    const direct = this.docs.get(rel)?.model
    if (direct && !direct.isDisposed()) return direct
    for (const model of monaco.editor.getModels()) {
      if (model.isDisposed()) continue
      if (relFromUri(model.uri, this.cwd) === rel) return model
    }
    return null
  }

  private applyDiagnostics(event: LspDiagnosticsEvent): void {
    if (this.disposed || event.cwd !== this.cwd) return
    const uri = safeUri(event.uri)
    if (!uri) return
    const rel = relFromUri(uri, this.cwd)
    if (!rel) return

    const markers: monaco.editor.IMarkerData[] = event.diagnostics.map((d) => {
      const range = monacoRange(d.range)
      return {
        severity: markerSeverity(d.severity),
        startLineNumber: range.startLineNumber,
        startColumn: range.startColumn,
        endLineNumber: range.endLineNumber,
        endColumn: range.endColumn,
        message: d.message,
        source: d.source || 'lsp',
        ...(d.code !== undefined ? { code: String(d.code) } : {}),
        ...(markerTags(d.tags).length ? { tags: markerTags(d.tags) } : {})
      }
    })
    this.diagnostics.set(rel, markers)
    const model = this.modelForRel(rel) ?? monaco.editor.getModel(uri)
    if (model) monaco.editor.setModelMarkers(model, OWNER, markers)
  }
}

/* ── Monaco provider 注册 ───────────────────────────────── */

let active: LspController | null = null

function textDocumentOf(model: monaco.editor.ITextModel): { uri: string } {
  return { uri: model.uri.toString() }
}

/** declaration / implementation / typeDefinition 共用一套 Location 解析 */
async function locationRequest(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
  method: string
): Promise<monaco.languages.Location[] | null> {
  if (!active) return null
  const result = await active.request(model, method, {
    textDocument: textDocumentOf(model),
    position: lspPosition(position)
  })
  const locations = toLocations(result)
  return locations.length ? locations : null
}

export function installLspProviders(controller: LspController): () => void {
  active = controller
  const disposables: monaco.IDisposable[] = []
  const languages = Object.keys(LSP_LANGUAGE_ID)

  /*
   * 语义着色按会话动态挂载：服务器就绪后才注册 provider，避免 Monaco
   * 在还没有 legend 时反复请求；会话停止 / 崩溃时卸载，回落到语法着色。
   */
  const semantic = new Map<string, monaco.IDisposable>()
  const enableSemantic = (language: string): void => {
    if (semantic.has(language)) return
    semantic.set(
      language,
      monaco.languages.registerDocumentSemanticTokensProvider(language, {
        getLegend: () => SEMANTIC_LEGEND,
        provideDocumentSemanticTokens: async (model) => {
          if (!active) return null
          return active.semanticTokens(model)
        },
        releaseDocumentSemanticTokens: () => {}
      })
    )
  }
  const disableSemantic = (language: string): void => {
    semantic.get(language)?.dispose()
    semantic.delete(language)
  }
  controller.onSessionReady = (language, capabilities) => {
    if (semanticLegendOf(capabilities)) enableSemantic(language)
    else disableSemantic(language)
  }
  controller.onSessionStopped = (language) => disableSemantic(language)

  for (const language of languages) {
    disposables.push(
      monaco.languages.registerDefinitionProvider(language, {
        provideDefinition: async (model, position) => {
          if (!active) return null
          const result = await active.request(model, 'textDocument/definition', {
            textDocument: textDocumentOf(model),
            position: lspPosition(position)
          })
          const locations = toLocations(result)
          return locations.length ? locations : null
        }
      }),

      monaco.languages.registerReferenceProvider(language, {
        provideReferences: async (model, position) => {
          if (!active) return null
          const result = await active.request(model, 'textDocument/references', {
            textDocument: textDocumentOf(model),
            position: lspPosition(position),
            context: { includeDeclaration: true }
          })
          const locations = toLocations(result)
          return locations.length ? locations : null
        }
      }),

      monaco.languages.registerRenameProvider(language, {
        provideRenameEdits: async (model, position, newName) => {
          if (!active) return null
          const result = await active.request(model, 'textDocument/rename', {
            textDocument: textDocumentOf(model),
            position: lspPosition(position),
            newName
          })
          return asWorkspaceEdit(result)
        }
      }),

      monaco.languages.registerHoverProvider(language, {
        provideHover: async (model, position) => {
          if (!active) return null
          const result = await active.request(model, 'textDocument/hover', {
            textDocument: textDocumentOf(model),
            position: lspPosition(position)
          })
          if (!result || typeof result !== 'object') return null
          const hover = result as { contents?: unknown; range?: unknown }
          const contents = markdownContents(hover.contents)
          if (contents.length === 0) return null
          const range = rangeOf(hover.range)
          return range ? { contents, range } : { contents }
        }
      }),

      monaco.languages.registerCompletionItemProvider(language, {
        triggerCharacters: ['.', '/', '"', "'", '`', ':', '@', '<'],
        provideCompletionItems: async (model, position, context) => {
          if (!active) return null
          const result = await active.request(model, 'textDocument/completion', {
            textDocument: textDocumentOf(model),
            position: lspPosition(position),
            context: {
              triggerKind:
                context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter
                  ? 2
                  : context.triggerKind ===
                      monaco.languages.CompletionTriggerKind.TriggerForIncompleteCompletions
                    ? 3
                    : 1,
              ...(context.triggerCharacter
                ? { triggerCharacter: context.triggerCharacter }
                : {})
            }
          })
          if (!result || typeof result !== 'object') return null
          const list = result as { items?: unknown; isIncomplete?: unknown }
          const rawItems = Array.isArray(result)
            ? result
            : Array.isArray(list.items)
              ? list.items
              : []
          const suggestions = rawItems
            .map((raw) => completionOf(raw, model, position))
            .filter((x): x is monaco.languages.CompletionItem => !!x)
          return {
            suggestions,
            incomplete: list.isIncomplete === true
          }
        }
      }),

      monaco.languages.registerDocumentFormattingEditProvider(language, {
        provideDocumentFormattingEdits: async (model, options) => {
          if (!active) return null
          const result = await active.request(model, 'textDocument/formatting', {
            textDocument: textDocumentOf(model),
            options: {
              tabSize: options.tabSize,
              insertSpaces: options.insertSpaces
            }
          })
          return toTextEdits(result)
        }
      }),

      monaco.languages.registerDocumentRangeFormattingEditProvider(language, {
        provideDocumentRangeFormattingEdits: async (model, range, options) => {
          if (!active) return null
          const result = await active.request(model, 'textDocument/rangeFormatting', {
            textDocument: textDocumentOf(model),
            range: {
              start: {
                line: range.startLineNumber - 1,
                character: range.startColumn - 1
              },
              end: { line: range.endLineNumber - 1, character: range.endColumn - 1 }
            },
            options: {
              tabSize: options.tabSize,
              insertSpaces: options.insertSpaces
            }
          })
          return toTextEdits(result)
        }
      })
    )

    const pendingActions = new WeakMap<monaco.languages.CodeAction, unknown>()

    disposables.push(
      monaco.languages.registerDeclarationProvider(language, {
        provideDeclaration: (model, position) =>
          locationRequest(model, position, 'textDocument/declaration')
      }),

      monaco.languages.registerImplementationProvider(language, {
        provideImplementation: (model, position) =>
          locationRequest(model, position, 'textDocument/implementation')
      }),

      monaco.languages.registerTypeDefinitionProvider(language, {
        provideTypeDefinition: (model, position) =>
          locationRequest(model, position, 'textDocument/typeDefinition')
      }),

      monaco.languages.registerDocumentHighlightProvider(language, {
        provideDocumentHighlights: async (model, position) => {
          if (!active) return null
          const result = await active.request(model, 'textDocument/documentHighlight', {
            textDocument: textDocumentOf(model),
            position: lspPosition(position)
          })
          return highlightsOf(result)
        }
      }),

      monaco.languages.registerDocumentSymbolProvider(language, {
        provideDocumentSymbols: async (model) => {
          if (!active) return null
          const result = await active.request(
            model,
            'textDocument/documentSymbol',
            { textDocument: textDocumentOf(model) },
            10_000
          )
          const symbols = documentSymbolsOf(result, model.uri.toString())
          return symbols.length ? symbols : null
        }
      }),

      monaco.languages.registerSignatureHelpProvider(language, {
        signatureHelpTriggerCharacters: ['(', ',', '<'],
        signatureHelpRetriggerCharacters: [','],
        provideSignatureHelp: async (model, position, _token, context) => {
          if (!active) return null
          const result = await active.request(model, 'textDocument/signatureHelp', {
            textDocument: textDocumentOf(model),
            position: lspPosition(position),
            context: {
              triggerKind: context.triggerKind,
              isRetrigger: context.isRetrigger,
              ...(context.triggerCharacter
                ? { triggerCharacter: context.triggerCharacter }
                : {})
            }
          })
          return signatureHelpOf(result)
        }
      }),

      monaco.languages.registerCodeActionProvider(
        language,
        {
          provideCodeActions: async (model, range, context) => {
            if (!active) return { actions: [], dispose: () => {} }
            const result = await active.request(model, 'textDocument/codeAction', {
              textDocument: textDocumentOf(model),
              range: {
                start: {
                  line: range.startLineNumber - 1,
                  character: range.startColumn - 1
                },
                end: { line: range.endLineNumber - 1, character: range.endColumn - 1 }
              },
              context: {
                diagnostics: context.markers.map(diagnosticOf),
                ...(context.only ? { only: [context.only] } : {}),
                triggerKind: context.trigger
              }
            })
            const actions: monaco.languages.CodeAction[] = []
            if (Array.isArray(result)) {
              for (const raw of result) {
                const action = codeActionOf(raw, pendingActions)
                if (action) actions.push(action)
              }
            }
            return { actions, dispose: () => {} }
          },
          resolveCodeAction: async (action) => {
            const raw = pendingActions.get(action)
            if (!active || raw === undefined) return action
            const resolved = await active.requestForLanguage(
              language,
              'codeAction/resolve',
              raw,
              10_000
            )
            const edit = asWorkspaceEdit(
              resolved && typeof resolved === 'object'
                ? (resolved as { edit?: unknown }).edit
                : undefined
            )
            return edit ? { ...action, edit } : action
          }
        },
        { providedCodeActionKinds: ['quickfix', 'refactor', 'source'] }
      )
    )
  }

  return () => {
    if (active === controller) active = null
    controller.onSessionReady = undefined
    controller.onSessionStopped = undefined
    for (const disposable of semantic.values()) disposable.dispose()
    semantic.clear()
    for (const disposable of disposables) disposable.dispose()
  }
}

function completionOf(
  raw: unknown,
  model: monaco.editor.ITextModel,
  position: monaco.IPosition
): monaco.languages.CompletionItem | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as CompletionShape
  const labelRaw = item.label as
    | string
    | { label?: unknown; detail?: unknown; description?: unknown }
    | undefined
  let label = ''
  let labelDetail: string | undefined
  let labelDescription: string | undefined
  if (typeof labelRaw === 'string') label = labelRaw
  else if (labelRaw && typeof labelRaw === 'object') {
    if (typeof labelRaw.label === 'string') label = labelRaw.label
    if (typeof labelRaw.detail === 'string') labelDetail = labelRaw.detail
    if (typeof labelRaw.description === 'string') labelDescription = labelRaw.description
  }
  if (!label) return null

  let range: monaco.IRange | monaco.languages.CompletionItemRanges = wordRangeAt(
    model,
    position
  )
  let insertText = typeof item.insertText === 'string' ? item.insertText : label
  const edit = item.textEdit
  if (edit && typeof edit === 'object') {
    const e = edit as {
      range?: unknown
      newText?: unknown
      insert?: unknown
      replace?: unknown
    }
    if (typeof e.newText === 'string') insertText = e.newText
    const replace = rangeOf(e.replace)
    const insert = rangeOf(e.insert)
    if (replace && insert) {
      range = { insert, replace }
    } else {
      const single = rangeOf(e.range)
      if (single) range = single
    }
  }

  const additional: monaco.editor.ISingleEditOperation[] = []
  if (Array.isArray(item.additionalTextEdits)) {
    for (const rawEdit of item.additionalTextEdits) {
      if (!rawEdit || typeof rawEdit !== 'object') continue
      const e = rawEdit as { range?: unknown; newText?: unknown }
      const r = rangeOf(e.range)
      if (r && typeof e.newText === 'string') additional.push({ range: r, text: e.newText })
    }
  }

  const docs = markdownContents(item.documentation)
  const tags = Array.isArray(item.tags) && item.tags.includes(1)
    ? [monaco.languages.CompletionItemTag.Deprecated]
    : item.deprecated === true
      ? [monaco.languages.CompletionItemTag.Deprecated]
      : undefined

  return {
    label:
      labelDetail || labelDescription
        ? {
            label,
            ...(labelDetail ? { detail: labelDetail } : {}),
            ...(labelDescription ? { description: labelDescription } : {})
          }
        : label,
    kind: completionKind(item.kind),
    insertText,
    range,
    ...(item.insertTextFormat === 2
      ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }
      : {}),
    ...(typeof item.detail === 'string' ? { detail: item.detail } : {}),
    ...(docs.length ? { documentation: { value: docs.map((d) => d.value).join('\n\n') } } : {}),
    ...(typeof item.sortText === 'string' ? { sortText: item.sortText } : {}),
    ...(typeof item.filterText === 'string' ? { filterText: item.filterText } : {}),
    ...(item.preselect === true ? { preselect: true } : {}),
    ...(additional.length ? { additionalTextEdits: additional } : {}),
    ...(Array.isArray(item.commitCharacters)
      ? {
          commitCharacters: item.commitCharacters.filter(
            (c): c is string => typeof c === 'string'
          )
        }
      : {}),
    ...(tags ? { tags } : {})
  }
}
