import type { PermissionMode } from '@shared/events'
import type { MessageKey } from '@shared/i18n'

/** 权限模式的展示文案 key；具体语言在渲染时解析 */
export const MODE_LABEL_KEY: Record<PermissionMode, MessageKey> = {
  standard: 'mode.standard',
  acceptEdits: 'mode.acceptEdits',
  auto: 'mode.auto',
  plan: 'mode.plan',
  dontAsk: 'mode.dontAsk',
  bypassPermissions: 'mode.bypassPermissions'
}

export const PERMISSION_MODES: PermissionMode[] = [
  'standard',
  'acceptEdits',
  'auto',
  'plan',
  'dontAsk',
  'bypassPermissions'
]

export const MODE_HINT_KEY: Record<PermissionMode, MessageKey> = {
  standard: 'modeHint.standard',
  acceptEdits: 'modeHint.acceptEdits',
  auto: 'modeHint.auto',
  plan: 'modeHint.plan',
  dontAsk: 'modeHint.dontAsk',
  bypassPermissions: 'modeHint.bypassPermissions'
}

export const COMPOSER_MODE_LABEL_KEY: MessageKey = 'composer.workspaceEdit'
