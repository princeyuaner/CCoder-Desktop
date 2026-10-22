import type { PermissionMode } from '@shared/events'

export const MODE_LABEL: Record<PermissionMode, string> = {
  standard: '标准模式',
  acceptEdits: '接受编辑',
  auto: '自动',
  plan: '仅计划',
  dontAsk: '不再询问',
  bypassPermissions: '跳过权限'
}

export const PERMISSION_MODES: PermissionMode[] = [
  'standard',
  'acceptEdits',
  'auto',
  'plan',
  'dontAsk',
  'bypassPermissions'
]

export const MODE_HINT: Record<PermissionMode, string> = {
  standard: '每次改动与命令都问你',
  acceptEdits: '自动接受文件编辑，命令仍会问',
  auto: '由模型自行判断，少打扰',
  plan: '只出计划，不动手',
  dontAsk: '不问，直接按允许清单执行',
  bypassPermissions: '跳过所有权限检查（仅在沙箱里用）'
}

export const COMPOSER_MODE_LABEL = '工作区内修改'
