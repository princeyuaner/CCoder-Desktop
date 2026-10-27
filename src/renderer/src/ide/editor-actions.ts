import type * as monaco from 'monaco-editor'

/**
 * 对"当前编辑器"执行 Monaco 内置动作。
 *
 * IdeApp 里的命令面板 / 快捷键不在 MonacoEditor 的 React 树里，也不方便
 * 把 editor 实例一路传上去；MonacoEditor 挂载时已经把实例放在宿主元素上
 * （`__ccoderEditor`，测试脚本也用它），这里按 DOM 反查。
 */
type EditorHost = HTMLDivElement & {
  __ccoderEditor?: monaco.editor.IStandaloneCodeEditor
}

export function activeEditor(): monaco.editor.IStandaloneCodeEditor | null {
  const hosts = Array.from(document.querySelectorAll<EditorHost>('.ide-monaco'))
  for (const host of hosts) {
    if (host.__ccoderEditor && !host.__ccoderEditor.getModel()?.isDisposed()) {
      return host.__ccoderEditor
    }
  }
  return null
}

export function runEditorAction(id: string): boolean {
  const editor = activeEditor()
  const action = editor?.getAction(id)
  if (!editor || !action?.isSupported()) return false
  void action.run()
  return true
}

/**
 * 格式化整个文档。
 *
 * Monaco 的 TypeScript 语言服务只注册了「格式化选区」，没有注册整篇格式化；
 * 所以先试 formatDocument，再退化为全选 + formatSelection，完成后恢复选区。
 */
export async function formatActiveDocument(): Promise<boolean> {
  const editor = activeEditor()
  const model = editor?.getModel()
  if (!editor || !model) return false

  try {
    const full = editor.getAction('editor.action.formatDocument')
    if (full?.isSupported()) {
      await full.run()
      return true
    }

    const selection = editor.getSelection()
    editor.setSelection(model.getFullModelRange())
    const range = editor.getAction('editor.action.formatSelection')
    if (!range?.isSupported()) {
      if (selection) editor.setSelection(selection)
      return false
    }
    await range.run()
    if (selection) editor.setSelection(selection)
    return true
  } catch {
    return false
  }
}
