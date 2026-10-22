/**
 * 工作区文件检索的结果形状。
 *
 * `path` 是**相对工作区根目录**的路径，且统一用 `/` —— 渲染进程直接拿它
 * 填进 `@` 引用；Windows 的反斜杠不会漏到界面上。
 */
export interface FileMatch {
  /** 相对路径，例：src/renderer/src/useChat.ts */
  path: string
  /** 最后一段：useChat.ts / components */
  name: string
  /** 父目录（相对、`/` 连接），根目录下为空串 */
  dir: string
  kind: 'file' | 'dir'
}
