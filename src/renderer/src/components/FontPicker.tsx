/**
 * 可搜索的字体选择器。
 *
 * 设置页原先用原生 <select> 列出所有本机字体，字体多的机器上有上千项，
 * 翻找基本不可用。这里换成「触发按钮 + 展开面板」：面板里的输入框按名字
 * 过滤，键盘上下选择，回车确认，Esc 关闭。
 *
 * 面板是内联展开的（不是绝对定位浮层）—— 设置页的内容区是滚动容器，
 * 浮层会被 overflow 裁掉。
 */
import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { IconChevronDown } from './Icons'

export interface FontPickerOption {
  name: string
  value: string
}

type Row =
  | { kind: 'preset' | 'system'; name: string; value: string }
  | { kind: 'custom'; name: string; value: '__custom__' }

export function FontPicker({
  value,
  isCustom,
  presets,
  system,
  systemLabel,
  customLabel,
  searchPlaceholder,
  onPick,
  onCustom
}: {
  /** 当前落盘的 CSS font-family */
  value: string
  /** 当前值不是预设 / 本机字体之一（或用户主动切到自定义） */
  isCustom: boolean
  presets: FontPickerOption[]
  system: FontPickerOption[]
  systemLabel: string
  customLabel: string
  searchPlaceholder: string
  onPick: (value: string) => void
  onCustom: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  /*
   * 当前选中项的显示名。system 可能有上千项，别在鼠标悬停 / 每次输入时
   * 都全表扫一遍；依赖稳定（Options 由调用方 memo）时结果会复用。
   */
  const current = useMemo(() => {
    if (isCustom) return customLabel
    return (
      presets.find((p) => p.value === value)?.name ??
      system.find((s) => s.value === value)?.name ??
      value
    )
  }, [isCustom, presets, system, value, customLabel])

  const { rows, systemStart } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const match = (text: string): boolean => !q || text.toLowerCase().includes(q)
    const presetRows: Row[] = presets
      .filter((p) => match(p.name))
      .map((p): Row => ({ kind: 'preset', ...p }))
    const systemRows: Row[] = system
      .filter((s) => match(s.name))
      .map((s): Row => ({ kind: 'system', ...s }))
    return {
      rows: [
        ...presetRows,
        ...systemRows,
        // 「自定义」是动作而不是搜索结果，永远保留
        { kind: 'custom', name: customLabel, value: '__custom__' } as Row
      ],
      systemStart: presetRows.length
    }
  }, [presets, system, query, customLabel])

  /* 点面板外面收起 */
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  /* 键盘移动时把当前项滚进视野 */
  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const openPicker = (): void => {
    const selected = isCustom ? '__custom__' : value
    const all = [...presets, ...system, { name: customLabel, value: '__custom__' }]
    const idx = all.findIndex((o) => o.value === selected)
    setQuery('')
    setActive(idx >= 0 ? idx : 0)
    setOpen(true)
  }

  const close = (): void => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const choose = (row: Row): void => {
    if (row.kind === 'custom') onCustom()
    else onPick(row.value)
    close()
  }

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = rows[active]
      if (row) choose(row)
    } else if (e.key === 'Escape') {
      // 阻止冒泡到设置弹窗的全局 Esc 关闭逻辑
      e.preventDefault()
      close()
    }
  }

  return (
    <div className="fontpick" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="input fontpick__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => (open ? setOpen(false) : openPicker())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter') {
            e.preventDefault()
            if (!open) openPicker()
          } else if (e.key === 'Escape' && open) {
            e.preventDefault()
            close()
          }
        }}
      >
        <span className="fontpick__value">{current}</span>
        <IconChevronDown width={12} height={12} />
      </button>

      {open && (
        <div className="fontpick__panel">
          <input
            className="input fontpick__search"
            autoFocus
            value={query}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onSearchKey}
          />
          <div className="fontpick__list" id={listId} role="listbox" ref={listRef}>
            {rows.map((row, i) => (
              <Fragment key={`${row.kind}:${row.value}`}>
                {i === systemStart && i < rows.length - 1 && (
                  <div className="fontpick__group" role="presentation">
                    {systemLabel}
                  </div>
                )}
                <div
                  id={`${listId}-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={row.kind === 'custom' ? isCustom : row.value === value}
                  className={[
                    'fontpick__opt',
                    i === active ? 'is-active' : '',
                    row.kind === 'custom' ? 'fontpick__opt--custom' : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(row)}
                >
                  {row.name}
                </div>
              </Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
