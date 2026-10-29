import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'

export interface PopoverMenuAction {
  key: string
  label: string
  icon?: ReactNode
  /** 破坏性操作：红字，放在菜单最下面 */
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

export interface PopoverMenuSeparator {
  key: string
  separator: true
}

export type PopoverMenuEntry = PopoverMenuAction | PopoverMenuSeparator

const WIDTH = 190
/** 估算高度用的行高 / 分隔线高度，跟 shell.css 里的内边距对齐 */
const ROW_HEIGHT = 31
const SEPARATOR_HEIGHT = 9
const EDGE = 8

/**
 * 通用操作菜单。
 *
 * fixed 定位而不是挂进触发按钮的父容器：侧栏滚动区域会裁掉溢出的绝对定位
 * 元素，靠近底部的行根本看不到菜单。打开时按视口夹一次，放不下就翻到上方。
 *
 * 点菜单外 / Esc 收起；上下键在项之间移动。焦点的落点是**第一项** ——
 * 用鼠标打开时这不会造成困扰，键盘打开时可以直接回车。
 */
export function PopoverMenu({
  x,
  y,
  align = 'left',
  width = WIDTH,
  label,
  entries,
  onClose
}: {
  x: number
  y: number
  /** `right`：x 指的是触发按钮的右边缘，菜单从右往左展开 */
  align?: 'left' | 'right'
  width?: number
  label: string
  entries: PopoverMenuEntry[]
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  const height =
    entries.reduce(
      (sum, e) => sum + ('separator' in e ? SEPARATOR_HEIGHT : ROW_HEIGHT),
      0
    ) + 8
  const left = Math.min(
    Math.max(EDGE, align === 'right' ? x - width : x),
    Math.max(EDGE, window.innerWidth - width - EDGE)
  )
  // y 是触发按钮的下边缘。放不下时翻到按钮上方，留一点间距。
  const top = y + height > window.innerHeight - EDGE ? Math.max(EDGE, y - height - 12) : y

  useLayoutEffect(() => {
    ref.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus()
  }, [])

  useEffect(() => {
    // 捕获阶段监听：点在任何地方都先经过这里，菜单能可靠收起
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const items = Array.from(
        ref.current?.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]:not(:disabled)'
        ) ?? []
      )
      if (items.length === 0) return
      e.preventDefault()
      const at = items.indexOf(document.activeElement as HTMLButtonElement)
      const next =
        e.key === 'ArrowDown'
          ? (at + 1 + items.length) % items.length
          : (at - 1 + items.length) % items.length
      items[next].focus()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="session-menu"
      style={{ left, top, width }}
      role="menu"
      aria-label={label}
    >
      {entries.map((entry) =>
        'separator' in entry ? (
          <div key={entry.key} className="session-menu__sep" role="separator" />
        ) : (
          <button
            key={entry.key}
            className={`session-menu__item ${entry.danger ? 'is-danger' : ''}`}
            role="menuitem"
            disabled={entry.disabled}
            onClick={() => {
              entry.onSelect()
              onClose()
            }}
          >
            {entry.icon ?? <span className="session-menu__glyph" aria-hidden="true" />}
            <span>{entry.label}</span>
          </button>
        )
      )}
    </div>
  )
}
