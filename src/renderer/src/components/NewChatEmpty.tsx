import { useI18n } from '../i18n'
import { IconImage, IconSpark, IconTerminal } from './Icons'

/**
 * 新会话的空态。只在一条消息都没有时出现，替代原来的一行提示。
 *
 * 这里只解释「怎么把话说明白」，不放可点击的动作 —— 真正的入口就是下面的
 * 输入框，任何按钮都会和它抢注意力。四张卡片覆盖 @ / 图片 / 执行者，
 * 对应输入框现有的四种补充上下文的方式。
 */
export function NewChatEmpty(): JSX.Element {
  const { t } = useI18n()

  return (
    <section className="ncempty">
      <header className="ncempty__head">
        <span className="ncempty__mark">
          <IconSpark width={17} height={17} />
        </span>
        <div>
          <h2>{t('empty.title')}</h2>
          <p>{t('empty.subtitle')}</p>
        </div>
      </header>

      <div className="ncempty__grid">
        <div className="ncempty__card">
          <span className="ncempty__ic ncempty__ic--violet ncempty__glyph">@</span>
          <span className="ncempty__body">
            <b>{t('empty.ctx.title')}</b>
            <span>{t('empty.ctx.body')}</span>
          </span>
        </div>
        <div className="ncempty__card">
          <span className="ncempty__ic ncempty__ic--cyan ncempty__glyph">/</span>
          <span className="ncempty__body">
            <b>{t('empty.cmd.title')}</b>
            <span>{t('empty.cmd.body')}</span>
          </span>
        </div>
        <div className="ncempty__card">
          <span className="ncempty__ic ncempty__ic--mint">
            <IconImage width={15} height={15} />
          </span>
          <span className="ncempty__body">
            <b>{t('empty.image.title')}</b>
            <span>{t('empty.image.body')}</span>
          </span>
        </div>
        <div className="ncempty__card">
          <span className="ncempty__ic ncempty__ic--gold">
            <IconTerminal width={15} height={15} />
          </span>
          <span className="ncempty__body">
            <b>{t('empty.cli.title')}</b>
            <span>{t('empty.cli.body')}</span>
          </span>
        </div>
      </div>

      <footer className="ncempty__keys">
        <kbd>Enter</kbd>
        <span>{t('empty.key.send')}</span>
        <kbd>Shift</kbd>
        <span>+</span>
        <kbd>Enter</kbd>
        <span>{t('empty.key.newline')}</span>
      </footer>
    </section>
  )
}
