import { useEffect, useState } from 'react'
import { IconBrand, IconPanel } from './Icons'

/**
 * 无边框窗口的自绘标题栏。
 *
 * 整条是拖拽区（-webkit-app-region: drag），但窗口控件必须显式声明
 * no-drag，否则点不动。
 */
export function TitleBar(): JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.api?.isMaximized().then(setMaximized)
    return window.api?.onMaximizedChanged(setMaximized)
  }, [])

  return (
    <div className="titlebar">
      <div className="titlebar__brand">
        <IconBrand width={22} height={22} className="titlebar__brand-mark" />
        <span className="titlebar__brand-name">CCoder</span>
      </div>

      <div className="titlebar__right">
        <button
          className="titlebar__panel"
          title="切换侧栏"
          onClick={() => undefined}
        >
          <IconPanel width={15} height={15} />
        </button>
        <button className="wctl" title="最小化" onClick={() => window.api?.minimize()}>
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button
          className="wctl"
          title={maximized ? '还原' : '最大化'}
          onClick={() => window.api?.toggleMaximize()}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
              <rect x="0.5" y="2.5" width="7" height="7" />
              <path d="M2.5 2.5V0.5h7v7h-2" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
              <rect x="0.5" y="0.5" width="9" height="9" />
            </svg>
          )}
        </button>
        <button className="wctl wctl--close" title="关闭" onClick={() => window.api?.close()}>
          <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor">
            <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
          </svg>
        </button>
      </div>
    </div>
  )
}
