/**
 * 界面语言。
 *
 * `system` 只保存用户的*选择*，真正的解析在主进程完成（app.getSystemLocale），
 * 解析结果通过 `locale:info` 告诉渲染层。渲染层之后用同一个 resolveLanguage
 * 在本地解析，保证主进程和所有窗口一致。
 */

export type LanguageSetting = 'zh' | 'en' | 'system'
export type ResolvedLocale = 'zh' | 'en'

export interface LocaleInfo {
  /** 操作系统语言，例如 zh-CN / en-US */
  systemLocale: string
  /** system 解析后的实际语言 */
  resolved: ResolvedLocale
}

/** 设置页里的选项顺序 */
export const LANGUAGES: LanguageSetting[] = ['zh', 'en', 'system']

export const DEFAULT_LANGUAGE: LanguageSetting = 'system'

export function isLanguageSetting(v: unknown): v is LanguageSetting {
  // 用显式数组校验，不要拿 label map 的 key 当合法值集合：
  // label 一旦本地化/拆分，校验就会跟着坏掉。
  return v === 'zh' || v === 'en' || v === 'system'
}

/** system → 系统语言；zh-* / zh_TW 都按简体中文处理 */
export function resolveLanguage(
  setting: LanguageSetting | undefined,
  systemLocale: string | undefined
): ResolvedLocale {
  if (setting === 'zh' || setting === 'en') return setting
  return (systemLocale ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}
