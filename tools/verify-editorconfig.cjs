#!/usr/bin/env node
/**
 * .editorconfig 解析 / 匹配的单元检查。
 *
 * 直接跑编译后的 shared/editorconfig.ts；不启动 Electron。
 */
const assert = require('node:assert/strict')
const path = require('node:path')

const mod = require(path.join(__dirname, '..', '.tmp-build', 'editorconfig.cjs'))
const {
  parseEditorConfig,
  editorConfigGlobToRegExp,
  matchEditorConfig,
  resolveEditorConfig
} = mod

function match(glob, rel) {
  return editorConfigGlobToRegExp(glob).test(rel)
}

// ── glob ─────────────────────────────────────────────────
assert.equal(match('*.ts', 'a/b/c.ts'), true)
assert.equal(match('*.ts', 'a/b/c.tsx'), false)
assert.equal(match('src/*.ts', 'src/a.ts'), true)
assert.equal(match('src/*.ts', 'src/deep/a.ts'), false)
assert.equal(match('/src/*.ts', 'src/a.ts'), true)
assert.equal(match('**/*.ts', 'a.ts'), true)
assert.equal(match('**/*.ts', 'a/b/c.ts'), true)
assert.equal(match('src/**/*.ts', 'src/a.ts'), true)
assert.equal(match('src/**/*.ts', 'src/x/y/a.ts'), true)
assert.equal(match('*.{js,ts}', 'a/b.ts'), true)
assert.equal(match('*.{js,ts}', 'a/b.py'), false)
assert.equal(match('[abc].ts', 'b.ts'), true)
assert.equal(match('[!abc].ts', 'd.ts'), true)
assert.equal(match('[!abc].ts', 'a.ts'), false)

// ── parse ────────────────────────────────────────────────
const parsed = parseEditorConfig(`
root = true

# comment
[*]
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = false

[*.md]
trim_trailing_whitespace = false
`)
assert.equal(parsed.root, true)
assert.equal(parsed.sections.length, 2)
assert.equal(parsed.sections[0].properties.indentStyle, 'space')
assert.equal(parsed.sections[0].properties.indentSize, 2)
assert.equal(parsed.sections[0].properties.insertFinalNewline, true)
assert.equal(parsed.sections[0].properties.trimTrailingWhitespace, false)

// unset 覆盖前面的值
const unset = parseEditorConfig('[*]\nindent_size = 4\n[*.go]\nindent_size = unset\n')
assert.deepEqual(matchEditorConfig('x.go', unset.sections), {})

// indent_size = tab + tab_width
const tabs = parseEditorConfig('[*]\nindent_style = tab\nindent_size = tab\ntab_width = 8\n')
assert.deepEqual(matchEditorConfig('a.py', tabs.sections), {
  indentStyle: 'tab',
  indentSize: 'tab',
  tabWidth: 8
})

// ── resolve：根目录先应用，靠近文件的覆盖 ───────────────
const merged = resolveEditorConfig('src/deep/a.ts', [
  {
    dirRel: '',
    text: '[*]\nindent_size = 2\nend_of_line = lf\n[*.ts]\ntrim_trailing_whitespace = true\n'
  },
  {
    dirRel: 'src',
    text: '[*.ts]\nindent_size = 4\n'
  }
])
assert.equal(merged.indentSize, 4)
assert.equal(merged.endOfLine, 'lf')
assert.equal(merged.trimTrailingWhitespace, true)

// 不同目录的同名 pattern 不串味
const scoped = resolveEditorConfig('docs/a.ts', [
  { dirRel: 'src', text: '[*.ts]\nindent_size = 8\n' }
])
assert.deepEqual(scoped, {})

console.log('verify-editorconfig: ok')
