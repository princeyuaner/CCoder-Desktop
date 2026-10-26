/**
 * 工作区忽略规则 —— 纯 Node，不 import Electron。
 *
 * 文件树、快速打开、rg 结果过滤和 Node 回退扫描共用同一份表。rg 自己会
 * 遵循 `.gitignore`，这里只是额外兜住生成目录和敏感文件。
 */

export const WORKSPACE_IGNORE_DIRS: ReadonlySet<string> = new Set([
  // JS / TS
  'node_modules',
  'bower_components',
  'jspm_packages',
  '.pnpm-store',
  // 构建产物
  'out',
  'dist',
  'build',
  'release',
  'coverage',
  'htmlcov',
  'storybook-static',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.angular',
  '.expo',
  '.vercel',
  '.netlify',
  '.serverless',
  '.aws-sam',
  '.cache',
  '.turbo',
  '.parcel-cache',
  // 各语言 / 工具链
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.nox',
  '.hypothesis',
  '.ipynb_checkpoints',
  '.gradle',
  '.kotlin',
  '.dart_tool',
  '.stack-work',
  'Pods',
  'DerivedData',
  '.terraform',
  '.terragrunt-cache',
  // 版本控制元数据：文件树、快速打开、代码搜索都不应该进去
  '.git',
  '.svn',
  '_svn',
  '.hg',
  '.bzr',
  'CVS',
  '.jj',
  '_darcs',
  // 编辑器 / 工具目录
  '.claude',
  '.idea',
  '.vscode',
  '.vs',
  '.settings',
  '.fleet',
  '.history',
  'logs',
  // 本地临时目录（含本仓库的 .tmp-build / .buildtmp）
  '.tmp',
  '.tmp-build',
  '.buildtmp'
])

const IGNORE_DIRS_LOWER = new Set([...WORKSPACE_IGNORE_DIRS].map((d) => d.toLowerCase()))

/** 生成目录的额外模式：名字带后缀，无法用固定集合表达 */
const IGNORE_DIR_PATTERNS = [/\.egg-info$/i, /\.dist-info$/i]

// 统一小写比较：Windows 文件系统本身不区分大小写，POSIX 上多忽略几个
// 大小写变体也不会造成实际问题。
const IGNORE_FILES = new Set(
  [
    '.DS_Store',
    'Thumbs.db',
    'ehthumbs.db',
    'desktop.ini',
    '.npmrc',
    '.netrc',
    '.pypirc'
  ].map((f) => f.toLowerCase())
)

const IGNORE_FILE_PATTERNS = [
  /^\.env(\.|$)/i,
  /\.(log|pem|p12|pfx|key|p8|jks|keystore)$/i,
  /^id_(rsa|ed25519|ecdsa)(\.|$)/i
]

/**
 * 传给 rg 的排除 glob。JS 侧仍会再过滤一遍，这里只是让 rg 不要浪费 I/O
 * 去扫描 node_modules / 构建产物 / 敏感文件。
 */
export const WORKSPACE_IGNORE_GLOBS: readonly string[] = [
  ...[...WORKSPACE_IGNORE_DIRS].map((dir) => `!**/${dir}/**`),
  '!**/*.egg-info/**',
  '!**/*.dist-info/**',
  '!**/.env*',
  '!**/*.log',
  '!**/*.pem',
  '!**/*.p12',
  '!**/*.pfx',
  '!**/*.key',
  '!**/*.p8',
  '!**/*.jks',
  '!**/*.keystore',
  '!**/desktop.ini',
  '!**/ehthumbs.db',
  '!**/.pypirc',
  '!**/id_rsa*',
  '!**/id_ed25519*',
  '!**/id_ecdsa*',
  '!**/.DS_Store',
  '!**/Thumbs.db',
  '!**/.npmrc',
  '!**/.netrc',
  '!tools/_*.cjs'
]

/** 单个目录名是否属于固定忽略项（文件树 / watcher / 搜索共用） */
export function isIgnoredDirName(name: string): boolean {
  const key = process.platform === 'win32' ? name.toLowerCase() : name
  if (WORKSPACE_IGNORE_DIRS.has(key)) return true
  if (process.platform === 'win32' && IGNORE_DIRS_LOWER.has(key)) return true
  return IGNORE_DIR_PATTERNS.some((re) => re.test(name))
}

/** 文件名 / 工作区相对路径是否属于固定忽略项 */
export function isIgnoredFile(name: string, rel: string): boolean {
  if (IGNORE_FILES.has(name.toLowerCase())) return true
  if (IGNORE_FILE_PATTERNS.some((re) => re.test(name))) return true
  // verify 脚本 esbuild 出来的临时 bundle，体积大且没检索价值
  if (rel.startsWith('tools/_') && rel.endsWith('.cjs')) return true
  return false
}

/** 工作区相对 POSIX 路径是否应该被跳过（目录段或文件名命中） */
export function isIgnoredWorkspacePath(rel: string): boolean {
  const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!norm || norm === '.') return false
  const parts = norm.split('/').filter(Boolean)
  if (parts.length === 0) return false
  for (const part of parts) {
    if (isIgnoredDirName(part)) return true
  }
  return isIgnoredFile(parts[parts.length - 1], norm)
}
