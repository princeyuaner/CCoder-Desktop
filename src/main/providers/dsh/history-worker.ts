/**
 * dsh 会话解析 worker。
 *
 * 主线程只负责收消息、回消息；读盘 / fzstd 解压 / JSON.parse 全在这里。
 * 由 `electron.vite.config.ts` 作为独立入口构建到 `out/main/dsh-history-worker.js`，
 * 打包时复制到 `resources/worker/`（asar 外），主进程用 worker_threads 启动。
 */
import { parentPort } from 'node:worker_threads'
import { readDshRecords } from './history-read'

interface Request {
  id: number
  file: string
}

if (!parentPort) throw new Error('dsh history worker requires a parent port')

const port = parentPort
port.on('message', (req: Request) => {
  void (async () => {
    try {
      const records = await readDshRecords(req.file)
      port.postMessage({ id: req.id, ok: true, records })
    } catch (e) {
      port.postMessage({
        id: req.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e)
      })
    }
  })()
})
