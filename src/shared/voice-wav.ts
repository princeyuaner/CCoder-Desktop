/**
 * PCM Float32 → 16-bit 单声道 WAV。
 *
 * 放在 shared 里是因为两边都要用：
 *  - 渲染层把录音重采样到 16k 后编码；
 *  - 主进程「测试连接」时生成一小段静音 WAV，走同一条转写链路。
 *
 * 只支持 16-bit PCM —— 语音接口吃这个格式，没必要引入编码器。
 */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2
  const out = new Uint8Array(44 + dataBytes)
  const view = new DataView(out.buffer)

  const ascii = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }

  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk 大小
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // 单声道
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate = rate × 声道 × 2
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)

  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]
    const clamped = v > 1 ? 1 : v < -1 ? -1 : v
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }
  return out
}

/** 测试连接用的一小段静音；0.6s 足够让大多数接口接受。 */
export function silentWav(seconds = 0.6, sampleRate = 16000): Uint8Array {
  const frames = Math.max(1, Math.round(seconds * sampleRate))
  return encodeWavPcm16(new Float32Array(frames), sampleRate)
}
