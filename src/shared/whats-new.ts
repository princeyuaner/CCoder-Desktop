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
