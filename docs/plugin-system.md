# CCoder 插件系统（v1）

入口：侧栏「插件」。插件页是独立一级页面，设置弹窗仍然盖在它上面；插件安装、启停、卸载都在这里完成。

v1 包含：

- 两种插件：**免代码**（`declarative`）与**需要运行代码**（`js`）；
- 本地目录安装、热重载、启用 / 禁用 / 卸载；
- 插件自己的持久化存储；
- 状态栏、命令、设置页、主区页签四类界面扩展点；
- 主题 token 与受限 CSS 注入；
- 市场索引、zip 下载、sha256 校验与安装入口；
- 一个免代码示例和一个 JS 示例。

## 1. 两种插件

| Tier | 目录内容 | 是否运行 JS | 适合做什么 |
|---|---|---|---|
| `declarative` | `manifest.json` + 可选 `styles.css` | 否 | 主题、静态状态栏文字、声明式命令、纯样式调整 |
| `js` | `manifest.json` + `main.js` + 可选 `styles.css` | 是 | 有状态的界面、命令、设置页、工作流集成 |

`js` 插件的 `main.js` 必须是**单文件 ESM**：

```js
export default function activate(ctx) {
  // 返回值可以是清理函数
  return () => {}
}
```

不能有 `import` / `require` / JSX；React 组件用 `ctx.react.createElement` 创建。宿主用 Blob URL 动态 import，因此打包后的 `file://` 也不会被 CSP / 跨源限制拦住。

## 2. 目录与 manifest

安装后的目录由主进程管理：

```
<userData>/plugins/<id>/        # 插件本身
<userData>/plugin-data/<id>.json # 插件自己的 key-value 存储
<userData>/plugins-state.json   # 启用状态 / 安装来源
```

插件页底部会显示当前实际的插件根目录。`<userData>` 是 Electron 的 `app.getPath('userData')`。

最小 manifest：

```jsonc
{
  "id": "my-panel",
  "name": "我的面板",
  "version": "0.1.0",
  "tier": "js",
  "description": "在状态栏和主区显示一点东西",
  "author": "you",
  "permissions": ["ui:status-bar", "ui:panel-tab", "storage"],
  "minAppVersion": "1.2.0"
}
```

必填字段：

- `id`：`^[a-z0-9][a-z0-9-]{1,63}$`，同时也是安装目录名，全局唯一；
- `name`：显示名；
- `version`：`x.y.z`；
- `tier`：`declarative` / `js`；
- `permissions`：字符串数组，未知权限会被拒绝安装。

可选：`description`、`author`、`homepage`、`minAppVersion`、`sdkVersion`、`contributes`、`configSchema`。

## 3. 免代码贡献（Tier 0）

```jsonc
{
  "contributes": {
    "themes": [
      {
        "name": "Midnight",
        "tokens": {
          "dark": { "--br-accent": "#b8a1e0" },
          "light": { "--br-accent": "#6b4fa0" }
        }
      }
    ],
    "statusBarItems": [
      { "text": "Midnight", "tone": "accent", "align": "end" }
    ],
    "commands": [
      { "key": "midnight-refresh", "title": "刷新主题", "description": "发一条事件" }
    ]
  }
}
```

- `themes` 需要 `theme` 权限；只接受 `--*` token，分别落到 `data-scheme=dark/light`。
- `statusBarItems` 需要 `ui:status-bar`；`tone` 支持 `default` / `accent` / `ok` / `warn` / `danger`。
- `commands` 需要 `ui:command`；免代码命令只会在事件总线上发 `command:<key>`，没有 JS 监听时不会产生动作。
- `styles.css` 会全局注入；禁止 `@import`、远程 `url(...)`、`expression(...)`。
- `i18n`、`configSchema` 字段会被保留，但 v1 还不会应用。

## 4. JS 扩展点（Tier 1）

v1 已实现的 `ctx`：

```ts
ctx.pluginId
ctx.version
ctx.react
ctx.host: { appVersion, sdkVersion, locale, isWeb }

ctx.ui.registerStatusBarItem({ key?, component, align?, order? }): Disposer
ctx.ui.registerCommand({ key, title, description?, keywords?, run }): Disposer
ctx.ui.registerSettingsSection({ key?, label, icon?, component }): Disposer
ctx.ui.registerPanelTab({ key?, label, icon?, component, order? }): Disposer

ctx.theme.injectCss(css): Disposer
ctx.theme.setTokens({ light?, dark? }): Disposer

ctx.storage.get(key): Promise<T | null>
ctx.storage.set(key, value): Promise<void>
ctx.storage.delete(key): Promise<void>

ctx.events.on(topic, cb): Disposer
ctx.events.emit(topic, data): void
```

所有 `register*` / `on` / 注入方法都返回 `Disposer`；宿主在插件禁用或卸载时逆序执行它们，插件不需要自己保存列表。

对应权限：

| 能力 | 权限 |
|---|---|
| 状态栏组件 | `ui:status-bar` |
| 命令 | `ui:command` |
| 设置页 | `ui:settings-section` |
| 主区页签 | `ui:panel-tab` |
| `theme.*` | `theme` |
| `storage.*` | `storage` |
| `events.*` | `events` |

调用未在 manifest 声明的能力会立即抛错，`activate()` 失败会在插件页显示错误并自动禁用。

示例（`docs/plugins/examples/ccoder-demo-health/main.js`）：

```js
export default function activate(ctx) {
  const { createElement: h } = ctx.react
  ctx.ui.registerPanelTab({
    key: 'demo',
    label: '示例面板',
    component: ({ workspacePath }) =>
      h('div', null, `工作区：${workspacePath}`)
  })
}
```

## 5. 安装与热重载

- 插件页「从本地目录安装」选择包含 `manifest.json` 的那一层目录；
- 主进程先解析 manifest，弹窗展示来源、版本、Tier 和权限；用户确认后才真正安装；
- 渲染层只拿到一次性 token，不持有可写入的路径；token 10 分钟过期；
- 主进程校验 manifest、`main.js`、CSS 大小和目录体积，然后复制到 `<userData>/plugins/<id>`；
- 跳过 `node_modules`、`.git`、符号链接；上限 16MB / 2000 个文件；
- 同一 id 再次安装会覆盖旧版本并热重载（先卸载旧实例，再按新代码 activate）；
- 卸载会删除插件目录，插件数据保留，便于重新安装后恢复。

## 6. 市场

v1 的市场是**静态索引 + zip 产物**：

- 索引默认地址：`https://raw.githubusercontent.com/princeyuaner/CCoder-Desktop/main/docs/plugins/index.json`；
- 开发模式下优先使用仓库里的 `docs/plugins/index.json`；
- 打包版会把索引和示例包复制到 `resources/plugin-market/`，远程索引不可用时兜底；
- 可用环境变量 `CCODER_PLUGIN_MARKET_URL` 覆盖索引地址；
- 每个版本需要 `url`（https / file / 相对索引的路径）、可选 `sha256`、`size`、`minAppVersion`；
- 客户端下载后校验大小和 sha256，解压时拒绝越界路径、绝对路径、符号链接和 zip64；
- 解压后的 manifest 必须与市场条目的 `id` / `version` 一致。

示例索引和产物在：

```
docs/plugins/index.json
docs/plugins/artifacts/*.zip
docs/plugins/examples/*
```

## 7. 安全模型（v1 的限制）

- **Tier-1 插件和宿主在同一个 renderer 世界**，能直接访问 `window.api`；`ctx` 的权限检查是能力门禁，不是安全沙箱。
- 因此 v1 只适合安装**你信任的插件**。不要从不可信来源安装需要运行代码的插件。
- 市场客户端目前只校验 sha256，**还没有发布者签名和撤销列表**；开放公共市场前需要补上。
- 插件 CSS 会拒绝远程引用；Tier-1 的 `styles.css` 需要 `theme` 权限才会自动注入。
- 渲染进程 CSP 为插件模块放开了 `blob:`；这是运行 JS 插件的必要条件，但也意味着插件代码和宿主同源。

后续方向：把 Tier-1 放进 sandboxed iframe / isolated world / utilityProcess，并补上发布者签名、权限变更确认和撤销机制，再开放社区市场。

## 8. 开发与验收

```bash
npm run dev            # 侧栏「插件」→ 从本地目录安装
npm run typecheck
npm run verify:plugins # 无头验证仓库、zip、市场索引与市场安装
npm run build
```

示例插件：

- `docs/plugins/examples/ccoder-demo-theme`：免代码，主题 token + 状态栏；
- `docs/plugins/examples/ccoder-demo-health`：JS，状态栏 / 命令 / 设置页 / 主区页签 / storage / events / CSS；
- `docs/plugins/examples/ccoder-composer-marquee`：免代码，会话运行中给输入框加追光边框，结束自动熄灭。

无头验证主进程仓库与市场：`npm run verify:plugins`（自动打包 `tools/_plugins-probe.ts` 后运行）。

UI 验收（启动构建后的应用并截图）：

```bash
npm run build
node tools/_probe-plugins-ui.cjs
```

截图输出到 `docs/mockups/plugins-*-live.png`。

## 9. v1 尚未实现

- Markdown / 时间线行渲染器；
- 会话菜单、工作区菜单、侧栏入口；
- `agent` / `host:session` / `host:workspace` / `host:models` 等宿主能力；
- `ctx.bridge` 的 network / exec 授权；
- `configSchema` 自动设置表单；
- 插件签名、撤销列表、市场审核流程；
- Tier-1 沙箱隔离。
