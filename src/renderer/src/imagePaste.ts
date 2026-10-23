import type { ImageAttachment } from '@shared/attachment'
import { tr } from './i18n'

/**
 * 剪贴板 / 文件选择里的图片 → 可直接随消息发送的附件。
 *
 * 为什么要自己缩放：4K 截图原图动辄几 MB，base64 再涨 33%，还要过
 * IPC → JSON → stdin 三跳。压到最长边 1568px 后，模型的视觉输入足够，
 * 单张通常只剩几百 KB。
 */

const MAX_DIM = 1568
const MAX_COUNT = 5
const MAX_BYTES = 5 * 1024 * 1024
const ACCEPT = /^image\/(png|jpeg|webp|gif)$/i

function newId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `img-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function nameFor(file: File, index: number, mediaType: string): string {
  if (file.name && file.name.trim()) return file.name
  const ext = mediaType === 'image/jpeg' ? 'jpg' : mediaType.split('/')[1] || 'png'
  return `${tr('attachment.pastedScreenshot', { n: index + 1 })}.${ext}`
}

function toAttachment(
  file: File,
  index: number,
  data: string,
  mediaType: string,
  width: number,
  height: number,
  size: number
): ImageAttachment {
  return {
    id: newId(),
    mediaType,
    data,
    name: nameFor(file, index, mediaType),
    width,
    height,
    size
  }
}

/** 原样读取（缩放失败时的兜底）；超过上限就不要了 */
function readRaw(file: File, index: number): Promise<ImageAttachment | null> {
  if (!ACCEPT.test(file.type) || file.size > MAX_BYTES) return Promise.resolve(null)
  return new Promise((resolve) => {
    const r = new FileReader()
    r.onerror = () => resolve(null)
    r.onload = () => {
      const s = typeof r.result === 'string' ? r.result : ''
      const comma = s.indexOf(',')
      if (comma < 0) {
        resolve(null)
        return
      }
      resolve(toAttachment(file, index, s.slice(comma + 1), file.type, 0, 0, file.size))
    }
    r.readAsDataURL(file)
  })
}

export async function readImageFile(
  file: File,
  index: number
): Promise<ImageAttachment | null> {
  if (!ACCEPT.test(file.type)) return null

  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close?.()
      return readRaw(file, index)
    }
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close?.()

    // 截图优先 PNG（文字边缘干净）；照片用 JPEG 省体积
    const mediaType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    const dataUrl = canvas.toDataURL(mediaType, mediaType === 'image/jpeg' ? 0.9 : undefined)
    const comma = dataUrl.indexOf(',')
    if (comma < 0) return readRaw(file, index)
    const data = dataUrl.slice(comma + 1)
    const size = Math.floor((data.length * 3) / 4)
    if (size > MAX_BYTES) return readRaw(file, index)
    return toAttachment(file, index, data, mediaType, width, height, size)
  } catch {
    return readRaw(file, index)
  }
}

/** 一次处理多张；最多 MAX_COUNT 张，失败的单张直接跳过 */
export async function readImageFiles(files: File[]): Promise<ImageAttachment[]> {
  const selected = files.slice(0, MAX_COUNT)
  const out: ImageAttachment[] = []
  for (let i = 0; i < selected.length; i++) {
    const a = await readImageFile(selected[i], i)
    if (a) out.push(a)
  }
  return out
}

export const MAX_IMAGES = MAX_COUNT
