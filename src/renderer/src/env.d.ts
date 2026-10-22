/// <reference types="vite/client" />
import type { WindowApi } from '@shared/ipc'

declare global {
  interface Window {
    /** preload 注入。浏览器里跑（纯 vite dev）时不存在，调用方需兜底。 */
    api?: WindowApi
  }
}

export {}
