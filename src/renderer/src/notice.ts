/**
 * 应用级轻提示。
 *
 * 有些操作发生在很深的组件里（比如点工具卡打开 IDE），失败时却应该由
 * App 顶上那条 notice 统一显示。用 DOM 事件当总线：不引状态库，也不用
 * 把 setNotice 一层层穿过 memo 过的转写行。
 */

export const NOTICE_EVENT = 'ccoder:notice'

export function notify(message: string): void {
  window.dispatchEvent(new CustomEvent<string>(NOTICE_EVENT, { detail: message }))
}

/** 订阅一次提示，返回取消订阅函数 */
export function onNotice(cb: (message: string) => void): () => void {
  const listener = (e: Event): void => cb((e as CustomEvent<string>).detail)
  window.addEventListener(NOTICE_EVENT, listener)
  return () => window.removeEventListener(NOTICE_EVENT, listener)
}
