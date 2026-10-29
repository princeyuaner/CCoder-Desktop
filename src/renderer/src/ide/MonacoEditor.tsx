import { useCallback, useEffect, useRef } from 'react'
import type { IdeTextFile } from '@shared/ide'
import { DEFAULT_EDITOR_SETTINGS, type EditorSettings } from '@shared/settings'
import { applyMonacoTheme, monaco, monacoLanguage } from './monaco-setup'
import { useI18n } from '../i18n'

export interface EditorSelection {
  startLine: number
  endLine: number
  code: string
  rect: {
    left: number
    top: number
    right: number
    bottom: number
    width: number
    height: number
  }
}

type EditorHost = HTMLDivElement & {
  /** 测试和调试用；渲染进程本来就能拿到整个 window.api，不构成额外权限 */
  __ccoderEditor?: monaco.editor.IStandaloneCodeEditor
  __ccoderMonaco?: typeof monaco
}

function monoFont(): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
    "'Cascadia Mono', 'JetBrains Mono', Consolas, monospace"
  )
}

/** 大文件降级档位：0 正常，1 大，2 超大 */
type EditorTier = 0 | 1 | 2

const LARGE_LINES = 20_000
const LARGE_UNITS = 1_000_000
const HUGE_LINES = 50_000
const HUGE_UNITS = 1_800_000

function tierForModel(model: monaco.editor.ITextModel): EditorTier {
  const lines = model.getLineCount()
  const units = model.getValueLength()
  if (lines > HUGE_LINES || units > HUGE_UNITS) return 2
  if (lines > LARGE_LINES || units > LARGE_UNITS) return 1
  return 0
}

/**
 * 大文件时关掉全量渲染/装饰相关的功能。Monaco 的查找算法本身仍是 O(buffer)，
 * 但 minimap、折叠、括号着色、occurrence highlight 这些会额外拖慢输入和滚动。
 */
function optionsForTier(
  tier: EditorTier
): monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions {
  const minimap = {
    enabled: tier === 0,
    maxColumn: 100,
    renderCharacters: false,
    showSlider: 'mouseover' as const
  }

  if (tier === 0) {
    return {
      minimap,
      folding: true,
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: false, indentation: true },
      occurrencesHighlight: 'singleFile',
      'semanticHighlighting.enabled': true,
      maxTokenizationLineLength: 20_000,
      stopRenderingLineAfter: -1,
      hover: { enabled: 'on' },
      links: true,
      colorDecorators: true,
      wordBasedSuggestions: 'currentDocument'
    }
  }

  if (tier === 1) {
    return {
      minimap,
      folding: false,
      bracketPairColorization: { enabled: false },
      guides: { bracketPairs: false, indentation: true },
      occurrencesHighlight: 'off',
      'semanticHighlighting.enabled': false,
      maxTokenizationLineLength: 10_000,
      stopRenderingLineAfter: 5_000,
      hover: { enabled: 'on' },
      links: true,
      colorDecorators: true,
      wordBasedSuggestions: 'off'
    }
  }

  return {
    minimap,
    folding: false,
    bracketPairColorization: { enabled: false },
    guides: { bracketPairs: false, indentation: false },
    occurrencesHighlight: 'off',
    'semanticHighlighting.enabled': false,
    maxTokenizationLineLength: 5_000,
    stopRenderingLineAfter: 2_000,
    hover: { enabled: 'off' },
    links: false,
    colorDecorators: false,
    wordBasedSuggestions: 'off'
  }
}

function preferencesOptions(
  prefs: EditorSettings
): monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions {
  return {
    fontSize: prefs.fontSize,
    tabSize: prefs.tabSize,
    insertSpaces: prefs.insertSpaces,
    wordWrap: prefs.wordWrap,
    wordWrapColumn: 100,
    minimap: { enabled: prefs.minimap }
  }
}

function mergedOptions(
  tier: EditorTier,
  prefs: EditorSettings
): monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions {
  const base = optionsForTier(tier)
  const prefsOptions = preferencesOptions(prefs)
  return {
    ...base,
    ...prefsOptions,
    // 大文件档位下强制关掉 minimap，优先保证输入 / 滚动流畅
    minimap: { ...base.minimap, ...prefsOptions.minimap, enabled: prefs.minimap && tier === 0 }
  }
}

function applyEditorTier(
  editor: monaco.editor.IStandaloneCodeEditor,
  model: monaco.editor.ITextModel,
  tierRef: { current: EditorTier },
  prefs: EditorSettings
): void {
  const tier = tierForModel(model)
  if (tier === tierRef.current) return
  tierRef.current = tier
  editor.updateOptions(mergedOptions(tier, prefs))
}

/** 把编辑器的当前选区换算成发给聊天用的行号 / 原文 / 定位点 */
function selectionOf(
  editor: monaco.editor.ICodeEditor,
  host: HTMLElement
): EditorSelection | null {
  const model = editor.getModel()
  const sel = editor.getSelection()
  if (!model || !sel || sel.isEmpty()) return null

  const startLine = sel.startLineNumber
  let endLine = sel.endLineNumber
  // 多行选区停在下一行行首时，不要把那一整行算进去
  if (endLine > startLine && sel.endColumn === 1) endLine -= 1
  const code =
    startLine === endLine
      ? model.getValueInRange(sel).replace(/\s+$/, '')
      : model
          .getValueInRange(
            new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine))
          )
          .replace(/\s+$/, '')
  if (!code.trim()) return null

  const pos = sel.getEndPosition()
  const view = editor.getScrolledVisiblePosition(pos)
  const r = host.getBoundingClientRect()
  const x = view ? r.left + view.left : r.left + 40
  const y = view ? r.top + view.top + 19 : r.top + 40
  return {
    startLine,
    endLine,
    code,
    rect: { left: x, top: y, right: x, bottom: y, width: 0, height: 0 }
  }
}

/**
 * Monaco 文本编辑器。
 *
 * 每个工作区相对路径对应一个 model，切 tab 时只换 model，不重建编辑器，
 * 所以撤销栈和滚动位置都留在各自文件里。外部状态（保存 / 还原 / VCS 刷新）
 * 变化时按文本比较，只有真的不同才回写 model，避免打字时把光标重置。
 */
export function MonacoEditor({
  cwd,
  file,
  jumpLine,
  prefs = DEFAULT_EDITOR_SETTINGS,
  onCursor,
  onChange,
  onSendSelection,
  onSendFile
}: {
  /** 工作区绝对路径：用来生成 file:// model URI，让 TS worker 能解析 import */
  cwd: string
  file: IdeTextFile
  jumpLine?: number
  /** 设置页里的编辑器偏好；不传时用默认值（测试 / 旧调用方） */
  prefs?: EditorSettings
  onCursor: (line: number, col: number) => void
  onChange: (text: string) => void
  onSendSelection: (sel: EditorSelection) => void
  onSendFile: () => void
}): JSX.Element {
  const { t } = useI18n()
  const hostRef = useRef<EditorHost>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelsRef = useRef(new Map<string, monaco.editor.ITextModel>())
  const viewsRef = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>())
  const relRef = useRef(file.rel)
  const applyingRef = useRef(false)
  const tierRef = useRef<EditorTier>(0)
  const tierTimer = useRef<number | null>(null)
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  const propsRef = useRef({ file, onCursor, onChange, onSendSelection, onSendFile })
  propsRef.current = { file, onCursor, onChange, onSendSelection, onSendFile }

  const ensureModel = useCallback((next: IdeTextFile): monaco.editor.ITextModel => {
    const lang = monacoLanguage(next.language, next.rel)
    const abs = `${cwdRef.current.replace(/\\/g, '/').replace(/\/+$/, '')}/${next.rel}`
    const uri = monaco.Uri.file(abs)
    // tsProject 可能已经为 import 目标建了同名 model；不能重复 createModel
    let model = modelsRef.current.get(next.rel) ?? monaco.editor.getModel(uri) ?? undefined
    if (!model || model.isDisposed()) {
      model = monaco.editor.createModel(next.text, lang, uri)
      modelsRef.current.set(next.rel, model)
    } else if (model.getValue() !== next.text) {
      applyingRef.current = true
      model.setValue(next.text)
      applyingRef.current = false
    }
    if (!modelsRef.current.has(next.rel)) modelsRef.current.set(next.rel, model)
    if (model.getLanguageId() !== lang) monaco.editor.setModelLanguage(model, lang)
    model.updateOptions({
      tabSize: prefsRef.current.tabSize,
      insertSpaces: prefsRef.current.insertSpaces
    })
    return model
  }, [])

  // 创建编辑器；model 在 rel 变化时单独切换
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    applyMonacoTheme()
    const initial = propsRef.current.file
    const initialModel = ensureModel(initial)
    const initialTier = tierForModel(initialModel)
    tierRef.current = initialTier
    const editor = monaco.editor.create(host, {
      model: initialModel,
      theme: 'ccoder',
      automaticLayout: true,
      fontFamily: monoFont(),
      lineHeight: Math.round(prefsRef.current.fontSize * 1.55),
      detectIndentation: false,
      largeFileOptimizations: true,
      ...mergedOptions(initialTier, prefsRef.current),
      lineNumbers: 'on',
      lineNumbersMinChars: 3,
      lineDecorationsWidth: 6,
      glyphMargin: false,
      showFoldingControls: 'mouseover',
      smoothScrolling: false,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'off',
      renderLineHighlight: 'all',
      renderWhitespace: 'selection',
      scrollBeyondLastLine: false,
      padding: { top: 8, bottom: 20 },
      scrollbar: {
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10,
        useShadows: false
      },
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      fixedOverflowWidgets: true,
      contextmenu: true,
      /*
       * Monaco 0.56 起默认用 Shadow DOM 渲染右键菜单。standalone 的主题只在
       * .monaco-editor / .monaco-component 上定义 --vscode-* 颜色变量，而菜单的
       * shadow host 挂在编辑器宿主下、不在 .monaco-editor 里面，变量继承不进去：
       * 菜单背景透明、文字黑色，在深色主题下看起来就是「右键没反应」。
       * 关掉 Shadow DOM 后菜单回到普通 DOM，主题变量正常生效。
       */
      useShadowDOM: false,
      mouseWheelZoom: false,
      stickyScroll: { enabled: false },
      suggest: { showWords: false }
    })

    editorRef.current = editor
    host.__ccoderEditor = editor
    host.__ccoderMonaco = monaco

    const p = editor.getPosition()
    if (p) propsRef.current.onCursor(p.lineNumber, p.column)

    const disposables = [
      editor.onDidChangeModelContent(() => {
        if (applyingRef.current) return
        propsRef.current.onChange(editor.getValue())

        // 文件可能从普通变成超大（粘贴/生成）；1 秒防抖后只在跨档时重配
        if (tierTimer.current !== null) window.clearTimeout(tierTimer.current)
        tierTimer.current = window.setTimeout(() => {
          tierTimer.current = null
          const current = editorRef.current
          const model = current?.getModel()
          if (current && model) applyEditorTier(current, model, tierRef, prefsRef.current)
        }, 1000)
      }),
      editor.onDidChangeCursorPosition((e) => {
        propsRef.current.onCursor(e.position.lineNumber, e.position.column)
      })
    ]

    return () => {
      if (tierTimer.current !== null) window.clearTimeout(tierTimer.current)
      tierTimer.current = null
      for (const d of disposables) d.dispose()
      host.__ccoderEditor = undefined
      host.__ccoderMonaco = undefined
      editor.dispose()
      editorRef.current = null
      for (const model of modelsRef.current.values()) {
        if (!model.isDisposed()) model.dispose()
      }
      modelsRef.current.clear()
      viewsRef.current.clear()
    }
  }, [ensureModel])

  /*
   * 右键菜单里的「发送到聊天」。单独一个 effect，依赖当前语言：
   * 切换语言时先 dispose 旧 action，再按新语言注册，已打开的 IDE 窗口也能立即更新。
   */
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const sendSelection = editor.addAction({
      id: 'ccoder.sendSelection',
      label: t('ide.sendSelection'),
      precondition: 'editorHasSelection',
      // navigation 组在 Monaco 右键菜单里始终排最前，order 0/1 又早于自带的
      // 跳转项（1.1），两个「发送到聊天」就是菜单最上面的两条
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 0,
      run: (ed) => {
        const host = hostRef.current
        const sel = host ? selectionOf(ed, host) : null
        if (sel) propsRef.current.onSendSelection(sel)
      }
    })
    const sendFile = editor.addAction({
      id: 'ccoder.sendFile',
      label: t('ide.sendFile'),
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1,
      run: () => propsRef.current.onSendFile()
    })
    return () => {
      sendSelection.dispose()
      sendFile.dispose()
    }
  }, [t])

  // 切文件：保存/恢复视图状态，换成对应的 model
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const prev = relRef.current
    // 文本变化统一交给下面的 effect 处理，这里再做一次 setValue 会先重置光标
    if (prev === file.rel) return

    if (editor.getModel()) viewsRef.current.set(prev, editor.saveViewState())
    const model = ensureModel(file)
    applyingRef.current = true
    editor.setModel(model)
    applyingRef.current = false
    applyEditorTier(editor, model, tierRef, prefsRef.current)
    const view = viewsRef.current.get(file.rel)
    if (view) editor.restoreViewState(view)
    else {
      editor.setPosition({ lineNumber: 1, column: 1 })
      editor.revealLine(1)
    }
    relRef.current = file.rel
  }, [ensureModel, file])

  // 外部替换了文本（保存返回、VCS 还原、磁盘文件被外部进程改动等）
  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model || model.getValue() === file.text) return

    const view = editor.saveViewState()
    const pos = editor.getPosition()
    const sel = editor.getSelection()
    applyingRef.current = true
    model.setValue(file.text)
    applyingRef.current = false
    applyEditorTier(editor, model, tierRef, prefsRef.current)
    if (view) editor.restoreViewState(view)

    // 文件变短时把光标 / 选区夹回合法范围
    if (pos) {
      const line = Math.min(pos.lineNumber, model.getLineCount())
      editor.setPosition({
        lineNumber: line,
        column: Math.min(pos.column, model.getLineMaxColumn(line))
      })
    }
    if (sel) {
      const startLine = Math.min(sel.startLineNumber, model.getLineCount())
      const endLine = Math.min(sel.endLineNumber, model.getLineCount())
      editor.setSelection(
        new monaco.Selection(
          startLine,
          Math.min(sel.startColumn, model.getLineMaxColumn(startLine)),
          endLine,
          Math.min(sel.endColumn, model.getLineMaxColumn(endLine))
        )
      )
    }
  }, [file.text, file.rel])

  // 设置页改了编辑器偏好：已打开的窗口立即跟上，不用重开
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.updateOptions({
      ...mergedOptions(tierRef.current, prefs),
      lineHeight: Math.round(prefs.fontSize * 1.55)
    })
    for (const model of modelsRef.current.values()) {
      if (!model.isDisposed()) {
        model.updateOptions({ tabSize: prefs.tabSize, insertSpaces: prefs.insertSpaces })
      }
    }
  }, [prefs])

  // 从聊天工具卡 / 搜索跳转到某一行
  useEffect(() => {
    if (!jumpLine) return
    const editor = editorRef.current
    if (!editor) return
    editor.revealLineInCenter(jumpLine)
    editor.setPosition({ lineNumber: Math.max(1, jumpLine), column: 1 })
    editor.focus()
  }, [jumpLine, file.rel])

  // 主题 / 字体变化跟着 app 的 CSS token 走
  useEffect(() => {
    const apply = (): void => {
      applyMonacoTheme()
      editorRef.current?.updateOptions({ fontFamily: monoFont() })
    }
    apply()
    const obs = new MutationObserver(apply)
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-scheme', 'style']
    })
    return () => obs.disconnect()
  }, [])

  return <div className="ide-monaco" ref={hostRef} />
}
