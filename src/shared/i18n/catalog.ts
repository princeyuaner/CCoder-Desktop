import type { TranslateParams } from './types'
import { zh } from './messages/zh'
import { en } from './messages/en'

/** 所有合法文案 key，由中文目录推导 */
export type MessageKey = keyof typeof zh

/**
 * 跨 IPC 传递的文案。
 *
 * 字符串 = 原文（用户数据、原始 stderr、日志等，永不翻译）；
 * `{ key, params }` = 主进程生成、渲染层按当前语言解析的文案。
 * 这样才能做到「切换语言后，界面上已经存在的错误/权限提示也跟着变」。
 */
export type LocalizedText =
  | string
  | {
      key: MessageKey
      params?: TranslateParams
    }

export const CATALOGS = { zh, en } as const

/** 构造一条可延迟解析的文案 */
export function ltext(key: MessageKey, params?: TranslateParams): LocalizedText {
  return params ? { key, params } : { key }
}
