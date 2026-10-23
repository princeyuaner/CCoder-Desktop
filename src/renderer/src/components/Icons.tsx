/**
 * 内联 SVG 图标。不引第三方图标库 —— 依赖越少，打包与主题一致性越好。
 * 统一 16px 视口、currentColor 描边，尺寸由调用方的 CSS 控制。
 */
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

const base = (p: IconProps): IconProps => ({
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  ...p
})

export const IconDownload = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M8 2.5v7.5M5 7l3 3 3-3M3 13.5h10" />
  </svg>
)

export const IconPlus = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M8 3v10M3 8h10" />
  </svg>
)

export const IconSearch = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5 14 14" />
  </svg>
)

export const IconSort = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 3v10M4 13l-2-2M4 13l2-2M12 13V3M12 3l-2 2M12 3l2 2" />
  </svg>
)

export const IconFolderPlus = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.2l1.3 1.6h4.5A1.5 1.5 0 0 1 13 6.1V11a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2 11z" />
    <path d="M7.5 7.6v3M6 9.1h3" />
  </svg>
)

export const IconFolder = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.2l1.3 1.6h4.5A1.5 1.5 0 0 1 13 6.1V11a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2 11z" />
  </svg>
)

export const IconPlugin = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6 2.5v2M10 2.5v2" />
    <rect x="3" y="4.5" width="10" height="9" rx="1.6" />
    <path d="M6.2 8.2v2.4M9.8 8.2v2.4" />
  </svg>
)

export const IconClock = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="5.6" />
    <path d="M8 5v3.2l2 1.3" />
  </svg>
)

export const IconChevronDown = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 6.5 8 10.5l4-4" />
  </svg>
)

export const IconChevronRight = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6.5 4 10.5 8l-4 4" />
  </svg>
)

/**
 * 大脑 —— 思考深度 chip 的标识。
 * 原稿是 24 格，缩到 15px 时线宽也跟着按比例变细，所以这边把 strokeWidth
 * 提到 2，视觉粗细才跟 16 格里的 1.5 对得上。
 */
export const IconBrain = (p: IconProps) => (
  <svg {...base(p)} viewBox="0 0 24 24" strokeWidth={2}>
    <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
    <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
  </svg>
)

export const IconChevronLeft = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M9.5 4 5.5 8l4 4" />
  </svg>
)

/** 在 IDE 中打开 —— 一对代码尖括号，比通用外链更像"看代码" */
export const IconOpenInIde = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M5.8 4.2 2.6 8l3.2 3.8M10.2 4.2 13.4 8l-3.2 3.8" />
  </svg>
)

export const IconCopy = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.4" />
    <path d="M10.5 3.5H4A1.5 1.5 0 0 0 2.5 5v6" />
  </svg>
)

export const IconThumbUp = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M5 7.2 7.3 2.6a1.2 1.2 0 0 1 2.2.7V6h2.6a1.2 1.2 0 0 1 1.2 1.5l-1 4.6A1.2 1.2 0 0 1 11.1 13H5" />
    <path d="M5 7.2H2.8V13H5z" />
  </svg>
)

export const IconThumbDown = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M11 8.8 8.7 13.4a1.2 1.2 0 0 1-2.2-.7V10H3.9a1.2 1.2 0 0 1-1.2-1.5l1-4.6A1.2 1.2 0 0 1 4.9 3H11" />
    <path d="M11 8.8h2.2V3H11z" />
  </svg>
)

export const IconMore = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="3.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
  </svg>
)

export const IconPanel = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="2.5" y="3" width="11" height="10" rx="1.6" />
    <path d="M10.5 3v10" />
  </svg>
)

export const IconSend = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M8 12.5V3.5M8 3.5 4 7.5M8 3.5l4 4" />
  </svg>
)

export const IconGear = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2 3.6 12.4" />
  </svg>
)

/** 品牌标 —— 参考截图左上的鲸鱼剪影，先用一个抽象几何代替 */
export const IconBrand = (p: IconProps) => (
  <svg {...base(p)} strokeWidth={0}>
    <path
      d="M2 9.2c0-3.2 2.6-5.8 5.8-5.8 1.2 0 2.3.4 3.2 1 .5-.4 1.2-.6 1.9-.5l1.6.2-.9 1.5c.4.8.6 1.7.6 2.6 0 3.2-2.6 5.8-5.8 5.8-1.6 0-3-.6-4.1-1.7-.3-.3-.6-.6-.8-1l-.6.2.3-1.2A5.7 5.7 0 0 1 2 9.2z"
      fill="currentColor"
    />
    <circle cx="6.4" cy="8.2" r="0.75" fill="var(--bg-app)" />
  </svg>
)


/* ── 品牌标记 ────────────────────────────────────────────────
 * 路径原样取自 simple-icons v16.35.0 的 `claudecode` / `openai`，
 * **没有重绘、没有变形**。Simple Icons 那些文件是 CC0，但标记本身是
 * 各自公司的商标 —— 这里只用来标明"这条会话是哪个 CLI 写的"，属指名使用。
 *
 * 跟上面那批线条图标不同：品牌标记是实心字形，走 fill 不走 stroke。
 */

export const IconClaudeCode = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" width={16} height={16} {...p}>
    <path d="M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Zm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z" />
  </svg>
)

export const IconOpenAI = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" width={16} height={16} {...p}>
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
  </svg>
)
