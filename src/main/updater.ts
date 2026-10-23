import { app, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { ProgressInfo, UpdateInfo } from 'electron-updater'
import { IPC } from '../shared/ipc'
import type { UpdateInstallResult, UpdateState } from '../shared/update'
import { logMain } from './crash-log'

/**
 * 启动后等一会儿再检查：别和窗口首屏、会话列表抢网络。
 * 之后每 4 小时看一次 —— 更新源是 GitHub Releases，请求很轻。
 */
const FIRST_CHECK_DELAY_MS = 8_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

export interface UpdaterControl {
  status(): UpdateState
  check(): Promise<UpdateState>
  download(): Promise<UpdateState>
  install(): Promise<UpdateInstallResult>
}

interface UpdaterOptions {
  /** 状态变化时广播给所有窗口 */
  emit(state: UpdateState): void
  /** 有回合正在跑时不允许重启安装，否则用户会丢掉刚发出的活 */
  hasBusySessions(): boolean
  /** 允许安装后、退出前收掉所有 CLI 子进程（Windows 上它们会占着安装目录） */
  beforeInstall(): void
}

/**
 * 便携版由 electron-builder 的 portable.nsi 启动，会注入这个变量。
 * electron-updater 只会去改「安装版」，在便携版上调用 quitAndInstall
 * 会把应用装到别的目录，所以这里直接禁用。
 */
function isPortable(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR)
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

function notesOf(info: UpdateInfo): string | undefined {
  const name = info.releaseName?.trim()
  return name || undefined
}

export function createUpdater(opts: UpdaterOptions): UpdaterControl {
  let state: UpdateState = {
    phase: 'idle',
    currentVersion: app.getVersion()
  }
  /** 最近一次操作：出错时据此决定要不要在界面上提示 */
  let lastAction: 'check' | 'download' = 'check'
  let firstTimer: ReturnType<typeof setTimeout> | null = null
  let intervalTimer: ReturnType<typeof setInterval> | null = null

  const publish = (patch: Partial<UpdateState>): void => {
    const prevPhase = state.phase
    const prevError = state.error
    state = { ...state, ...patch }
    // 下载进度事件很密，只在阶段 / 错误变化时落盘
    if (state.phase !== prevPhase || state.error !== prevError) {
      logMain('updater.state', {
        from: prevPhase,
        to: state.phase,
        version: state.version,
        percent: state.percent,
        errorScope: state.errorScope,
        error: state.error
      })
    }
    opts.emit(state)
  }

  if (!app.isPackaged) {
    state = { ...state, phase: 'unsupported', reason: 'dev' }
    logMain('updater.disabled', { reason: 'dev' })
  } else if (isPortable()) {
    state = { ...state, phase: 'unsupported', reason: 'portable' }
    logMain('updater.disabled', {
      reason: 'portable',
      dir: process.env.PORTABLE_EXECUTABLE_DIR
    })
  } else {
    // 更新源来自 resources/app-update.yml（electron-builder 按 publish 配置生成）
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowPrerelease = false
    // 打包版没有终端：只在 console 里打等于没打，统一进 main.log
    autoUpdater.logger = {
      info: (m) => logMain('updater', m),
      warn: (m) => logMain('updater.warn', m),
      // 只打 message：electron-updater 抛的 HTTP 错误里带着完整响应头，别整坨进日志
      error: (m) => logMain('updater.error', messageOf(m))
    }

    autoUpdater.on('checking-for-update', () => {
      publish({ phase: 'checking', error: undefined, errorScope: undefined })
    })

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      publish({
        phase: 'available',
        version: info.version,
        releaseName: notesOf(info),
        percent: undefined,
        error: undefined,
        errorScope: undefined
      })
    })

    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      publish({
        phase: 'up-to-date',
        version: info.version,
        releaseName: undefined,
        percent: undefined,
        error: undefined,
        errorScope: undefined
      })
    })

    autoUpdater.on('download-progress', (p: ProgressInfo) => {
      publish({
        phase: 'downloading',
        percent: Math.min(100, Math.max(0, p.percent))
      })
    })

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      publish({
        phase: 'downloaded',
        version: info.version,
        releaseName: notesOf(info),
        percent: 100,
        error: undefined,
        errorScope: undefined
      })
    })

    autoUpdater.on('update-cancelled', (info: UpdateInfo) => {
      publish({
        phase: 'available',
        version: info.version,
        releaseName: notesOf(info),
        percent: undefined
      })
    })

    autoUpdater.on('error', (e: Error) => {
      publish({ phase: 'error', error: messageOf(e), errorScope: lastAction })
    })

    firstTimer = setTimeout(() => {
      void check()
    }, FIRST_CHECK_DELAY_MS)
    intervalTimer = setInterval(() => {
      void check()
    }, CHECK_INTERVAL_MS)
    // 别让定时器持有事件循环（主进程本来就不会自己退出，这里只是习惯）
    firstTimer.unref?.()
    intervalTimer.unref?.()
  }

  async function check(): Promise<UpdateState> {
    // 已经有结果 / 正在处理时不再重复检查：否则定时器会把「已下载」
    // 打回「可下载」，用户得重新点一次。
    if (
      state.phase === 'unsupported' ||
      state.phase === 'checking' ||
      state.phase === 'available' ||
      state.phase === 'downloading' ||
      state.phase === 'downloaded'
    ) {
      logMain('updater.check.skip', { phase: state.phase })
      return state
    }
    lastAction = 'check'
    logMain('updater.check', { current: state.currentVersion })
    try {
      await autoUpdater.checkForUpdates()
    } catch (e) {
      // 自动检查（断网 / 还没发 Release）不该打扰用户；手动检查的人能看到错误
      publish({ phase: 'error', error: messageOf(e), errorScope: 'check' })
    }
    return state
  }

  async function download(): Promise<UpdateState> {
    // 下载失败后点「重试」：先重新确认一次版本，再走正常的下载流程
    if (state.phase === 'error' && state.errorScope === 'download') {
      await check()
      if (state.phase === 'error') {
        // 这是用户主动点的重试，重新检查失败也要留在提醒里，别让它悄悄消失
        publish({ errorScope: 'download' })
        return state
      }
    }
    if (state.phase !== 'available') {
      logMain('updater.download.rejected', { phase: state.phase })
      return state
    }
    lastAction = 'download'
    logMain('updater.download', { version: state.version })
    publish({ phase: 'downloading', percent: 0, error: undefined, errorScope: undefined })
    try {
      await autoUpdater.downloadUpdate()
    } catch (e) {
      publish({ phase: 'error', error: messageOf(e), errorScope: 'download' })
    }
    return state
  }

  async function install(): Promise<UpdateInstallResult> {
    if (state.phase !== 'downloaded') {
      logMain('updater.install.rejected', { reason: 'not-downloaded', phase: state.phase })
      return { ok: false, message: '更新还没下载完成' }
    }
    if (opts.hasBusySessions()) {
      logMain('updater.install.rejected', { reason: 'busy' })
      return { ok: false, message: '有会话正在运行，请等这一轮结束后再安装更新' }
    }
    logMain('updater.install', { version: state.version })
    opts.beforeInstall()
    // 先让 IPC 把结果送回渲染进程，再真正退出；否则界面来不及收起
    setImmediate(() => {
      logMain('updater.quit-and-install', { version: state.version })
      try {
        autoUpdater.quitAndInstall(true, true)
      } catch (e) {
        logMain('updater.quit-and-install.failed', e)
      }
    })
    return { ok: true }
  }

  return { status: () => state, check, download, install }
}

export function registerUpdaterIpc(updater: UpdaterControl): void {
  ipcMain.handle(IPC.updaterStatus, () => updater.status())
  ipcMain.handle(IPC.updaterCheck, () => updater.check())
  ipcMain.handle(IPC.updaterDownload, () => updater.download())
  ipcMain.handle(IPC.updaterInstall, () => updater.install())
}
