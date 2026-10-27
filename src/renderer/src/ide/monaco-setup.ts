import * as monaco from 'monaco-editor/editor'
// 编辑器功能（查找替换、折叠、多光标、建议、括号匹配等）
import 'monaco-editor/features/register.all'
// 带语言服务的 JSON / CSS / HTML / TS
import * as typescript from 'monaco-editor/languages/features/typescript/register'
// 注意：json 子路径需要显式 .js 后缀，否则 Vite 5.4 解析 exports 时会落空
import 'monaco-editor/languages/features/json/register.js'
import 'monaco-editor/languages/features/css/register'
import 'monaco-editor/languages/features/html/register'
// 轻量 Monarch 语言；只引 IDE 会映射到的那部分，避免整包语言定义。
// 0.56 起语言服务与语言定义拆分，CSS / HTML 的 tokenizer 也要单独注册。
import 'monaco-editor/languages/definitions/typescript/register'
import 'monaco-editor/languages/definitions/javascript/register'
import 'monaco-editor/languages/definitions/markdown/register'
import 'monaco-editor/languages/definitions/python/register'
import 'monaco-editor/languages/definitions/rust/register'
import 'monaco-editor/languages/definitions/go/register'
import 'monaco-editor/languages/definitions/java/register'
import 'monaco-editor/languages/definitions/cpp/register'
import 'monaco-editor/languages/definitions/csharp/register'
import 'monaco-editor/languages/definitions/shell/register'
import 'monaco-editor/languages/definitions/powershell/register'
import 'monaco-editor/languages/definitions/yaml/register'
import 'monaco-editor/languages/definitions/ini/register'
import 'monaco-editor/languages/definitions/sql/register'
import 'monaco-editor/languages/definitions/xml/register'
import 'monaco-editor/languages/definitions/dockerfile/register'
import 'monaco-editor/languages/definitions/bat/register'
import 'monaco-editor/languages/definitions/css/register'
import 'monaco-editor/languages/definitions/scss/register'
import 'monaco-editor/languages/definitions/less/register'
import 'monaco-editor/languages/definitions/html/register'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/languages/features/json/json.worker.js?worker'
import CssWorker from 'monaco-editor/languages/features/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/languages/features/html/html.worker?worker'
import TsWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker'

/*
 * 增强版 Python 语法着色。
 *
 * Monaco 自带的 Python Monarch 只区分关键字 / 字符串 / 数字 / 注释，
 * 类名、函数、属性全部落到 identifier（主题里就是正文白色）。这里在不
 * 改变语言配置（缩进、括号、折叠）的前提下，补上：
 *   - def / class 后面的名字
 *   - 点号属性（self.timer / mod_service.X）
 *   - 函数调用与大写类名
 * 服务器支持 semantic tokens 时，语义着色会盖在它上面。
 */
const pythonLanguage: monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.python',
  keywords: [
    'False',
    'None',
    'True',
    'and',
    'as',
    'assert',
    'async',
    'await',
    'break',
    'case',
    'class',
    'continue',
    'def',
    'del',
    'elif',
    'else',
    'except',
    'finally',
    'for',
    'from',
    'global',
    'if',
    'import',
    'in',
    'is',
    'lambda',
    'match',
    'nonlocal',
    'not',
    'or',
    'pass',
    'raise',
    'return',
    'try',
    'while',
    'with',
    'yield',
    'self',
    'cls'
  ],
  builtins: [
    'abs',
    'all',
    'any',
    'bin',
    'bool',
    'bytearray',
    'bytes',
    'callable',
    'chr',
    'classmethod',
    'complex',
    'dict',
    'dir',
    'divmod',
    'enumerate',
    'eval',
    'exec',
    'filter',
    'float',
    'format',
    'frozenset',
    'getattr',
    'globals',
    'hasattr',
    'hash',
    'help',
    'hex',
    'id',
    'input',
    'int',
    'isinstance',
    'issubclass',
    'iter',
    'len',
    'list',
    'locals',
    'map',
    'max',
    'memoryview',
    'min',
    'next',
    'object',
    'oct',
    'open',
    'ord',
    'pow',
    'print',
    'property',
    'range',
    'repr',
    'reversed',
    'round',
    'set',
    'setattr',
    'slice',
    'sorted',
    'staticmethod',
    'str',
    'sum',
    'super',
    'tuple',
    'type',
    'vars',
    'zip'
  ],
  brackets: [
    { open: '{', close: '}', token: 'delimiter.curly' },
    { open: '[', close: ']', token: 'delimiter.square' },
    { open: '(', close: ')', token: 'delimiter.parenthesis' }
  ],
  tokenizer: {
    root: [
      [/[rRbBuUfF]{0,2}'''/, 'string', '@docstring'],
      [/[rRbBuUfF]{0,2}"""/, 'string', '@docstringD'],
      [/[rRbBuUfF]{0,2}'(?:\\.|[^'\\\n])*'/, 'string'],
      [/[rRbBuUfF]{0,2}"(?:\\.|[^"\\\n])*"/, 'string'],
      [/#.*$/, 'comment'],
      [/@[a-zA-Z_]\w*/, 'decorator'],
      [/\b(def)(\s+)([a-zA-Z_]\w*)/, ['keyword', 'white', 'function']],
      [/\b(class)(\s+)([a-zA-Z_]\w*)/, ['keyword', 'white', 'type']],
      [/(\.)([a-zA-Z_]\w*)/, ['delimiter', 'property']],
      [/\b[A-Z]\w*(?=\s*\()/, 'type'],
      [
        /\b[a-zA-Z_]\w*(?=\s*\()/,
        {
          cases: {
            '@keywords': 'keyword',
            '@builtins': 'builtin',
            '@default': 'function'
          }
        }
      ],
      [/\b[A-Z]\w*\b/, 'type'],
      [
        /[a-zA-Z_]\w*/,
        {
          cases: {
            '@keywords': 'keyword',
            '@builtins': 'builtin',
            '@default': 'identifier'
          }
        }
      ],
      [/\b0[xX][0-9a-fA-F_]+[lL]?/, 'number.hex'],
      [/\b0[bB][01_]+/, 'number.binary'],
      [/\b0[oO][0-7_]+/, 'number.octal'],
      [/\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+\-]?\d+)?[jJ]?/, 'number'],
      [/[{}()\[\]]/, '@brackets'],
      [/[,:;]/, 'delimiter'],
      [/[=><!~?:&|+\-*\/\^%@]+/, 'operator'],
      [/\s+/, 'white']
    ],
    docstring: [
      [/[^']+/, 'string'],
      [/'''/, 'string', '@pop'],
      [/'/, 'string']
    ],
    docstringD: [
      [/[^"]+/, 'string'],
      [/"""/, 'string', '@pop'],
      [/"/, 'string']
    ]
  }
}

monaco.languages.setMonarchTokensProvider('python', pythonLanguage)

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
typescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: false
})
typescript.javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: false
})
const compilerOptions = {
  allowNonTsExtensions: true,
  target: typescript.ScriptTarget.ESNext,
  module: typescript.ModuleKind.ESNext,
  moduleResolution: typescript.ModuleResolutionKind.NodeJs,
  jsx: typescript.JsxEmit.ReactJSX,
  allowJs: true
}
typescript.typescriptDefaults.setCompilerOptions(compilerOptions)
typescript.javascriptDefaults.setCompilerOptions(compilerOptions)
/*
 * 默认情况下 worker 只同步「被查询过」的 model。tsProject.ts 会为 import
 * 目标创建隐藏 model；不 eagerly 同步的话它们不会出现在
 * getScriptFileNames 里，跨文件跳转仍然找不到。
 */
typescript.typescriptDefaults.setEagerModelSync(true)
typescript.javascriptDefaults.setEagerModelSync(true)

/**
 * LSP 会话就绪后关掉 Monaco 自带的 TS worker provider。
 *
 * 两套语言服务同时开会让补全出现两份、跳转弹两个 peek；诊断也会在
 * 问题面板里重复。关掉 worker 后仍保留 tokenizer（语法高亮）和
 * 编辑器本身。没有找到 LSP 时再打开，回到原来的行为。
 */
export function setTsWorkerMode(enabled: boolean): void {
  const config = {
    completionItems: enabled,
    hovers: enabled,
    documentSymbols: enabled,
    definitions: enabled,
    references: enabled,
    documentHighlights: enabled,
    rename: enabled,
    diagnostics: enabled,
    documentRangeFormattingEdits: enabled,
    // 下面几项目前没有 LSP provider 映射。保留 worker 的能力，
    // 免得打开语言服务器之后，快速修复 / 签名提示反而消失。
    signatureHelp: true,
    onTypeFormattingEdits: true,
    codeActions: true,
    inlayHints: true
  }
  typescript.typescriptDefaults.setModeConfiguration(config)
  typescript.javascriptDefaults.setModeConfiguration(config)
}

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
  mts: 'typescript',
  cts: 'typescript',
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
  // 语义着色：变量 / 参数 / 属性各给一个颜色，否则 LSP 打开后仍然一大片白色
  const variable = light ? '1d4f91' : 'c8d3f5'
  const property = light ? '0f7b6c' : '7fdbca'
  const param = light ? '7a3e00' : 'e5c07b'

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
      { token: 'builtin', foreground: type },
      { token: 'identifier', foreground: fg.replace('#', '') },
      // LSP semantic tokens
      { token: 'namespace', foreground: type },
      { token: 'class', foreground: type },
      { token: 'enum', foreground: type },
      { token: 'interface', foreground: type },
      { token: 'struct', foreground: type },
      { token: 'typeParameter', foreground: type, fontStyle: 'italic' },
      { token: 'builtinType', foreground: type },
      { token: 'parameter', foreground: param },
      { token: 'variable', foreground: variable },
      { token: 'property', foreground: property },
      { token: 'enumMember', foreground: number },
      { token: 'event', foreground: type },
      { token: 'method', foreground: fn },
      { token: 'macro', foreground: number },
      { token: 'modifier', foreground: keyword },
      { token: 'regexp', foreground: string },
      { token: 'operator', foreground: dim.replace('#', '') },
      { token: 'decorator', foreground: keyword },
      { token: 'label', foreground: number },
      { token: 'selfKeyword', foreground: keyword },
      { token: 'selfTypeKeyword', foreground: keyword }
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
