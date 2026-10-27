import type { PermissionOption } from '../../../shared/events'
import type { EffortLevel } from '../../../shared/settings'
import { bareModel, canonicalModel } from '../../../shared/model'
import { msg } from '../../i18n'

/**
 * DSH provider 之间共享的纯函数。
 *
 * ACP 适配器、Web 适配器和历史回放都要做同一套归一化：工具名映射、
 * 参数整形、模型值解析、退出码判断。放在这里是为了避免三个实现各自
 * 漂移；这里不允许 import 任何 provider 实现，保持无环。
 */

export type Obj = Record<string, unknown>

export const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {}
export const isObj = (v: unknown): v is Obj =>
  !!v && typeof v === 'object' && !Array.isArray(v)
export const str = (v: unknown): string => (typeof v === 'string' ? v : '')
export const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

export function clip(s: string, max = 20_000): string {
  return s.length > max ? `${s.slice(0, max)}\n…（输出已截断）` : s
}

export function safeJson(v: unknown): string {
  if (v === undefined) return ''
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export const stripAnsi = (s: string): string =>
  s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')

/**
 * ACP 的 ToolCallStatus 只表达“这次工具调用有没有跑完”，不表达命令本身
 * 成功与否：PowerShell 的 UnauthorizedAccessException 也会以 completed
 * 收尾。从输出里的 exit code 兜一层，避免工具卡把失败画成绿色。
 */
export function toolFailed(content: string, rawOutput: unknown): boolean {
  const m = content.match(/\[exit code:\s*(-?\d+)\]/i)
  if (m && Number(m[1]) !== 0) return true

  if (isObj(rawOutput)) {
    const code = rawOutput.exitCode ?? rawOutput.exit_code ?? rawOutput.status
    if (typeof code === 'number' && code !== 0) return true
  }
  if (typeof rawOutput === 'string') {
    const rm = rawOutput.match(/exit code[:\s]+(-?\d+)/i)
    if (rm && Number(rm[1]) !== 0) return true
  }
  return false
}

/**
 * dsh 的工具名是小写的（read/write/edit/bash…），而 UI 的
 * toolFamily / 工具卡只认识 Claude 那套 PascalCase。这里做一次归一化，
 * 否则图标、折叠标题、权限预览都会退化。
 */
export function uiToolName(raw: string, kind: string): string {
  const name = raw.trim()
  const key = name.toLowerCase().replace(/[\s-]+/g, '_')
  const MAP: Record<string, string> = {
    read: 'Read',
    write: 'Write',
    edit: 'Edit',
    multi_edit: 'MultiEdit',
    multiedit: 'MultiEdit',
    str_replace_editor: 'Edit',
    apply_patch: 'ApplyPatch',
    bash: 'Bash',
    shell: 'Bash',
    pwsh: 'Bash',
    powershell: 'Bash',
    execute: 'Bash',
    grep: 'Grep',
    glob: 'Glob',
    search: 'Grep',
    web_search: 'WebSearch',
    websearch: 'WebSearch',
    web_fetch: 'WebFetch',
    webfetch: 'WebFetch',
    todo_write: 'TodoWrite',
    todowrite: 'TodoWrite',
    ask_user: 'AskUserQuestion',
    ask_user_question: 'AskUserQuestion',
    read_image: 'Read',
    task: 'Task',
    subagent: 'Task',
    agent: 'Task'
  }
  if (MAP[key]) return MAP[key]

  const k = kind.toLowerCase()
  if (k === 'execute') return 'Bash'
  if (k === 'read') return 'Read'
  if (k === 'edit' || k === 'move' || k === 'delete') return 'Edit'
  if (k === 'search') return 'Grep'
  if (k === 'fetch') return 'WebFetch'
  return name || kind || 'tool'
}

/**
 * 把 ACP 的 rawInput 补齐成 permission-preview 认识的形状。
 *
 * 这里全是防御性归一化：不同版本 / 不同工具的字段名不完全一致，
 * 认不出就原样保留，让 buildPreview 退化成“参数展示”，绝不抛错。
 */
export function normalizeToolInput(raw: unknown, locations: Obj[]): Obj {
  const input: Obj = isObj(raw) ? { ...raw } : raw == null ? {} : { value: raw }

  const path =
    str(input.file_path) ||
    str(input.path) ||
    str(input.filePath) ||
    str(locations[0]?.path)
  if (path && !str(input.file_path)) input.file_path = path

  if (!str(input.command) && str(input.cmd)) input.command = str(input.cmd)
  if (!str(input.old_string) && typeof input.oldText === 'string') {
    input.old_string = input.oldText
  }
  if (!str(input.new_string) && typeof input.newText === 'string') {
    input.new_string = input.newText
  }
  return input
}

/**
 * ACP 的模型值可能是 JSON 元组：`["deepseek-official","deepseek-flash"]`。
 * 取最后一个元素（模型 id），再去掉渠道里可能带的窗口标记。
 */
export function modelOfValue(value: string): string {
  const s = value.trim()
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s) as unknown
      if (Array.isArray(parsed)) {
        const last = parsed[parsed.length - 1]
        if (typeof last === 'string') return bareModel(last)
      }
    } catch {
      // 不是 JSON 就按普通字符串处理
    }
  }
  return bareModel(s)
}

/** 思考深度 → dsh 的 reasoning_effort 取值。medium 是默认档，不显式覆盖。 */
export function dshEffort(effort: EffortLevel): string | null {
  switch (effort) {
    case 'low':
      return 'low'
    case 'medium':
      return null
    case 'high':
      return 'high'
    case 'xhigh':
    case 'max':
    case 'ultra':
      return 'max'
    default:
      return null
  }
}

/** Web 会话里选择模型；undefined 表示保持 dsh 自己的默认。 */
export function dshEffortForSelect(effort: EffortLevel): string | undefined {
  return dshEffort(effort) ?? undefined
}

/**
 * 权限模式 → 宿主侧自动答复。
 *
 * ACP 只有 ask 的请求通道，没有 Claude 那套 --permission-mode 启动参数；
 * Web 的 approval/request 也一样，所以“不问”的几档必须在宿主侧代答：
 *  - bypassPermissions / auto / dontAsk：直接允许（依赖 dsh 自己的沙箱约束）；
 *  - plan：直接拒绝所有需要升级的操作，等价于只读；
 *  - acceptEdits：文件编辑放行，命令仍然问；
 *  - standard：全部问。
 */
export function autoPermission(
  mode: string,
  tool: string,
  kind = ''
): 'allow' | 'deny' | null {
  if (mode === 'bypassPermissions' || mode === 'auto' || mode === 'dontAsk') return 'allow'
  if (mode === 'plan') return 'deny'
  if (mode === 'acceptEdits') {
    const k = kind.toLowerCase()
    if (k === 'edit' || k === 'delete' || k === 'move') return 'allow'
    if (/^(Write|Edit|MultiEdit|ApplyPatch)$/i.test(tool)) return 'allow'
  }
  return null
}

/** UI 的 PermissionModal 只认 allow / allow-always / deny。 */
export function uiPermissionOptions(tool: string, acpOptions: Obj[] = []): PermissionOption[] {
  const out: PermissionOption[] = []
  for (const o of acpOptions) {
    const kind = str(o.kind)
    const value =
      kind === 'allow_once'
        ? 'allow'
        : kind === 'allow_always'
          ? 'allow-always'
          : kind === 'reject_once'
            ? 'deny'
            : kind === 'reject_always'
              ? 'deny-always'
              : ''
    if (!value || out.some((x) => x.value === value)) continue
    out.push({
      value,
      label:
        kind === 'allow_once'
          ? msg('dsh.permission.allow')
          : kind === 'allow_always'
            ? msg('dsh.permission.allowAlways', { tool })
            : kind === 'reject_once'
              ? msg('dsh.permission.deny')
              : msg('dsh.permission.denyAlways'),
      ...(kind.startsWith('reject') ? { danger: true } : {})
    })
  }
  // UI 的 PermissionModal 只认这三个 value；缺哪个就补哪个，别让它没按钮可点
  if (!out.some((o) => o.value === 'allow')) {
    out.unshift({ value: 'allow', label: msg('dsh.permission.allow') })
  }
  if (!out.some((o) => o.value === 'deny')) {
    out.push({ value: 'deny', label: msg('dsh.permission.deny'), danger: true })
  }
  if (!out.some((o) => o.value === 'allow-always')) {
    out.push({
      value: 'allow-always',
      label: msg('dsh.permission.allowAlways', { tool })
    })
  }
  return out
}

/** 模型选择里的扁平候选；Web 和 ACP 共用。 */
export interface ModelChoice {
  value: string
  model: string
  name: string
}

export function modelChoices(opt: Obj): ModelChoice[] {
  const out: ModelChoice[] = []
  const push = (o: Obj): void => {
    const value = str(o.value)
    if (!value) return
    out.push({ value, model: modelOfValue(value), name: str(o.name) })
  }
  for (const item of arr(opt.options).map(obj)) {
    const nested = arr(item.options).map(obj)
    if (nested.length > 0) nested.forEach(push)
    else push(item)
  }
  return out
}

export function selectValues(opt: Obj): string[] {
  const out: string[] = []
  for (const item of arr(opt.options).map(obj)) {
    const nested = arr(item.options).map(obj)
    if (nested.length > 0) {
      for (const n of nested) if (str(n.value)) out.push(str(n.value))
    } else if (str(item.value)) {
      out.push(str(item.value))
    }
  }
  return out
}

export function matchModel(choices: ModelChoice[], wanted: string): ModelChoice | null {
  const w = canonicalModel(wanted)
  if (!w) return null
  return (
    choices.find((c) => c.value === wanted) ??
    choices.find((c) => canonicalModel(c.model) === w) ??
    choices.find((c) => canonicalModel(c.name) === w) ??
    null
  )
}
