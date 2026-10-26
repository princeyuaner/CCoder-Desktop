import { statSync, watch, type FSWatcher } from 'node:fs'
import { resolve } from 'node:path'
import type { SyncConfig } from '../../shared/sync'
import { isExcluded, normalizeRelPath, syncable, syncableDir } from './filters'

/**
 * 看盘：把文件系统事件折算成「该同步了」的提示，不做任何同步。
 *
 * 事件只当提示：丢了、合并了、重复了都无害，最坏是滞后一个巡检周期。
 * 过滤用与扫描**同一套**判定，否则会出现「扫描认为该同步、监听却把事件
 * 挡掉」——那个文件要等一次巡检才动，而且看不出为什么。
 */
export class SyncWatcher {
  private watcher: FSWatcher | null = null
  private stopped = false
  private hints = 0
  private recursive = false
  private warned = false

  constructor(
    private readonly root: string,
    private readonly cfg: () => SyncConfig,
    private readonly onHint: (rel: string | null) => void,
    private readonly log: (line: string) => void = () => undefined
  ) {}

  get hintCount(): number {
    return this.hints
  }

  start(): void {
    if (this.watcher || this.stopped) return
    const root = resolve(this.root)
    try {
      this.watcher = watch(root, { recursive: true }, (_event, filename) => {
        this.handle(filename)
      })
      this.recursive = true
    } catch (e) {
      // Linux 的 inotify 不支持递归；退回只听根目录，范围未知时按 generic 提示。
      this.recursive = false
      try {
        this.watcher = watch(root, { recursive: false }, () => {
          this.hints++
          this.onHint(null)
        })
      } catch (e2) {
        this.watcher = null
        this.log(`[监听] 无法监听源目录：${reasonOf(e2)}`)
        return
      }
      this.log(`[监听] 递归监听不可用（${reasonOf(e)}）—— 退回根目录监听，其余改动靠巡检`)
    }
    this.watcher.on('error', (e) => {
      if (this.stopped || this.warned) return
      this.warned = true
      this.log(`[监听] 监听器出错：${reasonOf(e)}；已请求一轮完整扫描`)
      this.hints++
      this.onHint(null)
    })
    this.log(`[监听] 已开始监听源目录${this.recursive ? '（递归）' : '（仅根目录）'}`)
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    try {
      this.watcher?.close()
    } catch {
      // 关闭失败不影响窗口销毁
    }
    this.watcher = null
  }

  private handle(filename: string | Buffer | null): void {
    if (this.stopped) return
    if (!this.recursive) {
      this.hints++
      this.onHint(null)
      return
    }
    if (filename == null) {
      this.hints++
      this.onHint(null)
      return
    }
    const raw = typeof filename === 'string' ? filename : filename.toString('utf8')
    if (!raw || raw.includes('\0')) {
      this.hints++
      this.onHint(null)
      return
    }
    const rel = normalizeRelPath(raw)
    if (!rel) return

    const cfg = this.cfg()
    if (isExcluded(rel, cfg.exclude)) return

    let isDirectory = false
    try {
      isDirectory = statSync(resolve(this.root, rel)).isDirectory()
    } catch {
      // 删除事件：已经不存在了，按文件规则判断即可
    }

    if (isDirectory) {
      if (!syncableDir(rel, cfg)) return
    } else if (!syncable(rel, cfg)) {
      return
    }

    // 目录事件与文件事件都只给「该看一眼了」；真正扫什么由对账决定。
    this.hints++
    this.onHint(rel)
  }
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
