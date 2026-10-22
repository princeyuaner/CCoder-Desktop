import { nativeTheme } from 'electron'
import { THEME_BG, THEME_SCHEME, type ThemeMode } from '../shared/settings'

/**
 * 主进程侧的当前主题。
 *
 * 渲染层用 CSS 变量换肤，窗口底色却得由 BrowserWindow 提前定 —— 页面还没
 * 画出来时看到的就是这块颜色。系统原生控件（菜单、对话框）由
 * nativeTheme.themeSource 控制，它只认 dark / light / system，所以新增的
 * 深色主题一律映射成 dark，浅色主题映射成 light。
 *
 * 主题存在 settings.json 里，由启动流程和保存设置时写入这里；窗口创建、
 * 系统深浅色切换时都从这里取，避免反复读盘、解密渠道密钥。
 */
let activeTheme: ThemeMode = 'contrast'

export function setActiveTheme(theme: ThemeMode): void {
  activeTheme = theme
}

export function applyNativeTheme(theme: ThemeMode): void {
  activeTheme = theme
  // 防御非法值（旧配置 / 手改 settings.json）：themeSource 只认三种值
  nativeTheme.themeSource =
    theme === 'system' ? 'system' : (THEME_SCHEME[theme] ?? 'dark')
}

/** 当前窗口底色。跟随系统时按 Electron 解析出的深浅色走 */
export function windowBg(): string {
  if (activeTheme === 'system') {
    return nativeTheme.shouldUseDarkColors ? THEME_BG.dark : THEME_BG.light
  }
  return THEME_BG[activeTheme] ?? THEME_BG.contrast
}
