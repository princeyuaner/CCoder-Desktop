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
}

export function ChatHeader({
  title,
  branch,
  modeLabel,
  hasRunInfo,
  panelOpen,
  live,
  onTogglePanel
}: Props): JSX.Element {
  const { t } = useI18n()
  return (
    <header className="chathead">
      <div className="chathead__left">
        <h1 className="chathead__title">{title}</h1>
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
        <button className="iconbtn">
          <IconMore width={16} height={16} />
        </button>
      </div>
    </header>
  )
}
