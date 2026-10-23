import { Fragment } from 'react'
import type { Usage } from '@shared/events'
import { useI18n } from '../i18n'
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
 * 右侧的 token / 缓存命中仍然来自 `turn_end`，一轮更新一次。上下文百分比
 * 已经合并进输入框的上下文胶囊（那边还能展开构成），这里不再重复。
 */
export function StatusBar({ turns, steps, usage, live, liveRate }: Props): JSX.Element {
  const { t, tn } = useI18n()
  const hit = usage ? cacheHitRate(usage) : null
  // 工具执行期间没有输出增量，估算会掉到 0 —— 这时不显示，别留一个假速度
  const rate = live ? (liveRate && liveRate > 0 ? liveRate : undefined) : usage?.tokensPerSecond

  const total = usage ? totalTokens(usage) : 0
  const parts: string[] = []
  // dsh 只报上下文用量，input/output 都是 0 —— 别显示一个没有意义的「0 tok」
  if (total > 0) parts.push(`${fmtTokens(total)} tok`)
  if (hit != null) parts.push(t('status.cacheHit', { n: hit }))

  return (
    <div className="statusbar">
      <div className="statusbar__left">
        <span>
          {tn('count.turns', turns)} · {tn('count.steps', steps)}
        </span>
        {rate != null && (
          <>
            <span className="statusbar__sep">·</span>
            <span>{rate} tok/s</span>
          </>
        )}
      </div>
      <div className="statusbar__right">
        {parts.map((p, i) => (
          <Fragment key={`${i}-${p}`}>
            {i > 0 && <span className="statusbar__sep">|</span>}
            <span>{p}</span>
          </Fragment>
        ))}
      </div>
    </div>
  )
}
