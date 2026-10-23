import type { ResolvedLocale } from './locale'
import { translate, translatePlural } from './translate'

/**
 * 语言相关的格式化。
 *
 * 只处理会随语言变化的单位 / 日期；tok、tok/s、ms、%、B/KB/MB 这类
 * 技术单位保持中立，不放进这里。
 */

function toMs(value: string | number | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || !value) return null
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : null
}

/** 会话 / 消息时间：中文「10月23日 14:10」，英文「Oct 23, 14:10」 */
export function formatTimestamp(
  value: string | number | undefined,
  locale: ResolvedLocale
): string {
  const t = toMs(value)
  if (t == null) return ''
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(t)
}

/** 只有日期：中文「10月23日」，英文「Oct 23」 */
export function formatDate(value: string | number, locale: ResolvedLocale): string {
  const t = toMs(value)
  if (t == null) return ''
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric'
  }).format(t)
}

/**
 * 相对时间。
 *
 * - `ago`：中文「5 分钟前」，英文「5 minutes ago」
 * - `short`：中文「5 分钟」，英文「5m」
 * 超过 7 天回落到日期。
 */
export function formatRelativeTime(
  value: string | number | undefined,
  locale: ResolvedLocale,
  style: 'ago' | 'short' = 'ago'
): string {
  const t = toMs(value)
  if (t == null) return ''
  const diff = Date.now() - t
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return translate(locale, 'time.justNow')

  if (minutes < 60) {
    return style === 'ago'
      ? translatePlural(locale, 'time.minutesAgo', minutes)
      : translatePlural(locale, 'time.minutesShort', minutes)
  }

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return style === 'ago'
      ? translatePlural(locale, 'time.hoursAgo', hours)
      : translatePlural(locale, 'time.hoursShort', hours)
  }

  const days = Math.floor(hours / 24)
  if (days < 7) {
    return style === 'ago'
      ? translatePlural(locale, 'time.daysAgo', days)
      : translatePlural(locale, 'time.daysShort', days)
  }

  return formatDate(t, locale)
}

/** 时长：中文「1 分 12 秒」，英文「1m 12s」 */
export function formatDuration(ms: number, locale: ResolvedLocale): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes === 0) return translatePlural(locale, 'duration.seconds', seconds)
  return translate(locale, 'duration.minutesSeconds', { m: minutes, s: seconds })
}
