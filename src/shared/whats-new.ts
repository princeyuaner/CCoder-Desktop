import type { ResolvedLocale } from './i18n'

/**
 * 每个版本发布时给用户看的更新说明。
 *
 * 维护方式：发版时在数组**最前面**补一条，version 必须和 package.json 一致。
 * 渲染层按当前安装版本精确匹配 —— 找不到就不弹，宁可沉默也不拿旧说明
 * 冒充这次更新。
 *
 * 文案放在这里而不是 i18n 目录：它随版本走、每次发版整段替换，
 * 和界面里那批稳定文案的生命周期不同。
 */

export type WhatsNewIcon =
  | 'rich-text'
  | 'review'
  | 'batch'
  | 'search'
  | 'bell'
  | 'keyboard'
  | 'lsp'
  | 'hooks'
  | 'sparkle'
  | 'collapse'
  | 'terminal'

export interface WhatsNewText {
  zh: string
  en: string
}

export interface WhatsNewItem {
  icon: WhatsNewIcon
  title: WhatsNewText
  desc: WhatsNewText
}

export interface WhatsNewSection {
  /** 分组标题走界面语言（新增 / 改进），条目内容留在本文件 */
  kind: 'new' | 'improved'
  items: WhatsNewItem[]
}

export interface WhatsNewRelease {
  /** 和 package.json 的 version 一致，不带 v */
  version: string
  /** 发布日期，展示用的 YYYY-MM-DD */
  date: string
  /** 本次的重点，单独用带底色的卡片展示 */
  highlight: WhatsNewItem
  sections: WhatsNewSection[]
}

export const WHATS_NEW_RELEASES: WhatsNewRelease[] = [
  {
    version: '1.2.27',
    date: '2026-11-09',
    highlight: {
      icon: 'bell',
      title: {
        zh: '自动化任务',
        en: 'Scheduled automation tasks'
      },
      desc: {
        zh: '侧栏新增「自动化任务」：按每隔 N 分钟、每天或每周的计划，在后台拉起一条普通会话。工作区、CLI、模型、思考深度、权限、提示词、超时和单次预算都按任务配置，每次运行都留成可回看、可续跑的会话。',
        en: 'A new Automation page in the sidebar starts an ordinary session in the background on a minute interval, daily, or weekly schedule. Workspace, CLI, model, thinking effort, permissions, prompt, timeout, and per-run budget are configured per task, and every run becomes a session you can review and resume.'
      }
    },
    sections: [
      {
        kind: 'new',
        items: [
          {
            icon: 'keyboard',
            title: {
              zh: '语音输入',
              en: 'Voice input'
            },
            desc: {
              zh: '点输入框的麦克风或按 Ctrl+Shift+M 开始说话，再点一次结束，文字会插入光标处并可一键撤销。默认走硅基流动免费额度，也可切 Groq 或自填 OpenAI 兼容端点；录音只留在内存，不写入磁盘。',
              en: 'Click the microphone in the composer or press Ctrl+Shift+M to dictate, then click again to stop; the transcript is inserted at the caret and can be undone. It uses SiliconFlow’s free tier by default, with Groq or a custom OpenAI-compatible endpoint as alternatives. Audio stays in memory and is never written to disk.'
            }
          },
          {
            icon: 'terminal',
            title: {
              zh: '执行台：子代理与后台任务',
              en: 'Run panel: subagents and background tasks'
            },
            desc: {
              zh: '执行台重新排版：计时器作为头部锚点，任务、子代理、后台任务各自分区滚动。子代理卡片按类型配图标，左侧色条和状态胶囊双重标记状态；后台 shell / workflow 单独成区；运行结束后可以打开完整报告。',
              en: 'The run panel is reorganized: the timer anchors the header, and tasks, subagents, and background tasks each scroll in their own section. Subagent cards get type icons with a status bar and pill; background shells and workflows have their own section; finished runs open a full report.'
            }
          }
        ]
      },
      {
        kind: 'improved',
        items: [
          {
            icon: 'collapse',
            title: {
              zh: '执行台在矮窗口下的高度分配',
              en: 'Run panel height in short windows'
            },
            desc: {
              zh: '后台任务很多时，不再按内容高度抢走可用空间、把子代理区压成半张卡。子代理区至少保留一张完整卡片的高度；窗口极矮时整个面板兜底滚动。',
              en: 'A long background-task list no longer steals the available height and squeezes the subagent section into half a card. The subagent section keeps at least one full card, and the panel scrolls as a whole when space is extremely tight.'
            }
          },
          {
            icon: 'sparkle',
            title: {
              zh: 'macOS 麦克风权限',
              en: 'macOS microphone permission'
            },
            desc: {
              zh: 'macOS 包补充了麦克风用途说明和音频输入 entitlement，首次录音时系统会正常弹出授权，不再直接被拒。',
              en: 'The macOS build now declares the microphone usage description and audio-input entitlement, so the first recording prompts for permission instead of being denied outright.'
            }
          }
        ]
      }
    ]
  },
  {
    version: '1.2.26',
    date: '2026-11-07',
    highlight: {
      icon: 'terminal',
      title: {
        zh: '工具卡悬停预览',
        en: 'Hover previews for tool calls'
      },
      desc: {
        zh: '鼠标停在工具行上，就会浮出命令、输出、完整路径、增删行或错误摘要。浮层只做预览、不挡鼠标，滚出视野自动收起；完整内容仍然点开卡片看。',
        en: 'Hover a tool call to see its command, output, full path, diff stats, or error summary. The popup is preview-only and never blocks the pointer; it dismisses when scrolled away, while the full details stay behind a click.'
      }
    },
    sections: [
      {
        kind: 'improved',
        items: [
          {
            icon: 'sparkle',
            title: {
              zh: '等待与思考的星核动效',
              en: 'Orb animation for waiting and thinking'
            },
            desc: {
              zh: '等待响应和思考行的标记换成星核：核心呼吸、卫星沿椭圆轨道、标题渐变流光；展开的思考卡带扫描光带。浅色与星野主题有单独配色，系统开启「减少动态效果」时自动停下。',
              en: 'Waiting and thinking rows now use an orb: a breathing core, satellites on elliptical orbits, and a flowing gradient label; the expanded thinking card gets a scan line. It has dedicated light and starfield palettes and stops when reduced motion is requested.'
            }
          },
          {
            icon: 'rich-text',
            title: {
              zh: '拖入文件自动识别编码',
              en: 'Encoding detection for dropped files'
            },
            desc: {
              zh: '拖进输入框的文本文件不再一律按 UTF-8 读取：BOM、UTF-16 / 32、严格 UTF-8 都能识别，识别不出时回落到 GB18030；非 UTF-8 的源编码标在引用卡上，无 BOM 的宽字符文件也不再被当成二进制。',
              en: 'Text files dropped into the composer are no longer read as UTF-8 only: BOM, UTF-16 / 32, and strict UTF-8 are detected, with GB18030 as a fallback. Non-UTF-8 source encodings show on the reference card, and BOM-less wide-character files are no longer treated as binary.'
            }
          }
        ]
      }
    ]
  },
  {
    version: '1.2.25',
    date: '2026-11-07',
    highlight: {
      icon: 'rich-text',
      title: {
        zh: '拖入文件自动识别编码',
        en: 'Encoding detection for dropped files'
      },
      desc: {
        zh: '拖进输入框的文本文件不再一律按 UTF-8 读取。GBK、Big5、Shift-JIS、EUC-KR、UTF-16 / 32 等编码会自动识别，非 UTF-8 的源编码会标在引用卡上。',
        en: 'Text files dropped into the composer are no longer read as UTF-8 only. GBK, Big5, Shift-JIS, EUC-KR, and UTF-16 / 32 are detected automatically, and non-UTF-8 source encodings are shown on the reference card.'
      }
    },
    sections: [
      {
        kind: 'improved',
        items: [
          {
            icon: 'rich-text',
            title: { zh: '拖入文件与二进制判定', en: 'Dropped files and binary detection' },
            desc: {
              zh: '无 BOM 的 UTF-16 / 32 文件不再被当成二进制跳过；真正含 NUL 的二进制仍会跳过。截断到 512 KB 时，落在多字节字符中间的半个字符不会再以替换符的形式出现在引用卡里。',
              en: 'BOM-less UTF-16 / 32 files are no longer skipped as binary, while real binaries containing NUL bytes still are. When truncating at 512 KB, a multi-byte character cut in half no longer shows up as a replacement character on the reference card.'
            }
          }
        ]
      }
    ]
  },
  {
    version: '1.2.24',
    date: '2026-11-05',
    highlight: {
      icon: 'sparkle',
      title: {
        zh: '插件系统上线',
        en: 'Plugins arrive'
      },
      desc: {
        zh: '侧栏新增插件页。免代码插件只需要 manifest 和 CSS，需要逻辑的插件用单文件 ESM；本地目录安装、热重载、启停和市场安装都已打通。',
        en: 'A new Plugins page in the sidebar. No-code plugins need only a manifest and CSS; code plugins are a single ESM file. Local install, hot reload, enable/disable, and market install all work.'
      }
    },
    sections: [
      {
        kind: 'new',
        items: [
          {
            icon: 'sparkle',
            title: { zh: '插件与市场', en: 'Plugins and market' },
            desc: {
              zh: '支持状态栏、命令面板、设置页、主区页签、主题 token 和受限 CSS；权限按风险分级并在安装前展示。市场读取静态索引、校验 sha256 后安装，远程不可用时回退到内置索引。',
              en: 'Plugins can extend the status bar, command palette, settings, main-area tabs, theme tokens, and scoped CSS. Permissions are risk-rated and shown before install. The market validates sha256 and falls back to a bundled index when the remote is unavailable.'
            }
          },
          {
            icon: 'review',
            title: { zh: '文件检查点', en: 'File checkpoints' },
            desc: {
              zh: '每轮开始前自动给工作区拍快照，可以从会话菜单预览并恢复到任意一轮开始前的状态；恢复前会再拍一份备份，恢复错了还能退回来。快照使用应用自己的 shadow git 仓库，不碰用户仓库的 HEAD / index / stash。',
              en: 'A workspace snapshot is captured before every turn. Preview and restore to the state before any turn from the session menu; a backup is captured first so the restore itself can be undone. Snapshots use an app-owned shadow Git repository and never touch the user’s HEAD, index, or stash.'
            }
          },
          {
            icon: 'batch',
            title: { zh: '会话分叉', en: 'Session fork' },
            desc: {
              zh: '从会话菜单把当前对话复制成一条新会话。Claude 走 --fork-session，Codex 走 thread/fork；新会话拥有自己的记录，后续修改不会回写原会话。',
              en: 'Copy the current conversation into a new session from the session menu. Claude uses --fork-session and Codex uses thread/fork; the fork gets its own record, so later changes never write back to the original.'
            }
          }
        ]
      },
      {
        kind: 'improved',
        items: [
          {
            icon: 'collapse',
            title: { zh: '便携版配置隔离', en: 'Portable build keeps its own data' },
            desc: {
              zh: '便携版把数据写到 exe 同级的 CCoderData，不再和安装版共用 %APPDATA%，同时启动时不会再因为配置锁互相挤掉。',
              en: 'The portable build now stores data in CCoderData next to the executable instead of sharing %APPDATA% with the installed build, so the two no longer knock each other out over the profile lock.'
            }
          }
        ]
      }
    ]
  },
  {
    version: '1.2.23',
    date: '2026-11-05',
    highlight: {
      icon: 'review',
      title: {
        zh: 'diff 按整文件显示',
        en: 'Diffs now render the whole file'
      },
      desc: {
        zh: '未修改的行也铺出来，行号连续可读；上一处 / 下一处、并排 / 统一、折叠未修改都在顶部，Alt + ↑ / ↓ 或 F7 直接跳转。',
        en: 'Unchanged lines stay in place so line numbers are continuous. Previous/next change, split/unified, and collapse-unchanged live in the toolbar; jump with Alt + ↑ / ↓ or F7.'
      }
    },
    sections: [
      {
        kind: 'new',
        items: [
          {
            icon: 'review',
            title: { zh: '整文件 diff 视图', en: 'Whole-file diff view' },
            desc: {
              zh: '差异页签按整文件渲染，支持并排 / 统一两种视图、折叠未修改和右侧改动导航条。长行可以用底部横向滚动条或 Shift + 滚轮左右拖动。',
              en: 'Diff tabs render the complete file with split and unified modes, collapsible unchanged regions, and a change navigator. Long lines pan via the bottom scrollbar or Shift + wheel.'
            }
          },
          {
            icon: 'keyboard',
            title: { zh: '差异导航', en: 'Change navigation' },
            desc: {
              zh: '顶部按钮、Alt + ↑ / ↓ 和 F7 / Shift + F7 可以跳到上一处 / 下一处差异；超过 2 MB、二进制、冲突 combined diff 或读不到完整文本时自动回落到原来的差异块视图。',
              en: 'Toolbar buttons, Alt + ↑ / ↓, and F7 / Shift + F7 jump between changes. Binary files, files over 2 MB, combined conflict diffs, or unavailable text fall back to the hunk view.'
            }
          }
        ]
      },
      {
        kind: 'improved',
        items: [
          {
            icon: 'collapse',
            title: { zh: 'diff 面板不再周期性闪烁', en: 'The diff panel no longer flashes periodically' },
            desc: {
              zh: '后台 VCS 刷新失败时保留已有内容，不再把整块界面闪成错误页；diff 内容没变化时复用旧对象，避免整棵 diff 树重渲染。',
              en: 'A failed background VCS refresh now keeps the existing content instead of flashing an error page, and unchanged diffs reuse the previous object so the diff tree no longer re-renders wholesale.'
            }
          },
          {
            icon: 'sparkle',
            title: { zh: '上下文用量显示修正', en: 'Context usage is reported correctly' },
            desc: {
              zh: '长轮次里上下文胶囊不再把整轮累计 token 当成当前上下文（之前会显示 4.3M / 1M 并误报接近上限）。现在按最后一次请求的输入、缓存和输出计算。',
              en: 'Long turns no longer show the whole turn’s cumulative tokens as the current context (previously 4.3M / 1M with a false near-limit warning). The meter now uses the last request’s input, cache, and output.'
            }
          }
        ]
      }
    ]
  },
  {
    version: '1.2.22',
    date: '2026-11-04',
    highlight: {
      icon: 'sparkle',
      title: {
        zh: '六套带氛围的主题上线',
        en: 'Six ambient themes arrive'
      },
      desc: {
        zh: '极光、余烬、深渊、樱夜、全息棱镜、冰川晨曦。光晕和粒子只占空白处，玻璃面板把正文托住，长时间阅读也不费眼。',
        en: 'Aurora, Ember, Abyss, Sakura Night, Holographic Prism, and Glacier Dawn. Glows and particles stay out of the way while glass panels keep the text readable.'
      }
    },
    sections: [
      {
        kind: 'new',
        items: [
          {
            icon: 'sparkle',
            title: { zh: '极光 · 余烬 · 深渊 · 樱夜', en: 'Aurora, Ember, Abyss, Sakura Night' },
            desc: {
              zh: '四套动态深色主题：极光带缓慢流动、火星从底部升起、深海荧光漂浮、樱瓣在夜色里落下。每套都有独立的调色板和运行态颜色。',
              en: 'Four animated dark themes: drifting aurora ribbons, embers rising from the bottom, deep-sea bioluminescence, and petals falling through the night. Each has its own palette and running-state color.'
            }
          },
          {
            icon: 'rich-text',
            title: { zh: '全息棱镜 · 冰川晨曦', en: 'Holographic Prism, Glacier Dawn' },
            desc: {
              zh: '一套是石墨底上缓慢流动的虹彩，一套是冰蓝浅色配磨砂玻璃。前者克制，后者适合白天使用。',
              en: 'One is slow iridescent light over graphite; the other is icy blue with frosted glass. The first stays restrained, the second is made for daytime.'
            }
          },
          {
            icon: 'collapse',
            title: { zh: '玻璃面板与减少动态', en: 'Glass panels and reduced motion' },
            desc: {
              zh: '标题栏、侧栏、输入框、代码块和工具卡都换成半透明玻璃，背景只在空白处呼吸。开启「减少动态」后，光晕动画和粒子层会全部停止。',
              en: 'The titlebar, sidebar, composer, code blocks, and tool cards become translucent glass so the background can breathe. With reduced motion enabled, animations and particle layers stop entirely.'
            }
          }
        ]
      },
      {
        kind: 'improved',
        items: [
          {
            icon: 'sparkle',
            title: { zh: '背景层会随主题正确卸载', en: 'Background layers unload with the theme' },
            desc: {
              zh: '切回普通主题后，氛围背景和 canvas 粒子会立即移除，不留残影，也不继续占用渲染资源。',
              en: 'Switching back to a regular theme immediately removes the ambient layer and its canvas particles, with no leftovers and no wasted rendering work.'
            }
          },
          {
            icon: 'keyboard',
            title: { zh: 'IDE 编辑体验改进', en: 'IDE editing refinements' },
            desc: {
              zh: '草稿改为按文件保存，重启后能恢复，旧版按工作区存储的草稿会自动迁移；状态栏显示光标行列，面包屑跟随光标更新；打开文件时的加载占位更稳定，切换页签不会丢失编辑器状态。',
              en: 'Drafts are now stored per file and restored after a restart, with automatic migration from the old workspace-level format. The status bar shows the cursor line and column, breadcrumbs follow the cursor, and the loading placeholder no longer drops editor state when switching tabs.'
            }
          }
        ]
      }
    ]
  },
  {
    version: '1.2.21',
    date: '2026-11-04',
    highlight: {
      icon: 'sparkle',
      title: {
        zh: '星野主题下，更新面板能正常点了',
        en: 'The update panel is clickable again in the starfield theme'
      },
      desc: {
        zh: '修掉一个层级问题：星野主题的正文层盖在标题栏上方，更新面板看得见却点不动。标题栏现在独立成层，下载和重启安装都能正常触发。',
        en: 'Fixed a stacking issue in the starfield theme where the transcript sat above the titlebar, making the update panel visible but unclickable. The titlebar is now its own layer, so download and restart-to-install work again.'
      }
    },
    sections: [
      {
        kind: 'improved',
        items: [
          {
            icon: 'sparkle',
            title: { zh: '标题栏不再被正文盖住', en: 'The titlebar stays above the content' },
            desc: {
              zh: '星野主题给正文层加了 z-index 来压背景遮罩，标题栏没有定位，整条落在它下面。现在标题栏有独立的层级，更新面板、窗口按钮的点击都不会再被透明的转写区接走。',
              en: 'The starfield theme raised the transcript to cover its background scrim, which left the unpositioned titlebar underneath. The titlebar now has its own stacking level, so the update panel and window buttons no longer lose clicks to the transparent transcript.'
            }
          }
        ]
      }
    ]
  },
  {
    version: '1.2.20',
    date: '2026-11-04',
    highlight: {
      icon: 'review',
      title: {
        zh: 'IDE 更像一个完整编辑器了',
        en: 'The IDE grew into a fuller editor'
      },
      desc: {
        zh: '资源管理器支持多选、拖拽和复制粘贴；右侧新增审阅栏；未命名缓冲区、语言模式、LF / CRLF、编码自动识别和 .editorconfig 一起补上；编辑器偏好扩展到字体、光标、参考线与粘性滚动。星野主题换成极光帷幕，新会话也有了自己的上手卡片。',
        en: 'The explorer now supports multi-select, drag and drop, and copy / paste. A review panel arrives on the right, alongside untitled buffers, language mode, LF / CRLF, automatic encoding detection, and .editorconfig. Editor preferences expand to fonts, cursor, guides, and sticky scroll. The starfield theme gets aurora curtains, and new chats get a proper start screen.'
      }
    },
    sections: [
      {
        kind: 'new',
        items: [
          {
            icon: 'review',
            title: { zh: '右侧审阅栏', en: 'Review panel' },
            desc: {
              zh: '汇总工作区改动，按文件展开与 HEAD 比较的 hunk 摘要，点击直接打开对应 diff；没有改动或不是仓库时自动收起，也可以从活动栏手动开合。',
              en: 'Summarizes workspace changes with per-file hunks compared against HEAD; click straight through to the diff. It collapses automatically when the workspace is clean or not a repository, and can be toggled from the activity rail.'
            }
          },
          {
            icon: 'lsp',
            title: { zh: '路径 + 符号面包屑', en: 'Path and symbol breadcrumbs' },
            desc: {
              zh: '编辑器顶部显示当前文件路径和光标所在符号，点击即可跳到对应的文件或定义。',
              en: 'The top of the editor shows the current file path and the symbol under the cursor; click either to jump to the file or definition.'
            }
          },
          {
            icon: 'keyboard',
            title: { zh: '未命名缓冲区与文件切换', en: 'Untitled buffers and file switching' },
            desc: {
              zh: 'Ctrl+N 新建未命名缓冲区，支持另存为、手动切换语言模式、切换 LF / CRLF；未保存前一直标记为未保存。',
              en: 'Ctrl+N opens an untitled buffer with Save As, manual language mode, and LF / CRLF switching; it stays marked dirty until saved.'
            }
          },
          {
            icon: 'rich-text',
            title: { zh: '打开时自动识别编码', en: 'Encoding detected on open' },
            desc: {
              zh: '识别 BOM、UTF-8、GBK / GB18030、Big5、Shift-JIS、EUC-JP / KR、UTF-16 / 32，以及常见的西欧 / 俄文单字节编码；状态栏可以手动改写或恢复自动检测。',
              en: 'Detects BOM, UTF-8, GBK / GB18030, Big5, Shift-JIS, EUC-JP / KR, UTF-16 / 32, and common Western / Cyrillic single-byte encodings. The status bar can override it or return to auto-detect.'
            }
          },
          {
            icon: 'hooks',
            title: { zh: '读取工作区 .editorconfig', en: 'Workspace .editorconfig support' },
            desc: {
              zh: 'indent_style / indent_size / tab_width / end_of_line / insert_final_newline / trim_trailing_whitespace 会覆盖全局设置和按语言配置。',
              en: 'indent_style, indent_size, tab_width, end_of_line, insert_final_newline, and trim_trailing_whitespace override global and per-language settings.'
            }
          },
          {
            icon: 'sparkle',
            title: { zh: '星野主题与新会话空态', en: 'Starfield theme and a new start screen' },
            desc: {
              zh: '星野主题改为极光帷幕背景，星点更密并加入疏散星团；新会话空态用四张卡片说明 @、/、图片与执行者，随主题明暗适配。',
              en: 'The starfield theme now paints aurora curtains with denser stars and an open cluster. New chats explain @, /, images, and runners with four cards that adapt to light and dark themes.'
            }
          }
        ]
      },
      {
        kind: 'improved',
        items: [
          {
            icon: 'collapse',
            title: { zh: '资源管理器操作补齐', en: 'A more capable explorer' },
            desc: {
              zh: '支持 Ctrl / Shift 多选、全选、拖拽移动（按住 Ctrl / Alt 为复制）、内部复制 / 剪切 / 粘贴和多选删除；可切换隐藏文件与 node_modules / dist 等忽略目录，并按工作区自定义忽略 glob。',
              en: 'Ctrl / Shift multi-select, select all, drag to move (hold Ctrl / Alt to copy), in-app copy / cut / paste, and multi-item delete. Toggle dotfiles and ignored folders such as node_modules / dist, and define per-workspace ignore globs.'
            }
          },
          {
            icon: 'keyboard',
            title: { zh: '编辑器偏好扩展到细节', en: 'Editor preferences down to the details' },
            desc: {
              zh: '新增字体、连字、行高、字距、换行列宽、光标形状 / 闪烁 / 平滑移动、当前行、空白与控制字符、行号（含相对行号）、缩进 / 括号参考线、列标尺、缩略图、粘性滚动、平滑滚动、Ctrl + 滚轮缩放、保存时格式化和按语言缩进；终端字号与行高单独可调。',
              en: 'New font, ligatures, line height, letter spacing, wrap column, cursor style / blinking / smooth movement, current line, whitespace and control characters, line numbers (including relative), indent and bracket guides, column ruler, minimap, sticky scroll, smooth scrolling, Ctrl + wheel zoom, format on save, and per-language indentation. Terminal font size and line height are separate.'
            }
          },
          {
            icon: 'search',
            title: { zh: '搜索替换更稳', en: 'Safer search and replace' },
            desc: {
              zh: '结果按文件折叠，替换前先给逐文件预览，替换后可以撤销一次；搜索历史按工作区保存。替换后又被外部修改的文件会跳过，不会覆盖新内容。',
              en: 'Results collapse by file, replace shows a per-file preview first, and the last replace can be undone once. Search history is kept per workspace. Files modified externally after a replace are skipped rather than overwritten.'
            }
          },
          {
            icon: 'sparkle',
            title: { zh: '思考深度有了能量反馈', en: 'Thinking depth with energy feedback' },
            desc: {
              zh: '拖动思考深度时，滑轨会按档位打出粒子、电弧和涟漪；暗色与浅色主题共用同一套配色，减少动态效果时自动安静下来。',
              en: 'Dragging thinking depth sends sparks, arcs, and ripples along the track, tuned per level. Dark and light themes share one palette, and it quiets down when reduced motion is requested.'
            }
          }
        ]
      }
    ]
  },
  {
    version: '1.2.19',
    date: '2026-11-03',
    highlight: {
      icon: 'sparkle',
      title: {
        zh: '侧栏刷新更快，轮末不再卡一下',
        en: 'Faster sidebar refreshes, smoother turn endings'
      },
      desc: {
        zh: 'dsh / codex 的会话列表也改成了监听增量，没变的记录连 stat 都省掉；轮末一次报出的大量文件改动合并成一次界面更新；切走的老会话超过上限后按最久未打开回收，长时间使用不再只涨内存。',
        en: 'dsh and codex session lists now scan incrementally, skipping even the stat for unchanged records. Batches of file changes at the end of a turn are merged into one UI update, and old sessions you navigated away from are reclaimed least-recently-used once over the cache limit, so memory stops growing indefinitely.'
      }
    },
    sections: [
      {
        kind: 'improved',
        items: [
          {
            icon: 'batch',
            title: {
              zh: 'dsh / codex 列表增量扫描',
              en: 'Incremental dsh / codex session lists'
            },
            desc: {
              zh: '递归监听 dsh 的会话目录和投影缓存、codex 的 rollout 目录：没被改动过的会话直接复用上一次的解析结果，连 stat 都不做；dsh 标题变更也能及时反映。监听不可用时自动退回全量扫描，并每 60 秒兜底校验一次。',
              en: 'dsh session and projection-cache directories plus codex rollout directories are watched recursively. Unchanged sessions reuse their previous parse without even a stat, and dsh title changes still show up promptly. If watching is unavailable it falls back to a full scan with a 60-second revalidation.'
            }
          },
          {
            icon: 'sparkle',
            title: {
              zh: '轮末文件改动合并更新',
              en: 'File changes batched at turn end'
            },
            desc: {
              zh: '一轮结束时磁盘快照可能一次报出几十到几百个路径。以前每个路径都会单独触发一次界面更新，现在先在后台合并，再一次性落到「本轮修改」，轮末不再出现成串的重渲染。',
              en: 'A turn can produce dozens or hundreds of changed paths at once. Each one used to trigger its own UI update; they are now merged and applied in a single update, removing the burst of re-renders at the end of a turn.'
            }
          },
          {
            icon: 'collapse',
            title: {
              zh: '老会话缓存有上限',
              en: 'Bounded cache for old sessions'
            },
            desc: {
              zh: '切走的会话仍会保留以便秒开，但最多缓存 8 条；超出后按最久未打开回收，且只回收没在跑、没排队、没有后台任务和待审批的那些。打开过很多大会话时，渲染进程内存不再一路增长。',
              en: 'Sessions you navigate away from stay cached for instant switching, up to eight. Beyond that the least-recently-used ones are reclaimed — only when idle, with no queued messages, background tasks or pending approvals. Memory no longer grows without bound after visiting many large sessions.'
            }
          },
          {
            icon: 'batch',
            title: {
              zh: '追加写会话不再重复读头',
              en: 'No repeated head reads for appended sessions'
            },
            desc: {
              zh: '会话记录只会追加，文件变长时直接复用已经解析好的 cwd / 标题 / 创建时间，不再每轮重读 32KB 文件头。',
              en: 'Session records are append-only, so when a file grows the already-parsed cwd, title and creation time are reused instead of re-reading the 32KB header every turn.'
            }
          }
        ]
      }
    ]
  },
  {
    version: '1.2.18',
    date: '2026-11-02',
    highlight: {
      icon: 'sparkle',
      title: {
        zh: '侧栏只扫变动的，长会话一次成型',
        en: 'Sidebar scans only what changed; long sessions build in one pass'
      },
      desc: {
        zh: 'Claude 会话列表改为监听文件变化、只重扫改动过的记录，没变的文件连 stat 都省掉；打开旧会话时的历史回放合并成一次遍历并原地构建，大会话不再为每条事件整表拷贝。',
        en: 'The Claude session list now watches for file changes and rescans only what changed — unchanged files are not even stat-ed. Opening an old session replays its history in one pass that builds the list in place, instead of copying it for every event.'
      }
    },
    sections: [
      {
        kind: 'improved',
        items: [
          {
            icon: 'batch',
            title: {
              zh: '会话列表增量扫描',
              en: 'Incremental session-list scans'
            },
            desc: {
              zh: '监听 ~/.claude/projects 的写入，只重扫被改动过的 .jsonl；其余记录直接复用上次的解析结果，连 stat 都不做，Windows 上几百份文件的每趟 IO 尖刺随之消失。监听不可用时自动退回全量扫描，并每 60 秒兜底校验一次，避免漏掉事件。',
              en: 'Writes under ~/.claude/projects are watched, so only changed .jsonl files are rescanned. Everything else reuses its last parse without even a stat, removing the per-refresh IO spike from hundreds of files on Windows. If watching is unavailable it falls back to a full scan, with a 60-second revalidation to catch missed events.'
            }
          },
          {
            icon: 'sparkle',
            title: {
              zh: '长会话回放只遍历一次',
              en: 'Large-session replay in a single pass'
            },
            desc: {
              zh: '打开旧会话时，卡片、轮数、步数、用量、输入历史和「本轮修改」合并成一次遍历；回放期间直接原地构建列表，不再每来一条事件浅拷贝整张表，大会话首屏开销从 O(n²) 降到 O(n)。',
              en: 'Cards, turn count, steps, usage, input history and "changed this turn" are now derived in a single pass when opening an old session. Replay builds the list in place instead of shallow-copying it per event, taking large-session first paint from O(n²) to O(n).'
            }
          }
        ]
      }
    ]
  },
  {
    version: '1.2.17',
    date: '2026-11-02',
    highlight: {
      icon: 'sparkle',
      title: {
        zh: '输入历史，顺手翻；大会话，不卡顿',
        en: 'Input history, and large sessions that stay responsive'
      },
      desc: {
        zh: '输入框现在按 ↑ / ↓ 就能翻出本会话发过的内容，重启后仍然保留；Claude 大会话的解析移到独立线程，打开长会话不再占住主进程；搜索和侧栏刷新也减少了重复工作。',
        en: 'Press ↑ / ↓ in the composer to step through what you sent in this session, even after a restart. Claude history parsing now runs off the main thread, so opening a large session no longer blocks IPC or streaming, and search and sidebar refreshes do less repeated work.'
      }
    },
    sections: [
      {
        kind: 'new',
        items: [
          {
            icon: 'keyboard',
            title: {
              zh: '输入历史与上下键切换',
              en: 'Input history with ↑ / ↓'
            },
            desc: {
              zh: '每条会话单独记录发送过的原话。输入框里按 ↑ 往前翻、按 ↓ 返回；越过最新一条会恢复翻历史前的草稿。只在首行接管 ↑，多行编辑、选区、输入法和 @ / 命令弹层都不受影响。历史保留在本机，最多 100 条 / 200KB；打开旧会话时会从已有转写自动补齐。',
              en: 'Each session records the text you actually sent. Press ↑ in the composer to go back and ↓ to return; going past the newest entry restores the draft you had before. ↑ is intercepted only on the first line, so multiline editing, selections, IME composition and the @ / slash popups keep working. History stays on this machine (up to 100 entries / 200KB per session) and is backfilled from the existing transcript when you open an old session.'
            }
          }
        ]
      },
      {
        kind: 'improved',
        items: [
          {
            icon: 'sparkle',
            title: {
              zh: '大会话解析移出主线程',
              en: 'Large sessions parse off the main thread'
            },
            desc: {
              zh: 'Claude 历史记录的读盘、JSON 解析和回放搬到独立 worker；超过 2MB 的会话在后台解析，打开长会话时 IPC 和流式输出不再被同步解析卡住，worker 不可用时自动回退主线程。',
              en: 'Reading, JSON parsing and replay of Claude history now run in a worker. Sessions over 2MB are parsed in the background, so opening a long session no longer stalls IPC or streaming; it falls back to the main thread if the worker is unavailable.'
            }
          },
          {
            icon: 'search',
            title: {
              zh: '搜索与侧栏刷新更省',
              en: 'Lighter search and sidebar refreshes'
            },
            desc: {
              zh: '会话搜索按会话缓存小写文本，连续输入不再重复转换整份记录；侧栏在内容没变时复用旧列表，窗口聚焦触发的刷新最多 4 秒一次。',
              en: 'Session search caches the lowercased text per session, so typing no longer re-lowercases the whole record; the sidebar reuses its list when nothing changed, and focus-triggered refreshes are limited to once every four seconds.'
            }
          },
          {
            icon: 'batch',
            title: {
              zh: '长会话的工具事件更轻',
              en: 'Lighter tool events in long sessions'
            },
            desc: {
              zh: '工具卡查找改为从转写尾部向前，工具回执只替换目标一项，不再为每个回执遍历整条会话。',
              en: 'Tool-card lookup now starts from the end of the transcript and a tool result replaces only its target item instead of walking the whole session.'
            }
          }
        ]
      }
    ]
  },
  {
    version: '1.2.16',
    date: '2026-11-02',
    highlight: {
      icon: 'sparkle',
      title: {
        zh: '启动更快，长会话更轻',
        en: 'Faster startup, lighter long sessions'
      },
      desc: {
        zh: '主进程与 preload 首次压缩打包，安装包更小、启动解析更省；Codex / dsh 会话列表改为并发扫描，新会话用定向查询确认落盘；长会话的查找、轨迹页和轮末磁盘核对也减少了重复计算。',
        en: 'The main process and preload bundles are now minified for a smaller installer and less startup parsing. Codex and dsh session lists scan in parallel, new sessions are confirmed with a targeted lookup, and long sessions avoid repeated work in find, the trace tab and end-of-turn disk checks.'
      }
    },
    sections: [
      {
        kind: 'improved',
        items: [
          {
            icon: 'batch',
            title: {
              zh: '会话列表扫描进一步并发化',
              en: 'Session list scans get more parallelism'
            },
            desc: {
              zh: 'Codex 的 rollout 文件与 dsh 的会话目录改为 16 路并发处理，侧栏在 turn_end / 窗口聚焦后的刷新明显更快。',
              en: 'Codex rollout files and dsh session folders are processed 16 at a time, so the sidebar refreshes noticeably faster after a turn ends or the window regains focus.'
            }
          },
          {
            icon: 'search',
            title: {
              zh: '新会话更快出现在侧栏',
              en: 'New sessions show up sooner'
            },
            desc: {
              zh: '新增单条会话存在性查询：只定向检查记录文件是否落盘，确认后再刷新一次列表。原先最多 5 次全量扫描，现在只需 1 次。',
              en: 'A new existence check only looks for the session file and refreshes the list once it is there. What used to take up to five full scans now takes one.'
            }
          },
          {
            icon: 'sparkle',
            title: {
              zh: '主进程体积更小',
              en: 'Smaller main-process bundle'
            },
            desc: {
              zh: '主进程与 preload 开启压缩：主进程产物约 2.5MB → 1.5MB，preload 约 28KB → 18KB；截图产物也不再打进安装包。',
              en: 'The main process and preload are minified: the main bundle drops from about 2.5MB to 1.5MB and preload from about 28KB to 18KB. Screenshot artifacts are no longer bundled either.'
            }
          },
          {
            icon: 'rich-text',
            title: {
              zh: '查找与轨迹页更省 CPU',
              en: 'Find and the trace tab use less CPU'
            },
            desc: {
              zh: '会话内查找只在查找条打开时计算内容签名，不再为每个流式增量拼接整段工具输出；轨迹页屏幕外的行跳过排版。',
              en: 'In-conversation find now computes its content signature only while the find bar is open and no longer joins full tool output for every streaming delta. Off-screen trace rows skip layout as well.'
            }
          },
          {
            icon: 'collapse',
            title: {
              zh: '轮末磁盘核对更快',
              en: 'Faster end-of-turn disk checks'
            },
            desc: {
              zh: '未跟踪文件的行数按 mtime / size 缓存，轮前轮后两次快照不再重复读同一批没变的文件；结束的会话也会清掉文件写入者索引。',
              en: 'Line counts for untracked files are cached by mtime and size, so the two snapshots per turn stop re-reading unchanged files. Finished sessions also drop their file-writer index.'
            }
          }
        ]
      }
    ]
  },
  {
    version: '1.2.15',
    date: '2026-11-02',
    highlight: {
      icon: 'sparkle',
      title: {
        zh: '更新公告恢复显示',
        en: 'Update notes are back'
      },
      desc: {
        zh: '之前几个版本发版时漏写了更新说明，客户端按版本号精确匹配不到内容就会静默跳过。现在已补齐 1.2.9 起的说明，并让发版流程在缺少说明时直接停下，后续版本不会再漏。',
        en: "The last few releases shipped without their what's-new entry, and the client silently skipped the dialog when the exact version had no notes. Entries since 1.2.9 are now filled in, and the release pipeline fails when notes are missing, so future versions cannot slip through."
      }
    },
    sections: [
      {
        kind: 'improved',
        items: [
          {
            icon: 'review',
            title: {
              zh: '历史版本说明已补齐',
              en: 'Missing release notes backfilled'
            },
            desc: {
              zh: '1.2.9 ~ 1.2.14 的重点、新增与改进已按提交记录补写，中英文都有。',
              en: 'Highlights, additions and improvements for 1.2.9 through 1.2.14 are filled in from the commit history, in both languages.'
            }
          },
          {
            icon: 'lsp',
            title: {
              zh: '发版前自动校验说明',
              en: 'Release notes are checked before shipping'
            },
            desc: {
              zh: 'CI 会核对 package.json 的版本是否有对应说明；缺失、重复或中英文不完整都会让构建失败。',
              en: 'CI verifies that the package.json version has a matching entry; missing, duplicate or incomplete bilingual notes fail the build.'
            }
          },
          {
            icon: 'search',
            title: {
              zh: '公告去重不再提前消耗版本',
              en: 'The seen marker no longer burns a version'
            },
            desc: {
              zh: '展示记录改用独立的键，只有在真正弹出说明后才写入；某个版本当时没有说明，后补的内容仍能在下次启动补弹。',
              en: 'The "seen" marker now uses its own key and is written only after a dialog is actually shown, so notes added later can still appear on the next launch.'
            }
          },
          {
            icon: 'terminal',
            title: {
              zh: 'dsh 大会话解析移入后台 worker',
              en: 'dsh history parsing moves to a worker'
            },
            desc: {
              zh: '会话解压与 JSON 解析不再占用主进程；打开大会话时窗口、流式输出和 IPC 不会被同步解压卡住，拿不到 worker 时自动回退主线程。',
              en: 'Session decompression and JSON parsing no longer block the main process. Opening a large session keeps windows, streaming and IPC responsive, and it falls back to the main thread if the worker is unavailable.'
            }
          },
          {
            icon: 'batch',
            title: {
              zh: '会话列表扫描并发化',
              en: 'Session list scans run in parallel'
            },
            desc: {
              zh: '项目目录按 16 路、会话文件按 8 路并发扫描，Claude / Codex / dsh 三边同时启动，几百个会话的列表刷新明显更快。',
              en: 'Project directories scan 16 at a time and session files 8 at a time, with the Claude, Codex and dsh scans started together, so lists with hundreds of sessions refresh noticeably faster.'
            }
          },
          {
            icon: 'collapse',
            title: {
              zh: 'IDE 文件树只刷新受影响的目录',
              en: 'The IDE file tree refreshes only affected folders'
            },
            desc: {
              zh: 'Agent 连续写文件时不再让所有展开目录重新读取，只更新命中路径的子树；收起再展开的目录会重新列一次。',
              en: 'When the agent writes files in a burst, only the affected subtrees reload instead of every expanded folder. A collapsed folder refreshes when it is reopened.'
            }
          },
          {
            icon: 'rich-text',
            title: {
              zh: '流式输出不再出现乱码',
              en: 'No more broken characters in streamed output'
            },
            desc: {
              zh: 'stdout / stderr 交给流自己做 UTF-8 解码，中文或 emoji 正好跨缓冲区边界时不会再变成 �；NDJSON 分帧也避免了大 tool_result 的重复拼接。',
              en: 'stdout and stderr now decode UTF-8 at the stream level, so Chinese text or emoji split across buffer boundaries no longer turn into �. NDJSON framing also avoids re-joining large tool results.'
            }
          },
          {
            icon: 'search',
            title: {
              zh: '超大会话的读取上限与更快搜索',
              en: 'A cap for huge sessions and faster search'
            },
            desc: {
              zh: '尾部回放最多扩到 32MB，避免几百 MB 的会话把内存打爆；搜索只解析对话正文，跳过工具回执和图片 base64。',
              en: 'Tail replay now stops growing at 32MB so multi-hundred-MB sessions cannot exhaust memory, and search parses conversation text only, skipping tool results and image base64.'
            }
          }
        ]
      }
    ]
  },
  {
    version: '1.2.14',
    date: '2026-11-02',
    highlight: {
      icon: 'terminal',
      title: {
        zh: '大输出和磁盘快照不再拖慢长会话',
        en: 'Big output and disk snapshots stop slowing long sessions'
      },
      desc: {
        zh: 'Claude 工具输出统一归一化并截断到 20k 字符，实时流与历史回放同一口径；磁盘快照缓存 git 根目录、并行跑 status 与 diff，本轮没有工具活动时直接跳过轮末对比。',
        en: 'Claude tool output is normalized and capped at 20k characters in both live streams and history replay. Disk snapshots cache the git root, run status and diffs in parallel, and skip the end-of-turn comparison when no tools ran.'
      }
    },
    sections: [
      {
        kind: 'new',
        items: [
          {
            icon: 'rich-text',
            title: {
              zh: '流式 Markdown 按长度降频解析',
              en: 'Streaming Markdown parses less as it grows'
            },
            desc: {
              zh: '按文本长度在 16 / 48 / 100ms 之间调整解析频率，元素 memo 避免无变化重排，长回答滚动更顺。',
              en: 'Parse frequency scales with text length — 16 / 48 / 100ms — and memoized elements avoid re-rendering unchanged blocks, so long answers scroll more smoothly.'
            }
          },
          {
            icon: 'lsp',
            title: {
              zh: 'dsh 状态探测不再卡设置页',
              en: 'dsh probes no longer stall Settings'
            },
            desc: {
              zh: 'dsh 状态探测改为异步 execFile，node 能力与版本号带缓存，打开设置页不会再卡住主进程。',
              en: 'dsh status probes now use async execFile, and node capability and version lookups are cached, so opening Settings no longer blocks the main process.'
            }
          }
        ]
      },
      {
        kind: 'improved',
        items: [
          {
            icon: 'review',
            title: {
              zh: '磁盘快照并发化',
              en: 'Disk snapshots run in parallel'
            },
            desc: {
              zh: 'git 根目录只探测一次，status 与两条 diff 并行，文件 stat 按 16 路并发，轮末检查明显更快。',
              en: 'The git root is probed once, status and both diffs run in parallel, and file stats run 16 at a time, making end-of-turn checks noticeably faster.'
            }
          },
          {
            icon: 'sparkle',
            title: {
              zh: '空轮次跳过磁盘对比',
              en: 'Empty turns skip the disk diff'
            },
            desc: {
              zh: '本轮没有任何工具活动时不再做轮末磁盘对比，纯聊天轮次少一次无用扫描。',
              en: 'When a turn had no tool activity, the end-of-turn disk comparison is skipped, saving a pointless scan on chat-only turns.'
            }
          }
        ]
      }
    ]
  },
  {
    version: '1.2.13',
    date: '2026-11-02',
    highlight: {
      icon: 'sparkle',
      title: {
        zh: '大会话打开更快，长对话滚动更轻',
        en: 'Large sessions open faster and long chats scroll lighter'
      },
      desc: {
        zh: '会话记录列表与回放改为异步 I/O，大文件只读尾部；转写区默认只挂最近几块，往上翻再按需加载更早的内容。',
        en: 'Session lists and replay now use async I/O and large files are read from the tail only. The transcript mounts just the latest blocks and loads earlier ones on demand.'
      }
    },
    sections: [
      {
        kind: 'new',
        items: [
          {
            icon: 'collapse',
            title: {
              zh: '转写区窗口化',
              en: 'Windowed transcript'
            },
            desc: {
              zh: '默认只渲染最近几块消息，支持「加载更早」；公式与设置页也改为按需加载，首屏更轻。',
              en: 'Only the latest blocks render by default, with a "load earlier" action. Math and Settings load on demand too, keeping the first paint light.'
            }
          },
          {
            icon: 'keyboard',
            title: {
              zh: '字体选择器可搜索',
              en: 'Searchable font picker'
            },
            desc: {
              zh: '设置页字体改为可搜索选择器；本机字体枚举失败不再永久缓存，装完字体刷新即可看到。',
              en: 'The font picker in Settings is now searchable, and a failed system-font scan is no longer cached forever — install a font and refresh to see it.'
            }
          }
        ]
      },
      {
        kind: 'improved',
        items: [
          {
            icon: 'rich-text',
            title: {
              zh: '流式渲染合并',
              en: 'Batched streaming renders'
            },
            desc: {
              zh: 'token 增量按 16ms 合并，事件只发给聊天主窗口；组件 memo 配合稳定回调，流式输出期间重渲染更少。',
              en: 'Token deltas are merged every 16ms and events go only to the chat window. Memoized components and stable callbacks cut re-renders during streaming.'
            }
          },
          {
            icon: 'search',
            title: {
              zh: '回放缓存与扫描去重',
              en: 'Replay cache and deduped scans'
            },
            desc: {
              zh: '新增回放缓存与并发扫描去重，轮次快照按序暂存、进程代次隔离，跨轮事件不会串。',
              en: 'A replay cache and scan deduplication were added; turn snapshots are queued in order and isolated by process generation, so events no longer leak across turns.'
            }
          }
        ]
      }
    ]
  },
  {
    version: '1.2.12',
    date: '2026-10-30',
    highlight: {
      icon: 'terminal',
      title: {
        zh: 'Windows、Linux、macOS 同一套发版流程',
        en: 'One release pipeline for Windows, Linux and macOS'
      },
      desc: {
        zh: '新增 Linux（AppImage / deb）与 macOS（dmg / zip）打包配置；推送 tag 后 GitHub Actions 三端并行构建，全部成功后自动创建 Release 并上传产物。',
        en: 'Linux (AppImage / deb) and macOS (dmg / zip) targets are now configured. A tag triggers parallel builds on GitHub Actions, then a Release is created with every artifact once all three succeed.'
      }
    },
    sections: [
      {
        kind: 'new',
        items: [
          {
            icon: 'keyboard',
            title: {
              zh: '本机字体选择',
              en: 'Pick from installed fonts'
            },
            desc: {
              zh: '设置页字体下拉直接枚举系统已安装字体；「等宽字体」更名为「代码字体」，并说明它作用于代码与终端。',
              en: 'The font dropdown now lists fonts installed on your machine. "Monospace font" was renamed "Code font" and explains that it applies to code and the terminal.'
            }
          },
          {
            icon: 'terminal',
            title: {
              zh: 'Linux 与 macOS 安装包',
              en: 'Linux and macOS installers'
            },
            desc: {
              zh: 'Linux 出 AppImage / deb，macOS 出 dmg / zip；macOS 自动更新需要签名，仓库里已支持配置证书。',
              en: 'Linux ships AppImage and deb, macOS ships dmg and zip. macOS auto-update needs signing, and the repo now supports certificate secrets.'
            }
          }
        ]
      },
      {
        kind: 'improved',
        items: [
          {
            icon: 'bell',
            title: {
              zh: '后台续跑标记准确',
              en: 'Background continuations are marked correctly'
            },
            desc: {
              zh: '后台任务通知引发的 CLI 续跑会正确标记新一轮开始，不再和上一轮的结果混在一起。',
              en: 'When a CLI continues after a background-task notification, the new turn is marked correctly instead of blending into the previous result.'
            }
          },
          {
            icon: 'rich-text',
            title: {
              zh: '代码高亮与浅色主题细节',
              en: 'Code highlighting and light-theme polish'
            },
            desc: {
              zh: 'Markdown 代码块高亮与浅色主题的边框、对比度细节做了调整。',
              en: 'Markdown code highlighting plus light-theme borders and contrast got a polish pass.'
            }
          }
        ]
      }
    ]
  },
  {
    version: '1.2.11',
    date: '2026-10-30',
    highlight: {
      icon: 'sparkle',
      title: {
        zh: '六套浅色主题',
        en: 'Six light themes'
      },
      desc: {
        zh: '新增 paper、frost、mint、lavender、rose、sandstone 六套浅色主题，边框、控件与对比度统一到设计变量，IDE 侧同步适配。',
        en: 'Six new light themes — paper, frost, mint, lavender, rose and sandstone — with borders, controls and contrast unified on design tokens and the IDE adapted to match.'
      }
    },
    sections: [
      {
        kind: 'new',
        items: [
          {
            icon: 'sparkle',
            title: {
              zh: '主题选择列表',
              en: 'Theme picker'
            },
            desc: {
              zh: '设置里可以直接切换六套浅色主题，浅色模式不再只有一套配色。',
              en: 'Pick any of the six light themes in Settings, so light mode is no longer a single palette.'
            }
          },
          {
            icon: 'rich-text',
            title: {
              zh: 'Lua 语法高亮',
              en: 'Lua syntax highlighting'
            },
            desc: {
              zh: 'IDE 编辑器新增 Lua 语法高亮；自动保存提示也补了说明。',
              en: 'The IDE editor now highlights Lua, and the autosave hint explains what it does.'
            }
          }
        ]
      },
      {
        kind: 'improved',
        items: [
          {
            icon: 'collapse',
            title: {
              zh: '设置改为覆盖式弹窗',
              en: 'Settings opens as an overlay'
            },
            desc: {
              zh: '设置页改为覆盖式弹窗：对话不卸载，关闭后滚动位置和正在运行的状态都保持。',
              en: 'Settings is now an overlay: the chat stays mounted, and scroll position and running state survive closing it.'
            }
          },
          {
            icon: 'review',
            title: {
              zh: '浅色对比度调优',
              en: 'Light-theme contrast pass'
            },
            desc: {
              zh: '浅色主题的边框、控件配色与对比度统一到 tokens，IDE 侧同步调整。',
              en: 'Light-theme borders, control colors and contrast now come from shared tokens, with matching IDE updates.'
            }
          }
        ]
      }
    ]
  },
  {
    version: '1.2.10',
    date: '2026-10-30',
    highlight: {
      icon: 'review',
      title: {
        zh: '设置页先回答「CLI 能不能用」',
        en: 'Settings answers "can I use this CLI?" first'
      },
      desc: {
        zh: '安装与登录状态块移到「启用与更新」之后，进设置先看到是否启用、版本是否最新，再往下才是登录细节。',
        en: 'The install and sign-in status block moved below "Enable & update", so Settings leads with whether the CLI is enabled and up to date before the sign-in details.'
      }
    },
    sections: [
      {
        kind: 'new',
        items: [
          {
            icon: 'search',
            title: {
              zh: '资源管理器自动定位当前文件',
              en: 'Explorer follows the current file'
            },
            desc: {
              zh: '编辑器设置新增「在资源管理器中自动展开并定位」开关，默认开启；打开或切换文件时，资源管理器会自动展开到对应位置。',
              en: 'A new editor setting — on by default — expands the explorer to the current file whenever you open or switch files.'
            }
          }
        ]
      },
      {
        kind: 'improved',
        items: [
          {
            icon: 'keyboard',
            title: {
              zh: '设置页信息顺序调整',
              en: 'Reordered Settings'
            },
            desc: {
              zh: '设置页把启用、更新、安装、登录按使用顺序排列，常用状态不用再往下翻。',
              en: 'Enable, update, install and sign-in are now ordered by how people use them, so common status no longer requires scrolling.'
            }
          }
        ]
      }
    ]
  },
  {
    version: '1.2.9',
    date: '2026-10-29',
    highlight: {
      icon: 'terminal',
      title: {
        zh: '单条会话的附加目录',
        en: 'Extra directories for a single session'
      },
      desc: {
        zh: '输入框上方的「附加目录 +N」可以给这一条会话加 Claude 的 --add-dir；工作区始终可访问，新会话默认不带，也可以从「最近使用」里点选。',
        en: 'The "+N directories" control above the composer adds Claude --add-dir paths to that session only. The workspace is always available, new sessions start with none, and recent directories can be reused with a click.'
      }
    },
    sections: [
      {
        kind: 'new',
        items: [
          {
            icon: 'rich-text',
            title: {
              zh: '会话导出 Markdown',
              en: 'Export a session as Markdown'
            },
            desc: {
              zh: '聊天头部新增导出：包含用户消息、回答、工具摘要、错误与提问回答，跳过思考过程和界面状态。',
              en: 'Export from the chat header writes user messages, answers, tool summaries, errors and question answers to Markdown, skipping thinking and UI state.'
            }
          }
        ]
      },
      {
        kind: 'improved',
        items: [
          {
            icon: 'review',
            title: {
              zh: '附加目录的边界校验',
              en: 'Directory guardrails'
            },
            desc: {
              zh: '只接受绝对路径、必须存在且是文件夹、不能位于工作区内，按 realpath 去重，单会话最多 20 条；失效目录保留配置、启动时跳过，改动在下次启动 CLI 时生效。',
              en: 'Only absolute paths that exist, are directories and sit outside the workspace are accepted. Paths are deduped by realpath, capped at 20 per session, and missing ones stay configured but are skipped at startup. Changes apply the next time the CLI process starts.'
            }
          },
          {
            icon: 'search',
            title: {
              zh: '头部快捷动作',
              en: 'Header shortcuts'
            },
            desc: {
              zh: '聊天头部新增「在文件管理器中显示」与「复制工作目录」。',
              en: 'The chat header can now reveal the working directory in the file manager or copy its path.'
            }
          }
        ]
      }
    ]
  },
  {
    version: '1.2.8',
    date: '2026-10-29',
    highlight: {
      icon: 'hooks',
      title: {
        zh: 'Hooks 钩子有了管理界面',
        en: 'Hooks now have a manager'
      },
      desc: {
        zh: '设置 → 能力 → Hooks 里可以直接查看、新建、编辑和停用 Claude Code 的钩子：用户 / 项目 / 本地三档作用域可写，command / prompt / agent / http / mcp_tool 五种类型与 33 个事件全部覆盖，命令和 HTTP 还能在表单里试运行。',
        en: 'Settings → Capabilities → Hooks lets you view, add, edit and disable Claude Code hooks. User / project / local scopes are writable, all five types — command / prompt / agent / http / mcp_tool — and all 33 events are covered, and command and HTTP hooks can be test-run from the form.'
      }
    },
    sections: [
      {
        kind: 'new',
        items: [
          {
            icon: 'sparkle',
            title: {
              zh: '升级后先看一眼改了什么',
              en: 'See what changed after an update'
            },
            desc: {
              zh: '版本变化后首次启动会弹出本次更新说明，重点、新增和改进分开列出；同一个版本只弹一次，底部可以跳到完整的发布记录。',
              en: 'The first launch after a version change shows what is new, grouped into highlight, new and improved. It appears once per version, and the footer links to the full release history.'
            }
          },
          {
            icon: 'collapse',
            title: {
              zh: '提问卡片可以收起',
              en: 'Question cards can collapse'
            },
            desc: {
              zh: 'AskUserQuestion 写得再长也能先收成一行，回去翻上面的讨论，答完再展开 —— 收起只是折起正文，不影响已选答案。',
              en: 'Long AskUserQuestion cards collapse to a single row so you can scroll back through the discussion, then expand again. Collapsing only hides the body; answers are untouched.'
            }
          },
          {
            icon: 'terminal',
            title: {
              zh: 'dsh 原生指令直通',
              en: 'dsh slash commands run natively'
            },
            desc: {
              zh: '/goal、/export 这类 dsh 自己的指令现在会在原会话里执行，不再被当成普通消息发出去；/compact 也走 Web 的 commands/execute。',
              en: 'Commands such as /goal and /export now execute in the session instead of being sent as plain text, and /compact uses the Web commands/execute path.'
            }
          }
        ]
      },
      {
        kind: 'improved',
        items: [
          {
            icon: 'review',
            title: {
              zh: '本轮改动不再串会话',
              en: "This turn's changes stay with this turn"
            },
            desc: {
              zh: '同一工作区并行跑多条会话时，别的会话写的文件不会再出现在本会话的「本轮改动」里。',
              en: 'With several sessions running in one workspace, files written by another session no longer show up in this session’s changed-file list.'
            }
          },
          {
            icon: 'lsp',
            title: {
              zh: 'DSH Web 连接更稳',
              en: 'A steadier DSH Web connection'
            },
            desc: {
              zh: '渠道配置变化只让旧进程退池、不掐断正在跑的轮次；断线重连会补上漏掉的事件；$DSH_HOME 下的历史也能在侧栏看到，渠道测试按当前传输层实际发一句话。',
              en: 'A config change retires the old process without cutting running turns, reconnects replay missed events, sessions under $DSH_HOME appear in the sidebar, and the channel test sends a real message over the active transport.'
            }
          }
        ]
      }
    ]
  },
  {
    version: '1.2.7',
    date: '2026-10-28',
    highlight: {
      icon: 'rich-text',
      title: {
        zh: '富文本渲染全面升级',
        en: 'Rich text rendering, upgraded'
      },
      desc: {
        zh: '改用 react-markdown 渲染消息，GFM 表格、任务列表、代码块与 KaTeX 数学公式都能正确显示，长回答的结构也更清晰。',
        en: 'Messages now render with react-markdown. GFM tables, task lists, code blocks and KaTeX math all display correctly, and long answers are easier to scan.'
      }
    },
    sections: [
      {
        kind: 'new',
        items: [
          {
            icon: 'review',
            title: {
              zh: '本轮改动可随时审阅',
              en: "Review this turn's changes anytime"
            },
            desc: {
              zh: '对话结束后一键查看本轮修改过的文件与 diff，不需要再翻 git 记录。',
              en: 'See every file changed in this turn, with its diff, without digging through git history.'
            }
          },
          {
            icon: 'batch',
            title: {
              zh: '会话批量选择与删除',
              en: 'Batch select and delete sessions'
            },
            desc: {
              zh: '会话列表支持多选、全选，一次清理多个会话。',
              en: 'Multi-select and select-all let you clean up several sessions at once.'
            }
          },
          {
            icon: 'search',
            title: {
              zh: '消息级操作与会话内查找',
              en: 'Message actions and in-session search'
            },
            desc: {
              zh: '单条消息可复制、引用；Ctrl+F 在当前会话里直接搜索，命中处逐条跳转。',
              en: 'Copy or quote a single message; Ctrl+F searches the current session and jumps between hits.'
            }
          },
          {
            icon: 'bell',
            title: {
              zh: '任务跑完主动提醒',
              en: 'Notified when a task finishes'
            },
            desc: {
              zh: '长任务结束时发系统通知，切到别的窗口也不会错过结果。',
              en: 'A system notification when a long task ends, so results are not missed in another window.'
            }
          }
        ]
      },
      {
        kind: 'improved',
        items: [
          {
            icon: 'keyboard',
            title: {
              zh: '快捷键自定义与文件编码',
              en: 'Custom shortcuts and file encoding'
            },
            desc: {
              zh: '设置页可改键位，编辑器新增文件编码选项与 IDE 设置弹窗。',
              en: 'Remap shortcuts in settings, plus file-encoding options and an IDE settings dialog.'
            }
          },
          {
            icon: 'lsp',
            title: {
              zh: 'CLI 更新检查与 LSP 能力扩展',
              en: 'CLI update checks and broader LSP support'
            },
            desc: {
              zh: '启动时可检查 CLI 新版本；语言服务补齐补全、跳转与诊断能力。',
              en: 'Check for new CLI versions at startup; language services now cover completion, go-to-definition and diagnostics.'
            }
          }
        ]
      }
    ]
  }
]

/** 按安装版本取更新说明；允许调用方传带 v 前缀的版本号 */
export function whatsNewFor(version: string): WhatsNewRelease | undefined {
  const v = version.trim().replace(/^v/i, '')
  return WHATS_NEW_RELEASES.find((r) => r.version === v)
}

/** 本次更新条目数：重点也算一项 */
export function whatsNewCount(release: WhatsNewRelease): number {
  return 1 + release.sections.reduce((n, s) => n + s.items.length, 0)
}

export function whatsNewText(text: WhatsNewText, locale: ResolvedLocale): string {
  return locale === 'en' ? text.en : text.zh
}
