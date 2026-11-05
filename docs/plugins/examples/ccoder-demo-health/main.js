/**
 * CCoder 插件示例：单文件 ESM，不能有 import / JSX。
 *
 * 这里演示 v1 已实现的扩展点：
 *  - 状态栏组件
 *  - 命令
 *  - 设置页
 *  - 主区页签
 *  - storage / events / theme.injectCss
 */
export default function activate(ctx) {
  const { createElement: h, useEffect, useState } = ctx.react

  async function readPings() {
    const value = await ctx.storage.get('pings')
    return typeof value === 'number' ? value : 0
  }

  function usePings() {
    const [count, setCount] = useState(null)
    useEffect(() => {
      let alive = true
      void readPings().then((n) => {
        if (alive) setCount(n)
      })
      const off = ctx.events.on('demo:ping', () => {
        setCount((current) => {
          const next = (typeof current === 'number' ? current : 0) + 1
          void ctx.storage.set('pings', next)
          return next
        })
      })
      return () => {
        alive = false
        off()
      }
    }, [])
    return count
  }

  function Status({ workspacePath }) {
    const count = usePings()
    return h(
      'span',
      { title: workspacePath || '未选择工作区' },
      'Demo ',
      count === null ? '…' : count
    )
  }

  function Panel({ workspacePath }) {
    const count = usePings()
    return h(
      'div',
      { className: 'plugin-demo-card' },
      h('h2', { className: 'plugin-demo-title' }, '示例插件面板'),
      h('p', { className: 'plugin-demo-muted' }, `工作区：${workspacePath || '未选择'}`),
      h(
        'p',
        null,
        '收到 ',
        h('b', null, count === null ? '…' : count),
        ' 次 demo:ping 事件'
      ),
      h(
        'button',
        {
          className: 'plugin-demo-button',
          onClick: () => ctx.events.emit('demo:ping', { at: Date.now() })
        },
        '发一条事件'
      ),
      h(
        'button',
        {
          className: 'plugin-demo-button is-ghost',
          onClick: () => {
            void ctx.storage.set('pings', 0)
            ctx.events.emit('demo:ping', { reset: true })
          }
        },
        '重置计数'
      )
    )
  }

  function Settings() {
    const [note, setNote] = useState('')
    useEffect(() => {
      let alive = true
      void ctx.storage.get('note').then((value) => {
        if (alive && typeof value === 'string') setNote(value)
      })
      return () => {
        alive = false
      }
    }, [])
    return h(
      'div',
      { className: 'plugin-demo-settings' },
      h('p', { className: 'plugin-demo-muted' }, '这个设置页由插件注册，内容存在插件自己的存储里。'),
      h('input', {
        className: 'plugin-demo-input',
        value: note,
        placeholder: '写点什么…',
        onChange: (e) => {
          const value = e.target.value
          setNote(value)
          void ctx.storage.set('note', value)
        }
      }),
      h('p', { className: 'plugin-demo-muted' }, `宿主版本：${ctx.host.appVersion}`)
    )
  }

  ctx.theme.injectCss(`
    .plugin-demo-card{padding:18px 20px;border:1px solid var(--border);border-radius:12px;background:var(--bg-raised);color:var(--text)}
    .plugin-demo-title{margin:0 0 8px;font-size:16px}
    .plugin-demo-muted{font-size:12px;color:var(--text-muted)}
    .plugin-demo-button{margin:10px 8px 0 0;padding:6px 12px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:12px}
    .plugin-demo-button.is-ghost{background:transparent;color:var(--text-dim);border:1px solid var(--border)}
    .plugin-demo-input{width:100%;max-width:420px;margin:8px 0;padding:7px 9px;border:1px solid var(--border);border-radius:8px;background:var(--bg-app);color:var(--text);outline:none}
  `)

  ctx.ui.registerStatusBarItem({ component: Status, align: 'end', order: 10 })
  ctx.ui.registerCommand({
    key: 'demo-ping',
    title: '插件示例：+1',
    description: '向示例事件总线发一条 demo:ping',
    keywords: ['demo', 'plugin', '示例'],
    run() {
      ctx.events.emit('demo:ping', { at: Date.now() })
    }
  })
  ctx.ui.registerSettingsSection({
    key: 'main',
    label: '示例插件',
    component: Settings
  })
  ctx.ui.registerPanelTab({
    key: 'demo',
    label: '示例面板',
    component: Panel,
    order: 10
  })
}
