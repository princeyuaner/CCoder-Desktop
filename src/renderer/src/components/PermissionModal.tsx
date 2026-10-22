import { useEffect, useRef } from 'react'
import type { PermissionPreview } from '@shared/events'
import type { ChatItem } from '../useChat'

/**
 * 审批弹窗（居中模态 + 遮罩）。
 *
 * 为什么从转写区里搬出来：审批是**阻塞**的 —— 不回答，agent 就卡在那儿不动。
 * 嵌在时间线里意味着它得跟一堆滚过去的卡片抢注意力，用户往下翻的时候
 * 很容易把"等待你的许可"当成又一条已经跑完的记录划过去。
 * 做成模态就没有这个问题：除了回答它，哪儿也点不了。
 *
 * 代价是遮住了上下文。所以转写区**留了一条痕**（见 Transcript 的
 * PermissionTrace）—— 关掉之后还能查到"这一步被批准过"，而且
 * 判断 diff 合不合理需要的上下文，遮罩下也还看得见个大概。
 */
export function PermissionModal({
  item,
  pendingCount,
  onRespond
}: {
  item: Extract<ChatItem, { kind: 'permission' }>
  /** 一共几条待回答。>1 时右上角显示 1/N，否则用户不知道后面还排着 */
  pendingCount: number
  onRespond: (requestId: string, allow: boolean, always: boolean) => void
}): JSX.Element {
  const { preview } = item
  const dangerous = !!preview.danger
  const dlgRef = useRef<HTMLDivElement>(null)

  /**
   * 打开时把焦点从输入框抢过来。
   *
   * 不抢的话，回车会**同时**被输入框的发送逻辑和这里的放行逻辑接住 ——
   * 一条消息发出去，一次审批也被悄悄放行了。焦点在弹窗里就只有一个接收方。
   */
  useEffect(() => {
    dlgRef.current?.focus()
  }, [item.id])

  /**
   * 回车放行、Esc 拒绝。
   *
   * 危险的命令**不给回车** —— 手滑一下就把 `rm -rf` 放行了，这个快捷键
   * 在最需要它的场合恰恰最不该存在。Esc 永远可以，拒绝不该有摩擦。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 焦点在按钮上时让按钮自己处理 —— 否则回车会既点按钮又走这里，一次操作发两个决定
      if ((e.target as HTMLElement | null)?.tagName === 'BUTTON') return

      if (e.key === 'Escape') {
        e.preventDefault()
        onRespond(item.id, false, false)
      } else if (e.key === 'Enter' && !dangerous) {
        e.preventDefault()
        onRespond(item.id, true, false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [item.id, dangerous, onRespond])

  // 按钮按语义分三组摆：拒绝在左，允许在右，其余夹中间
  const deny = item.options.filter((o) => o.value === 'deny')
  const always = item.options.filter((o) => o.value === 'allow-always')
  const allow = item.options.filter((o) => o.value === 'allow')
  const rest = item.options.filter((o) => !['deny', 'allow-always', 'allow'].includes(o.value))

  const tail = ASK_TAIL[preview.kind]

  return (
    <div className="modal">
      <div className="modal__scrim" />

      <div
        className={`modal__dlg ${dangerous ? 'is-danger' : ''}`}
        ref={dlgRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={preview.title}
      >
        <div className="modal__h">
          <span className="modal__badge">等待你的许可</span>
          <span className="modal__t">{preview.title}</span>
          {/* 危险时 note 挪到下面的警示条里，别在标题栏重复一遍 */}
          {preview.note && !dangerous && <span className="modal__note">{preview.note}</span>}
          {pendingCount > 1 && <span className="modal__q">1/{pendingCount}</span>}
        </div>

        {dangerous && (
          <div className="modal__warn">
            <span className="modal__warn-g">⚠</span>
            <span>
              这条命令会<b>{preview.note}</b>。回车快捷放行已停用，确认无误再点。
            </span>
          </div>
        )}

        <div className="modal__b">
          {preview.path && <div className="modal__path">{preview.path}</div>}

          {preview.kind === 'diff' && preview.lines && (
            <pre className="modal__pre selectable">
              {preview.lines.map((l, i) => (
                <div key={i} className={`dline is-${l.kind}`}>
                  {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
                  {l.text}
                </div>
              ))}
            </pre>
          )}

          {preview.kind === 'command' && (
            <pre className="modal__pre is-cmd selectable">$ {preview.command}</pre>
          )}

          {preview.kind === 'text' && (
            <pre className="modal__pre selectable">{JSON.stringify(item.input, null, 2)}</pre>
          )}

          <p className="modal__ask">
            模型要执行 <b>{item.tool}</b>
            {tail}，放行吗？
          </p>
        </div>

        <div className="modal__f">
          {deny.map((o) => (
            <button
              key={o.value}
              className="btn btn--danger"
              onClick={() => onRespond(item.id, false, false)}
            >
              {o.label}
              <span className="kbd">Esc</span>
            </button>
          ))}

          <span className="modal__sp" />

          {rest.map((o) => (
            <button key={o.value} className="btn" onClick={() => onRespond(item.id, true, false)}>
              {o.label}
            </button>
          ))}

          {always.map((o) => (
            <button
              key={o.value}
              className="btn"
              onClick={() => onRespond(item.id, true, true)}
            >
              {o.label}
            </button>
          ))}

          {allow.map((o) => (
            <button
              key={o.value}
              className="btn btn--primary"
              onClick={() => onRespond(item.id, true, false)}
            >
              {o.label}
              {!dangerous && <span className="kbd">⏎</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** 「模型要执行 X ____，放行吗？」中间那截 —— 说清这一步到底要干什么 */
const ASK_TAIL: Record<PermissionPreview['kind'], string> = {
  diff: '改这个文件',
  command: '跑这条命令',
  text: ''
}
