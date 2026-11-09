import { useCallback, useEffect, useRef, useState } from 'react'
import type { VoiceErrorCode, VoiceSettings } from '@shared/voice'
import { blobToVoiceAudio } from './voice-audio'

export type VoiceStatus = 'idle' | 'recording' | 'transcribing'

export interface VoiceInputError {
  code: VoiceErrorCode
  detail?: string
}

export interface VoiceInputApi {
  status: VoiceStatus
  elapsedMs: number
  error: VoiceInputError | null
  clearError(): void
  start(): void
  stop(): void
  cancel(): void
}

/** 单次录音上限：16k 单声道 120 秒约 3.8 MB，远低于接口的 25 MB 上限 */
const MAX_RECORD_MS = 120_000
/** 太短的录音转出来多半是空文本，直接提示而不是发一次无意义的请求 */
const MIN_RECORD_MS = 350

function micErrorCode(e: unknown): VoiceErrorCode {
  const name = (e as { name?: string })?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'mic-denied'
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'mic-not-found'
  return 'unsupported'
}

function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? ''
}

/**
 * 录音 → 转写 → 交回文本。
 *
 * 状态机只有三档：idle / recording / transcribing。文本插入、撤销、自动发送
 * 都由 Composer 决定 —— 这个 hook 不碰输入框，只负责「拿到一段文字」。
 */
export function useVoiceInput(opts: {
  settings: VoiceSettings
  onText: (text: string) => void
}): VoiceInputApi {
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [error, setError] = useState<VoiceInputError | null>(null)

  const settingsRef = useRef(opts.settings)
  settingsRef.current = opts.settings
  const onTextRef = useRef(opts.onText)
  onTextRef.current = opts.onText

  const statusRef = useRef<VoiceStatus>('idle')
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<number | null>(null)
  const maxTimerRef = useRef<number | null>(null)
  const startedAtRef = useRef(0)
  const discardRef = useRef(false)
  const requestIdRef = useRef(0)
  const mountedRef = useRef(true)
  /** getUserMedia 还没 resolve 时再点一次麦克风，不能起第二路录音 */
  const startingRef = useRef(false)
  const stopRef = useRef<() => void>(() => undefined)

  const setStatusSafe = useCallback((next: VoiceStatus): void => {
    statusRef.current = next
    setStatus(next)
  }, [])

  const clearTimers = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (maxTimerRef.current !== null) {
      window.clearTimeout(maxTimerRef.current)
      maxTimerRef.current = null
    }
  }, [])

  const stopTracks = useCallback((): void => {
    const stream = streamRef.current
    streamRef.current = null
    stream?.getTracks().forEach((track) => {
      try {
        track.stop()
      } catch {
        // 设备已经拔掉 / 轨道已经结束，忽略
      }
    })
  }, [])

  /** 录音结束后的统一出口：短录音提示、取消丢弃、否则转写。 */
  const finish = useCallback(
    async (mime: string | undefined): Promise<void> => {
      clearTimers()
      stopTracks()
      recorderRef.current = null
      const elapsed = Date.now() - startedAtRef.current
      const discard = discardRef.current
      discardRef.current = false
      setElapsedMs(0)

      if (discard) {
        setStatusSafe('idle')
        return
      }
      if (elapsed < MIN_RECORD_MS) {
        chunksRef.current = []
        setStatusSafe('idle')
        setError({ code: 'too-short' })
        return
      }

      const blob = new Blob(chunksRef.current, { type: mime || 'audio/webm' })
      chunksRef.current = []
      if (blob.size === 0) {
        setStatusSafe('idle')
        setError({ code: 'too-short' })
        return
      }

      const requestId = ++requestIdRef.current
      setStatusSafe('transcribing')
      try {
        const audio = await blobToVoiceAudio(blob)
        if (!mountedRef.current || requestId !== requestIdRef.current) return
        if (audio.data.byteLength === 0) {
          setStatusSafe('idle')
          setError({ code: 'empty' })
          return
        }

        const res = await window.api?.voice.transcribe(audio)
        if (!mountedRef.current || requestId !== requestIdRef.current) return
        if (!res) {
          setStatusSafe('idle')
          setError({ code: 'unsupported' })
          return
        }
        if (!res.ok) {
          setStatusSafe('idle')
          setError({ code: res.error, detail: res.detail })
          return
        }
        const text = res.text.trim()
        setStatusSafe('idle')
        if (text) onTextRef.current(text)
        else setError({ code: 'empty' })
      } catch (e) {
        if (!mountedRef.current || requestId !== requestIdRef.current) return
        setStatusSafe('idle')
        setError({ code: 'network', detail: (e as Error)?.message })
      }
    },
    [clearTimers, setStatusSafe, stopTracks]
  )

  const start = useCallback((): void => {
    if (statusRef.current !== 'idle' || startingRef.current) return
    const settings = settingsRef.current
    if (!settings.enabled) {
      setError({ code: 'disabled' })
      return
    }
    if (!settings.baseUrl.trim()) {
      setError({ code: 'no-endpoint' })
      return
    }
    if (!settings.model.trim()) {
      setError({ code: 'no-model' })
      return
    }
    if (!settings.apiKey.trim()) {
      setError({ code: 'no-key' })
      return
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError({ code: 'unsupported' })
      return
    }

    setError(null)
    startingRef.current = true
    void (async () => {
      try {
        const allowed = await window.api?.voice.ensureMicAccess()
        if (allowed === false) {
          startingRef.current = false
          setError({ code: 'mic-denied' })
          return
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: { ideal: true },
            noiseSuppression: { ideal: true },
            autoGainControl: { ideal: true }
          }
        })
        if (!mountedRef.current) {
          startingRef.current = false
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = stream

        const mime = pickMime()
        const recorder = mime
          ? new MediaRecorder(stream, { mimeType: mime })
          : new MediaRecorder(stream)
        recorderRef.current = recorder
        chunksRef.current = []
        discardRef.current = false

        recorder.ondataavailable = (e: BlobEvent): void => {
          if (e.data.size > 0) chunksRef.current.push(e.data)
        }
        recorder.onstop = (): void => {
          void finish(recorder.mimeType || mime)
        }
        recorder.onerror = (): void => {
          discardRef.current = true
          setError({ code: 'unsupported' })
          try {
            if (recorder.state !== 'inactive') recorder.stop()
          } catch {
            stopTracks()
            clearTimers()
            setStatusSafe('idle')
          }
        }

        startedAtRef.current = Date.now()
        setElapsedMs(0)
        setStatusSafe('recording')
        startingRef.current = false
        recorder.start(250)
        timerRef.current = window.setInterval(() => {
          setElapsedMs(Date.now() - startedAtRef.current)
        }, 200)
        maxTimerRef.current = window.setTimeout(() => {
          if (statusRef.current === 'recording') stopRef.current()
        }, MAX_RECORD_MS)
      } catch (e) {
        startingRef.current = false
        stopTracks()
        clearTimers()
        setStatusSafe('idle')
        setError({ code: micErrorCode(e), detail: (e as Error)?.message })
      }
    })()
  }, [clearTimers, finish, setStatusSafe, stopTracks])

  const stop = useCallback((): void => {
    if (statusRef.current !== 'recording') return
    const recorder = recorderRef.current
    clearTimers()
    if (!recorder) {
      stopTracks()
      setStatusSafe('idle')
      return
    }
    try {
      if (recorder.state === 'inactive') void finish(recorder.mimeType)
      else recorder.stop()
    } catch {
      stopTracks()
      setStatusSafe('idle')
    }
  }, [clearTimers, finish, setStatusSafe, stopTracks])

  stopRef.current = stop

  const cancel = useCallback((): void => {
    if (statusRef.current === 'recording') {
      discardRef.current = true
      const recorder = recorderRef.current
      clearTimers()
      if (!recorder || recorder.state === 'inactive') {
        stopTracks()
        setStatusSafe('idle')
        return
      }
      try {
        recorder.stop()
      } catch {
        stopTracks()
        setStatusSafe('idle')
      }
      return
    }
    if (statusRef.current === 'transcribing') {
      // 请求没法从渲染层 abort，但可以让结果到达时被丢弃
      requestIdRef.current++
      setStatusSafe('idle')
    }
  }, [clearTimers, setStatusSafe, stopTracks])

  const clearError = useCallback((): void => setError(null), [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestIdRef.current++
      discardRef.current = true
      startingRef.current = false
      clearTimers()
      const recorder = recorderRef.current
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop()
        } catch {
          // 卸载阶段的清理，失败也不能影响关闭
        }
      }
      stopTracks()
    }
  }, [clearTimers, stopTracks])

  return { status, elapsedMs, error, clearError, start, stop, cancel }
}
