# CCoder 介绍页

静态单页，无需构建。直接打开 `index.html` 即可预览，也可以把整个目录丢给任意静态托管。

## 文件

- `index.html` — 页面结构
- `styles.css` — 全部样式、响应式与动效
- `app.js` — 滚动进度、进入动效、鼠标视差、配色预览
- `assets/` — 产品截图与应用图标（截图已裁掉原生标题栏，避免与页面窗口框重复）

## 本地预览

```bash
# 直接打开
start index.html

# 或起一个静态服务
npx serve docs/site
```

## 交互

- 顶部滚动进度与导航毛玻璃
- 首屏标题/窗口载入、三条 CLI 状态条、截图扫描线
- 鼠标在首屏移动时，窗口有轻微透视跟随（触屏与 `prefers-reduced-motion` 下关闭）
- 配色区默认自动轮播三套，点击任意色卡后停止；预览窗口实时换色

## 外部依赖

Google Fonts 上的 Bricolage Grotesque、IBM Plex Mono 与 Noto Sans SC。离线时会回退到 Bahnschrift / Segoe UI / 微软雅黑 / Cascadia 等系统字体，布局不变。

## 部署

页面内所有链接都指向 GitHub Releases，没有后端依赖。发布到 GitHub Pages 时，把发布目录设为 `docs/site`（或把这三个文件与 `assets/` 拷到 Pages 根目录）即可。
