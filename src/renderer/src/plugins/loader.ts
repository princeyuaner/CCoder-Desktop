import type { PluginContext } from './types'

export interface ImportedPluginModule {
  activate: (ctx: PluginContext) => void | (() => void)
  url: string
}

/**
 * 用 Blob URL 动态 import 插件代码。
 *
 * 打包后 renderer 是 file://，直接 import 插件目录里的文件会被 CSP / 跨源
 * 限制拦掉；Blob URL 和宿主同源，且不需要自定义协议。main.js 不能有 bare
 * import（浏览器没有模块解析器），这一点由插件作者遵守。
 */
export async function importPluginModule(code: string): Promise<ImportedPluginModule> {
  const blob = new Blob([code], { type: 'text/javascript' })
  const url = URL.createObjectURL(blob)
  try {
    const mod = (await import(/* @vite-ignore */ url)) as { default?: unknown }
    if (typeof mod.default !== 'function') throw new Error('activate-missing')
    return {
      activate: mod.default as ImportedPluginModule['activate'],
      url
    }
  } catch (e) {
    URL.revokeObjectURL(url)
    throw e
  }
}
