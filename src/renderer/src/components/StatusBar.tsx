import type { Usage } from '@shared/events'
import { cacheHitRate, fmtTokens, totalTokens } from './format'

interface Props {
  turns: number
  steps: number
  usage?: Usage
}

/**
 * 底部状态栏。数字全部来自 `turn_end` 事件 —— 这是事件模型里
 * Usage 那几个字段的展示面。
 */
export function StatusBar({ turns, steps, usage }: Props): JSX.Element {
  const hit = usage ? cacheHitRate(usage) : null
  return (
    <div className="statusbar">
      <div className="statusbar__left">
        <span>
          {turns} 轮 {steps} 步
        </span>
        {usage?.tokensPerSecond != null && (
          <>
            <span className="statusbar__sep">·</span>
            <span>{usage.tokensPerSecond} tok/s</span>
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
