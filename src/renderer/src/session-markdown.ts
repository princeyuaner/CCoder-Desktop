import type { I18nApi } from './i18n'
import type { ChatItem } from './useChat'
import { parseIdeRefs } from './ideRef'

export interface MarkdownSession {
  title: string
  cwd: string
  cliName: string
  /** 新会话还没拿到 CLI id 时为空 */
  sessionId?: string
  items: readonly ChatItem[]
}

/**
 * 把转写区导出成 Markdown。
 *
 * 只收用户真正想留下的内容：用户消息、模型回答、工具调用摘要、错误和
 * 提问的回答。思考过程、审批留痕、回合分隔条（以及设置切换的系统留痕）
 * 不进导出 —— 它们是界面状态，不是对话内容。
 *
 * 连续的文本卡会并到同一个「助手」小节里：转写区为了画出"一步步在干什么"
 * 把每条 delta 拆成了独立的卡，照搬成 Markdown 会变成一串碎标题。
 */
export function sessionToMarkdown(session: MarkdownSession, i18n: I18nApi): string {
  const { t } = i18n
  const out: string[] = []
  const push = (...lines: string[]): void => {
    out.push(...lines)
  }

  push(`# ${session.title || t('chat.export.untitled')}`, '')
  push(`- ${t('chat.export.meta.cwd', { path: session.cwd || '—' })}`)
  push(`- ${t('chat.export.meta.cli', { name: session.cliName })}`)
  push(
    `- ${t('chat.export.meta.sessionId', {
      id: session.sessionId || t('chat.export.meta.pending')
    })}`
  )
  push(
    `- ${t('chat.export.meta.exportedAt', {
      time: new Date().toLocaleString(i18n.locale)
    })}`,
    '',
    '---'
  )

  /** 上一次输出的是哪类内容 —— 用来合并连续的助手文本 */
  let last: ChatItem['kind'] | null = null

  for (const item of session.items) {
    switch (item.kind) {
      case 'user': {
        // 正文里的 IDE 引用块是给 CLI 看的，导出时只留用户自己写的话
        const clean = parseIdeRefs(item.text).text || item.text
        push('', `## ${t('chat.export.user')}`, '', clean.trim(), '')
        if (item.images?.length) {
          push(`*${i18n.tn('chat.export.images', item.images.length, { n: item.images.length })}*`, '')
        }
        last = 'user'
        break
      }
      case 'text': {
        if (!item.text.trim()) break
        if (last !== 'text') push('', `## ${t('chat.export.assistant')}`, '')
        push(item.text.trim(), '')
        last = 'text'
        break
      }
      case 'tool': {
        const detail = (item.subject || item.summary).trim()
        push('', `### ${t('chat.export.tool', { name: item.name })}`, '')
        if (detail) push(...quote(detail), '')
        last = 'tool'
        break
      }
      case 'error': {
        push(
          '',
          `> ⚠️ ${t('chat.export.error', { message: i18n.text(item.message) })}`,
          ''
        )
        last = 'error'
        break
      }
      case 'question': {
        // 待回答的题没有可导出的答案；跳过，免得留下半道题
        if (item.state !== 'answered' || !item.answers) break
        push('', `### ${t('chat.export.question')}`, '')
        for (const q of item.questions) {
          push(`**${q.question}**`, '')
          const answer = item.answers[q.question]
          if (Array.isArray(answer)) push(...answer.map((v) => `- ${v}`))
          else if (answer) push(`- ${answer}`)
          push('')
        }
        last = 'question'
        break
      }
      default:
        // thinking / permission / system / turn：不进导出
        break
    }
  }

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

/** 默认文件名：去掉 Windows / macOS 都不接受的字符 */
export function markdownFilename(title: string, sessionId?: string): string {
  const base = (title || sessionId || 'session')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    // 结尾的点和空格在 Windows 上会被静默截掉，干脆先去掉
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 60)
  return `${base || 'session'}.md`
}

function quote(text: string): string[] {
  return text.split(/\r?\n/).map((line) => `> ${line}`)
}
