import type { IdeCodeRef } from '@shared/ide-chat'
import type { IdeTextFile } from '@shared/ide'
import { baseName } from '@shared/path'

/** 超过这个行数就提示用户选「前 500 行」或「整文件」 */
export const MAX_REF_LINES = 500

/** IDE 的语言标签 → Markdown 围栏语言 */
const FENCE: Record<string, string> = {
  TypeScript: 'ts',
  'TypeScript React': 'tsx',
  JavaScript: 'js',
  'JavaScript React': 'jsx',
  JSON: 'json',
  CSS: 'css',
  SCSS: 'scss',
  LESS: 'less',
  HTML: 'html',
  Markdown: 'md',
  Python: 'py',
  Lua: 'lua',
  Rust: 'rs',
  Go: 'go',
  Java: 'java',
  C: 'c',
  'C++': 'cpp',
  'C#': 'cs',
  Shell: 'bash',
  PowerShell: 'powershell',
  YAML: 'yaml',
  TOML: 'toml',
  SQL: 'sql',
  XML: 'xml',
  Vue: 'vue',
  Svelte: 'svelte',
  Dockerfile: 'dockerfile',
  Makefile: 'makefile',
  Text: 'text'
}

export function fenceLang(language: string, rel: string): string {
  const hit = FENCE[language]
  if (hit) return hit
  const ext = rel.split('.').pop()?.toLowerCase() ?? ''
  return /^[a-z0-9+#-]+$/.test(ext) ? ext : 'text'
}

function newId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function buildIdeRef(
  file: Pick<IdeTextFile, 'rel' | 'text' | 'language' | 'truncated'>,
  cwd: string,
  kind: IdeCodeRef['kind'],
  code: string,
  startLine?: number,
  endLine?: number
): IdeCodeRef {
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  return {
    id: newId(),
    kind,
    rel: file.rel,
    path: root ? `${root}/${file.rel}` : file.rel,
    name: baseName(file.rel),
    ...(kind === 'selection' ? { startLine, endLine } : {}),
    lang: fenceLang(file.language, file.rel),
    code: code.replace(/\r\n?/g, '\n'),
    totalLines: file.text.split('\n').length,
    ...(file.truncated ? { truncated: true } : {}),
    cwd
  }
}
