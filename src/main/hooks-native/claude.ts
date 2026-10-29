import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import * as jsonc from 'jsonc-parser/lib/esm/main'
import {
  HOOK_EVENT_IDS,
  HOOK_KNOWN_KEYS,
  coerceHookEntry,
  isHookEvent,
  isHookType,
  isWritableHookScope,
  validateHookInput,
  type HookEntry,
  type HookEvent,
  type HookInput,
  type HookListResult,
  type HookMutationResult,
  type HookReadOnlyReason,
  type HookScope,
  type HookSourceFile,
  type HookView,
  type HookWritableScope,
  type UnknownHook
} from '../../shared/hooks'
import { NativeParseError, isWritable, readTextFile, withTextFile } from '../mcp-native/fs'
import { pathKey } from '../path-key'
import type { DisabledHook, HookNativeContext, HookReadResult, LocatedHook } from './types'

/**
 * Claude Code Hooks 的原生配置读写。
 *
 * settings.json 用 JSONC 解析；写回只替换顶层 `hooks`，保留文件里其它字段
 * 和注释。禁用不是写 `enabled:false`（CLI 不认），而是真正从数组里移除，
 * 再把完整条目存进 userData/hooks-disabled.json；启用时按指纹写回。
 */

type Json = Record<string, unknown>

interface HookDoc extends Json {
  hooks?: unknown
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function parseDoc(text: string, file: string): HookDoc {
  const errors: jsonc.ParseError[] = []
  const doc = jsonc.parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length) {
    const e = errors[0]
    throw new NativeParseError(
      'hook.error.parseFailed',
      `${file}: ${jsonc.printParseErrorCode(e.error)} @ ${e.offset}`
    )
  }
  const out = asRecord(doc) ?? {}
  if (out.hooks !== undefined && !asRecord(out.hooks)) {
    throw new NativeParseError('hook.error.parseFailed', `${file}: "hooks" 必须是对象`)
  }
  return out
}

function applyModify(text: string, path: jsonc.JSONPath, value: unknown): string {
  const edits = jsonc.modify(text, path, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2 }
  })
  return jsonc.applyEdits(text, edits)
}

export function settingsPath(
  ctx: HookNativeContext,
  scope: HookWritableScope,
  cwd: string
): string {
  if (scope === 'user') return join(ctx.claudeDir, 'settings.json')
  return join(cwd, '.claude', scope === 'project' ? 'settings.json' : 'settings.local.json')
}

/** 稳定 JSON：键排序、忽略 undefined，保证同一份 Hook 每次指纹一致 */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

export function fingerprintOf(
  scope: HookScope,
  cwd: string,
  event: string,
  matcher: string,
  hook: HookEntry,
  sourceFile = ''
): string {
  const workspace = scope === 'user' || scope === 'plugin' ? '' : pathKey(cwd)
  const pluginFile = scope === 'plugin' ? pathKey(sourceFile) : ''
  return createHash('sha1')
    .update([scope, workspace, event, matcher, pluginFile, stableJson(hook)].join('\0'), 'utf8')
    .digest('hex')
}

function readHook(
  raw: unknown
): { hook: HookEntry; readOnlyReason: HookReadOnlyReason | null } | null {
  const o = asRecord(raw)
  if (!o || typeof o.type !== 'string' || !o.type) return null
  if (!isHookType(o.type)) {
    return { hook: o as unknown as UnknownHook, readOnlyReason: 'unsupported' }
  }
  // 已知类型但字段缺失 / 类型不对的条目不让编辑，避免把坏配置写得更坏
  const valid = (() => {
    if (o.type === 'command') return typeof o.command === 'string' && o.command.trim().length > 0
    if (o.type === 'prompt' || o.type === 'agent') {
      return typeof o.prompt === 'string' && o.prompt.trim().length > 0
    }
    if (o.type === 'http') return typeof o.url === 'string' && /^https?:\/\//i.test(o.url)
    if (o.type === 'mcp_tool') {
      return typeof o.server === 'string' && typeof o.tool === 'string'
    }
    return true
  })()
  return { hook: o as unknown as HookEntry, readOnlyReason: valid ? null : 'unsupported' }
}

function readFileLocated(
  file: string,
  scope: HookScope,
  cwd: string,
  readOnly: boolean,
  pluginName?: string
): HookReadResult {
  const r = readTextFile(file)
  if (!r.ok) {
    return { hooks: [], error: `${r.errorKey}: ${r.detail}`, exists: false }
  }
  if (!r.file.exists) return { hooks: [], exists: false }

  let doc: HookDoc
  try {
    doc = parseDoc(r.file.text, file)
  } catch (e) {
    return {
      hooks: [],
      error: e instanceof Error ? e.message : String(e),
      exists: true
    }
  }

  const root = asRecord(doc.hooks)
  if (!root) return { hooks: [], exists: true }

  const out: LocatedHook[] = []
  for (const [event, matcherList] of Object.entries(root)) {
    if (!isHookEvent(event) || !Array.isArray(matcherList)) continue
    matcherList.forEach((matcherRaw, matcherIndex) => {
      const m = asRecord(matcherRaw)
      if (!m) return
      const matcher = typeof m.matcher === 'string' ? m.matcher : ''
      const entries = Array.isArray(m.hooks) ? m.hooks : []
      entries.forEach((entryRaw, hookIndex) => {
        const parsed = readHook(entryRaw)
        if (!parsed) return
        const id = fingerprintOf(scope, cwd, event, matcher, parsed.hook, scope === 'plugin' ? file : '')
        const view: HookView = {
          id,
          scope,
          event,
          matcher,
          hook: parsed.hook,
          enabled: true,
          readOnly: readOnly || parsed.readOnlyReason !== null,
          readOnlyReason: readOnly ? 'plugin' : parsed.readOnlyReason,
          ...(pluginName ? { pluginName } : {}),
          sourceFile: file,
          cwd: scope === 'user' || scope === 'plugin' ? '' : cwd
        }
        out.push({ view, file, matcherIndex, hookIndex })
      })
    })
  }
  return { hooks: out, exists: true }
}

/** 插件 Hook：installed_plugins.json + `plugins/*\/hooks/hooks.json` */
function pluginHookFiles(ctx: HookNativeContext): { file: string; pluginName: string }[] {
  const out: { file: string; pluginName: string }[] = []
  const seen = new Set<string>()
  const add = (file: string, pluginName: string): void => {
    const key = pathKey(file)
    if (seen.has(key) || !safeExists(file)) return
    seen.add(key)
    out.push({ file, pluginName })
  }

  const installed = join(ctx.claudeDir, 'plugins', 'installed_plugins.json')
  const r = readTextFile(installed)
  if (r.ok && r.file.exists) {
    try {
      const doc = JSON.parse(r.file.text) as Json
      const plugins = asRecord(doc.plugins)
      if (plugins) {
        for (const [key, value] of Object.entries(plugins)) {
          if (!Array.isArray(value)) continue
          const name = key.split('@')[0] || key
          for (const inst of value) {
            const installPath = asRecord(inst)?.installPath
            if (typeof installPath === 'string' && installPath.trim()) {
              add(join(installPath, 'hooks', 'hooks.json'), name)
            }
          }
        }
      }
    } catch {
      // 插件索引坏了不影响用户 / 项目 Hook
    }
  }

  try {
    const base = join(ctx.claudeDir, 'plugins')
    for (const ent of readdirSync(base, { withFileTypes: true })) {
      if (!ent.isDirectory() || ['cache', 'marketplaces', 'data'].includes(ent.name)) continue
      add(join(base, ent.name, 'hooks', 'hooks.json'), ent.name)
    }
  } catch {
    // plugins 目录不存在
  }

  return out.slice(0, 200)
}

function safeExists(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

function sourceOf(
  scope: HookScope,
  file: string,
  read: HookReadResult,
  writable: boolean
): HookSourceFile {
  return {
    scope,
    path: file,
    exists: read.exists,
    writable: writable && isWritable(file),
    count: read.hooks.length,
    ...(read.error ? { error: read.error } : {})
  }
}

/* ── 禁用注册表 ─────────────────────────────────────────── */

export function readDisabled(ctx: HookNativeContext): DisabledHook[] {
  const r = readTextFile(ctx.disabledPath)
  if (!r.ok || !r.file.exists) return []
  try {
    const doc = JSON.parse(r.file.text) as { entries?: unknown }
    const list = Array.isArray(doc.entries) ? doc.entries : []
    const out: DisabledHook[] = []
    for (const raw of list) {
      const o = asRecord(raw)
      if (!o) continue
      if (!isWritableHookScope(o.scope) || !isHookEvent(o.event)) continue
      const hook = asRecord(o.hook)
      if (!hook) continue
      const scope = o.scope
      const event = o.event
      const matcher = typeof o.matcher === 'string' ? o.matcher : ''
      const cwd = typeof o.cwd === 'string' ? o.cwd : ''
      const hookEntry = hook as unknown as HookEntry
      out.push({
        id: fingerprintOf(scope, cwd, event, matcher, hookEntry),
        scope,
        event,
        matcher,
        hook: hookEntry,
        sourceFile: typeof o.sourceFile === 'string' ? o.sourceFile : '',
        cwd,
        disabledAt: typeof o.disabledAt === 'number' ? o.disabledAt : 0
      })
    }
    return out
  } catch {
    return []
  }
}

function writeDisabled(
  ctx: HookNativeContext,
  entries: DisabledHook[]
): { ok: boolean; errorKey?: string; detail?: string } {
  try {
    mkdirSync(dirname(ctx.disabledPath), { recursive: true })
    const data = JSON.stringify({ v: 1, entries }, null, 2)
    const tmp = `${ctx.disabledPath}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 })
    try {
      renameSync(tmp, ctx.disabledPath)
    } catch {
      try {
        unlinkSync(ctx.disabledPath)
      } catch {
        // 目标不存在
      }
      renameSync(tmp, ctx.disabledPath)
    }
    return { ok: true }
  } catch (e) {
    return {
      ok: false,
      errorKey: 'hook.error.registryWrite',
      detail: e instanceof Error ? e.message : String(e)
    }
  }
}

function disabledView(entry: DisabledHook): HookView {
  return {
    id: entry.id,
    scope: entry.scope,
    event: entry.event,
    matcher: entry.matcher,
    hook: entry.hook,
    enabled: false,
    readOnly: false,
    readOnlyReason: null,
    sourceFile: entry.sourceFile,
    cwd: entry.scope === 'user' ? '' : entry.cwd,
    disabled: true
  }
}

function visibleDisabled(entry: DisabledHook, cwd: string): boolean {
  if (entry.scope === 'user') return true
  if (!cwd.trim()) return false
  return pathKey(entry.cwd) === pathKey(cwd)
}

/* ── 读 ─────────────────────────────────────────────────── */

const EVENT_ORDER = new Map<string, number>(
  HOOK_EVENT_IDS.map((id, i) => [id, i])
)
const SCOPE_ORDER: Record<HookScope, number> = { user: 0, project: 1, local: 2, plugin: 3 }

function compareViews(a: HookView, b: HookView): number {
  const ae = EVENT_ORDER.get(a.event as string) ?? 999
  const be = EVENT_ORDER.get(b.event as string) ?? 999
  if (ae !== be) return ae - be
  if (SCOPE_ORDER[a.scope] !== SCOPE_ORDER[b.scope]) {
    return SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]
  }
  if (a.matcher !== b.matcher) return a.matcher.localeCompare(b.matcher)
  return a.id.localeCompare(b.id)
}

export function listHooksNative(cwd: string, ctx: HookNativeContext): HookListResult {
  const sources: HookSourceFile[] = []
  const located: LocatedHook[] = []

  const userFile = settingsPath(ctx, 'user', '')
  const user = readFileLocated(userFile, 'user', '', false)
  located.push(...user.hooks)
  sources.push(sourceOf('user', userFile, user, true))

  if (cwd.trim()) {
    const projectFile = settingsPath(ctx, 'project', cwd)
    const project = readFileLocated(projectFile, 'project', cwd, false)
    located.push(...project.hooks)
    sources.push(sourceOf('project', projectFile, project, true))

    const localFile = settingsPath(ctx, 'local', cwd)
    const local = readFileLocated(localFile, 'local', cwd, false)
    located.push(...local.hooks)
    sources.push(sourceOf('local', localFile, local, true))
  }

  for (const { file, pluginName } of pluginHookFiles(ctx)) {
    const read = readFileLocated(file, 'plugin', '', true, pluginName)
    located.push(...read.hooks)
    sources.push({
      scope: 'plugin',
      path: file,
      exists: read.exists,
      writable: false,
      count: read.hooks.length,
      ...(read.error ? { error: read.error } : {})
    })
  }

  const enabledIds = new Set(located.map((x) => x.view.id))
  const disabled = readDisabled(ctx).filter(
    (e) => visibleDisabled(e, cwd) && !enabledIds.has(e.id)
  )

  const hooks = [...located.map((x) => x.view), ...disabled.map(disabledView)]
  hooks.sort(compareViews)

  return {
    cwd,
    hooks,
    sources,
    disabledCount: disabled.length,
    scannedAt: Date.now()
  }
}

/* ── 写 ─────────────────────────────────────────────────── */

function errorKeyOf(key: string | undefined): string | undefined {
  if (!key) return undefined
  return key.startsWith('mcp.error.') ? `hook.error.${key.slice('mcp.error.'.length)}` : key
}

function ok(list: HookListResult): HookMutationResult {
  return { ok: true, list }
}

function fail(
  errorKey: string,
  list: HookListResult,
  detail?: string
): HookMutationResult {
  return { ok: false, errorKey, ...(detail ? { detail } : {}), list }
}

function mergeHook(existing: HookEntry, incoming: HookEntry): HookEntry {
  if (existing.type !== incoming.type) return incoming
  const next: Record<string, unknown> = {
    ...(existing as unknown as Record<string, unknown>)
  }
  for (const key of HOOK_KNOWN_KEYS) delete next[key]
  Object.assign(next, incoming as unknown as Record<string, unknown>)
  return next as unknown as HookEntry
}

function removeFromDoc(
  doc: HookDoc,
  event: string,
  matcherIndex: number,
  hookIndex: number
): boolean {
  const root = asRecord(doc.hooks)
  if (!root) return false
  const list = root[event]
  if (!Array.isArray(list)) return false
  const matcher = asRecord(list[matcherIndex])
  if (!matcher || !Array.isArray(matcher.hooks)) return false
  const hooks = matcher.hooks as unknown[]
  hooks.splice(hookIndex, 1)
  if (hooks.length === 0) list.splice(matcherIndex, 1)
  if (list.length === 0) delete root[event]
  if (Object.keys(root).length === 0) delete doc.hooks
  return true
}

function insertIntoDoc(
  doc: HookDoc,
  event: string,
  matcher: string,
  hook: HookEntry
): void {
  let root = asRecord(doc.hooks)
  if (!root) {
    root = {}
    doc.hooks = root
  }

  let list: unknown[]
  if (Array.isArray(root[event])) list = root[event] as unknown[]
  else {
    list = []
    root[event] = list
  }

  const want = matcher.trim()
  let target: Record<string, unknown> | null = null
  for (const item of list) {
    const m = asRecord(item)
    if (!m) continue
    const cur = typeof m.matcher === 'string' ? m.matcher.trim() : ''
    if (cur === want) {
      target = m
      break
    }
  }
  if (!target) {
    target = want ? { matcher: want, hooks: [] } : { hooks: [] }
    list.push(target)
  }

  let hooks: unknown[]
  if (Array.isArray(target.hooks)) hooks = target.hooks as unknown[]
  else {
    hooks = []
    target.hooks = hooks
  }
  hooks.push(hook)
}

interface MutateResult {
  ok: boolean
  errorKey?: string
  detail?: string
}

function mutateFile(
  file: string,
  ctx: HookNativeContext,
  fn: (doc: HookDoc) => boolean
): MutateResult {
  const result = withTextFile(file, 'claude', ctx.backupRoot, (text, _exists) => {
    const base = text.trim() ? text : '{}\n'
    const doc = parseDoc(base, file)
    if (!fn(doc)) return null
    const hooks = doc.hooks
    if (hooks === undefined || (asRecord(hooks) && Object.keys(hooks as object).length === 0)) {
      return applyModify(base, ['hooks'], undefined)
    }
    return applyModify(base, ['hooks'], hooks)
  })

  if (!result.ok) {
    return {
      ok: false,
      errorKey: errorKeyOf(result.errorKey) ?? 'hook.error.writeFailed',
      detail: result.detail
    }
  }
  return { ok: true }
}

function enabledLocated(cwd: string, ctx: HookNativeContext): LocatedHook[] {
  const out: LocatedHook[] = []
  out.push(
    ...readFileLocated(settingsPath(ctx, 'user', ''), 'user', '', false).hooks
  )
  if (cwd.trim()) {
    out.push(
      ...readFileLocated(settingsPath(ctx, 'project', cwd), 'project', cwd, false).hooks
    )
    out.push(
      ...readFileLocated(settingsPath(ctx, 'local', cwd), 'local', cwd, false).hooks
    )
  }
  return out
}

function locateById(
  id: string,
  cwd: string,
  ctx: HookNativeContext
): LocatedHook | null {
  const hit = enabledLocated(cwd, ctx).find((x) => x.view.id === id)
  if (hit) return hit

  const entry = readDisabled(ctx).find((e) => e.id === id && visibleDisabled(e, cwd))
  if (!entry) return null
  return {
    view: disabledView(entry),
    file: settingsPath(
      ctx,
      entry.scope,
      entry.scope === 'user' ? '' : entry.cwd || cwd
    ),
    matcherIndex: -1,
    hookIndex: -1,
    disabledEntry: entry
  }
}

function makeDisabled(
  input: HookInput,
  hook: HookEntry,
  file: string,
  cwd: string
): DisabledHook {
  const scopeCwd = input.scope === 'user' ? '' : cwd
  return {
    id: fingerprintOf(input.scope, scopeCwd, input.event, input.matcher, hook),
    scope: input.scope,
    event: input.event,
    matcher: input.matcher,
    hook,
    sourceFile: file,
    cwd: scopeCwd,
    disabledAt: Date.now()
  }
}

export function saveHookNative(
  input: HookInput,
  cwd: string,
  ctx: HookNativeContext
): HookMutationResult {
  const list = (): HookListResult => listHooksNative(cwd, ctx)
  const targetCwd = input.scope === 'user' ? '' : input.cwd || cwd

  const bad = validateHookInput({ ...input, cwd: targetCwd })
  if (bad) return fail(bad, list())
  if (input.scope !== 'user' && !targetCwd.trim()) {
    return fail('hook.error.cwdRequired', list())
  }

  const existing = input.id ? locateById(input.id, cwd, ctx) : null
  if (input.id && !existing) return fail('hook.error.notFound', list())
  if (existing?.view.readOnly) return fail('hook.error.readOnly', list())
  if (existing && existing.view.scope !== input.scope) {
    return fail('hook.error.scopeLocked', list())
  }

  const previous = existing?.view.hook ?? null
  const nextHook = previous ? mergeHook(previous, input.hook) : input.hook
  const file = existing?.file ?? settingsPath(ctx, input.scope, targetCwd)
  const registry = readDisabled(ctx)

  // 新建但保存为停用：只进注册表，不碰 settings
  if (!existing && !input.enabled) {
    const entry = makeDisabled(input, nextHook, file, targetCwd)
    const w = writeDisabled(ctx, [...registry, entry])
    if (!w.ok) {
      return fail(w.errorKey ?? 'hook.error.registryWrite', list(), w.detail)
    }
    return ok(list())
  }

  // 原本停用，继续停用：更新注册表里的条目
  if (existing?.view.disabled && !input.enabled) {
    const entry = makeDisabled(input, nextHook, file, targetCwd)
    const w = writeDisabled(ctx, [
      ...registry.filter((e) => e.id !== existing.view.id),
      entry
    ])
    if (!w.ok) {
      return fail(w.errorKey ?? 'hook.error.registryWrite', list(), w.detail)
    }
    return ok(list())
  }

  // 原本停用，启用：先从注册表摘掉，再写 settings；写失败就把注册表放回去
  if (existing?.view.disabled && input.enabled) {
    const old = existing.disabledEntry
    if (!old) return fail('hook.error.notFound', list())
    const remaining = registry.filter((e) => e.id !== old.id)
    const rw = writeDisabled(ctx, remaining)
    if (!rw.ok) {
      return fail(rw.errorKey ?? 'hook.error.registryWrite', list(), rw.detail)
    }
    const w = mutateFile(file, ctx, (doc) => {
      insertIntoDoc(doc, input.event, input.matcher, nextHook)
      return true
    })
    if (!w.ok) {
      writeDisabled(ctx, [...remaining, old])
      return fail(w.errorKey ?? 'hook.error.writeFailed', list(), w.detail)
    }
    return ok(list())
  }

  // 原本启用，改成停用：先写注册表，再从 settings 移除；移除失败就回滚注册表
  if (existing && !existing.view.disabled && !input.enabled) {
    const entry = makeDisabled(input, nextHook, existing.file, targetCwd)
    const rw = writeDisabled(ctx, [
      ...registry.filter((e) => e.id !== existing.view.id),
      entry
    ])
    if (!rw.ok) {
      return fail(rw.errorKey ?? 'hook.error.registryWrite', list(), rw.detail)
    }
    const w = mutateFile(existing.file, ctx, (doc) => {
      if (
        !removeFromDoc(
          doc,
          existing.view.event,
          existing.matcherIndex,
          existing.hookIndex
        )
      ) {
        throw new NativeParseError('hook.error.notFound', existing.file)
      }
      return true
    })
    if (!w.ok) {
      writeDisabled(ctx, registry)
      return fail(w.errorKey ?? 'hook.error.writeFailed', list(), w.detail)
    }
    return ok(list())
  }

  // 新建启用 / 原本启用且继续启用
  const w = mutateFile(file, ctx, (doc) => {
    if (existing && !existing.view.disabled) {
      if (
        !removeFromDoc(
          doc,
          existing.view.event,
          existing.matcherIndex,
          existing.hookIndex
        )
      ) {
        throw new NativeParseError('hook.error.notFound', existing.file)
      }
    }
    insertIntoDoc(doc, input.event, input.matcher, nextHook)
    return true
  })
  if (!w.ok) {
    return fail(w.errorKey ?? 'hook.error.writeFailed', list(), w.detail)
  }

  // 极少数情况下注册表里残留同一个指纹，顺手清掉
  const nextId = fingerprintOf(input.scope, targetCwd, input.event, input.matcher, nextHook)
  if (registry.some((e) => e.id === nextId)) {
    writeDisabled(ctx, registry.filter((e) => e.id !== nextId))
  }

  return ok(list())
}

export function removeHookNative(
  id: string,
  cwd: string,
  ctx: HookNativeContext
): HookMutationResult {
  const list = (): HookListResult => listHooksNative(cwd, ctx)
  const hit = locateById(id, cwd, ctx)
  if (!hit) return fail('hook.error.notFound', list())
  if (hit.view.readOnly && hit.view.readOnlyReason === 'plugin') {
    return fail('hook.error.readOnly', list())
  }

  if (hit.view.disabled) {
    const w = writeDisabled(
      ctx,
      readDisabled(ctx).filter((e) => e.id !== id)
    )
    if (!w.ok) {
      return fail(w.errorKey ?? 'hook.error.registryWrite', list(), w.detail)
    }
    return ok(list())
  }

  const w = mutateFile(hit.file, ctx, (doc) => {
    if (
      !removeFromDoc(doc, hit.view.event, hit.matcherIndex, hit.hookIndex)
    ) {
      throw new NativeParseError('hook.error.notFound', hit.file)
    }
    return true
  })
  if (!w.ok) return fail(w.errorKey ?? 'hook.error.writeFailed', list(), w.detail)
  return ok(list())
}

export function setHookEnabledNative(
  id: string,
  enabled: boolean,
  cwd: string,
  ctx: HookNativeContext
): HookMutationResult {
  const list = (): HookListResult => listHooksNative(cwd, ctx)
  const hit = locateById(id, cwd, ctx)
  if (!hit) return fail('hook.error.notFound', list())
  if (hit.view.readOnly) return fail('hook.error.readOnly', list())
  if (hit.view.disabled === !enabled) return ok(list())

  const scope = hit.view.scope
  if (!isWritableHookScope(scope)) return fail('hook.error.readOnly', list())

  const input: HookInput = {
    id: hit.view.id,
    scope,
    cwd: scope === 'user' ? '' : hit.view.cwd || cwd,
    event: hit.view.event as HookEvent,
    matcher: hit.view.matcher,
    hook: hit.view.hook,
    enabled
  }
  return saveHookNative(input, cwd, ctx)
}

/** 打开配置目录用：用户级是 ~/.claude，项目级是 <cwd>/.claude */
export function hookConfigDir(
  scope: HookWritableScope,
  cwd: string,
  ctx: HookNativeContext
): string {
  return scope === 'user' ? ctx.claudeDir : join(cwd, '.claude')
}

export { settingsPath as hookSettingsPath }

