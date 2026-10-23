/**
 * DeepSeek Harness（dsh）的运行时状态。
 *
 * 设置页需要区分四种"能不能用"：
 *   1. 根本没装                 → 给 npm 安装引导
 *   2. 装了但没有 Node 24+      → dsh 的 bin.js 用 import.meta.main 自启动，
 *                                 Node 20 会静默退出 0，必须明确告诉用户
 *   3. 装了但 --version 跑不起来 → 版本/安装损坏
 *   4. 一切正常                 → 显示版本、DSH_HOME 和 Node 路径
 *
 * 这些信息只在主进程与设置页之间流动，不进会话事件流。
 */
export interface DshStatus {
  installed: boolean
  /** bin.js 的绝对路径；没装时是尝试过的首选路径 */
  path: string
  /** 用来跑 bin.js 的 Node */
  node: string
  /** Node 是否支持 import.meta.main（Node 24+） */
  nodeOk: boolean
  version?: string
  /** 显式选定的 Harness home（凭据、插件、会话都在这下面） */
  home: string
  error?: string
  checkedAt: number
}
