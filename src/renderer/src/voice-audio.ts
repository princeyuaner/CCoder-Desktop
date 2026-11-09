import { encodeWavPcm16 } from '@shared/voice-wav'

export interface VoiceAudio {
  data: Uint8Array
  mime: string
}

/** 语音接口对采样率有要求，统一转 16k 单声道；WAV 是最通用的容器。 */
const TARGET_RATE = 16000

/**
 * 浏览器录出来的是 webm/opus，先解码再重采样成 16k 单声道 WAV。
 *
 * MediaRecorder 的容器在一些端点 / 网关上的兼容性不如 WAV；解码失败时
 * 退回原始字节（带上真实 MIME），至少还有一次机会，而不是直接报错。
 */
export async function blobToVoiceAudio(blob: Blob): Promise<VoiceAudio> {
  const original = new Uint8Array(await blob.arrayBuffer())
  let ctx: AudioContext | null = null
  try {
    ctx = new AudioContext()
    // decodeAudioData 会 detach 传入的 ArrayBuffer，给一份拷贝
    const decoded = await ctx.decodeAudioData(original.slice().buffer)
    const frames = Math.max(1, Math.ceil((decoded.length / decoded.sampleRate) * TARGET_RATE))
    const offline = new OfflineAudioContext(1, frames, TARGET_RATE)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    const rendered = await offline.startRendering()
    return {
      data: encodeWavPcm16(rendered.getChannelData(0), TARGET_RATE),
      mime: 'audio/wav'
    }
  } catch {
    return { data: original, mime: blob.type || 'audio/webm' }
  } finally {
    void ctx?.close().catch(() => undefined)
  }
}
