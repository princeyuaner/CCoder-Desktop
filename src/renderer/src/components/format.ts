import type { Usage } from '@shared/events'
import { formatDuration, type ResolvedLocale } from '@shared/i18n'

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** 7 秒 / 1 分 12 秒（英文 7s / 1m 12s） */
export function fmtDuration(ms: number, locale: ResolvedLocale): string {
  return formatDuration(ms, locale)
}

/** 毫秒 → 「01:12」；超过一小时给「1:02:03」。等宽数字，跳秒时宽度不变 */
export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 缓存命中率 = 命中读取 / 总 token */
/**
 * 缓存命中率 = 从缓存读到的 prompt token / prompt token 总量。
 *
 * 分母必须包含缓存读取和缓存写入本身 —— 之前只算 input + output，
 * 缓存读得多的时候会算出 388% 这种假数。结果夹到 0–100。
 */
export function cacheHitRate(u: Usage): number | null {
  const prompt = u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens
  if (prompt <= 0) return null
  return Math.min(100, Math.max(0, Math.round((u.cacheReadTokens / prompt) * 100)))
}

export function totalTokens(u: Usage): number {
  return u.inputTokens + u.outputTokens
}

/**
 * 模型名里能看出来的上下文窗口上限。
 *
 * 只认两类：显式标注（`[1m]` / `-200k` / `_128k`），以及 Claude 系列的默认
 * 200k。其余模型不猜 —— 猜大了百分比偏小，反而让人以为还有余量。
 */
export function contextWindowOf(model: string): number | null {
  const m = model.trim().toLowerCase()
  if (!m) return null

  const tagged =
    m.match(/\[(\d+(?:\.\d+)?)(k|m)\]/) ??
    m.match(/(?:^|[-_ ])(\d+(?:\.\d+)?)(k|m)(?:$|[-_ ])/)
  if (tagged) {
    const n = Number.parseFloat(tagged[1])
    if (Number.isFinite(n) && n > 0) {
      return Math.round(n * (tagged[2] === 'm' ? 1_000_000 : 1000))
    }
  }

  if (/(claude|sonnet|opus|haiku)/.test(m)) return 200_000
  return null
}

/** 上下文用量 → 百分比；没有数据或窗口未知时返回 null */
export function contextPercent(used?: number, window?: number | null): number | null {
  if (!used || used <= 0 || !window || window <= 0) return null
  return Math.min(100, Math.max(1, Math.round((used / window) * 100)))
}
