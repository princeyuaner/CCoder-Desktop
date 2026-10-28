import { useCallback, useEffect, useRef, useState } from 'react'
import { workspaceRel } from '@shared/path'
import { normalizeReviewRels } from '@shared/ide'
import type { VcsRepo } from '@shared/vcs'
import type { ChangedFile } from '../changedFiles'
import { IconChevronDown } from './Icons'
import { useI18n } from '../i18n'
import { notify } from '../notice'

/**
 * 输入框左上角、工作目录胶囊右边那颗按钮：本轮改过哪些文件。
 *
 * 数据来自 `file_change` 事件，覆盖三类来源：主对话的编辑工具、子代理
 * 的编辑工具、以及轮末磁盘快照发现的 Bash/脚本/MCP 改动。只看工具卡
 * 的话，后两类会整段消失。
 *
 * 为什么放这儿、而不是输出区上方单独占一条：它跟「这条会话写到哪去」是
 * 同一类信息，跟目录胶囊并排最省地方，也不会在每一轮开头都吃掉一行输出。
 *
 * **这里是一轮改动的审阅入口**：点一行在 IDE 里打开该文件的 diff 页签，
 * 底部「在 IDE 中审阅」一次开一批；有 VCS 时每行还能把文件还原到 HEAD。
 * 之前这里只有计数，看完清单还得自己去 IDE 的版本控制面板翻 —— 审阅的
 * 两半（看 / 撤）是断开的。
 *
 * **没有改动时整个不渲染** —— 胶囊右边就空着，不挂一个「0 个文件」。
 * 弹层往**上**开：输入区贴着窗口底部，往下没有地方。
 */
export function ChangedFiles({
  files,
  cwd,
  turnKey
}: {
  files: ChangedFile[]
  /** 会话工作目录 —— VCS / IDE 都按它做相对路径 */
  cwd: string
  /**
   * 本轮的身份（会话 + 轮次）。
   *
   * 只靠 files 数组判断不出「换了一轮但改的还是同一个文件」—— key 不变，
   * 上一轮的「已看过 / 已还原」会错误地留在新改动上。换值就把标记清掉。
   */
  turnKey: string
}): JSX.Element | null {
  const { t, tn } = useI18n()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  /**
   * 这一轮里已经在 IDE 打开过 diff 的文件。
   *
   * 只是**看过**，不代表改动没问题 —— 所以标记做得很轻（一个对勾），
   * 不抢行数统计的视线。
   */
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set())
  /** 已经还原到 HEAD 的文件：行变灰并标「已还原」，等下一轮自然消失 */
  const [reverted, setReverted] = useState<ReadonlySet<string>>(() => new Set())
  /** 正在等二次确认的那一行（key）；null = 没有 */
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  /**
   * 仓库能力。null = 还没探测完 / 不是仓库。
   *
   * 没有 VCS 时不该挂一个点了只会报错的「还原」按钮。只在弹层第一次打开时
   * 探一次：这个会话里仓库类型不会变。
   */
  const [repo, setRepo] = useState<VcsRepo | null>(null)
  const probed = useRef(false)

  // 点外面 / Esc 收起 —— 跟输入区那几个选择器一个规矩
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 发了新消息，本轮清零 —— 别让弹层挂在那儿显示上一轮的文件
  useEffect(() => {
    if (files.length === 0) setOpen(false)
  }, [files.length])

  /*
   * 换轮（或换会话）时把本地标记清掉。
   *
   * 不能只看 files 数组：同一个文件下一轮又被改，key 不变，上一轮的
   * 「已还原」会错误地挂在它身上。
   */
  useEffect(() => {
    setSeen(new Set())
    setReverted(new Set())
    setConfirming(null)
  }, [turnKey])

  // 换了工作区，之前探到的仓库类型不再成立；轮次变化不影响仓库身份
  useEffect(() => {
    probed.current = false
    setRepo(null)
  }, [cwd])

  const markSeen = useCallback((keys: string[]): void => {
    if (keys.length === 0) return
    setSeen((cur) => {
      const next = new Set(cur)
      for (const k of keys) next.add(k)
      return next
    })
  }, [])

  // 第一次打开弹层时探一次仓库能力
  useEffect(() => {
    if (!open || probed.current || !cwd) return
    probed.current = true
    void window.api?.vcs
      ?.detect(cwd)
      .then((r) => {
        if (r.ok && r.data.repo) setRepo(r.data.repo)
      })
      .catch(() => {
        // 探测失败就当没有 VCS：还原入口不出现，diff 仍然能看
      })
  }, [open, cwd])

  const relOf = useCallback(
    (f: ChangedFile): string | null => {
      /*
       * 各家 CLI 给的路径不统一：Claude / Codex 的已经 resolve 成绝对路径，
       * DSH 偶发回工作区相对路径。先按 cwd 换算出 rel；换不出来时，只要
       * 它本身像相对路径（不是盘符 / 根路径、没有 `..`）就直接当 rel 用。
       * 最终仍由主进程的 normalizeReviewRels 再收一次。
       */
      const rel = workspaceRel(cwd, f.path)
      const [clean] = normalizeReviewRels([rel ?? f.path])
      return clean ?? null
    },
    [cwd]
  )

  /** 打开一批 diff；失败时顶一条提示（窗口没开、路径不在工作区等） */
  const openDiffs = useCallback(
    (targets: ChangedFile[]): void => {
      const opened = targets.filter((f) => relOf(f))
      const rels = opened.map(relOf).filter((r): r is string => !!r)
      if (rels.length === 0) {
        notify(t('changed.outsideOnly'))
        return
      }
      void window.api?.ide
        ?.openDiffs(cwd, rels)
        .then((r) => {
          if (!r) return
          if (!r.ok) {
            notify(r.message || t('changed.openFailed'))
            return
          }
          markSeen(opened.map((f) => f.key))
        })
        .catch((err) => {
          notify(t('changed.openFailedWith', { error: errText(err) }))
        })
    },
    [cwd, markSeen, relOf, t]
  )

  /** 把文件还原到 HEAD。untracked 的（本轮新建）会被删掉 */
  const revert = useCallback(
    async (f: ChangedFile): Promise<void> => {
      const rel = relOf(f)
      const api = window.api?.vcs
      if (!rel || !repo || !api) return
      setConfirming(null)
      setBusy(f.key)
      try {
        const r =
          repo.kind === 'git'
            ? await api.discard({ cwd, paths: [rel], includeUntracked: true })
            : await api.revert({ cwd, paths: [rel] })
        if (!r.ok) {
          notify(t('changed.revertFailed', { error: r.error.message }))
          return
        }
        setReverted((cur) => new Set(cur).add(f.key))
        notify(t('changed.revertDone', { name: f.name }))
      } catch (err) {
        notify(t('changed.revertFailed', { error: errText(err) }))
      } finally {
        setBusy(null)
      }
    },
    [cwd, relOf, repo, t]
  )

  if (files.length === 0) return null

  const added = files.reduce((n, f) => n + f.added, 0)
  const removed = files.reduce((n, f) => n + f.removed, 0)
  const deleted = files.filter((f) => f.deleted).length
  const created = files.filter((f) => f.created && !f.deleted).length
  const edited = files.length - created - deleted
  const bits: string[] = []
  if (edited > 0) bits.push(tn('count.changes', edited))
  if (created > 0) bits.push(tn('count.created', created))
  if (deleted > 0) bits.push(tn('count.deleted', deleted))

  const canRevert = !!repo && (repo.kind === 'git' ? repo.capabilities.discard : repo.capabilities.revert)
  const reviewable = files.filter((f) => relOf(f)).length
  const seenCount = files.filter((f) => seen.has(f.key)).length

  return (
    <div className="cfwrap" ref={ref}>
      <button
        className={`cfbtn ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={tn('changed.title', files.length)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span className="cfbtn__seg cfbtn__main">
          <span className="cfbtn__ico">✎</span>
          <span className="cfbtn__label">
            <b>{files.length}</b> {t('changed.filesLabel')}
          </span>
        </span>
        <span className="cfbtn__seg cfbtn__stat">
          {(added > 0 || removed > 0) && (
            <span className="cfbtn__diff">
              {added > 0 && <em className="cf-add">+{added}</em>}
              {removed > 0 && <em className="cf-del">−{removed}</em>}
            </span>
          )}
          <IconChevronDown width={11} height={11} className="cfbtn__chev" />
        </span>
      </button>

      {open && (
        <div className="cfpop" role="dialog" aria-label={t('changed.aria')}>
          <div className="cfpop__head">
            <span className="cfpop__glyph">✎</span>
            <span className="cfpop__title">{tn('changed.title', files.length)}</span>
            <span className="cfpop__sum">
              {added > 0 && <b className="cf-add">+{added}</b>}
              {removed > 0 && <b className="cf-del">−{removed}</b>}
            </span>
          </div>

          <div className="cfpop__list">
            {files.map((f) => {
              const rel = relOf(f)
              const isReverted = reverted.has(f.key)
              // 完整路径进 title：列表里只放文件名和一层目录，长路径会把它撑爆
              if (confirming === f.key) {
                return (
                  <div className="cfrow is-confirm" key={f.key}>
                    <span className="cfrow__confirm" title={t('changed.revertHint')}>
                      {f.created && !f.deleted
                        ? t('changed.revertConfirmNew', { name: f.name })
                        : t('changed.revertConfirm', { name: f.name })}
                    </span>
                    <button
                      className="cfrow__btn is-danger"
                      disabled={busy === f.key}
                      onClick={() => void revert(f)}
                    >
                      {t('changed.revertDo')}
                    </button>
                    <button className="cfrow__btn" onClick={() => setConfirming(null)}>
                      {t('common.cancel')}
                    </button>
                  </div>
                )
              }
              return (
                /*
                 * 外层用 div 不用 button：行里还嵌着「还原」按钮，嵌套按钮是
                 * 非法 HTML，点哪个都会同时触发外层的「打开 diff」。
                 * 可点区域是里面那个整行宽的方形按钮，键盘 Tab 也只落在它
                 * 上面 —— 语义和视觉上的「整行可点」分开处理。
                 */
                <div
                  className={`cfrow ${f.deleted ? 'is-deleted' : ''} ${
                    isReverted ? 'is-reverted' : ''
                  } ${rel ? 'is-clickable' : 'is-outside'}`}
                  key={f.key}
                  title={rel ? t('changed.openDiffTitle', { path: f.path }) : f.path}
                >
                  <button
                    className="cfrow__open"
                    disabled={!rel}
                    aria-label={t('changed.openDiffTitle', { path: f.path })}
                    onClick={rel ? () => openDiffs([f]) : undefined}
                  >
                    <span
                      className={`cfrow__ico ${
                        f.deleted ? 'is-del' : f.wrote ? 'is-write' : 'is-edit'
                      }`}
                    >
                      {f.deleted ? '−' : f.wrote ? '＋' : '✎'}
                    </span>
                    <span className="cfrow__name">{f.name}</span>
                    <span className="cfrow__dir">{f.dir}</span>
                  </button>
                  {isReverted ? (
                    <span className="cfrow__reverted">{t('changed.reverted')}</span>
                  ) : (
                    <>
                      {f.created && !f.deleted && (
                        <span className="cfrow__new">{t('changed.new')}</span>
                      )}
                      {f.deleted && <span className="cfrow__del">{t('changed.deleted')}</span>}
                      {!rel && <span className="cfrow__outside">{t('changed.outside')}</span>}
                      <span className="cfrow__diff">
                        {f.added > 0 && <b className="cf-add">+{f.added}</b>}
                        {f.removed > 0 && <b className="cf-del">−{f.removed}</b>}
                      </span>
                    </>
                  )}
                  {rel && seen.has(f.key) && !isReverted && (
                    <span className="cfrow__seen" title={t('changed.seen')}>
                      ✓
                    </span>
                  )}
                  {/*
                    「还原」是破坏性操作，只在悬停 / 键盘聚焦时露出来：
                    常驻会让它在快速扫行数时抢注意力，也更容易误点。
                  */}
                  {rel && canRevert && !isReverted && (
                    <button
                      className="cfrow__undo"
                      title={t('changed.revert')}
                      aria-label={t('changed.revert')}
                      disabled={busy === f.key}
                      onClick={() => setConfirming(f.key)}
                    >
                      ↺
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          <div className="cfpop__foot">
            <span>
              {bits.join(' · ')}
              {reviewable > 0 && seenCount > 0 && ` · ${t('changed.seenCount', { n: seenCount })}`}
            </span>
            {reviewable > 0 ? (
              <button
                className="cfpop__review"
                // 已经还原的文件没有差异可看，别给它们开空页签
                onClick={() => openDiffs(files.filter((f) => !reverted.has(f.key)))}
                title={t('changed.reviewAllHint')}
              >
                {t('changed.reviewAll')}
              </button>
            ) : (
              <span>{t('changed.onlyThisTurn')}</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
