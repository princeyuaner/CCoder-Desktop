/**
 * 用户消息里可以携带的图片。
 *
 * 单独放一个文件，是因为 `events.ts`（历史事件）和 `session.ts`（发送入参）
 * 都要用它；放任何一个里面都会绕出循环 import。
 */
export interface ImageAttachment {
  /** 渲染层用来做 key；主进程不关心 */
  id: string
  /** image/png / image/jpeg / image/webp */
  mediaType: string
  /** base64，不带 `data:` 前缀 */
  data: string
  /** 原始文件名，只用于界面显示 */
  name: string
  width?: number
  height?: number
  /** 原始字节数 */
  size?: number
}
