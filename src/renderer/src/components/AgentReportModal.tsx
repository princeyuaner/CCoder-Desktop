import { useEffect, useRef, useState } from 'react'
import type { RunAgent, RunAgentStatus } from '../run-state'
import { fmtDuration, fmtTokens } from './format'
import { IconCopy } from './Icons'
import { RichText } from './rich'

/**
 * 子代理完整报告。
 *
 * 卡片里只有一行摘要（`result`），完整正文在 `report` —— 前台来自
 * Agent 工具的 tool_result，后台来自 task_notification 的 handback。
 * 报告可能是 Markdown，所以直接复用对话的 RichText，而不是塞进 <pre>。
 */

const STATUS_LABEL: Record<RunAgentStatus, string> = {
  running: '运行中',
  ok: '完成',
  error: '失败',
  stopped: '已停止',
  denied: '已拒绝'
}

function stateClass(status: RunAgentStatus): string {
  if (status === 'ok') return 'is-done'
  if (status === 'running') return 'is-live'
  if (status === 'stopped') return 'is-stopped'
  return 'is-bad'
}

export function AgentReportModal({
  agent,
  onClose
}: {
  agent: RunAgent
  onClose: () => void
}): JSX.Element {
  const dlgRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    dlgRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const copyText = agent.report || agent.result || agent.error || ''
  const isBackground = agent.isBackground === true || agent.info?.async === true
  const meta: string[] = [isBackground ? '后台运行' : '前台']
  if (agent.ms != null) meta.push(fmtDuration(agent.ms))
  if (agent.info?.totalTokens) meta.push(`${fmtTokens(agent.info.totalTokens)} tok`)
  if (agent.info?.toolUseCount) meta.push(`${agent.info.toolUseCount} 次工具`)
  if (agent.info?.model) meta.push(agent.info.model)
  if (agent.taskId) meta.push(`task ${agent.taskId}`)

  const copy = (): void => {
    if (!copyText) return
    void navigator.clipboard
      ?.writeText(copyText)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => undefined)
  }

  return (
    <div className="modal">
      <div className="modal__scrim" onClick={onClose} />
      <div
        className={`modal__dlg is-report ${agent.status === 'error' ? 'is-danger' : ''}`}
        ref={dlgRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`子代理报告：${agent.description}`}
      >
        <div className="modal__h">
          <span className={`modal__badge report__badge ${stateClass(agent.status)}`}>
            {STATUS_LABEL[agent.status]}
          </span>
          <span className="modal__t" title={agent.description}>
            {agent.description}
          </span>
          <span className="modal__note">{agent.type}</span>
        </div>

        <div className="modal__b">
          <div className="report__meta">
            {meta.map((m) => (
              <span key={m}>{m}</span>
            ))}
          </div>

          {agent.error && <div className="report__err">{agent.error}</div>}

          {agent.report ? (
            <div className="report__body">
              <RichText text={agent.report} />
            </div>
          ) : (
            <div className="report__empty">
              {agent.result ? (
                <>
                  <div className="selectable">{agent.result}</div>
                  <p className="report__note">仅保留摘要，CLI 没有回传完整正文。</p>
                </>
              ) : (
                <p className="report__note">这条子代理没有返回可查看的报告。</p>
              )}
            </div>
          )}

          {agent.outputFile && (
            <div className="report__file" title={agent.outputFile}>
              报告文件：{agent.outputFile}
            </div>
          )}
        </div>

        <div className="modal__f">
          <button className="btn report__cp" onClick={copy} disabled={!copyText}>
            <IconCopy width={13} height={13} />
            {copied ? '已复制' : '复制报告'}
          </button>
          <span className="modal__sp" />
          <button className="btn btn--primary" onClick={onClose}>
            关闭<span className="kbd">Esc</span>
          </button>
        </div>
      </div>
    </div>
  )
}
