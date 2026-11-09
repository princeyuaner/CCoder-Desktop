import { systemPreferences } from 'electron'
import { logMain } from './crash-log'
import { silentWav } from '../shared/voice-wav'
import {
  normalizeVoiceSettings,
  type VoiceErrorCode,
  type VoiceSettings,
  type VoiceTestResult,
  type VoiceTranscribeRequest,
  type VoiceTranscribeResult
} from '../shared/voice'

/**
 * 语音转写：只做 OpenAI 兼容的 `/audio/transcriptions`。
 *
 * 硅基流动 / Groq / 自填端点都吃这一套；渲染层不直接发请求（CSP 收在
 * `default-src 'self'`），音频和凭据都走主进程。
 */

const TIMEOUT_MS = 60_000
/** OpenAI 系的通用上限；我们自己的 WAV 120 秒也才 ~3.8 MB，留足余量 */
const MAX_BYTES = 25 * 1024 * 1024

/** 返回配置缺失的具体原因；配置完整时返回 null。 */
function configError(s: VoiceSettings): VoiceErrorCode | null {
  if (!s.baseUrl.trim()) return 'no-endpoint'
  if (!s.model.trim()) return 'no-model'
  if (!s.apiKey.trim()) return 'no-key'
  return null
}

/** 用户可能把完整 endpoint 直接粘进来；两种写法都认。 */
function endpointOf(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  return /\/audio\/transcriptions$/i.test(base) ? base : `${base}/audio/transcriptions`
}

function filenameFor(mime: string): string {
  if (/wav/i.test(mime)) return 'audio.wav'
  if (/webm/i.test(mime)) return 'audio.webm'
  if (/ogg/i.test(mime)) return 'audio.ogg'
  if (/mpeg|mp3/i.test(mime)) return 'audio.mp3'
  return 'audio'
}

function detailOf(body: string): string | undefined {
  if (!body) return undefined
  try {
    const json = JSON.parse(body) as {
      error?: { message?: unknown } | string
      message?: unknown
    }
    const raw =
      typeof json.error === 'string'
        ? json.error
        : typeof json.error?.message === 'string'
          ? json.error.message
          : typeof json.message === 'string'
            ? json.message
            : ''
    if (raw) return raw.slice(0, 300)
  } catch {
    // 不是 JSON 就按原文截断
  }
  return body.trim().slice(0, 300) || undefined
}

function errorCodeFor(status: number, body: string): VoiceErrorCode {
  const lower = body.toLowerCase()
  if (status === 401 || status === 403) {
    // 有的服务商把「余额不足」也回成 403，别让用户去检查 Key
    if (/balance|quota|insufficient|credit|余额|额度|欠费/.test(lower)) return 'quota'
    return 'unauthorized'
  }
  if (status === 402) return 'quota'
  if (status === 429) return 'rate-limit'
  if (status >= 500) return 'server'
  return 'bad-response'
}

async function requestTranscription(
  settings: VoiceSettings,
  data: Uint8Array,
  mime: string,
  opts: { allowEmpty?: boolean } = {}
): Promise<
  { ok: true; text: string; latencyMs: number } | { ok: false; error: VoiceErrorCode; detail?: string }
> {
  const url = endpointOf(settings.baseUrl)
  const form = new FormData()
  form.append('file', new Blob([Buffer.from(data)], { type: mime }), filenameFor(mime))
  form.append('model', settings.model)
  form.append('response_format', 'json')
  if (settings.language !== 'auto') form.append('language', settings.language)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const startedAt = Date.now()

  try {
    const res = await fetch(url, {
      method: 'POST',
      // OpenAI 兼容端点统一用 Bearer；Key 不进日志
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        Accept: 'application/json'
      },
      body: form,
      signal: controller.signal
    })
    const latencyMs = Date.now() - startedAt
    const body = await res.text()

    if (!res.ok) {
      return {
        ok: false,
        error: errorCodeFor(res.status, body),
        detail: detailOf(body)
      }
    }

    let text = ''
    try {
      const json = JSON.parse(body) as { text?: unknown }
      if (typeof json.text === 'string') text = json.text
    } catch {
      // 少数端点会直接回纯文本；没有 JSON 时按原文处理
      text = body
    }
    text = text.trim()
    if (!text && !opts.allowEmpty) return { ok: false, error: 'empty' }
    return { ok: true, text, latencyMs }
  } catch (e) {
    const aborted = (e as { name?: string })?.name === 'AbortError'
    return {
      ok: false,
      error: aborted ? 'timeout' : 'network',
      detail: aborted ? undefined : (e as Error)?.message?.slice(0, 300)
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function transcribeVoice(
  rawSettings: unknown,
  req: VoiceTranscribeRequest
): Promise<VoiceTranscribeResult> {
  const settings = normalizeVoiceSettings(rawSettings)
  if (!settings.enabled) return { ok: false, error: 'disabled' }

  const invalid = configError(settings)
  if (invalid) return { ok: false, error: invalid }

  // 跨 IPC 的输入按不可信处理：类型、大小、MIME 都验一遍
  const data = req?.data
  if (!(data instanceof Uint8Array) || data.byteLength === 0) {
    return { ok: false, error: 'empty' }
  }
  if (data.byteLength > MAX_BYTES) return { ok: false, error: 'too-large' }
  const mime = typeof req.mime === 'string' && req.mime ? req.mime : 'audio/wav'

  const result = await requestTranscription(settings, data, mime)
  if (!result.ok) {
    logMain('voice.transcribe.failed', {
      error: result.error,
      detail: result.detail,
      bytes: data.byteLength
    })
    return result
  }
  logMain('voice.transcribe.ok', { latencyMs: result.latencyMs, bytes: data.byteLength })
  return { ok: true, text: result.text, latencyMs: result.latencyMs }
}

export async function testVoice(rawSettings: unknown): Promise<VoiceTestResult> {
  const settings = normalizeVoiceSettings(rawSettings)
  const invalid = configError(settings)
  if (invalid) return { ok: false, error: invalid }

  // 用一小段静音走真实链路：验的是地址 / Key / 模型是否能通，
  // 而不是只看域名能不能解析。静音转出空文本也算成功。
  const result = await requestTranscription(settings, silentWav(0.6), 'audio/wav', {
    allowEmpty: true
  })
  if (!result.ok) {
    logMain('voice.test.failed', { error: result.error, detail: result.detail })
    return result
  }
  logMain('voice.test.ok', { latencyMs: result.latencyMs })
  return { ok: true, latencyMs: result.latencyMs }
}

/**
 * macOS 的麦克风授权必须在 getUserMedia 之前主动问一次；Windows / Linux
 * 由 Chromium 在 getUserMedia 时弹系统提示，这里直接放行。
 */
export async function ensureMicAccess(): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  try {
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'granted') return true
    if (status === 'denied' || status === 'restricted') return false
    return await systemPreferences.askForMediaAccess('microphone')
  } catch {
    // 拿不到状态就交给 getUserMedia 自己报错，别在这里挡住用户
    return true
  }
}
