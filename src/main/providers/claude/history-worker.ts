/**
 * Claude 历史解析 worker。
 *
 * 主线程只负责收发消息；读盘 / `JSON.parse` / 回放成 AgentEvent 全在这里。
 * 由 `electron.vite.config.ts` 作为独立入口构建到
 * `out/main/claude-history-worker.js`，打包时复制到 `resources/worker/`
 * （asar 外），主进程用 worker_threads 启动。
 */
import { parentPort } from 'node:worker_threads'
import type { ResolvedLocale } from '../../../shared/i18n'
import type { AgentEvent } from '../../../shared/events'
import { setMainLocale } from '../../i18n'
import { replayRecords } from './history'
import { readClaudeRecords } from './history-read'

interface Request {
  id: number
  file: string
  size: number
  textOnly: boolean
  /** 回放里偶有文案（截断提示、图片兜底名），要跟随主进程当前语言 */
  locale: ResolvedLocale
}

if (!parentPort) throw new Error('claude history worker requires a parent port')

const port = parentPort
port.on('message', (req: Request) => {
  void (async () => {
    try {
      setMainLocale(req.locale === 'en' ? 'en' : 'zh')
      const records = await readClaudeRecords(req.file, req.size)
      const events: AgentEvent[] = replayRecords(records, { textOnly: req.textOnly })
      port.postMessage({ id: req.id, ok: true, events })
    } catch (e) {
      port.postMessage({
        id: req.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e)
      })
    }
  })()
})
