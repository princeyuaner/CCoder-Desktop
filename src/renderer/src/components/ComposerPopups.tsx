import type { FileMatch } from '@shared/workspace'
import type { SlashCommand } from '../commands'
import { useI18n } from '../i18n'

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
  const { t, tn } = useI18n()
  return (
    <div className="cpop cpop--mention" role="listbox" aria-label={t('mention.aria')}>
      <div className="cpop__head">
        <span className="cpop__title">{t('mention.title')}</span>
        {scope && <span className="cpop__scope">{scope}</span>}
        <span className="cpop__hint">
          {loading
            ? t('mention.scanning')
            : query
              ? tn('mention.matches', items.length)
              : t('mention.workspaceFiles')}
        </span>
      </div>
      <div className="cpop__query">
        <span className="cpop__trigger">@</span>
        {query}
        <span className="cpop__caret" />
      </div>

      <div className="cpop__list">
        {loading && items.length === 0 && (
          <p className="cpop__empty">{t('mention.emptyLoading')}</p>
        )}
        {!loading && items.length === 0 && (
          <p className="cpop__empty">
            {query ? t('mention.emptyNoMatch', { query }) : t('mention.empty')}
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
              <span className="citem__meta">
                {f.kind === 'dir' ? t('mention.dir') : f.dir || t('mention.root')}
              </span>
            </button>
          )
        })}
      </div>

      <div className="cpop__foot">
        <span><b>↑↓</b> {t('mention.key.select')}</span>
        <span><b>Enter</b> {t('mention.key.insert')}</span>
        <span><b>Tab</b> {t('mention.key.complete')}</span>
        <span><b>Esc</b> {t('mention.key.close')}</span>
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
  const { t } = useI18n()
  const selected = items[active]
  const groups: { name: string; rows: { c: SlashCommand; index: number }[] }[] = []
  for (let i = 0; i < items.length; i++) {
    const c = items[i]
    const name = t(c.groupKey)
    const last = groups[groups.length - 1]
    if (last && last.name === name) last.rows.push({ c, index: i })
    else groups.push({ name, rows: [{ c, index: i }] })
  }

  return (
    <div className="cpop cpop--command" role="listbox" aria-label={t('command.aria')}>
      <div className="cpop__head">
        <span className="cpop__title">{t('command.title')}</span>
        <span className="cpop__scope">Claude Code</span>
        <span className="cpop__hint">{t('command.filter')}</span>
      </div>
      <div className="cpop__query">
        <span className="cpop__trigger">/</span>
        {query}
        <span className="cpop__caret" />
      </div>

      {items.length === 0 ? (
        <p className="cpop__empty cpop__empty--pad">
          {t('command.empty', { query })}
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
                    <span className="ccmd__desc">{t(c.descriptionKey)}</span>
                    {c.disabled && (
                      <span className="ccmd__tag">{t('command.notReady')}</span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>

          {selected && (
            <div className="ccmd-detail">
              <div className="ccmd-detail__kicker">{t(selected.groupKey)}</div>
              <div className="ccmd-detail__name">{selected.name}</div>
              <p className="ccmd-detail__desc">{t(selected.detailKey)}</p>
              {selected.warningKey && (
                <p className="ccmd-detail__warn">{t(selected.warningKey)}</p>
              )}
              <div className="ccmd-detail__foot">
                <span className="ccmd-key">Enter</span>
                <span>{selected.disabled ? t('command.viewInfo') : t('command.run')}</span>
                <span className="ccmd-dot">·</span>
                <span className="ccmd-key">Esc</span>
                <span>{t('command.close')}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
