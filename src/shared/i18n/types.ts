/** i18n 的基础类型。保持无依赖，供 catalog / translate / format 共用。 */

export type TranslateParams = Record<string, string | number>

/**
 * 一条文案。字符串用于两种语言同形的情况；对象用于英文单复数。
 * 中文没有单复数变化，统一取 `other`。
 */
export type MessageValue = string | { one: string; other: string }
