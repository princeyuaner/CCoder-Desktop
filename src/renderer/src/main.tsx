// 必须放在最前面：先装错误上报，再加载其余模块，模块求值阶段的异常才不会漏
import './report-errors'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { defaultSettings, type Settings } from '@shared/settings'
import { resolveLanguage, type LocaleInfo } from '@shared/i18n'
import './styles/tokens.css'
import './styles/global.css'
// KaTeX 的排版和字体是公式渲染的基础，必须全局引入一次
import 'katex/dist/katex.min.css'
import { App } from './App'
import { IdeApp } from './ide/IdeApp'
import { applyAppearance } from './appearance'
import { initRendererI18n } from './i18n'

const el = document.getElementById('root')
if (!el) throw new Error('#root not found')

/**
 * 先把外观设置读出来再渲染。
 *
 * 否则会按默认的深色先画一帧，等 useSettings 异步回来再切浅色 —— 用户看到
 * 一次明显的闪屏。主进程没起来时用默认值照常渲染，不能因为读设置失败白屏。
 */
async function boot(): Promise<void> {
  let settings: Settings = defaultSettings()
  let localeInfo: LocaleInfo = {
    systemLocale: navigator.language,
    resolved: resolveLanguage('system', navigator.language)
  }

  if (window.api) {
    // 两件事都要在首帧之前完成，否则会先闪一帧中文 / 默认外观
    const [s, i] = await Promise.all([
      window.api.settings.get().catch(() => defaultSettings()),
      window.api.i18n.locale().catch(() => localeInfo)
    ])
    settings = s
    localeInfo = i
  }

  initRendererI18n(localeInfo)
  applyAppearance(settings)
  const params = new URLSearchParams(location.search)
  const isIde = params.get('view') === 'ide'
  const ideCwd = params.get('cwd') ?? ''
  createRoot(el!).render(
    <React.StrictMode>
      {isIde ? <IdeApp cwd={ideCwd} /> : <App />}
    </React.StrictMode>
  )
}

void boot()
