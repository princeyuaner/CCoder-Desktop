import type { ResolvedLocale } from './locale'
import type { TranslateParams } from './types'
import { CATALOGS, type LocalizedText, type MessageKey } from './catalog'

/** 把 `{name}` 占位符替换成参数；没传对应参数时保留原样，便于发现漏传 */
export function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  )
}

function pick(
  locale: ResolvedLocale,
  key: MessageKey,
  count: number | undefined
): string {
  // 英文目录缺键时回落到中文，至少不会显示成 key 本身
  const value = CATALOGS[locale][key] ?? CATALOGS.zh[key]
  if (typeof value === 'string') return value
  if (count === undefined) return value.other
  return locale === 'en' && count === 1 ? value.one : value.other
}

export function translate(
  locale: ResolvedLocale,
  key: MessageKey,
  params?: TranslateParams
): string {
  return interpolate(pick(locale, key, undefined), params)
}

/** 带单复数的翻译。中文始终取 other，英文 count === 1 时取 one。 */
export function translatePlural(
  locale: ResolvedLocale,
  key: MessageKey,
  count: number,
  params?: TranslateParams
): string {
  return interpolate(pick(locale, key, count), { ...params, n: count })
}

/** 解析主进程传来的 LocalizedText */
export function localizeText(locale: ResolvedLocale, value: LocalizedText): string {
  return typeof value === 'string' ? value : translate(locale, value.key, value.params)
}
