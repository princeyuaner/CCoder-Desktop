import type { Usage } from '@shared/events'
import { cacheHitRate, fmtTokens, totalTokens } from './format'

interface Props {
  turns: number
  steps: number
  usage?: Usage
  /** 这一轮还在跑 —— 速度改用运行时估算值，而不是上一轮的汇总 */
  live: boolean
  /** 本轮流式速度估算（tok/s）；为 0/未就绪时不显示 */
  liveRate?: number
}

/**
 * 底部状态栏。
 *
 * 左侧的轮数 / 步数是累计值：轮数在发送时 +1，步数随工具调用实时增长。
 * 速度运行中用流式估算（`liveRate`），轮末回落到 `turn_end` 的真实平均值；
 * 右侧的 token / 缓存命中 / 上下文仍然来自 `turn_end`，一轮更新一次。
 */
export function StatusBar({ turns, steps, usage, live, liveRate }: Props): JSX.Element {
  const hit = usage ? cacheHitRate(usage) : null
  // 工具执行期间没有输出增量，估算会掉到 0 —— 这时不显示，别留一个假速度
  const rate = live ? (liveRate && liveRate > 0 ? liveRate : undefined) : usage?.tokensPerSecond
  return (
    <div className="statusbar">
      <div className="statusbar__left">
        <span>
          {turns} 轮 {steps} 步
        </span>
        {rate != null && (
          <>
            <span className="statusbar__sep">·</span>
            <span>{rate} tok/s</span>
          </>
        )}
      </div>
      <div className="statusbar__right">
        {usage && <span>{fmtTokens(totalTokens(usage))} tok</span>}
        {hit != null && (
          <>
            <span className="statusbar__sep">|</span>
            <span>缓存命中 {hit}%</span>
          </>
        )}
        {usage?.contextPercent != null && (
          <>
            <span className="statusbar__sep">|</span>
            <span>{usage.contextPercent}%</span>
          </>
        )}
      </div>
    </div>
  )
}
