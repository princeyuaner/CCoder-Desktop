import { join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { app, safeStorage } from 'electron'
import {
  CLI_IDS,
  DEFAULT_EFFORT,
  defaultSettings,
  emptyCliConfig,
  isCliAuthMode,
  isEffortLevel,
  normalizeSettings,
  type Channel,
  type CliConfig,
  type CliId,
  type Settings
} from '../shared/settings'

/**
 * 设置的落盘格式。密钥**不存明文**：优先用 Electron 的 safeStorage
 * （Windows 走 DPAPI，绑定当前用户），拿不到时才降级为明文并在 v 上标记。
 */
interface StoredSecret {
  /** 1 = safeStorage 加密；0 = 明文降级 */
  v: 1 | 0
  enc?: string
  plain?: string
}

type StoredChannel = Omit<Channel, 'authToken'> & { secret: StoredSecret }
type StoredCli = Omit<CliConfig, 'channels'> & { channels: StoredChannel[] }

/**
 * v2：渠道挂在 clis.<id> 下面，每个 CLI 一份。
 * v1：渠道是全局的（顶层 channels + activeChannelId），那时只有 Claude Code。
 * 两个字段都保留在类型里，是为了读得进旧文件 —— 写出去的一律是 v2。
 */
interface StoredSettings {
  clis?: Partial<Record<CliId, StoredCli>>
  language?: Settings['language']
  permissionMode?: Settings['permissionMode']
  defaultCwd?: string
  openedCwds?: string[]
  theme?: Settings['theme']
  uiZoom?: number
  chatFontSize?: number
  uiFont?: string
  monoFont?: string
  showTimestamps?: boolean
  thinkingOpen?: boolean
  toolDetail?: Settings['toolDetail']
  sendKey?: Settings['sendKey']
  editor?: Settings['editor']
  lsp?: Settings['lsp']
  /** @deprecated v1 遗留，只在读取时兼容 */
  activeChannelId?: string | null
  /** @deprecated v1 遗留，只在读取时兼容 */
  channels?: StoredChannel[]
}

function file(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function seal(plain: string): StoredSecret {
  if (!plain) return { v: 0, plain: '' }
  if (safeStorage.isEncryptionAvailable()) {
    return { v: 1, enc: safeStorage.encryptString(plain).toString('base64') }
  }
  return { v: 0, plain }
}

function unseal(s: StoredSecret | undefined): string {
  if (!s) return ''
  if (s.v === 1 && s.enc) {
    try {
      return safeStorage.decryptString(Buffer.from(s.enc, 'base64'))
    } catch {
      // 换机器 / 换用户后旧密文解不开，当作空而不是崩掉
      return ''
    }
  }
  return s.plain ?? ''
}

/** 取落盘的 clis，顺带把 v1 的扁平格式搬到 clis.claude 上（不丢用户已配的渠道） */
function storedClis(raw: StoredSettings): Partial<Record<CliId, StoredCli>> {
  if (raw.clis) return raw.clis
  if (Array.isArray(raw.channels)) {
    return {
      claude: {
        enabled: true,
        activeChannelId: raw.activeChannelId ?? null,
        channels: raw.channels,
        // v1 还没有这两档，补默认值 —— 反正 normalizeSettings 也会兜一次
        effort: DEFAULT_EFFORT,
        authMode: 'channel',
        officialModel: ''
      }
    }
  }
  return {}
}

export function loadSettings(): Settings {
  let raw: StoredSettings
  try {
    raw = JSON.parse(readFileSync(file(), 'utf8')) as StoredSettings
  } catch {
    // 文件不存在或坏了都回到默认值，绝不因此启动失败
    return defaultSettings()
  }

  const stored = storedClis(raw)
  const clis = {} as Record<CliId, CliConfig>
  for (const id of CLI_IDS) {
    const c = stored[id]
    const empty = emptyCliConfig(id)
    clis[id] = {
      enabled: c?.enabled ?? empty.enabled,
      activeChannelId: c?.activeChannelId ?? null,
      channels: (c?.channels ?? []).map(({ secret, ...rest }) => ({
        ...rest,
        authToken: unseal(secret)
      })) as Channel[],
      effort: isEffortLevel(c?.effort) ? c.effort : empty.effort,
      // 必须原样认下两种值：dsh 的 empty.authMode 是 official，早先这里
      // 只认 'official'，用户切到「API 渠道」后一落盘就被读回 official，
      // 界面上看起来就是根本切不过去。
      authMode: isCliAuthMode(c?.authMode) ? c.authMode : empty.authMode,
      officialModel:
        typeof c?.officialModel === 'string' ? c.officialModel : empty.officialModel
    }
  }

  return normalizeSettings({
    clis,
    language: raw.language,
    permissionMode: raw.permissionMode,
    defaultCwd: raw.defaultCwd,
    openedCwds: raw.openedCwds,
    theme: raw.theme,
    uiZoom: raw.uiZoom,
    chatFontSize: raw.chatFontSize,
    uiFont: raw.uiFont,
    monoFont: raw.monoFont,
    showTimestamps: raw.showTimestamps,
    thinkingOpen: raw.thinkingOpen,
    toolDetail: raw.toolDetail,
    sendKey: raw.sendKey,
    editor: raw.editor,
    lsp: raw.lsp
  })
}

export function saveSettings(s: Settings): void {
  const clis = {} as Record<CliId, StoredCli>
  for (const id of CLI_IDS) {
    const c = s.clis?.[id] ?? emptyCliConfig(id)
    clis[id] = {
      enabled: c.enabled,
      activeChannelId: c.activeChannelId,
      channels: c.channels.map(({ authToken, ...rest }) => ({
        ...rest,
        secret: seal(authToken)
      })),
      effort: c.effort,
      authMode: c.authMode,
      officialModel: c.officialModel
    }
  }

  const stored: StoredSettings = {
    clis,
    language: s.language,
    permissionMode: s.permissionMode,
    defaultCwd: s.defaultCwd,
    // 少了这一行，打开过的工作区一重启就全没了（StoredSettings 字段全是可选的，
    // 漏写不报错 —— 只能靠这条注释和下面的落盘验证兜着）
    openedCwds: s.openedCwds ?? [],
    theme: s.theme,
    uiZoom: s.uiZoom,
    chatFontSize: s.chatFontSize,
    uiFont: s.uiFont,
    monoFont: s.monoFont,
    showTimestamps: s.showTimestamps,
    thinkingOpen: s.thinkingOpen,
    toolDetail: s.toolDetail,
    sendKey: s.sendKey,
    editor: s.editor,
    lsp: s.lsp
  }

  const target = file()
  mkdirSync(join(target, '..'), { recursive: true })
  // 先写临时文件再改名：中途崩溃不会留下半个坏文件
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(stored, null, 2), 'utf8')
  renameSync(tmp, target)
}
