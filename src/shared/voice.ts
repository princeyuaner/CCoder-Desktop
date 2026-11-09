import type { MessageKey } from './i18n/catalog'

/**
 * 语音输入的服务商。
 *
 * v1 只做云端 OpenAI 兼容接口（硅基流动 / Groq / 自填），不做本地 whisper.cpp
 * —— 本地模型要额外分发二进制、下载几百 MB 模型，先不把复杂度带进来。
 */
export type VoiceProvider = 'siliconflow' | 'groq' | 'custom'

/** `auto` = 不向接口传 language，让服务商自己判断 */
export type VoiceLanguage = 'auto' | 'zh' | 'en'

/** 转写结果怎么进输入框 */
export type VoiceInsertMode = 'caret' | 'append'

export interface VoiceSettings {
  /** 关闭后输入框底栏不显示麦克风 */
  enabled: boolean
  provider: VoiceProvider
  /**
   * OpenAI 兼容根地址，例如 https://api.siliconflow.cn/v1
   * 末尾带不带 `/audio/transcriptions` 都能识别。
   */
  baseUrl: string
  apiKey: string
  model: string
  language: VoiceLanguage
  insertMode: VoiceInsertMode
  /** 转写完成后直接发送。默认关：识别有错字，先看一眼更稳 */
  autoSend: boolean
}

export interface VoicePreset {
  baseUrl: string
  model: string
}

/**
 * 预设只提供「地址 + 模型」两个默认值，Key 必须由用户自己填。
 * 免费额度会变，所以地址和模型在设置页里始终可编辑。
 */
export const VOICE_PRESETS: Record<'siliconflow' | 'groq', VoicePreset> = {
  siliconflow: {
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/SenseVoiceSmall'
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3-turbo'
  }
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: true,
  provider: 'siliconflow',
  ...VOICE_PRESETS.siliconflow,
  apiKey: '',
  language: 'auto',
  insertMode: 'caret',
  autoSend: false
}

function isProvider(v: unknown): v is VoiceProvider {
  return v === 'siliconflow' || v === 'groq' || v === 'custom'
}

function textOr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v.trim() : fallback
}

/**
 * 旧配置 / 手写测试数据 / 跨 IPC 的不可信输入都从这里过一遍。
 * 自定义服务商没有预设兜底：地址和模型留空就保持空，交给调用方报「未配置」。
 */
export function normalizeVoiceSettings(raw: unknown): VoiceSettings {
  const src =
    raw && typeof raw === 'object' ? (raw as Partial<VoiceSettings>) : ({} as Partial<VoiceSettings>)
  const provider = isProvider(src.provider) ? src.provider : 'siliconflow'
  const preset = provider === 'custom' ? { baseUrl: '', model: '' } : VOICE_PRESETS[provider]
  return {
    enabled: src.enabled !== false,
    provider,
    baseUrl: textOr(src.baseUrl, preset.baseUrl),
    model: textOr(src.model, preset.model),
    apiKey: typeof src.apiKey === 'string' ? src.apiKey : '',
    language: src.language === 'zh' || src.language === 'en' ? src.language : 'auto',
    insertMode: src.insertMode === 'append' ? 'append' : 'caret',
    autoSend: src.autoSend === true
  }
}

/** 主进程 → 渲染层的失败原因。文案在 i18n 里，主进程只回码。 */
export type VoiceErrorCode =
  | 'disabled'
  | 'no-endpoint'
  | 'no-model'
  | 'no-key'
  | 'unauthorized'
  | 'quota'
  | 'rate-limit'
  | 'network'
  | 'timeout'
  | 'server'
  | 'bad-response'
  | 'empty'
  | 'too-large'
  | 'unsupported'
  | 'mic-denied'
  | 'mic-not-found'
  | 'too-short'

export const VOICE_ERROR_KEY: Record<VoiceErrorCode, MessageKey> = {
  disabled: 'voice.error.disabled',
  'no-endpoint': 'voice.error.noEndpoint',
  'no-model': 'voice.error.noModel',
  'no-key': 'voice.error.noKey',
  unauthorized: 'voice.error.unauthorized',
  quota: 'voice.error.quota',
  'rate-limit': 'voice.error.rateLimit',
  network: 'voice.error.network',
  timeout: 'voice.error.timeout',
  server: 'voice.error.server',
  'bad-response': 'voice.error.badResponse',
  empty: 'voice.error.empty',
  'too-large': 'voice.error.tooLarge',
  unsupported: 'voice.error.unsupported',
  'mic-denied': 'voice.error.micDenied',
  'mic-not-found': 'voice.error.micNotFound',
  'too-short': 'voice.error.tooShort'
}

export interface VoiceTranscribeRequest {
  /**
   * 渲染层优先转成 16kHz 单声道 WAV；浏览器解不开时退回原始 webm/opus。
   * 主进程按不可信输入处理：查类型、查大小，不直接落盘。
   */
  data: Uint8Array
  mime: string
}

export type VoiceTranscribeResult =
  | { ok: true; text: string; latencyMs: number }
  | { ok: false; error: VoiceErrorCode; detail?: string }

export type VoiceTestResult =
  | { ok: true; latencyMs: number }
  | { ok: false; error: VoiceErrorCode; detail?: string }
