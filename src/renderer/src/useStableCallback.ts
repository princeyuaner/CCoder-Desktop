import { useCallback, useRef } from 'react'

/**
 * 身份稳定、实现永远是最新一次渲染的回调。
 *
 * 用于给 `memo` 过的子组件传 props：普通箭头函数每次父组件重渲染都会换身份，
 * 子组件的浅比较直接失效 —— 流式输出时父组件每 16ms 渲染一次，Composer /
 * 执行台就跟着整块重渲染。这里把身份固定下来，调用时再取最新闭包，既不丢
 * state 也不会让 memo 失守。
 */
export function useStableCallback<Args extends unknown[], R>(
  fn: (...args: Args) => R
): (...args: Args) => R {
  const ref = useRef(fn)
  ref.current = fn
  return useCallback((...args: Args) => ref.current(...args), [])
}
