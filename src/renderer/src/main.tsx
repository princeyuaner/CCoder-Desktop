import React from 'react'
import { createRoot } from 'react-dom/client'
import { defaultSettings, type Settings } from '@shared/settings'
import './styles/tokens.css'
import './styles/global.css'
import { App } from './App'
import { applyAppearance } from './appearance'

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
  if (window.api) {
    try {
      settings = await window.api.settings.get()
    } catch {
      // 用默认外观继续
    }
  }
  applyAppearance(settings)
  createRoot(el!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void boot()
