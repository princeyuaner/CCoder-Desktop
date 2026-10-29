import { useRef, useState } from 'react'
import { IconBranch, IconMore, IconPanel } from './Icons'
import { useI18n } from '../i18n'

interface Props {
  title: string
  /** 当前工作目录检出的 Git 分支；空串 = 不是仓库 / 还没读到 */
  branch?: string
  modeLabel: string
  /** 当前会话有任务或子代理 —— 有才显示执行台的开合按钮 */
  hasRunInfo: boolean
  /** 执行台是不是展开着 */
  panelOpen: boolean
  /** 这一轮还在跑：按钮上点一个跳动的点，不用打开面板也知道 */
  live: boolean
  onTogglePanel: () => void
  /** 操作菜单开着没 —— 只影响按钮的无障碍状态 */
  menuOpen: boolean
  /** (x, y) 是按钮下边缘的位置，菜单由 MainPane 渲染 */
  onToggleMenu: (x: number, y: number) => void
  /** 正在就地重命名标题 */
  renaming: boolean
  onCommitRename: (value: string) => void
  onCancelRename: () => void
}

export function ChatHeader({
  title,
  branch,
  modeLabel,
  hasRunInfo,
  panelOpen,
  live,
  onTogglePanel,
  menuOpen,
  onToggleMenu,
  renaming,
  onCommitRename,
  onCancelRename
}: Props): JSX.Element {
  const { t } = useI18n()
  return (
    <header className="chathead">
      <div className="chathead__left">
        {renaming ? (
          <TitleRename initial={title} onCommit={onCommitRename} onCancel={onCancelRename} />
        ) : (
          <h1 className="chathead__title" title={title}>
            {title}
          </h1>
        )}
        {branch && (
          <span className="chip chathead__branch" title={branch}>
            <IconBranch width={10} height={10} />
            {branch}
          </span>
        )}
        <span className="badge">{modeLabel}</span>
      </div>
      <div className="chathead__right">
        {hasRunInfo && (
          <button
            className={`chip chip--icon ${panelOpen ? 'is-on' : ''}`}
            onClick={onTogglePanel}
            title={panelOpen ? t('chat.header.collapsePanel') : t('chat.header.expandPanel')}
            aria-pressed={panelOpen}
          >
            <IconPanel width={15} height={15} />
            {live && <span className="chip__dot is-busy" />}
          </button>
        )}
        <button
          className={`iconbtn ${menuOpen ? 'is-on' : ''}`}
          title={t('chat.header.actions')}
          aria-label={t('chat.header.actions')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            onToggleMenu(r.right, r.bottom + 6)
          }}
        >
          <IconMore width={16} height={16} />
        </button>
      </div>
    </header>
  )
}

/**
 * 就地改标题。Enter / 失焦提交，Esc 取消。
 *
 * 和侧栏的重命名输入框同一套约定：空串表示**恢复 CLI 原标题**，
 * 不是把标题删成空白 —— 主进程那边也是这么理解的。
 */
function TitleRename({
  initial,
  onCommit,
  onCancel
}: {
  initial: string
  onCommit: (value: string) => void
  onCancel: () => void
}): JSX.Element {
  const { t } = useI18n()
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const cancelled = useRef(false)

  const finish = (commit: boolean): void => {
    if (done.current) return
    done.current = true
    if (commit) onCommit(value.trim())
    else onCancel()
  }

  return (
    <input
      className="chathead__rename"
      value={value}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          cancelled.current = true
          finish(false)
        }
      }}
      onBlur={() => {
        if (!cancelled.current) finish(true)
      }}
      aria-label={t('sidebar.rename')}
    />
  )
}
