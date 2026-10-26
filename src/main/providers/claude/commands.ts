import type { NativeCommand } from '../../../shared/commands'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

export interface ClaudeCommandContext {
  /** init 里 `skills` 的规范化名字；没有 init 信息时为空 */
  skillNames?: ReadonlySet<string>
  /** init 里 `terminal_slash_commands`；这些指令绑定终端 UI，桌面端不展示 */
  terminalNames?: ReadonlySet<string>
}

const EMPTY = new Set<string>()

/**
 * CLI 的 slash 指令表 → 归一化的原生指令。
 *
 * 数据来自两个地方，形状相同：
 *  - 客户端 `initialize` 控制请求的响应（启动时立刻有）；
 *  - `system/commands_changed` 推送（会话中技能变化时整份替换）。
 *
 * 关键细节：用户/插件技能的 `name` 可能是展示名（"Debug Issue"），
 * 真正能发送的是 `aliases[0]`（"debug-issue"）。发错名字 CLI 会当普通
 * 正文丢给模型，所以这里必须把「展示名」和「可发送名」分开。
 */
export function claudeCommands(raw: unknown, ctx: ClaudeCommandContext = {}): NativeCommand[] {
  const skillNames = ctx.skillNames ?? EMPTY
  const terminalNames = ctx.terminalNames ?? EMPTY
  const out: NativeCommand[] = []
  const seen = new Set<string>()

  for (const item of arr(raw)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const o = item as Record<string, unknown>

    const rawName = str(o.name).trim().replace(/^\/+/, '')
    if (!rawName) continue

    const aliases = arr(o.aliases)
      .map((a) => str(a).trim().replace(/^\/+/, ''))
      .filter(Boolean)

    // 带空格 / 大写的多半是展示名；有 alias 就发 alias
    const canonical =
      /[\sA-Z]/.test(rawName) && aliases[0] ? aliases[0] : rawName

    // 发不出去的名字不装能发（含空格且没有 alias 的极端情况）
    if (!canonical || /\s/.test(canonical)) continue
    // 内部/远程会话专用
    if (canonical.startsWith('__') || canonical === 'workflow-launch-exec') continue

    const names = [canonical, rawName, ...aliases].map((n) => n.toLowerCase())
    if (names.some((n) => terminalNames.has(n))) continue

    const key = canonical.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    /*
     * 分组优先级：
     *  1. init 的 skills 列表（最准，包含内置技能和用户技能）；
     *  2. 插件技能的 `plugin:skill` 前缀；
     *  3. 还没拿到 init 时，退回 `builtin` 标记（内置技能可能暂时被
     *     分到「指令」，init 到达后会重新映射再发一次）。
     */
    const isSkill = skillNames.size
      ? key.includes(':') || names.some((n) => skillNames.has(n))
      : o.builtin !== true

    const argumentHint = str(o.argumentHint).trim()
    out.push({
      name: canonical,
      ...(canonical !== rawName ? { label: rawName } : {}),
      description: str(o.description),
      ...(argumentHint ? { argumentHint } : {}),
      ...(aliases.length > 0 ? { aliases } : {}),
      run: 'send',
      group: isSkill ? 'skill' : 'command'
    })
  }

  return out
}
