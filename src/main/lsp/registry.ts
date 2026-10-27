import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * 已知语言服务器 + 探测。
 *
 * 不内置任何服务器二进制：用户装在哪就探测哪 —— 项目 `node_modules`
 * 优先（版本跟项目走），其次 PATH。找不到时渲染层会收到 not-found，
 * Monaco 自带的 TS worker 继续兜底，功能不会因此消失。
 *
 * TypeScript 有两条路：`typescript-language-server`（标准 LSP 包装）
 * 或项目自己的 `node_modules/.bin`。两者都找不到时不会去猜 tsserver
 * 的私有协议 —— 那会把「LSP 宿主」变成单一语言的适配器。
 */

export interface ServerDef {
  /** 同一类服务器共用 id，例如 TS / JS 都归 typescript */
  id: string
  /** 展示名，也是 PATH 上的命令名 */
  name: string
  /** Monaco 语言 id；一个服务器可以服务多种语言 */
  languages: string[]
  args: string[]
  /** 工作区内的 Node 入口（相对路径）；用 Electron 自带 Node 启动 */
  localNode?: string[]
}

export interface DetectedServer {
  id: string
  name: string
  /** 这个服务器能处理的 Monaco 语言 id */
  languages: string[]
  /** 实际启动的文件；可能是 PATH 里的命令，也可能是项目内的绝对路径 */
  file: string
  args: string[]
  /** 用 ELECTRON_RUN_AS_NODE 启动 */
  node: boolean
  /** Windows 的 .cmd / .bat 需要经过 cmd.exe */
  shell: boolean
}

const DEFS: ServerDef[] = [
  {
    id: 'typescript',
    name: 'typescript-language-server',
    languages: ['typescript', 'javascript'],
    args: ['--stdio'],
    localNode: [
      'node_modules/typescript-language-server/lib/cli.mjs',
      'node_modules/typescript-language-server/lib/cli.js'
    ]
  },
  {
    id: 'pyright',
    name: 'pyright-langserver',
    languages: ['python'],
    args: ['--stdio']
  },
  {
    id: 'pylsp',
    name: 'pylsp',
    languages: ['python'],
    args: []
  },
  {
    id: 'gopls',
    name: 'gopls',
    languages: ['go'],
    args: []
  },
  {
    id: 'rust-analyzer',
    name: 'rust-analyzer',
    languages: ['rust'],
    args: []
  },
  {
    id: 'clangd',
    name: 'clangd',
    languages: ['c', 'cpp'],
    args: []
  },
  {
    id: 'yaml',
    name: 'yaml-language-server',
    languages: ['yaml'],
    args: ['--stdio']
  },
  {
    id: 'bash',
    name: 'bash-language-server',
    languages: ['shell'],
    args: ['start']
  },
  {
    id: 'lua',
    name: 'lua-language-server',
    languages: ['lua'],
    args: []
  }
]

/** 这个 Monaco 语言有没有已知服务器定义（不代表一定装了） */
export function hasServerDefinition(language: string): boolean {
  return DEFS.some((d) => d.languages.includes(language))
}

export function serversFor(language: string): ServerDef[] {
  return DEFS.filter((d) => d.languages.includes(language))
}

function pathDirs(): string[] {
  const raw = process.env.PATH || process.env.Path || ''
  return raw.split(delimiter).filter(Boolean)
}

function executableNames(name: string): string[] {
  if (process.platform !== 'win32') return [name]
  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean)
  return [name, ...exts.map((ext) => `${name}${ext.toLowerCase()}`)]
}

/** 在 PATH 上找命令；找不到返回 null。 */
function findOnPath(name: string): string | null {
  const names = executableNames(name)
  for (const dir of pathDirs()) {
    for (const candidate of names) {
      const full = join(dir, candidate)
      if (existsSync(full)) return full
    }
  }
  return null
}

function isShellScript(file: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)
}

function detected(def: ServerDef, file: string, node: boolean): DetectedServer {
  return {
    id: def.id,
    name: def.name,
    languages: def.languages,
    file,
    args: def.args,
    node,
    shell: !node && isShellScript(file)
  }
}

/**
 * 按优先级探测：
 *   1. TypeScript：项目 node_modules 里的 Node 入口（版本跟项目一致）
 *   2. PATH
 *
 * 刻意**不**扫描项目里的 `node_modules/.bin`：那等于让工作区自带一个
 * 同名可执行文件就能在打开文件时被自动拉起。TypeScript 是唯一例外 ——
 * 它本来就是项目依赖的一部分；其他语言请装到 PATH。
 */
export function detectServer(def: ServerDef, cwd: string): DetectedServer | null {
  for (const rel of def.localNode ?? []) {
    const full = join(cwd, rel)
    if (existsSync(full)) return detected(def, full, true)
  }

  const global = findOnPath(def.name)
  if (global) return detected(def, global, false)

  return null
}
