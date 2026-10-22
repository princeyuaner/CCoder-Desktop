import { useCallback, useEffect, useState } from 'react'
import { defaultSettings, type Channel, type ChannelTestResult, type Settings } from '@shared/settings'

export interface SettingsApi {
  settings: Settings
  loading: boolean
  /** 返回主进程规范化后真正落盘的那份 —— 设置页拿它对齐 draft */
  save(next: Settings): Promise<Settings>
  test(channel: Channel): Promise<ChannelTestResult>
  /** 主进程是否可用（浏览器里跑纯 vite dev 时不可用） */
  available: boolean
}

export function useSettings(): SettingsApi {
  const [settings, setSettings] = useState<Settings>(defaultSettings)
  const [loading, setLoading] = useState(true)
  const available = typeof window !== 'undefined' && !!window.api

  useEffect(() => {
    if (!available) {
      setLoading(false)
      return
    }
    void window.api!.settings
      .get()
      .then((s) => setSettings(s))
      // 主进程没起来 / 通道没注册时也要能渲染，不能卡在「加载中」
      .catch(() => undefined)
      .finally(() => setLoading(false))
    return window.api!.settings.onChanged(setSettings)
  }, [available])

  const save = useCallback(
    async (next: Settings): Promise<Settings> => {
      if (!available) {
        setSettings(next)
        return next
      }
      const fresh = await window.api!.settings.save(next)
      setSettings(fresh)
      return fresh
    },
    [available]
  )

  const test = useCallback(
    async (channel: Channel): Promise<ChannelTestResult> => {
      if (!available) {
        return { ok: false, message: '当前不在 Electron 中运行，无法发起真实请求。', latencyMs: 0 }
      }
      return window.api!.settings.test(channel)
    },
    [available]
  )

  return { settings, loading, save, test, available }
}
