import type { Channel } from '../shared/settings'

/**
 * 渠道 → Claude Code 的环境变量。
 *
 * Codex 不走这里：它的 provider 配置是 app-server 的 `-c key=value` 覆盖，
 * 见 codex-runner.ts 的 codexConfigOverrides()。两边都保留是因为一个用
 * 进程环境、一个用 CLI 配置，没有共同的中间形态。
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
