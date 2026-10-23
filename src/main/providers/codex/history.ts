import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  type Dirent
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import type { AgentEvent, Usage } from '../../../shared/events'
import type { StoredSession } from '../../../shared/session'
import { t } from '../../i18n'

/**
 * 读 Codex 自己的 rollout 记录。
 *
 * 目录结构：`$CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-<时间>-<thread-id>.jsonl`
 *
 * 和 Claude 一样，**不另建一份会话存储** —— 终端里跑的 codex 和这里看到的
 * 必须是同一份。app-server 的 `thread/list` 也能列，但它要常驻一个线程；
 * 侧栏每次刷新都起一个 app-server 太重了。
 */

const HEAD_BYTES = 128 * 1024
const MAX_HEAD_BYTES = 8 * 1024 * 1024
const TAIL_BYTES = 128 * 1024
const MAX_RECORDS = 20_000

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function codexSessionsRoot(): string {
  const home = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  return join(home, 'sessions')
}

function readHead(file: string, bytes: number): string {
  try {
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(bytes)
      const n = readSync(fd, buf, 0, bytes, 0)
      return buf.subarray(0, n).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

function readTail(file: string, size: number): string {
  const bytes = Math.min(TAIL_BYTES, size)
  if (bytes <= 0) return ''
  try {
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(bytes)
      const n = readSync(fd, buf, 0, bytes, size - bytes)
      return buf.subarray(0, n).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

function cleanTitle(s: string): string {
  let t = s
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, ' ')
    .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/g, ' ')
    .replace(/<ide_reference\s+[^>]*>[\s\S]*?<\/ide_reference>/g, ' ')
    .replace(/<ide_reference\b[\s\S]*$/g, ' ')
  // 头部被截断时可能留下未闭合的标签
  t = t.replace(/<\/?[a-z_][^>]{0,40}>/gi, ' ')
  return t.replace(/\s+/g, ' ').trim().slice(0, 80)
}

/** 系统注入的上下文不是"用户说的话" */
function looksInjected(s: string): boolean {
  const t = s.trimStart()
  return (
    t.startsWith('<environment_context') ||
    t.startsWith('<user_instructions') ||
    t.startsWith('<turn_aborted') ||
    t.startsWith('# AGENTS.md instructions')
  )
}

function messageText(content: unknown): string {
  return arr(content)
    .map((v) => {
      const o = obj(v)
      const type = str(o.type)
      if (type === 'input_text' || type === 'output_text' || type === 'text') return str(o.text)
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function firstUserText(payload: Record<string, unknown>): string {
  if (str(payload.type) !== 'message') return ''
  if (str(payload.role) !== 'user') return ''
  const text = messageText(payload.content)
  return looksInjected(text) ? '' : text
}

/**
 * 头部恰好切在一条用户消息中间时的兜底。
 *
 * Codex 把图片 base64 和文字塞在同一条 `response_item` 里，一条消息动辄
 * 上百 KB；128KB 的文件头经常只读到半个 JSON。JSON.parse 失败不代表
 * 标题丢了 —— 文字排在 base64 前面，用正则就能抠出来，省得为了一个标题
 * 把整份文件（可能几十 MB）读进来。
 */
function looseUserText(line: string): string {
  if (!/"role"\s*:\s*"user"/.test(line)) return ''
  if (!/"type"\s*:\s*"message"/.test(line)) return ''
  const m =
    line.match(/"type"\s*:\s*"input_text"\s*,\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/) ??
    // 文字本身也被截断：能拿到多少算多少，标题只用前 80 个字符
    line.match(/"type"\s*:\s*"input_text"\s*,\s*"text"\s*:\s*"((?:\\.|[^"\\])*)$/)
  if (!m) return ''
  let text: string
  try {
    text = JSON.parse(`"${m[1]}"`) as string
  } catch {
    text = m[1]
  }
  return looksInjected(text) ? '' : text
}

/** 从一段文件头里抠出 id、cwd、标题、创建时间 */
function parseHead(head: string): {
  id: string
  cwd: string
  title: string
  createdAt: number
} {
  let id = ''
  let cwd = ''
  let title = ''
  let createdAt = 0

  for (const line of head.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(line) as Record<string, unknown>
    } catch {
      // 头部截断在半个 JSON 上：至少把 session_meta 里的 cwd/id 抠出来
      if (!cwd) {
        const m = line.match(/"cwd"\s*:\s*"((?:\\.|[^"\\])*)"/)
        if (m) {
          try {
            cwd = JSON.parse(`"${m[1]}"`) as string
          } catch {
            cwd = m[1]
          }
        }
      }
      if (!id) {
        const m = line.match(/"session_id"\s*:\s*"([^"]+)"/)
        if (m) id = m[1]
      }
      if (!title) {
        const text = looseUserText(line)
        if (text) title = cleanTitle(text)
      }
      continue
    }

    const ts = str(rec.timestamp)
    if (!createdAt && ts) {
      const t = Date.parse(ts)
      if (Number.isFinite(t)) createdAt = t
    }

    const type = str(rec.type)
    const payload = obj(rec.payload)

    if (type === 'session_meta') {
      id = id || str(payload.id) || str(payload.session_id)
      cwd = cwd || str(payload.cwd)
      const metaTs = str(payload.timestamp)
      if (metaTs) {
        const t = Date.parse(metaTs)
        if (Number.isFinite(t)) createdAt = createdAt || t
      }
      continue
    }

    if (title) continue
    if (type === 'response_item') {
      const text = firstUserText(payload)
      if (text) title = cleanTitle(text)
    } else if (type === 'event_msg' && str(payload.type) === 'user_message') {
      const text = str(payload.message)
      if (text && !looksInjected(text)) title = cleanTitle(text)
    }
  }

  return { id, cwd, title, createdAt }
}

interface Head {
  id: string
  cwd: string
  title: string
  createdAt: number
}

const headCache = new Map<
  string,
  { mtimeMs: number; size: number; head: Head }
>()

/** 递归找出所有 rollout 文件（结构是 年/月/日，不写死层数） */
function walk(dir: string, out: string[], depth = 0): void {
  if (depth > 6) return
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) walk(full, out, depth + 1)
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full)
  }
}

export interface CodexSessionFile {
  file: string
  session: StoredSession
}

export function listCodexSessionFiles(): CodexSessionFile[] {
  const files: string[] = []
  walk(codexSessionsRoot(), files)
  const out: CodexSessionFile[] = []
  const seen = new Set<string>()

  for (const file of files) {
    let st
    try {
      st = statSync(file)
    } catch {
      continue
    }
    seen.add(file)

    const hit = headCache.get(file)
    let head: Head
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      head = hit.head
    } else {
      let bytes = Math.min(st.size, HEAD_BYTES)
      let text = readHead(file, bytes)
      head = parseHead(text)
      // 标题可能同样被大图撑到 128KB 之外 —— 缺 cwd 或标题都要扩大重读
      while ((!head.cwd || !head.title) && bytes < MAX_HEAD_BYTES && bytes < st.size) {
        bytes = Math.min(bytes * 8, MAX_HEAD_BYTES, st.size)
        text = readHead(file, bytes)
        head = parseHead(text)
      }
      if (!head.cwd) {
        const tail = readTail(file, st.size)
        const m = tail.match(/"cwd"\s*:\s*"((?:\\.|[^"\\])*)"/)
        if (m) {
          try {
            head.cwd = JSON.parse(`"${m[1]}"`) as string
          } catch {
            head.cwd = m[1]
          }
        }
      }
      headCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, head })
    }

    if (!head.cwd) continue
    const fallbackId = basename(file).match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
    )?.[1]
    const id = head.id || fallbackId || basename(file, '.jsonl')

    out.push({
      file,
      session: {
        id,
        cwd: head.cwd,
        title: head.title || t('codexHistory.untitled'),
        createdAt: head.createdAt || st.birthtimeMs || st.mtimeMs,
        updatedAt: st.mtimeMs,
        cli: 'codex'
      }
    })
  }

  for (const key of headCache.keys()) {
    if (!seen.has(key)) headCache.delete(key)
  }
  return out
}

/* ── 历史回放 ───────────────────────────────────────────── */

function toBashInput(args: Record<string, unknown>): Record<string, unknown> {
  const raw = args.command
  const command = Array.isArray(raw)
    ? raw.map((v) => String(v)).join(' ')
    : str(raw)
  return {
    command,
    cwd: str(args.workdir) || str(args.cwd) || undefined,
    description: ''
  }
}

function normalizeToolCall(payload: Record<string, unknown>): {
  id: string
  name: string
  input: unknown
  patch?: string
} {
  const id = str(payload.call_id) || str(payload.id)
  const name = str(payload.name)
  const rawArgs = payload.arguments
  let args: Record<string, unknown> = {}
  if (typeof rawArgs === 'string' && rawArgs.trim()) {
    try {
      args = obj(JSON.parse(rawArgs))
    } catch {
      args = { raw: rawArgs }
    }
  } else {
    args = obj(rawArgs)
  }

  if (name === 'shell' || name === 'local_shell' || name === 'container.exec') {
    return { id, name: 'Bash', input: toBashInput(args) }
  }
  if (name === 'exec_command') {
    return {
      id,
      name: 'Bash',
      input: {
        command: str(args.cmd),
        cwd: str(args.workdir) || undefined,
        description: str(args.justification)
      }
    }
  }
  if (name === 'write_stdin') {
    return { id, name: 'WriteStdin', input: args }
  }
  if (name === 'apply_patch') {
    const patch = str(args.patch) || str(args.raw)
    return { id, name: 'ApplyPatch', input: { patch, file_path: firstPatchPath(patch) }, patch }
  }
  if (name === 'update_plan') {
    return { id, name: 'TodoWrite', input: args }
  }
  if (name === 'view_image') {
    return { id, name: 'Read', input: { file_path: str(args.path) || str(args.file_path) } }
  }
  if (name === 'web_search') {
    return { id, name: 'WebSearch', input: { query: str(args.query) } }
  }
  return { id, name: name || t('codexHistory.tool'), input: args }
}

function normalizeCustomCall(payload: Record<string, unknown>): {
  id: string
  name: string
  input: unknown
  patch?: string
} {
  const id = str(payload.call_id) || str(payload.id)
  const name = str(payload.name)
  const raw = str(payload.input)
  if (name === 'apply_patch') {
    return { id, name: 'ApplyPatch', input: { patch: raw, file_path: firstPatchPath(raw) }, patch: raw }
  }
  let input: unknown = raw
  if (raw.trim().startsWith('{')) {
    try {
      input = JSON.parse(raw) as unknown
    } catch {
      input = raw
    }
  }
  return { id, name: name || t('codexHistory.tool'), input }
}

function firstPatchPath(patch: string): string {
  const m = patch.match(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/m)
  return m ? m[1].trim() : ''
}

function patchFiles(patch: string): {
  path: string
  added: number
  removed: number
  created: boolean
  deleted: boolean
}[] {
  const out: {
    path: string
    added: number
    removed: number
    created: boolean
    deleted: boolean
  }[] = []
  let cur: (typeof out)[number] | null = null
  for (const line of patch.split('\n')) {
    const m = line.match(/^\*\*\* (Update|Add|Delete) File:\s*(.+)$/)
    if (m) {
      cur = {
        path: m[2].trim(),
        added: 0,
        removed: 0,
        created: m[1] === 'Add',
        deleted: m[1] === 'Delete'
      }
      out.push(cur)
      continue
    }
    if (!cur) continue
    if (line.startsWith('+') && !line.startsWith('+++')) cur.added++
    else if (line.startsWith('-') && !line.startsWith('---')) cur.removed++
  }
  return out
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output
  return arr(output)
    .map((v) => {
      const o = obj(v)
      return str(o.text) || str(o.content) || ''
    })
    .filter(Boolean)
    .join('\n')
}

function looksFailed(text: string): boolean {
  return /(?:^|\n)\s*(?:error:|Error:|Process exited with code [1-9])/.test(text)
}

function usageFromTokenCount(payload: Record<string, unknown>): Usage | null {
  const info = obj(payload.info)
  const last = obj(info.last_token_usage)
  if (!Object.keys(last).length) return null
  const input = num(last.input_tokens)
  const cached = num(last.cached_input_tokens)
  const cacheWrite = num(last.cache_write_input_tokens)
  const output = num(last.output_tokens)
  const total = num(last.total_tokens) || input + output
  const window = num(info.model_context_window)
  return {
    inputTokens: Math.max(0, input - cached - cacheWrite),
    outputTokens: output,
    cacheReadTokens: cached,
    cacheCreationTokens: cacheWrite,
    contextTokens: total,
    contextPercent:
      window > 0 ? Math.round(Math.min(100, (total / window) * 100) * 10) / 10 : undefined,
    contextUsage: {
      inputTokens: Math.max(0, input - cached - cacheWrite),
      outputTokens: output,
      cacheReadTokens: cached,
      cacheCreationTokens: cacheWrite
    }
  }
}

const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0
})

/**
 * 把一份 rollout 回放成 UI 认识的 AgentEvent。
 *
 * rollout 里同一条助手消息可能同时出现在 response_item 和 event_msg 里；
 * 只认 response_item，避免历史里每条回复都重复两遍。
 */
export function readCodexTranscript(
  file: string,
  cwd: string,
  sessionId = ''
): AgentEvent[] {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }

  const records: Record<string, unknown>[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    try {
      const v = JSON.parse(line) as unknown
      const o = obj(v)
      if (o) records.push(o)
    } catch {
      // 损坏行跳过
    }
  }

  const list = records.length > MAX_RECORDS ? records.slice(-MAX_RECORDS) : records
  const out: AgentEvent[] = []
  let started = false
  let model = ''
  let lastUsage: Usage = emptyUsage()
  let lastCallId = ''
  let turnStart = 0

  const startSession = (): void => {
    if (started) return
    started = true
    out.push({
      t: 'session_started',
      sessionId,
      provider: 'codex',
      model,
      cwd,
      tools: [],
      permissionMode: 'standard'
    })
  }

  for (const rec of list) {
    const type = str(rec.type)
    const payload = obj(rec.payload)
    const at = str(rec.timestamp)

    if (type === 'session_meta') {
      model = model || str(payload.model)
      continue
    }

    if (type === 'turn_context') {
      model = str(payload.model) || model
      startSession()
      turnStart = Date.parse(at) || turnStart
      out.push({ t: 'turn_started' })
      continue
    }

    if (type === 'response_item') {
      const ptype = str(payload.type)

      if (ptype === 'message') {
        const text = messageText(payload.content)
        if (!text) continue
        if (str(payload.role) === 'user') {
          if (looksInjected(text)) continue
          startSession()
          out.push({ t: 'user_message', text, at })
        } else if (str(payload.role) === 'assistant') {
          startSession()
          out.push({ t: 'text_delta', text })
        }
        continue
      }

      if (ptype === 'reasoning') {
        const text = [...arr(payload.summary), ...arr(payload.content)]
          .map((v) => str(obj(v).text))
          .filter(Boolean)
          .join('\n')
        if (text) out.push({ t: 'thinking_delta', text })
        continue
      }

      if (ptype === 'function_call' || ptype === 'custom_tool_call') {
        const call =
          ptype === 'custom_tool_call'
            ? normalizeCustomCall(payload)
            : normalizeToolCall(payload)
        if (!call.id) call.id = `call-${out.length}`
        lastCallId = call.id
        out.push({ t: 'tool_call', id: call.id, name: call.name, input: call.input })
        if (call.name === 'ApplyPatch' && call.patch) {
          for (const f of patchFiles(call.patch)) {
            out.push({
              t: 'file_change',
              path: isAbsolute(f.path) ? f.path : join(cwd, f.path),
              added: f.added,
              removed: f.removed,
              created: f.created,
              deleted: f.deleted,
              source: 'agent'
            })
          }
        }
        continue
      }

      if (ptype === 'function_call_output' || ptype === 'custom_tool_call_output') {
        const id = str(payload.call_id) || lastCallId || `call-${out.length}`
        const text = outputText(payload.output)
        out.push({
          t: 'tool_result',
          id,
          status: looksFailed(text) ? 'error' : 'ok',
          content: text
        })
        lastCallId = ''
        continue
      }

      if (ptype === 'local_shell_call') {
        const action = obj(payload.action)
        const command = arr(action.command).map((v) => String(v)).join(' ')
        const id = str(payload.call_id) || `call-${out.length}`
        lastCallId = id
        out.push({ t: 'tool_call', id, name: 'Bash', input: { command } })
        continue
      }

      continue
    }

    if (type === 'event_msg') {
      const ptype = str(payload.type)
      if (ptype === 'token_count') {
        const u = usageFromTokenCount(payload)
        if (u) lastUsage = u
        continue
      }
      if (ptype === 'task_complete' || ptype === 'turn_aborted') {
        out.push({
          t: 'turn_end',
          durationMs:
            num(payload.duration_ms) ||
            (turnStart ? Math.max(0, (Date.parse(at) || Date.now()) - turnStart) : 0),
          usage: lastUsage,
          steps: 0
        })
        lastUsage = emptyUsage()
        turnStart = 0
      }
      continue
    }
  }

  return out
}
