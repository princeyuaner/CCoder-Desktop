import type { JSX } from 'react'

export interface SyncBubbleRow {
  text: string
  deleted?: boolean
}

export interface SyncBubbleData {
  title: string
  failed: string | null
  rows: SyncBubbleRow[]
  more: string | null
}

/**
 * 一轮同步真的动了文件时，在窗口左下角冒一句。
 *
 * 最多三行路径、3 秒自动收；点它打开同步日志。只报「真的做成的」，
 * 不拿计划冒充结果 —— 「我改的东西怎么没同步」这个问题上尤其。
 */
export function SyncBubble({
  data,
  onOpen,
  onClose
}: {
  data: SyncBubbleData
  onOpen: () => void
  onClose: () => void
}): JSX.Element {
  return (
    <div
      className="sync-bubble"
      role="status"
      aria-live="polite"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      tabIndex={0}
    >
      <div className="sync-bubble-head">
        <span>{data.title}</span>
        <button
          className="sync-bubble-x"
          title="关闭"
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
        >
          ×
        </button>
      </div>
      {data.failed && <div className="sync-bubble-fail">{data.failed}</div>}
      {data.rows.length > 0 && (
        <div className="sync-bubble-rows">
          {data.rows.map((row, i) => (
            <div key={`${row.text}-${i}`} className={`sync-bubble-row ${row.deleted ? 'is-del' : ''}`}>
              {row.text}
            </div>
          ))}
        </div>
      )}
      {data.more && <div className="sync-bubble-more">{data.more}</div>}
      <span className="sync-bubble-timer" />
    </div>
  )
}
