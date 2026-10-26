#!/usr/bin/env node
'use strict'

/**
 * 检查可用于打包的 rg 二进制。
 *
 * 依次尝试：build/rg → @vscode/ripgrep 平台包 → PATH。
 * 输出版本与 PCRE2 支持情况；找不到时以非零码退出。
 */

const { existsSync } = require('node:fs')
const { dirname, join } = require('node:path')
const { execFileSync } = require('node:child_process')

const exe = process.platform === 'win32' ? 'rg.exe' : 'rg'
const pkg = `@vscode/ripgrep-${process.platform}-${process.arch}`

function packageDir() {
  try {
    return dirname(require.resolve(`${pkg}/package.json`, { paths: [process.cwd()] }))
  } catch {
    return join(process.cwd(), 'node_modules', '@vscode', `ripgrep-${process.platform}-${process.arch}`)
  }
}

const candidates = [
  join(process.cwd(), 'build', 'rg', exe),
  join(packageDir(), 'bin', exe),
  join(process.cwd(), 'node_modules', '@vscode', 'ripgrep', 'bin', exe),
  exe
]

for (const candidate of candidates) {
  if (candidate !== exe && !existsSync(candidate)) continue
  try {
    const out = execFileSync(candidate, ['--version'], { encoding: 'utf8' }).trim()
    console.log(`[check-rg] ${candidate}\n${out}`)
    if (!/\+pcre2/.test(out)) {
      console.warn('[check-rg] 警告：该 rg 构建不含 PCRE2，全字匹配会回退内置搜索。')
    }
    process.exit(0)
  } catch (err) {
    // 继续尝试下一个候选
  }
}

console.error(
  '[check-rg] 找不到可执行的 rg。\n' +
    '请执行 npm install 安装 @vscode/ripgrep，或通过 CCODER_RG_PATH 指定。'
)
process.exit(1)
