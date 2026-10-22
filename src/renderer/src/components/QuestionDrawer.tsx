import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Question } from '@shared/events'
import type { QuestionAnswer } from '@shared/session'
import type { ChatItem } from '../useChat'

type QuestionItem = Extract<ChatItem, { kind: 'question' }>

/**
 * 提问抽屉 —— 贴在输入框上方，不遮对话。
 *
 * 为什么不是模态：提问和审批不一样。审批的判断依据（diff / 命令）可以
 * 放进弹窗里，而「选哪个方案」经常要回看上面几句讨论。所以这里保持
 * 输入框和上下文都可见，只把输入区暂时锁住。
 *
 * 一次只显示一道题，1/N 由题目自己的数量决定；多组提问排队时由外层
 * 一次渲染一条，答完自动顶上。
 */
export function QuestionDrawer({
  item,
  pendingCount,
  onAnswer
}: {
  item: QuestionItem
  /** 还有几组待回答（含当前这组）。>1 时提示后面还排着 */
  pendingCount: number
  onAnswer: (requestId: string, answer: QuestionAnswer) => void
}): JSX.Element {
  const [index, setIndex] = useState(0)
  /** 每题选中的结构化选项 label；多选是数组 */
  const [picked, setPicked] = useState<Record<number, string[]>>({})
  /** 「其他」的输入文本 */
  const [other, setOther] = useState<Record<number, string>>({})
  /** 哪几题的「其他」输入框展开了 */
  const [otherOpen, setOtherOpen] = useState<Record<number, boolean>>({})
  /** 键盘高亮行：0..options.length（最后一个是「其他」） */
  const [active, setActive] = useState(0)
  const [hint, setHint] = useState<string | null>(null)

  const rootRef = useRef<HTMLDivElement>(null)
  const otherRef = useRef<HTMLInputElement>(null)

  const total = item.questions.length
  const q: Question = item.questions[index]
  const isLast = index === total - 1
  const pickedHere = picked[index] ?? []
  const otherHere = other[index] ?? ''
  const otherIsOpen = otherOpen[index] ?? false
  const hasAnswer = otherHere.trim().length > 0 || pickedHere.length > 0

  /** 换一组提问时完全复位 */
  useEffect(() => {
    setIndex(0)
    setPicked({})
    setOther({})
    setOtherOpen({})
    setActive(0)
    setHint(null)
  }, [item.id])

  /** 打开时把焦点从输入框抢过来 —— 否则方向键和回车会被输入框接走 */
  useEffect(() => {
    rootRef.current?.focus()
  }, [item.id, index])

  /** 「其他」展开后把光标放进去 */
  useEffect(() => {
    if (otherIsOpen) otherRef.current?.focus()
  }, [otherIsOpen, index])

  const valueOf = (i: number): string | string[] | null => {
    const text = (other[i] ?? '').trim()
    if (text) return item.questions[i].multiSelect ? [text] : text
    const sel = picked[i] ?? []
    if (sel.length === 0) return null
    return item.questions[i].multiSelect ? sel : sel[0]
  }

  const choose = (qi: number, label: string): void => {
    const question = item.questions[qi]
    setPicked((prev) => {
      const cur = prev[qi] ?? []
      const next = question.multiSelect
        ? cur.includes(label)
          ? cur.filter((v) => v !== label)
          : [...cur, label]
        : [label]
      return { ...prev, [qi]: next }
    })
    // 结构化选项和「其他」互斥：选了前者就收起输入框
    setOtherOpen((prev) => ({ ...prev, [qi]: false }))
    setOther((prev) => ({ ...prev, [qi]: '' }))
    setHint(null)
  }

  const openOther = (qi: number): void => {
    setOtherOpen((prev) => ({ ...prev, [qi]: true }))
    // 「其他」是自由输入，跟结构化选项互斥
    setPicked((prev) => ({ ...prev, [qi]: [] }))
    setHint(null)
  }

  /** 点完选项把焦点收回抽屉主体 —— 否则焦点可能还停在「跳过」上，
   *  下一次回车会误触那个按钮。 */
  const focusRoot = (): void => {
    rootRef.current?.focus()
  }

  const advance = (): void => {
    if (!hasAnswer) {
      setHint('先选一个答案，或在「其他」里输入')
      return
    }
    setHint(null)
    if (!isLast) {
      setIndex((i) => i + 1)
      return
    }

    // 最后一题：逐题核对，任何一题没答就跳回去
    const answers: Record<string, string | string[]> = {}
    for (let i = 0; i < total; i++) {
      const v = valueOf(i)
      if (v === null) {
        setIndex(i)
        setHint('还有问题没回答')
        return
      }
      answers[item.questions[i].question] = v
    }
    onAnswer(item.id, { answers })
  }

  const skip = (): void => {
    onAnswer(item.id, { answers: {}, skipped: true })
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.nativeEvent.isComposing) return

    // Esc 永远可以跳过，不该有摩擦
    if (e.key === 'Escape') {
      e.preventDefault()
      skip()
      return
    }

    // 「其他」里打字时，只接管回车；其余按键留给输入框
    if (e.target === otherRef.current) {
      if (e.key === 'Enter') {
        e.preventDefault()
        advance()
      }
      return
    }

    // 焦点在页脚按钮上时交给按钮自己处理 —— 否则回车会既点按钮又走这里，
    // 一次操作前进两题。
    if ((e.target as HTMLElement).tagName === 'BUTTON') return

    const rows = q.options.length + 1
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => (a + 1) % rows)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => (a - 1 + rows) % rows)
      return
    }

    // 数字键直选。1..N 对应选项，「其他」没有数字键
    if (/^[1-9]$/.test(e.key)) {
      const i = Number(e.key) - 1
      if (i < q.options.length) {
        e.preventDefault()
        setActive(i)
        choose(index, q.options[i].label)
      }
      return
    }

    if (e.key === ' ' && q.multiSelect) {
      e.preventDefault()
      if (active < q.options.length) choose(index, q.options[active].label)
      else openOther(index)
      return
    }

    if (e.key === 'Enter') {
      e.preventDefault()
      if (active < q.options.length) {
        const label = q.options[active].label
        // 当前高亮项还没选中 → 先选中；已经选中 → 再按一次才前进。
        // 这样「换选项」和「确认」不会挤在同一次回车里。
        if (!pickedHere.includes(label)) {
          choose(index, label)
          return
        }
        advance()
        return
      }
      if (!otherIsOpen) {
        openOther(index)
        return
      }
      advance()
    }
  }

  return (
    <div
      className="qdrawer"
      ref={rootRef}
      tabIndex={-1}
      role="group"
      aria-label={`模型在问：${q.question}`}
      onKeyDown={onKeyDown}
    >
      <div className="qdrawer__h">
        <span className="qdrawer__badge">模型在问你</span>
        <span className="qdrawer__t">回答后我会继续</span>
        {pendingCount > 1 && <span className="qdrawer__queue">还有 {pendingCount - 1} 组</span>}
        <span className="qdrawer__n">
          {index + 1}/{total}
        </span>
      </div>

      <div className="qdrawer__b">
        <div className="qdrawer__meta">
          <span className="qdrawer__chip">{q.header}</span>
          {q.multiSelect && <span className="qdrawer__multi">可多选</span>}
          <span className="qdrawer__count">
            第 {index + 1} 题，共 {total} 题
          </span>
        </div>

        <div className="qdrawer__q">{q.question}</div>

        <div className="qdrawer__opts" role={q.multiSelect ? 'group' : 'radiogroup'}>
          {q.options.map((o, i) => {
            const on = pickedHere.includes(o.label)
            return (
              <div
                key={o.label}
                className={`qopt ${on ? 'is-on' : ''} ${q.multiSelect ? 'is-multi' : ''} ${
                  active === i ? 'is-active' : ''
                }`}
                role={q.multiSelect ? 'checkbox' : 'radio'}
                aria-checked={on}
                onClick={() => {
                  focusRoot()
                  setActive(i)
                  choose(index, o.label)
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span className="qopt__m" />
                <span className="qopt__b">
                  <span className="qopt__t">{o.label}</span>
                  {o.description && <span className="qopt__d">{o.description}</span>}
                </span>
                <span className="qopt__k">{i + 1}</span>
              </div>
            )
          })}

          {/* 「其他」：CLI 自己也会提供这个选项，这里用输入框承接自由答案 */}
          <div
            className={`qopt qopt--other ${q.multiSelect ? 'is-multi' : ''} ${
              otherIsOpen ? 'is-open' : ''
            } ${active === q.options.length ? 'is-active' : ''} ${
              otherHere.trim() ? 'is-on' : ''
            }`}
            role="radio"
            aria-checked={otherHere.trim().length > 0}
            onClick={() => {
              focusRoot()
              setActive(q.options.length)
              openOther(index)
            }}
            onMouseEnter={() => setActive(q.options.length)}
          >
            <span className="qopt__m" />
            <span className="qopt__b">
              {otherIsOpen ? (
                <input
                  ref={otherRef}
                  className="qopt__input"
                  value={otherHere}
                  placeholder="输入你的答案…"
                  onChange={(e) => {
                    const v = e.target.value
                    setOther((prev) => ({ ...prev, [index]: v }))
                    setHint(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="qopt__t qopt__t--other">其他…</span>
              )}
            </span>
          </div>
        </div>

        {hint && <div className="qdrawer__hint">{hint}</div>}
      </div>

      <div className="qdrawer__f">
        <span className="qdrawer__keys">
          ↑↓ 选择 · ⏎ 选定 · {q.multiSelect ? '空格 多选 · ' : ''}Esc 跳过
        </span>
        {index > 0 && (
          <button
            className="qbtn"
            onClick={() => {
              setHint(null)
              setIndex(index - 1)
            }}
          >
            上一题
          </button>
        )}
        <button className="qbtn" onClick={skip}>
          跳过
        </button>
        <button className="qbtn qbtn--primary" disabled={!hasAnswer} onClick={advance}>
          {isLast ? '提交' : '下一题'}
          <span className="kbd">⏎</span>
        </button>
      </div>
    </div>
  )
}
