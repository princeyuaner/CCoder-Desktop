import type { RendererLogReport } from '@shared/log'

/**
 * 渲染进程异常上报。
 *
 * 打包版没有 DevTools：React 渲染失败、事件回调抛错、模块 chunk 缺失、
 * 未处理的 Promise 拒绝，用户只看到白屏 / 点了没反应，而 main.log 里
 * 什么都没有。这里统一把这些事件经 preload 发给主进程落盘。
 *
 * **必须在其他业务模块之前 import**：ESM 按声明顺序求值，这个模块装好
 * 监听器之后，后面的模块在求值阶段抛错也能被捕获。
 */

const MAX_PER_MINUTE = 20
let windowStart = Date.now()
let sentInWindow = 0

/** 错误风暴（比如打包产物缺 chunk，每个资源都报一次）不能刷爆日志 */
function allowed(): boolean {
  const now = Date.now()
  if (now - windowStart >= 60_000) {
    windowStart = now
    sentInWindow = 0
  }
  if (sentInWindow >= MAX_PER_MINUTE) return false
  sentInWindow++
  return true
}

function clip(v: string | undefined, max: number): string | undefined {
  if (!v) return undefined
  return v.length > max ? `${v.slice(0, max)}…` : v
}

function describe(v: unknown): string {
  if (v instanceof Error) return v.message || v.name
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function report(r: Omit<RendererLogReport, 'at'>): void {
  if (!allowed()) return
  try {
    // preload 没注入（纯浏览器里跑）时直接跳过
    window.api?.log.report({
      ...r,
      message: clip(r.message, 4000) ?? 'unknown',
      stack: clip(r.stack, 8000),
      source: clip(r.source, 1000),
      url: clip(r.url, 1000),
      at: Date.now()
    })
  } catch {
    // 日志通道自己失败就算了，绝不能让日志把页面再带崩一次
  }
}

function pageUrl(): string {
  try {
    return location.href
  } catch {
    return ''
  }
}

export function installErrorReporting(): void {
  // 捕获阶段才能拿到 <script>/<link> 这种不冒泡的资源加载错误
  window.addEventListener(
    'error',
    (event: Event) => {
      if (event instanceof ErrorEvent && event.message) {
        report({
          kind: 'error',
          message: event.message,
          stack: event.error instanceof Error ? event.error.stack : undefined,
          source: event.filename,
          line: event.lineno,
          column: event.colno,
          url: pageUrl()
        })
        return
      }

      // 资源加载失败是普通 Event（没有 message）：打包后最常见的是缺 chunk / CSS
      const el = event.target as Element | null
      const tag = el?.tagName ?? ''
      if (tag !== 'SCRIPT' && tag !== 'LINK') return
      const src =
        el instanceof HTMLScriptElement
          ? el.src
          : el instanceof HTMLLinkElement
            ? el.href
            : ''
      if (!src) return
      report({
        kind: 'resource',
        message: `资源加载失败：<${tag.toLowerCase()}> ${src}`,
        source: src,
        url: pageUrl()
      })
    },
    true
  )

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason
    report({
      kind: 'unhandledrejection',
      message: describe(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
      url: pageUrl()
    })
  })
}

installErrorReporting()
