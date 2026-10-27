import type { LspDiagnosticsEvent, LspPosition, LspRange, LspStateEvent } from '@shared/lsp'
import { monaco, setTsWorkerMode } from './monaco-setup'
import { diffChange } from './lsp-diff'
import { relFromUri } from './problems'

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
          this.sessions.set(language, { status: 'ready', server: result.server })
          this.emit(language, { state: 'ready', server: result.server })
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
        return false
      })
      .catch((err: unknown) => {
        if (this.disposed) return false
        const message = err instanceof Error ? err.message : String(err)
        this.sessions.set(language, { status: 'error', message, failedAt: Date.now() })
        this.emit(language, { state: 'error', message })
        return false
      })
    return state.promise
  }

  private onSessionState(event: LspStateEvent): void {
    if (this.disposed || event.cwd !== this.cwd) return
    if (event.state === 'ready') {
      this.sessions.set(event.language, {
        status: 'ready',
        server: event.server
      })
      this.emit(event.language, {
        state: 'ready',
        ...(event.server ? { server: event.server } : {})
      })
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

export function installLspProviders(controller: LspController): () => void {
  active = controller
  const disposables: monaco.IDisposable[] = []
  const languages = Object.keys(LSP_LANGUAGE_ID)

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
  }

  return () => {
    if (active === controller) active = null
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
