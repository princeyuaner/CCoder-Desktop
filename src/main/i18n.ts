import {
  ltext,
  resolveLanguage,
  translate,
  translatePlural,
  type LocaleInfo,
  type MessageKey,
  type ResolvedLocale,
  type TranslateParams
} from '../shared/i18n'

/**
 * 主进程翻译单例。
 *
 * 原生对话框、IPC 返回的错误、会话/更新器等模块的提示都从这里取当前语言。
 * 初始化必须在 whenReady 后、创建窗口前完成；设置保存时由 pushSettings 更新。
 *
 * **禁止在模块顶层调用 t()/tn()** —— 那时语言还没初始化，文案会被冻住。
 */

let locale: ResolvedLocale = 'zh'
let systemLocale = ''

export function initMainI18n(info: LocaleInfo): void {
  systemLocale = info.systemLocale
  locale = info.resolved
}

export function setMainLocale(next: ResolvedLocale): void {
  locale = next
}

export function mainLocale(): ResolvedLocale {
  return locale
}

export function mainLocaleInfo(): LocaleInfo {
  return { systemLocale, resolved: locale }
}

/** 当前语言的解析结果；设置页保存时会调用 */
export function applyLanguageSetting(setting: Parameters<typeof resolveLanguage>[0]): void {
  locale = resolveLanguage(setting, systemLocale)
}

export function t(key: MessageKey, params?: TranslateParams): string {
  return translate(locale, key, params)
}

export function tn(key: MessageKey, count: number, params?: TranslateParams): string {
  return translatePlural(locale, key, count, params)
}

/** 构造可跨 IPC、随语言切换重新解析的文案 */
export function msg(key: MessageKey, params?: TranslateParams): ReturnType<typeof ltext> {
  return ltext(key, params)
}
