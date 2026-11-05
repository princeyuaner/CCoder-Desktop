import * as React from 'react'
import type { ComponentType } from 'react'
import type { InstalledPlugin, PluginManifest } from '@shared/plugins'
import { PLUGIN_SDK_VERSION } from '@shared/plugins'
import { getLocale } from '../i18n'
import type {
  PluginCommandContribution,
  PluginContext,
  PluginPanelTabContribution,
  PluginSettingsContribution,
  PluginStatusComponentContribution
} from './types'

const STORAGE_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/

export interface PluginContextDeps {
  plugin: InstalledPlugin
  manifest: PluginManifest
  appVersion: string
  onDispose(fn: () => void): void
  addStatusBar(item: PluginStatusComponentContribution): () => void
  addCommand(item: PluginCommandContribution): () => void
  addSettings(item: PluginSettingsContribution): () => void
  addPanelTab(item: PluginPanelTabContribution): () => void
  injectCss(css: string): () => void
  injectTokens(tokens: { light?: Record<string, string>; dark?: Record<string, string> }): () => void
  eventsOn(topic: string, cb: (data: unknown) => void): () => void
  eventsEmit(topic: string, data: unknown): void
}

function uid(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

function requirePermission(manifest: PluginManifest, permission: string): void {
  if (!manifest.permissions.includes(permission)) {
    throw new Error(`plugin ${manifest.id} used ${permission} without declaring it`)
  }
}

function labelOf(value: string | (() => string), fallback: string): string {
  let label: unknown = value
  try {
    label = typeof value === 'function' ? value() : value
  } catch {
    label = fallback
  }
  return typeof label === 'string' && label.trim()
    ? label.trim().slice(0, 200)
    : fallback
}

function componentOf(value: unknown): ComponentType<any> {
  if (typeof value === 'function' || (typeof value === 'object' && value !== null)) {
    return value as ComponentType<any>
  }
  throw new Error('invalid-component')
}

function storageKey(key: unknown): string {
  const value = typeof key === 'string' ? key.trim() : ''
  if (!STORAGE_KEY_RE.test(value)) throw new Error('invalid-storage-key')
  return value
}

/**
 * 构造一个插件的 ctx。所有能力先查 manifest 权限；未声明时立即抛错，
 * 让插件在 activate 阶段就暴露问题，而不是静默拿到一个空实现。
 */
export function createPluginContext(deps: PluginContextDeps): PluginContext {
  const { manifest } = deps
  const id = (prefix: string): string => `${prefix}:${manifest.id}:${uid()}`

  const registerCommand = (item: PluginCommandContribution): (() => void) => {
    const remove = deps.addCommand(item)
    deps.onDispose(remove)
    return remove
  }

  const registerStatus = (item: PluginStatusComponentContribution): (() => void) => {
    const remove = deps.addStatusBar(item)
    deps.onDispose(remove)
    return remove
  }

  const registerSettings = (item: PluginSettingsContribution): (() => void) => {
    const remove = deps.addSettings(item)
    deps.onDispose(remove)
    return remove
  }

  const registerPanel = (item: PluginPanelTabContribution): (() => void) => {
    const remove = deps.addPanelTab(item)
    deps.onDispose(remove)
    return remove
  }

  return {
    pluginId: manifest.id,
    version: manifest.version,
    react: React,
    host: {
      appVersion: deps.appVersion,
      sdkVersion: PLUGIN_SDK_VERSION,
      locale: getLocale(),
      isWeb: false
    },
    ui: {
      registerStatusBarItem(def) {
        requirePermission(manifest, 'ui:status-bar')
        const component = componentOf(def.component) as ComponentType<{
          workspacePath?: string
        }>
        return registerStatus({
          kind: 'component',
          id: id('status'),
          pluginId: manifest.id,
          pluginName: manifest.name,
          component,
          align: def.align === 'end' ? 'end' : 'start',
          order: typeof def.order === 'number' && Number.isFinite(def.order) ? def.order : 100
        })
      },
      registerCommand(def) {
        requirePermission(manifest, 'ui:command')
        const key = typeof def.key === 'string' ? def.key.trim() : ''
        if (!key) throw new Error('command-key-required')
        if (typeof def.run !== 'function') throw new Error('command-run-required')
        return registerCommand({
          id: id('command'),
          pluginId: manifest.id,
          pluginName: manifest.name,
          key: key.slice(0, 80),
          title: labelOf(def.title, key),
          description: def.description ? labelOf(def.description, '') : '',
          keywords: Array.isArray(def.keywords)
            ? def.keywords.filter((x): x is string => typeof x === 'string').slice(0, 20)
            : [],
          run: () => {
            try {
              def.run()
            } catch (e) {
              console.error(`[plugin:${manifest.id}] command ${key} failed`, e)
            }
          }
        })
      },
      registerSettingsSection(def) {
        requirePermission(manifest, 'ui:settings-section')
        const key = typeof def.key === 'string' && def.key.trim() ? def.key.trim() : 'main'
        return registerSettings({
          id: id('settings'),
          pluginId: manifest.id,
          pluginName: manifest.name,
          key: key.slice(0, 80),
          label: labelOf(def.label, manifest.name),
          ...(def.icon ? { icon: def.icon } : {}),
          component: componentOf(def.component)
        })
      },
      registerPanelTab(def) {
        requirePermission(manifest, 'ui:panel-tab')
        const key = typeof def.key === 'string' && def.key.trim() ? def.key.trim() : 'main'
        return registerPanel({
          id: id('panel'),
          pluginId: manifest.id,
          pluginName: manifest.name,
          key: key.slice(0, 80),
          label: labelOf(def.label, manifest.name),
          ...(def.icon ? { icon: def.icon } : {}),
          component: componentOf(def.component) as ComponentType<{ workspacePath: string }>,
          order: typeof def.order === 'number' && Number.isFinite(def.order) ? def.order : 100
        })
      }
    },
    theme: {
      injectCss(css) {
        requirePermission(manifest, 'theme')
        if (typeof css !== 'string' || !css.trim()) throw new Error('css-required')
        const remove = deps.injectCss(css)
        deps.onDispose(remove)
        return remove
      },
      setTokens(tokens) {
        requirePermission(manifest, 'theme')
        if (!tokens || typeof tokens !== 'object') throw new Error('tokens-required')
        const remove = deps.injectTokens(tokens)
        deps.onDispose(remove)
        return remove
      }
    },
    storage: {
      async get<T>(key: string): Promise<T | null> {
        requirePermission(manifest, 'storage')
        const api = window.api?.plugins
        if (!api) throw new Error('plugin-api-unavailable')
        const result = await api.storage.get(manifest.id, storageKey(key))
        if (!result.ok) throw new Error(result.error ?? 'storage-read-failed')
        return (result.value ?? null) as T | null
      },
      async set(key: string, value: unknown): Promise<void> {
        requirePermission(manifest, 'storage')
        const api = window.api?.plugins
        if (!api) throw new Error('plugin-api-unavailable')
        const result = await api.storage.set(manifest.id, storageKey(key), value)
        if (!result.ok) throw new Error(result.error ?? 'storage-write-failed')
      },
      async delete(key: string): Promise<void> {
        requirePermission(manifest, 'storage')
        const api = window.api?.plugins
        if (!api) throw new Error('plugin-api-unavailable')
        const result = await api.storage.delete(manifest.id, storageKey(key))
        if (!result.ok) throw new Error(result.error ?? 'storage-delete-failed')
      }
    },
    events: {
      on(topic, cb) {
        requirePermission(manifest, 'events')
        if (typeof topic !== 'string' || !topic.trim()) throw new Error('topic-required')
        if (typeof cb !== 'function') throw new Error('listener-required')
        const off = deps.eventsOn(topic.trim().slice(0, 120), cb)
        deps.onDispose(off)
        return off
      },
      emit(topic, data) {
        requirePermission(manifest, 'events')
        if (typeof topic !== 'string' || !topic.trim()) throw new Error('topic-required')
        deps.eventsEmit(topic.trim().slice(0, 120), data)
      }
    }
  }
}
