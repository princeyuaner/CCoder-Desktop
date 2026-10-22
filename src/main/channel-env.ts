import type { Channel } from '../shared/settings'

/**
 * 渠道 → CLI 环境变量。这是整个渠道功能的**唯一**翻译点：
 * 想支持新协议（如 openai 兼容）时，只在这里加一个分支。
 */
export function channelToEnv(ch: Channel): Record<string, string> {
  const env: Record<string, string> = {}

  if (ch.kind === 'anthropic') {
    if (ch.baseUrl.trim()) env.ANTHROPIC_BASE_URL = ch.baseUrl.trim().replace(/\/+$/, '')
    if (ch.authToken.trim()) {
      if (ch.authMode === 'key') env.ANTHROPIC_API_KEY = ch.authToken.trim()
      else env.ANTHROPIC_AUTH_TOKEN = ch.authToken.trim()
    }
    if (ch.model.trim()) env.ANTHROPIC_MODEL = ch.model.trim()
    if (ch.smallFastModel.trim()) env.ANTHROPIC_SMALL_FAST_MODEL = ch.smallFastModel.trim()
  }

  for (const kv of ch.extraEnv) {
    const k = kv.key.trim()
    if (k) env[k] = kv.value
  }
  return env
}

/** 渠道是否填够了能用的最小信息 */
export function channelIsUsable(ch: Channel | undefined | null): ch is Channel {
  return !!ch && !!ch.baseUrl.trim() && !!ch.authToken.trim() && !!ch.model.trim()
}
