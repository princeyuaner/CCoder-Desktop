#!/usr/bin/env node
'use strict'

/**
 * 把 @vscode/ripgrep 的平台二进制复制到 build/rg/，供 electron-builder
 * 通过 extraResources 打进 resources/bin/。
 *
 * 用法：
 *   node tools/stage-rg.cjs [--platform win32] [--arch x64]
 *
 * @vscode/ripgrep 1.18 把二进制放在平台可选依赖包里：
 *   node_modules/@vscode/ripgrep-<platform>-<arch>/bin/rg(.exe)
 * npm 只会安装当前平台的包；跨平台打包时需在目标平台安装或在 CI 上装好对应包。
 */

const { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } = require('node:fs')
const { dirname, join } = require('node:path')

function argValue(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const platform = argValue('platform', process.platform)
const arch = argValue('arch', process.arch)
const exe = platform === 'win32' ? 'rg.exe' : 'rg'
const pkg = `@vscode/ripgrep-${platform}-${arch}`

function resolvePackageDir() {
  try {
    return dirname(require.resolve(`${pkg}/package.json`, { paths: [process.cwd()] }))
  } catch {
    // package.json 有时不会被 exports 暴露；退回约定路径
    return join(process.cwd(), 'node_modules', '@vscode', `ripgrep-${platform}-${arch}`)
  }
}

const pkgDir = resolvePackageDir()
const src = join(pkgDir, 'bin', exe)
if (!existsSync(src) || !statSync(src).isFile()) {
  console.error(
    `[stage-rg] 找不到 ${pkg} 的二进制：${src}\n` +
      `请先在目标平台执行 npm install，或安装 ${pkg}@1.18.0。`
  )
  process.exit(1)
}

const outDir = join(process.cwd(), 'build', 'rg')
mkdirSync(outDir, { recursive: true })

// 切换平台时清掉上一次的二进制，避免 resources/bin 里同时出现 rg 和 rg.exe
for (const name of readdirSync(outDir)) {
  if (name === 'rg' || name === 'rg.exe') rmSync(join(outDir, name), { force: true })
}

const dest = join(outDir, exe)
copyFileSync(src, dest)
if (platform !== 'win32') {
  try {
    require('node:fs').chmodSync(dest, 0o755)
  } catch {
    // 某些文件系统不支持 chmod；打包时仍可执行
  }
}

const license = join(pkgDir, 'LICENSE')
if (existsSync(license)) copyFileSync(license, join(outDir, 'LICENSE'))

console.log(
  `[stage-rg] ${exe} -> ${dest} (${(statSync(dest).size / 1024 / 1024).toFixed(1)} MB)`
)
