import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * 主进程崩溃日志。
 *
 * 打包后的应用没有终端，JS 层未捕获的异常 / Promise 拒绝会让进程直接
 * 退出，用户只看到窗口消失（闪退），事后无从查起。这里把这类事件连同
 * 渲染进程 / 子进程的消失原因一起写进 userData/logs/main.log。
 *
 * 日志只追加、不抛错：写日志失败绝不能反过来把应用带崩。
 */

const MAX_LOG_BYTES = 2 * 1024 * 1024
/** 单条日志上限：几百 KB 的异常对象不能让一次写入卡住主进程 */
const MAX_LINE_CHARS = 16 * 1024

/** null = 还没解析路径；'' = 解析失败，之后不再尝试 */
let cachedPath: string | null = null

function logPath(): string | null {
  if (cachedPath !== null) return cachedPath || null
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'main.log')
    try {
      // 单个文件封顶，超了就把上一份留成 .old，避免无限增长
      if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.old`)
    } catch {
      // 文件不存在是常态
    }
    cachedPath = file
  } catch {
    cachedPath = ''
  }
  return cachedPath || null
}

function describe(v: unknown): string {
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** 当前日志文件路径；解析失败（比如 userData 不可写）返回 null */
export function logFilePath(): string | null {
  return logPath()
}

/** 追加一条主进程事件。scope 用来区分来源，便于 grep。 */
export function logMain(scope: string, detail?: unknown): void {
  let body = detail === undefined ? '' : describe(detail)
  if (body.length > MAX_LINE_CHARS) {
    body = `${body.slice(0, MAX_LINE_CHARS)}…[truncated ${body.length - MAX_LINE_CHARS} chars]`
  }
  const line = `[${new Date().toISOString()}] [${scope}] ${body}\n`

  // 开发模式下终端能看到；打包后 stderr 可能没有接收方，失败就忽略
  try {
    process.stderr.write(line)
  } catch {
    // ignore
  }

  const file = logPath()
  if (!file) return
  try {
    appendFileSync(file, line, 'utf8')
  } catch {
    // 磁盘满 / 权限问题：日志本身不能成为新的崩溃源
  }
}

/**
 * 安装主进程兜底处理器。
 *
 * 注意：这里**不重新抛出**。这些错误的典型来源是子进程退出后的 EPIPE、
 * 窗口销毁后仍被 send 之类的收尾问题，继续运行比整窗消失更符合预期；
 * 真出了状态错乱，日志里也有完整堆栈。
 */
export function installCrashHandlers(): void {
  process.on('uncaughtException', (err) => {
    logMain('uncaughtException', err)
  })
  process.on('unhandledRejection', (reason) => {
    logMain('unhandledRejection', reason)
  })
  // Node 警告（监听器泄漏、弃用 API）往往是大问题的前兆，先留痕
  process.on('warning', (w) => {
    logMain('process-warning', w)
  })
  // 正常退出也会走到这里；原生崩溃 / 被外部杀掉时不会触发
  process.on('exit', (code) => {
    logMain('process.exit', code)
  })
}
