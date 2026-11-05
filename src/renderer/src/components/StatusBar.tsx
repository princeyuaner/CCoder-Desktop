import { Fragment, memo } from 'react'
import type { Usage } from '@shared/events'
import { useI18n } from '../i18n'
import { usePluginStatusContributions } from '../plugins/hooks'
import type { PluginStatusContribution } from '../plugins/types'
import { cacheHitRate, fmtTokens, totalTokens } from './format'

interface Props {
  turns: number
  steps: number
  usage?: Usage
  /** 这一轮还在跑 —— 速度改用运行时估算值，而不是上一轮的汇总 */
  live: boolean
  /** 本轮流式速度估算（tok/s）；为 0/未就绪时不显示 */
  liveRate?: number
  /** 当前工作区；插件状态栏组件按它取项目状态 */
  workspacePath?: string
}

function PluginStatusItem({
  item,
  workspacePath
}: {
  item: PluginStatusContribution
  workspacePath?: string
}): JSX.Element {
  if (item.kind === 'text') {
    return <span className={`statusbar__plugin is-${item.tone}`}>{item.text}</span>
  }
  const Component = item.component
  return (
    <span className="statusbar__plugin statusbar__plugin--component">
      <Component workspacePath={workspacePath} />
    </span>
  )
}

/**
 * 底部状态栏。
 *
 * 左侧的轮数 / 步数是累计值：轮数在发送时 +1，步数随工具调用实时增长。
 * 速度运行中用流式估算（`liveRate`），轮末回落到 `turn_end` 的真实平均值；
 * 右侧的 token / 缓存命中仍然来自 `turn_end`，一轮更新一次。上下文百分比
 * 已经合并进输入框的上下文胶囊（那边还能展开构成），这里不再重复。
 */
function StatusBarImpl({ turns, steps, usage, live, liveRate, workspacePath }: Props): JSX.Element {
  const { t, tn } = useI18n()
  const pluginItems = usePluginStatusContributions()
  const hit = usage ? cacheHitRate(usage) : null
  // 工具执行期间没有输出增量，估算会掉到 0 —— 这时不显示，别留一个假速度
  const rate = live ? (liveRate && liveRate > 0 ? liveRate : undefined) : usage?.tokensPerSecond

  const total = usage ? totalTokens(usage) : 0
  const parts: string[] = []
  // dsh 只报上下文用量，input/output 都是 0 —— 别显示一个没有意义的「0 tok」
  if (total > 0) parts.push(`${fmtTokens(total)} tok`)
  if (hit != null) parts.push(t('status.cacheHit', { n: hit }))

  const startItems = pluginItems
    .filter((x) => x.align === 'start')
    .sort((a, b) => (a.kind === 'component' && b.kind === 'component' ? a.order - b.order : 0))
  const endItems = pluginItems
    .filter((x) => x.align === 'end')
    .sort((a, b) => (a.kind === 'component' && b.kind === 'component' ? a.order - b.order : 0))

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
        {startItems.map((item) => (
          <Fragment key={item.id}>
            <span className="statusbar__sep">·</span>
            <PluginStatusItem item={item} workspacePath={workspacePath} />
          </Fragment>
        ))}
      </div>
      <div className="statusbar__right">
        {endItems.map((item) => (
          <Fragment key={item.id}>
            <PluginStatusItem item={item} workspacePath={workspacePath} />
            <span className="statusbar__sep">|</span>
          </Fragment>
        ))}
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

/** 只随轮数 / 用量 / 速度变化，不跟着流式正文每 16ms 重算 */
export const StatusBar = memo(StatusBarImpl)
