import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent
} from 'react'
import type { OutlineKind, OutlineSymbol } from './outline'
import { useI18n } from '../i18n'
import type { MessageKey } from '@shared/i18n'

/**
 * 路径栏后面的符号面包屑。
 *
 * 不用 Monaco 自带的那套：它的面包屑固定英文、样式也跟应用主题对不上。
 * 这里根据大纲（LSP documentSymbol / 正则回退）算出光标所在符号链，
 * 点任意一级弹出同级符号列表，选一个直接跳过去。
 */

interface SymNode {
  sym: OutlineSymbol
  children: SymNode[]
}

function buildTree(symbols: OutlineSymbol[]): SymNode[] {
  const roots: SymNode[] = []
  const stack: { depth: number; node: SymNode }[] = []
  for (const sym of symbols) {
    const node: SymNode = { sym, children: [] }
    while (stack.length > 0 && stack[stack.length - 1].depth >= sym.depth) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent) parent.node.children.push(node)
    else roots.push(node)
    stack.push({ depth: sym.depth, node })
  }
  return roots
}

/** 光标所在的最内层符号；没有范围信息时退化为「最近的前一个符号」 */
function chainAt(nodes: SymNode[], line: number): SymNode[] {
  let candidates: SymNode[] = []
  let fallback: SymNode[] = []

  const visit = (list: SymNode[], parents: SymNode[]): void => {
    for (const node of list) {
      const start = node.sym.line
      const end = node.sym.endLine
      if (start <= line) {
        const withParent = [...parents, node]
        if (end === undefined || line <= end) {
          if (withParent.length >= candidates.length) candidates = withParent
          visit(node.children, withParent)
          continue
        }
        // 没有结束行时，最近一个起始行 <= 光标的符号就是最可能的所在位置
        if (end === undefined && withParent.length >= fallback.length) fallback = withParent
      }
      if (start <= line && node.children.length > 0) visit(node.children, [...parents, node])
    }
  }

  visit(nodes, [])
  return candidates.length > 0 ? candidates : fallback
}

const KIND_MARK: Record<OutlineKind, string> = {
  function: 'ƒ',
  method: 'ƒ',
  class: 'C',
  interface: 'I',
  type: 'T',
  enum: 'E',
  module: 'M',
  constant: 'K',
  symbol: '·'
}

const KIND_KEY: Record<OutlineKind, MessageKey> = {
  function: 'ide.outline.kind.function',
  class: 'ide.outline.kind.class',
  interface: 'ide.outline.kind.interface',
  type: 'ide.outline.kind.type',
  enum: 'ide.outline.kind.enum',
  module: 'ide.outline.kind.module',
  constant: 'ide.outline.kind.constant',
  method: 'ide.outline.kind.method',
  symbol: 'ide.outline.kind.symbol'
}

interface MenuState {
  x: number
  y: number
  items: { label: string; kind: OutlineKind; line: number; current: boolean }[]
}

export const SymbolBreadcrumbs = memo(function SymbolBreadcrumbs({
  symbols,
  line,
  onJump
}: {
  symbols: OutlineSymbol[]
  line: number
  onJump: (line: number) => void
}): JSX.Element | null {
  const { t } = useI18n()
  const [menu, setMenu] = useState<MenuState | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const tree = useMemo(() => buildTree(symbols), [symbols])
  const chain = useMemo(() => chainAt(tree, line), [tree, line])

  useEffect(() => {
    setMenu(null)
  }, [symbols, line])

  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent): void => {
      if (menuRef.current?.contains(e.target as Node)) return
      setMenu(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  if (chain.length === 0) return null

  const openMenu = (
    index: number,
    e: ReactMouseEvent<HTMLButtonElement>,
    siblings: SymNode[]
  ): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    setMenu({
      x: Math.max(8, rect.left),
      y: rect.bottom + 4,
      items: siblings.map((node) => ({
        label: node.sym.name,
        kind: node.sym.kind,
        line: node.sym.line,
        current: node.sym.line === chain[index]?.sym.line
      }))
    })
  }

  const siblingsAt = (index: number): SymNode[] => {
    if (index === 0) return tree
    const parent = chain[index - 1]
    return parent?.children ?? []
  }

  return (
    <>
      <span className="ide-crumb-syms">
        {chain.map((node, i) => (
          <span key={`${node.sym.name}-${node.sym.line}-${i}`} className="ide-crumb-sym">
            <i>›</i>
            <button
              type="button"
              className="ide-crumb-seg"
              title={`${t(KIND_KEY[node.sym.kind])} · ${node.sym.name}:${node.sym.line}`}
              onClick={(e) => openMenu(i, e, siblingsAt(i))}
            >
              <em>{KIND_MARK[node.sym.kind]}</em>
              {node.sym.name}
            </button>
          </span>
        ))}
      </span>

      {menu && (
        <div
          ref={menuRef}
          className="ide-ctx ide-crumb-pop"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
        >
          {menu.items.map((item) => (
            <button
              key={`${item.line}-${item.label}`}
              type="button"
              role="menuitem"
              className={item.current ? 'is-current' : undefined}
              onClick={() => {
                setMenu(null)
                onJump(item.line)
              }}
            >
              <span className="ide-crumb-kind">{KIND_MARK[item.kind]}</span>
              <span className="ide-crumb-name">{item.label}</span>
              <em>{item.line}</em>
            </button>
          ))}
        </div>
      )}
    </>
  )
})
