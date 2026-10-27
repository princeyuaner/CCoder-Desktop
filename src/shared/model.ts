/**
 * 模型名的比较口径。
 *
 * 同一个模型在不同地方有不同的写法：
 *  - DeepSeek 网关现在只认 `deepseek-v4.1-flash`，旧的 `deepseek-flash` 已下线；
 *  - dsh 0.2.1 的内置目录仍然写着 `deepseek-flash`（显示名「DeepSeek-V4.1-Flash」），
 *    启动时用 patch 覆盖目录，见 providers/dsh/runner.ts；
 *  - 渠道配置和历史记录里可能还留着旧 id。
 *
 * 界面和适配器都按这里的口径比较，否则「用户选的」和「CLI 报的」会被当成两个
 * 模型 —— 会话一启动，胶囊就会跳成另一个名字，看着像被偷偷换了模型。
 */

/** `deepseek-v4.1-flash[1m]` → `deepseek-v4.1-flash`：去掉末尾的上下文窗口标记 */
export function bareModel(s: string): string {
  return s.trim().replace(/\s*\[[^\]]*\]\s*$/, '').trim()
}

/**
 * 已知别名 → 规范 id（键和值都小写）。
 *
 * 只收确认过是同一个模型的写法：
 *  - 网关废弃了 `deepseek-flash`，旧配置里的 id 必须归一到 `deepseek-v4.1-flash`；
 *  - `deepseek-v4-flash` 是更早的写法，同样归一到新 id；
 *  - Pro 仍是 `deepseek-v4-pro`，`deepseek-v4.1-pro` 是它显示名的写法。
 *
 * 拿不准的别往这里加 —— 归一错了会让两个不同的模型互相顶替。
 */
const MODEL_ALIASES: Record<string, string> = {
  'deepseek-flash': 'deepseek-v4.1-flash',
  'deepseek-v4-flash': 'deepseek-v4.1-flash',
  'deepseek-v4.1-pro': 'deepseek-v4-pro'
}

/** 去窗口标记 + 小写 + 别名归一。空串原样返回空串 */
export function canonicalModel(s: string): string {
  const m = bareModel(s).toLowerCase()
  if (!m) return ''
  return MODEL_ALIASES[m] ?? m
}

/** 两个写法是不是同一个模型。空串永远不算相等 */
export function sameModel(a: string, b: string): boolean {
  const x = canonicalModel(a)
  return x.length > 0 && x === canonicalModel(b)
}
