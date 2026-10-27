import * as YAML from 'yaml'
import type { SkillFrontmatter, SkillInput } from '../../shared/skills'

/**
 * SKILL.md 的 frontmatter 解析与生成。
 *
 * 解析一律容错：YAML 坏了不阻止技能出现在列表里，只挂一条告警；
 * 写回时只覆盖已知字段，其余字段原样保留。
 */

export interface ParsedSkillFile {
  frontmatter: SkillFrontmatter
  body: string
}

function textOf(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

function toolsOf(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v
      .map((x) => textOf(x).trim())
      .filter(Boolean)
      .slice(0, 64)
  }
  const text = textOf(v)
  if (!text.trim()) return []
  // 两种写法都见过：YAML 列表，以及逗号分隔的字符串
  return text
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 64)
}

function emptyFrontmatter(): SkillFrontmatter {
  return {
    present: false,
    name: '',
    description: '',
    allowedTools: [],
    argumentHint: '',
    model: '',
    version: '',
    extras: {},
    error: ''
  }
}

/** 找出文件开头的 `---` 块；没有就整份当正文 */
function splitBlock(text: string): { yaml: string; body: string } | null {
  const normalized = text.replace(/^﻿/, '')
  if (!normalized.startsWith('---')) return null
  const firstEnd = normalized.indexOf('\n')
  if (firstEnd < 0) return null
  // 第一行必须只有 ---（允许尾随空白）
  if (normalized.slice(0, firstEnd).trim() !== '---') return null

  const rest = normalized.slice(firstEnd + 1)
  const lines = rest.split('\n')
  let offset = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '---' || trimmed === '...') {
      const bodyStart = offset + line.length + 1
      return { yaml: rest.slice(0, offset), body: rest.slice(bodyStart) }
    }
    offset += line.length + 1
  }
  return null
}

export function parseSkillFile(text: string): ParsedSkillFile {
  const split = splitBlock(text)
  if (!split) {
    return { frontmatter: emptyFrontmatter(), body: text.replace(/^﻿/, '') }
  }

  const fm = emptyFrontmatter()
  fm.present = true
  try {
    const parsed = YAML.parse(split.yaml, { maxAliasCount: 100 })
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const o = parsed as Record<string, unknown>
      for (const [key, value] of Object.entries(o)) {
        switch (key) {
          case 'name':
            fm.name = textOf(value).trim()
            break
          case 'description':
            fm.description = textOf(value).trim()
            break
          case 'allowed-tools':
          case 'allowedTools':
            fm.allowedTools = toolsOf(value)
            break
          case 'argument-hint':
          case 'argumentHint':
            fm.argumentHint = textOf(value).trim()
            break
          case 'model':
            fm.model = textOf(value).trim()
            break
          case 'version':
            fm.version = textOf(value).trim()
            break
          default:
            fm.extras[key] = value
            break
        }
      }
    } else if (parsed != null) {
      fm.error = 'frontmatter is not a mapping'
    }
  } catch (e) {
    fm.error = e instanceof Error ? e.message : String(e)
  }

  return { frontmatter: fm, body: split.body.replace(/^\r?\n/, '') }
}

export interface ComposeOptions {
  /** 保留旧文件里的未知字段 */
  extra?: Record<string, unknown>
  /** Codex 没有 frontmatter */
  frontmatter?: boolean
}

/**
 * 生成 SKILL.md。
 *
 * `allowed-tools` 写成逗号分隔字符串 —— Claude Code 文档里的写法；
 * YAML 解析器会把它当普通字符串，读回来时再拆开。
 */
export function composeSkillFile(input: SkillInput, opts: ComposeOptions = {}): string {
  if (opts.frontmatter === false) {
    return input.body.trimEnd() + '\n'
  }

  const fields: Record<string, unknown> = {
    name: input.name.trim(),
    description: input.description.trim()
  }
  const tools = input.allowedTools.map((x) => x.trim()).filter(Boolean)
  if (tools.length) fields['allowed-tools'] = tools.join(', ')
  if (input.argumentHint.trim()) fields['argument-hint'] = input.argumentHint.trim()
  if (input.model.trim()) fields.model = input.model.trim()

  for (const [key, value] of Object.entries(opts.extra ?? {})) {
    if (key in fields) continue
    if (key === 'name' || key === 'description') continue
    fields[key] = value
  }

  const yaml = YAML.stringify(fields, { lineWidth: 0 }).trimEnd()
  const body = input.body.replace(/\r\n/g, '\n').trim()
  return `---\n${yaml}\n---\n\n${body}${body ? '\n' : ''}`
}

/**
 * Codex 提示词没有 frontmatter，展示用的描述取正文第一段。
 * 去掉标题标记与行内代码标记，避免列表里出现 `#`。
 */
export function deriveDescription(body: string): string {
  let inComment = false
  for (const raw of body.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = raw.trim()
    // 没写 frontmatter 的技能常见做法是用 HTML 注释放来源信息；
    // 那行不是给人看的描述，跳过整段注释。
    if (inComment) {
      if (trimmed.includes('-->')) inComment = false
      continue
    }
    if (trimmed.startsWith('<!--')) {
      if (!trimmed.includes('-->')) inComment = true
      continue
    }
    const line = raw
      .replace(/^\s{0,3}#{1,6}\s*/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/[`*_>]/g, '')
      .trim()
    if (!line) continue
    if (line === '---') continue
    return line.slice(0, 160)
  }
  return ''
}
