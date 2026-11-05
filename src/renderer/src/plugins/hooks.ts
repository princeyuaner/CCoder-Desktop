import { useSyncExternalStore } from 'react'
import { getPluginHostState, subscribePluginHost } from './host'
import type {
  PluginCommandContribution,
  PluginHostState,
  PluginPanelTabContribution,
  PluginSettingsContribution,
  PluginStatusContribution
} from './types'

export function usePluginHost(): PluginHostState {
  return useSyncExternalStore(subscribePluginHost, getPluginHostState, getPluginHostState)
}

export function usePluginStatusContributions(): PluginStatusContribution[] {
  return usePluginHost().contributions.statusBar
}

export function usePluginCommands(): PluginCommandContribution[] {
  return usePluginHost().contributions.commands
}

export function usePluginSettingsSections(): PluginSettingsContribution[] {
  return usePluginHost().contributions.settings
}

export function usePluginPanelTabs(): PluginPanelTabContribution[] {
  return usePluginHost().contributions.panelTabs
}
