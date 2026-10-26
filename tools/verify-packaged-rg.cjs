#!/usr/bin/env node
'use strict'

/**
 * 打包后检查 rg 是否被放进 resources/bin 并且可执行。
 * 先运行 `npm run package`，再执行本脚本。
 */

const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')

const root = join(__dirname, '..')
const candidates = [
  join(root, 'release', 'win-unpacked', 'resources', 'bin', 'rg.exe'),
  join(root, 'release', 'win-unpacked', 'resources', 'bin', 'rg')
]

const found = candidates.find((p) => existsSync(p))
if (!found) {
  console.error('[verify-packaged-rg] 没找到 release/win-unpacked/resources/bin/rg(.exe)')
  process.exit(1)
}

try {
  const out = execFileSync(found, ['--version'], { encoding: 'utf8' }).trim()
  console.log(`[verify-packaged-rg] ${found}\n${out}`)
} catch (err) {
  console.error(`[verify-packaged-rg] 无法执行：${err instanceof Error ? err.message : err}`)
  process.exit(1)
}
