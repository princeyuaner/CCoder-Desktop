import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 插件仓库的运行上下文。
 *
 * 和 MCP / Skills / Hooks 的原生适配器一样，这里不直接读 homedir / env；
 * 路径由调用方解析好传进来，测试可以用临时目录构造一份。
 */
export interface PluginHostContext {
  /** userData/plugins */
  root: string
  /** userData/plugin-data */
  dataRoot: string
  /** userData/plugins-state.json */
  statePath: string
  appVersion: string
  /** 本地市场索引：开发模式优先使用，打包版只在远程失败时兜底 */
  devMarketIndex?: string
  /** true = 先读本地索引；打包版应传 false，先试远程 */
  preferDevMarket?: boolean
}

function appVersion(): string {
  // 打包版 app.getVersion() 就是 package.json 的版本。开发时直接用
  // electron out/main/index.js 启动，Electron 可能把 app path 指到 out/，
  // 这时 getVersion() 会回落到 Electron 自己的版本（33.x）；插件兼容性
  // 判断不能拿它当宿主版本。
  if (app.isPackaged) return app.getVersion()
  for (const base of [process.cwd(), app.getAppPath()]) {
    try {
      const pkg = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8')) as {
        version?: unknown
      }
      if (typeof pkg.version === 'string' && /^\d+\.\d+\.\d+$/.test(pkg.version)) {
        return pkg.version
      }
    } catch {
      // 继续试下一个位置
    }
  }
  return app.getVersion()
}

export function createPluginHostContext(overrides?: Partial<PluginHostContext>): PluginHostContext {
  const userData = app.getPath('userData')
  return {
    root: join(userData, 'plugins'),
    dataRoot: join(userData, 'plugin-data'),
    statePath: join(userData, 'plugins-state.json'),
    appVersion: appVersion(),
    preferDevMarket: false,
    ...overrides
  }
}
