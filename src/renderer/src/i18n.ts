import { useCallback, useSyncExternalStore } from 'react'
import {
  localizeText,
  resolveLanguage,
  translate,
  translatePlural,
  type LanguageSetting,
  type LocaleInfo,
  type LocalizedText,
  type MessageKey,
  type ResolvedLocale,
  type TranslateParams
} from '@shared/i18n'

/**
 * 渲染层语言 store。
 *
 * 不用 React Context：`useSettings` 在 App / MainPane / SettingsPage 各自
 * 实例化，且 run-state / pending-approvals 等非 React 模块也要取当前语言。
 * 模块级 store + useSyncExternalStore 让每个组件自己订阅，memo 子组件也
 * 不会漏掉语言切换。
 */

let locale: ResolvedLocale = 'zh'
let systemLocale = ''
const listeners = new Set<() => void>()

function emit(): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
  }
  for (const cb of listeners) cb()
}

export function initRendererI18n(info: LocaleInfo): void {
  systemLocale = info.systemLocale
  locale = info.resolved
  emit()
}

export function applyResolvedLocale(next: ResolvedLocale): void {
  if (next === locale) return
  locale = next
  emit()
}

/** 按用户的设置项切换；system 用启动时缓存的系统语言解析 */
export function applyLanguageSetting(setting: LanguageSetting): void {
  applyResolvedLocale(resolveLanguage(setting, systemLocale))
}

export function getLocale(): ResolvedLocale {
  return locale
}

export function getSystemLocale(): string {
  return systemLocale
}

export function subscribeLocale(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** 非 React 模块用的即时翻译 */
export function tr(key: MessageKey, params?: TranslateParams): string {
  return translate(locale, key, params)
}

export function trn(key: MessageKey, count: number, params?: TranslateParams): string {
  return translatePlural(locale, key, count, params)
}

export function currentText(value: LocalizedText): string {
  return localizeText(locale, value)
}

export interface I18nApi {
  locale: ResolvedLocale
  t(key: MessageKey, params?: TranslateParams): string
  tn(key: MessageKey, count: number, params?: TranslateParams): string
  text(value: LocalizedText): string
}

export function useI18n(): I18nApi {
  const loc = useSyncExternalStore(subscribeLocale, getLocale, getLocale)
  const t = useCallback(
    (key: MessageKey, params?: TranslateParams): string => translate(loc, key, params),
    [loc]
  )
  const tn = useCallback(
    (key: MessageKey, count: number, params?: TranslateParams): string =>
      translatePlural(loc, key, count, params),
    [loc]
  )
  const text = useCallback((value: LocalizedText): string => localizeText(loc, value), [loc])
  return { locale: loc, t, tn, text }
}
