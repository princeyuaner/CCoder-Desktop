import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
// 编辑器功能（查找替换、折叠、多光标、建议、括号匹配等）
import 'monaco-editor/esm/vs/editor/editor.all'
// 带语言服务的 JSON / CSS / HTML / TS
import 'monaco-editor/esm/vs/language/json/monaco.contribution'
import 'monaco-editor/esm/vs/language/css/monaco.contribution'
import 'monaco-editor/esm/vs/language/html/monaco.contribution'
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution'
// 轻量 Monarch 语言；只引 IDE 会映射到的那部分，避免整包 basic-languages
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution'
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution'
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution'
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution'
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution'
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution'
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution'
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution'
import 'monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution'
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution'
import 'monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution'
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution'
import 'monaco-editor/esm/vs/basic-languages/ini/ini.contribution'
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution'
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution'
import 'monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution'
import 'monaco-editor/esm/vs/basic-languages/bat/bat.contribution'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

/**
 * Monaco 的 worker 入口。
 *
 * 打包后 Electron 走 `file://`，模块 worker 在部分 Chromium 版本上会被 CORS
 * 拦掉，所以 electron-vite 的 renderer 侧把 worker 输出成 iife（见
 * electron.vite.config.ts）。这里按语言把 Monaco 的 worker 分派出去。
 */
type WorkerEnv = {
  getWorker(workerId: string, label: string): Worker
}

;(self as unknown as { MonacoEnvironment: WorkerEnv }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker()
      case 'typescript':
      case 'javascript':
        return new TsWorker()
      default:
        return new EditorWorker()
    }
  }
}

/*
 * 这里没有加载工作区的 tsconfig / node_modules，语义检查会把 import 和
 * process 一类全局标成红线。保留语法检查，关掉语义诊断；补全仍然可用。
 */
monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: false
})
monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: false
})
monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
  allowNonTsExtensions: true,
  target: monaco.languages.typescript.ScriptTarget.ESNext,
  moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
  jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
  allowJs: true
})

const LANGUAGE: Record<string, string> = {
  TypeScript: 'typescript',
  'TypeScript React': 'typescript',
  JavaScript: 'javascript',
  'JavaScript React': 'javascript',
  JSON: 'json',
  CSS: 'css',
  SCSS: 'scss',
  LESS: 'less',
  HTML: 'html',
  Markdown: 'markdown',
  Python: 'python',
  Rust: 'rust',
  Go: 'go',
  Java: 'java',
  C: 'c',
  'C++': 'cpp',
  'C#': 'csharp',
  Shell: 'shell',
  PowerShell: 'powershell',
  YAML: 'yaml',
  TOML: 'ini',
  SQL: 'sql',
  XML: 'xml',
  SVG: 'xml',
  Vue: 'html',
  Svelte: 'html',
  Dockerfile: 'dockerfile',
  Makefile: 'plaintext',
  Text: 'plaintext'
}

const BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  mdx: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  sh: 'shell',
  bash: 'shell',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  sql: 'sql',
  xml: 'xml',
  svg: 'xml',
  vue: 'html',
  svelte: 'html'
}

export function monacoLanguage(language: string, rel: string): string {
  const byName = LANGUAGE[language]
  if (byName) return byName
  const name = rel.split('/').pop() ?? rel
  if (name === 'Dockerfile') return 'dockerfile'
  if (name === 'Makefile') return 'plaintext'
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return BY_EXT[ext] ?? 'plaintext'
}

function css(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

/** 把当前 data-theme / data-scheme 的 token 映射成 Monaco 主题 */
export function applyMonacoTheme(): void {
  const root = document.documentElement
  const light = root.dataset.scheme === 'light'
  const bg = css('--bg-app', light ? '#ffffff' : '#191919')
  const raised = css('--bg-raised', light ? '#ffffff' : '#232323')
  const fg = css('--text', light ? '#1d1d1f' : '#e8e8e8')
  const dim = css('--text-muted', light ? '#5f5f67' : '#a0a0a6')
  const faint = css('--text-faint', light ? '#a8a8b0' : '#55555d')
  const border = css('--border', light ? '#dcdce2' : '#333338')
  const hover = css('--bg-hover', light ? '#ececf0' : '#262626')
  const active = css('--bg-active', light ? '#e4e4e8' : '#303036')

  const keyword = light ? '8b3fb8' : 'c792ea'
  const string = light ? '2e7d32' : 'a5d6a7'
  const number = light ? 'a05a00' : 'f78c6c'
  const comment = light ? '8a8a92' : '6b6b73'
  const type = light ? '2c62a8' : '82aaff'
  const fn = light ? '8a5a00' : 'ffcb6b'

  monaco.editor.defineTheme('ccoder', {
    base: light ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: keyword },
      { token: 'string', foreground: string },
      { token: 'number', foreground: number },
      { token: 'comment', foreground: comment, fontStyle: 'italic' },
      { token: 'type', foreground: type },
      { token: 'type.identifier', foreground: type },
      { token: 'function', foreground: fn },
      { token: 'identifier', foreground: fg.replace('#', '') }
    ],
    colors: {
      'editor.background': bg,
      'editor.foreground': fg,
      'editorGutter.background': bg,
      'editorLineNumber.foreground': faint,
      'editorLineNumber.activeForeground': dim,
      'editor.selectionBackground': light ? '#cfe0f6' : '#264f78',
      'editor.inactiveSelectionBackground': light ? '#e4edf9' : '#20354d',
      'editor.lineHighlightBackground': light ? '#f7f7f9' : '#ffffff08',
      'editorCursor.foreground': fg,
      'editorIndentGuide.background1': light ? '#e7e7ea' : '#2b2b31',
      'editorIndentGuide.activeBackground1': light ? '#c9c9d1' : '#3c3c46',
      'editorWidget.background': raised,
      'editorWidget.foreground': fg,
      'editorWidget.border': border,
      'editorSuggestWidget.background': raised,
      'editorSuggestWidget.border': border,
      'editorSuggestWidget.selectedBackground': active,
      'editorHoverWidget.background': raised,
      'editorHoverWidget.border': border,
      'input.background': raised,
      'input.foreground': fg,
      'input.border': border,
      'list.hoverBackground': hover,
      'list.activeSelectionBackground': active,
      'list.activeSelectionForeground': fg,
      'scrollbarSlider.background': light ? '#00000014' : '#ffffff14',
      'scrollbarSlider.hoverBackground': light ? '#00000024' : '#ffffff22',
      'scrollbarSlider.activeBackground': light ? '#00000034' : '#ffffff33',
      'minimap.background': bg,
      'editorBracketMatch.background': light ? '#dfe8f6' : '#2f4a66',
      'editorBracketMatch.border': light ? '#b9cbe6' : '#45698f'
    }
  })
  monaco.editor.setTheme('ccoder')
}

export { monaco }
