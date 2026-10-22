import type { FileMatch } from '@shared/workspace'
import type { SlashCommand } from '../commands'

/* ── @ 文件引用 ─────────────────────────────────────────── */

interface MentionProps {
  items: FileMatch[]
  active: number
  query: string
  loading: boolean
  /** 当前工作区名，放在标题右侧 */
  scope: string
  onPick: (f: FileMatch) => void
  onHover: (index: number) => void
}

/** 文件类型徽标：颜色只做区分，不承载语义 */
function fileBadge(name: string, kind: 'file' | 'dir'): { text: string; tone: string } {
  if (kind === 'dir') return { text: 'DIR', tone: 'dir' }
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  switch (ext) {
    case 'tsx':
      return { text: 'TSX', tone: 'tsx' }
    case 'ts':
      return { text: 'TS', tone: 'ts' }
    case 'js':
    case 'jsx':
      return { text: 'JS', tone: 'js' }
    case 'json':
      return { text: '{}', tone: 'json' }
    case 'md':
      return { text: 'MD', tone: 'md' }
    case 'css':
      return { text: 'CSS', tone: 'css' }
    case 'html':
      return { text: '<>', tone: 'html' }
    case 'py':
      return { text: 'PY', tone: 'py' }
    default:
      return { text: ext ? ext.slice(0, 3).toUpperCase() : '·', tone: 'other' }
  }
}

export function MentionPopup({
  items,
  active,
  query,
  loading,
  scope,
  onPick,
  onHover
}: MentionProps): JSX.Element {
  return (
    <div className="cpop cpop--mention" role="listbox" aria-label="引用文件">
      <div className="cpop__head">
        <span className="cpop__title">引用文件</span>
        {scope && <span className="cpop__scope">{scope}</span>}
        <span className="cpop__hint">
          {loading ? '扫描中…' : query ? `${items.length} 个匹配` : '工作区文件'}
        </span>
      </div>
      <div className="cpop__query">
        <span className="cpop__trigger">@</span>
        {query}
        <span className="cpop__caret" />
      </div>

      <div className="cpop__list">
        {loading && items.length === 0 && <p className="cpop__empty">正在扫描工作区…</p>}
        {!loading && items.length === 0 && (
          <p className="cpop__empty">
            {query ? `没有匹配 “${query}” 的文件` : '这个工作区里没有可引用的文件'}
          </p>
        )}
        {items.map((f, i) => {
          const b = fileBadge(f.name, f.kind)
          return (
            <button
              key={`${f.kind}:${f.path}`}
              className={`citem ${i === active ? 'is-on' : ''}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault()
                onPick(f)
              }}
              onMouseEnter={() => onHover(i)}
            >
              <span className={`citem__ico is-${b.tone}`}>{b.text}</span>
              <span className="citem__main">
                <span className="citem__name">{f.name}</span>
                <span className="citem__path">{f.path}</span>
              </span>
              <span className="citem__meta">{f.kind === 'dir' ? '目录' : f.dir || '根目录'}</span>
            </button>
          )
        })}
      </div>

      <div className="cpop__foot">
        <span><b>↑↓</b> 选择</span>
        <span><b>Enter</b> 插入</span>
        <span><b>Tab</b> 补全路径</span>
        <span><b>Esc</b> 关闭</span>
      </div>
    </div>
  )
}

/* ── / 系统指令 ─────────────────────────────────────────── */

interface CommandProps {
  items: SlashCommand[]
  active: number
  query: string
  onPick: (c: SlashCommand) => void
  onHover: (index: number) => void
}

function commandGlyph(c: SlashCommand): string {
  switch (c.name) {
    case '/clear':
      return '✕'
    case '/compact':
      return '↯'
    case '/model':
      return '◈'
    case '/permissions':
      return '▣'
    case '/effort':
      return '▤'
    case '/status':
      return '◷'
    case '/help':
      return '?'
    case '/resume':
      return '↩'
    case '/doctor':
      return '✚'
    default:
      return '/'
  }
}

export function CommandPopup({
  items,
  active,
  query,
  onPick,
  onHover
}: CommandProps): JSX.Element {
  const selected = items[active]
  const groups: { name: string; rows: { c: SlashCommand; index: number }[] }[] = []
  for (let i = 0; i < items.length; i++) {
    const c = items[i]
    const last = groups[groups.length - 1]
    if (last && last.name === c.group) last.rows.push({ c, index: i })
    else groups.push({ name: c.group, rows: [{ c, index: i }] })
  }

  return (
    <div className="cpop cpop--command" role="listbox" aria-label="系统指令">
      <div className="cpop__head">
        <span className="cpop__title">系统指令</span>
        <span className="cpop__scope">Claude Code</span>
        <span className="cpop__hint">输入名称筛选</span>
      </div>
      <div className="cpop__query">
        <span className="cpop__trigger">/</span>
        {query}
        <span className="cpop__caret" />
      </div>

      {items.length === 0 ? (
        <p className="cpop__empty cpop__empty--pad">
          没有匹配 “{query}” 的指令
        </p>
      ) : (
        <div className="ccmd-cols">
          <div className="ccmd-list">
            {groups.map((g) => (
              <div key={g.name}>
                <div className="cpop__group">{g.name}</div>
                {g.rows.map(({ c, index }) => (
                  <button
                    key={c.name}
                    className={`ccmd ${index === active ? 'is-on' : ''} ${c.disabled ? 'is-off' : ''}`}
                    role="option"
                    aria-selected={index === active}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      onPick(c)
                    }}
                    onMouseEnter={() => onHover(index)}
                  >
                    <span className="ccmd__ico">{commandGlyph(c)}</span>
                    <span className="ccmd__name">{c.name}</span>
                    <span className="ccmd__desc">{c.description}</span>
                    {c.disabled && <span className="ccmd__tag">暂未接入</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>

          {selected && (
            <div className="ccmd-detail">
              <div className="ccmd-detail__kicker">{selected.group}</div>
              <div className="ccmd-detail__name">{selected.name}</div>
              <p className="ccmd-detail__desc">{selected.detail}</p>
              {selected.warning && <p className="ccmd-detail__warn">{selected.warning}</p>}
              <div className="ccmd-detail__foot">
                <span className="ccmd-key">Enter</span>
                <span>{selected.disabled ? '查看说明' : '执行'}</span>
                <span className="ccmd-dot">·</span>
                <span className="ccmd-key">Esc</span>
                <span>关闭</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
