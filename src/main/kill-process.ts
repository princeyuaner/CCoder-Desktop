import { spawn, type ChildProcess } from 'node:child_process'

const IS_WIN = process.platform === 'win32'

/**
 * 结束一个外部命令行进程。
 *
 * Windows 上 `child.kill()` 只杀直接子进程；rg 通常没有孙进程，但安全软件
 * 包装层可能有。用 taskkill /T 兜底，和 CLI runner 的处理方式保持一致。
 */
export function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return
  if (IS_WIN) {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      // PATH 异常 / taskkill 被拦时不要抛未处理异常；退回直接 kill
      killer.on('error', () => {
        try {
          child.kill()
        } catch {
          // 已经没了
        }
      })
      killer.unref()
    } catch {
      // 进程已经没了
    }
    return
  }
  try {
    child.kill('SIGTERM')
  } catch {
    // 已经没了
  }
}
