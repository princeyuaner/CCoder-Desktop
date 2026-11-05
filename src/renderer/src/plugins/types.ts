import type { ComponentType } from 'react'
import type {
  PluginManifest,
  PluginStatusBarTone,
  PluginTier
} from '@shared/plugins'

export interface PluginStatusProps {
  workspacePath?: string
}

export interface PluginPanelProps {
  workspacePath: string
}

export interface PluginStatusTextContribution {
  kind: 'text'
  id: string
  pluginId: string
  pluginName: string
  text: string
  tone: PluginStatusBarTone
  align: 'start' | 'end'
}

export interface PluginStatusComponentContribution {
  kind: 'component'
  id: string
  pluginId: string
  pluginName: string
  component: ComponentType<PluginStatusProps>
  align: 'start' | 'end'
  order: number
}

export type PluginStatusContribution =
  | PluginStatusTextContribution
  | PluginStatusComponentContribution

export interface PluginCommandContribution {
  id: string
  pluginId: string
  pluginName: string
  key: string
  title: string
  description: string
  keywords: string[]
  run: () => void
}

export interface PluginSettingsContribution {
  id: string
  pluginId: string
  pluginName: string
  key: string
  label: string
  icon?: ComponentType<{ className?: string }>
  component: ComponentType
}

export interface PluginPanelTabContribution {
  id: string
  pluginId: string
  pluginName: string
  key: string
  label: string
  icon?: ComponentType<{ className?: string }>
  component: ComponentType<PluginPanelProps>
  order: number
}

export interface PluginContributionsState {
  statusBar: PluginStatusContribution[]
  commands: PluginCommandContribution[]
  settings: PluginSettingsContribution[]
  panelTabs: PluginPanelTabContribution[]
}

export interface PluginLoadedInfo {
  id: string
  tier: PluginTier
  manifest: PluginManifest
}

export interface PluginHostState {
  plugins: import('@shared/plugins').InstalledPlugin[]
  root: string
  contributions: PluginContributionsState
  /** 插件 id → 加载失败原因 */
  errors: Record<string, string>
  loading: boolean
  /** 已经完成 activate 的插件 id */
  loaded: string[]
}

export interface PluginDisposer {
  (): void
}

export interface PluginStorageApi {
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

export interface PluginThemeApi {
  injectCss(css: string): PluginDisposer
  setTokens(tokens: { light?: Record<string, string>; dark?: Record<string, string> }): PluginDisposer
}

export interface PluginUiApi {
  registerStatusBarItem(def: {
    key?: string
    component: ComponentType<PluginStatusProps>
    align?: 'start' | 'end'
    order?: number
  }): PluginDisposer
  registerCommand(def: {
    key: string
    title: string | (() => string)
    description?: string | (() => string)
    keywords?: string[]
    run(): void
  }): PluginDisposer
  registerSettingsSection(def: {
    key?: string
    label: string | (() => string)
    icon?: ComponentType<{ className?: string }>
    component: ComponentType
  }): PluginDisposer
  registerPanelTab(def: {
    key?: string
    label: string | (() => string)
    icon?: ComponentType<{ className?: string }>
    component: ComponentType<PluginPanelProps>
    order?: number
  }): PluginDisposer
}

export interface PluginEventsApi {
  on(topic: string, cb: (data: unknown) => void): PluginDisposer
  emit(topic: string, data: unknown): void
}

/**
 * 插件 activate(ctx) 拿到的能力面。
 *
 * v1 只实现这里列出的方法；manifest 里声明了别的权限也不会凭空长出方法。
 * 所有方法都会先查 manifest.permissions，未声明的能力调用即抛错。
 */
export interface PluginContext {
  pluginId: string
  version: string
  react: typeof import('react')
  host: {
    appVersion: string
    sdkVersion: string
    locale: string
    isWeb: false
  }
  ui: PluginUiApi
  theme: PluginThemeApi
  storage: PluginStorageApi
  events: PluginEventsApi
}
