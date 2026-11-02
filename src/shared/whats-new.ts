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
