import { defaultSettings, type Settings } from '@shared/settings'

/** 只取外观相关字段：设置页在编辑时会把整份 draft 传进来，这里只关心这几项 */
export type Appearance = Pick<
  Settings,
  'theme' | 'uiZoom' | 'chatFontSize' | 'uiFont' | 'monoFont'
>

let themeMode: Settings['theme'] = 'dark'
let watchingSystem = false
/** 记住上一次的缩放值：设置页每敲一个字都会调用 apply，没必要反复重排整个页面 */
let lastZoom: number | null = null

function resolveTheme(): 'dark' | 'light' {
  if (themeMode !== 'system') return themeMode
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * 把主题落到 `<html data-theme>` 上。
 *
 * 用 data 属性而不是直接改一堆 CSS 变量：tokens.css 里两套调色板各自挂在
 * `:root` 和 `:root[data-theme='light']` 上，组件 CSS 完全不用知道主题这回事。
 * `color-scheme` 也跟着切 —— 原生滚动条、select 弹层、输入框光标都靠它。
 */
function paintTheme(): void {
  const root = document.documentElement
  const resolved = resolveTheme()
  root.dataset.theme = resolved
  root.style.colorScheme = resolved
}

/** 跟随系统时只需要挂一次监听；切回固定主题后监听留着也无害（内部会判断） */
function watchSystemTheme(): void {
  if (watchingSystem) return
  watchingSystem = true
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themeMode === 'system') paintTheme()
  })
}

/**
 * 应用外观设置。设置页会拿 draft 反复调用它做**实时预览**；
 * 取消编辑（离开设置页）时再拿已保存的设置调一次即可还原。
 */
export function applyAppearance(a: Appearance): void {
  const fallback = defaultSettings()
  // 防御旧版主进程 / 截图桩返回的不完整设置：任何一个字段坏了都不该让界面崩
  themeMode = a.theme === 'light' || a.theme === 'system' ? a.theme : 'dark'
  if (themeMode === 'system') watchSystemTheme()
  paintTheme()

  const root = document.documentElement
  // 空字符串会让 var(--font-ui) 直接失效，兜回默认字体栈
  const uiFont = typeof a.uiFont === 'string' && a.uiFont.trim() ? a.uiFont : fallback.uiFont
  const monoFont =
    typeof a.monoFont === 'string' && a.monoFont.trim() ? a.monoFont : fallback.monoFont
  root.style.setProperty('--font-ui', uiFont)
  root.style.setProperty('--font-mono', monoFont)
  root.style.setProperty(
    '--chat-font-size',
    `${typeof a.chatFontSize === 'number' && a.chatFontSize > 0 ? a.chatFontSize : fallback.chatFontSize}px`
  )

  const zoom = typeof a.uiZoom === 'number' && a.uiZoom > 0 ? a.uiZoom : 1
  if (zoom !== lastZoom) {
    lastZoom = zoom
    window.api?.setZoom(zoom)
  }
}
