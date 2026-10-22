import { useCallback, useEffect, useRef } from 'react'
import type { IdeTextFile } from '@shared/ide'
import { applyMonacoTheme, monaco, monacoLanguage } from './monaco-setup'

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
  file,
  jumpLine,
  onCursor,
  onChange,
  onSendSelection,
  onSendFile
}: {
  file: IdeTextFile
  jumpLine?: number
  onCursor: (line: number, col: number) => void
  onChange: (text: string) => void
  onSendSelection: (sel: EditorSelection) => void
  onSendFile: () => void
}): JSX.Element {
  const hostRef = useRef<EditorHost>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelsRef = useRef(new Map<string, monaco.editor.ITextModel>())
  const viewsRef = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>())
  const relRef = useRef(file.rel)
  const applyingRef = useRef(false)
  const propsRef = useRef({ file, onCursor, onChange, onSendSelection, onSendFile })
  propsRef.current = { file, onCursor, onChange, onSendSelection, onSendFile }

  const ensureModel = useCallback((next: IdeTextFile): monaco.editor.ITextModel => {
    const lang = monacoLanguage(next.language, next.rel)
    let model = modelsRef.current.get(next.rel)
    if (!model || model.isDisposed()) {
      model = monaco.editor.createModel(
        next.text,
        lang,
        monaco.Uri.parse(`ccoder:///${encodeURIComponent(next.rel)}`)
      )
      modelsRef.current.set(next.rel, model)
    } else if (model.getValue() !== next.text) {
      applyingRef.current = true
      model.setValue(next.text)
      applyingRef.current = false
    }
    if (model.getLanguageId() !== lang) monaco.editor.setModelLanguage(model, lang)
    return model
  }, [])

  // 创建编辑器；model 在 rel 变化时单独切换
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    applyMonacoTheme()
    const initial = propsRef.current.file
    const editor = monaco.editor.create(host, {
      model: ensureModel(initial),
      theme: 'ccoder',
      automaticLayout: true,
      fontFamily: monoFont(),
      fontSize: 12,
      lineHeight: 19,
      tabSize: 2,
      insertSpaces: true,
      detectIndentation: false,
      wordWrap: 'off',
      minimap: {
        enabled: true,
        maxColumn: 100,
        renderCharacters: false,
        showSlider: 'mouseover'
      },
      lineNumbers: 'on',
      lineNumbersMinChars: 3,
      lineDecorationsWidth: 6,
      glyphMargin: false,
      folding: true,
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
      mouseWheelZoom: false,
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: false, indentation: true },
      stickyScroll: { enabled: false },
      suggest: { showWords: false }
    })

    editorRef.current = editor
    host.__ccoderEditor = editor
    host.__ccoderMonaco = monaco

    const p = editor.getPosition()
    if (p) propsRef.current.onCursor(p.lineNumber, p.column)

    // 发送入口放在右键菜单里，不再占用工具栏 / 浮动条
    const sendSelection = editor.addAction({
      id: 'ccoder.sendSelection',
      label: '发送选区到聊天',
      precondition: 'editorHasSelection',
      contextMenuGroupId: '9_cutcopypaste',
      contextMenuOrder: 10,
      run: (ed) => {
        const host = hostRef.current
        const sel = host ? selectionOf(ed, host) : null
        if (sel) propsRef.current.onSendSelection(sel)
      }
    })
    const sendFile = editor.addAction({
      id: 'ccoder.sendFile',
      label: '发送当前文件到聊天',
      contextMenuGroupId: '9_cutcopypaste',
      contextMenuOrder: 11,
      run: () => propsRef.current.onSendFile()
    })

    const disposables = [
      sendSelection,
      sendFile,
      editor.onDidChangeModelContent(() => {
        if (applyingRef.current) return
        propsRef.current.onChange(editor.getValue())
      }),
      editor.onDidChangeCursorPosition((e) => {
        propsRef.current.onCursor(e.position.lineNumber, e.position.column)
      })
    ]

    return () => {
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
