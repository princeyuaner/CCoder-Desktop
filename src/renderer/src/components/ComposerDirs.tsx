import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MAX_ADD_DIRS,
  type DirCheckReason,
  type DirCheckResult,
  type RecentAddDir
} from '@shared/add-dirs'
import { baseName, cwdKey } from '@shared/path'
import type { MessageKey } from '@shared/i18n'
import { useI18n } from '../i18n'
import { IconAlert, IconCheck, IconFolder, IconPlus, IconRefresh, IconX } from './Icons'

interface Props {
  /** 这条会话的工作目录 —— 工作区本身始终可访问 */
  cwd: string
  /** 这条会话已有的附加目录 */
  dirs: string[]
  /** 别的会话用过的目录，只作建议 */
  recent: RecentAddDir[]
  /** 这一轮还在跑：改动会延到轮末 */
  running: boolean
  onChange: (next: string[]) => void
}

const REASON_KEY: Record<DirCheckReason, MessageKey> = {
  ok: 'dirdirs.reason.ok',
  notAbsolute: 'dirdirs.reason.notAbsolute',
  missing: 'dirdirs.reason.missing',
  notDirectory: 'dirdirs.reason.notDirectory',
  inside: 'dirdirs.reason.inside',
  duplicate: 'dirdirs.reason.duplicate'
}

/** Windows / POSIX 都能切开；只用于展示，不参与读写 */
function splitPath(p: string): { dir: string; name: string } {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) }
}

function samePath(a: string, b: string): boolean {
  return cwdKey(a) === cwdKey(b)
}

/**
 * 输入框上方的「附加目录」入口。
 *
 * 目录跟着**会话**走：工作区固定可访问，附加目录只影响这条会话。入口做成
 * 一个胶囊，点开是「工作区 + 附加目录 + 最近使用」的弹层；添加时先校验
 * 存在 / 是文件夹 / 不在工作区内 / 不重复，再写回会话。
 */
export function ComposerDirs({
  cwd,
  dirs,
  recent,
  running,
  onChange
}: Props): JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'list' | 'add'>('list')
  const [input, setInput] = useState('')
  const [check, setCheck] = useState<DirCheckResult | null>(null)
  const [busy, setBusy] = useState(false)
  /** 已加目录的当前磁盘状态：失效的保留配置，但标出来（启动时会被跳过） */
  const [status, setStatus] = useState<Record<string, DirCheckResult>>({})
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const timer = useRef<number | null>(null)
  /** 校验请求序号：输入变了之后，旧请求回来不能覆盖新结果 */
  const checkSeq = useRef(0)

  // 关掉弹层时把「添加」半成品一起清掉，下次打开是干净的列表
  useEffect(() => {
    if (open) return
    setMode('list')
    setInput('')
    setCheck(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (mode === 'add') {
        setMode('list')
        setInput('')
        setCheck(null)
      } else {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [open, mode])

  const validate = useCallback(
    async (raw: string): Promise<void> => {
      const dir = raw.trim()
      if (!dir) {
        checkSeq.current++
        setCheck(null)
        setBusy(false)
        return
      }
      const seq = ++checkSeq.current
      setBusy(true)
      try {
        const r = await window.api?.sessions.validateDir(dir, cwd, dirs)
        if (seq !== checkSeq.current) return
        setCheck(r ?? null)
      } catch {
        if (seq !== checkSeq.current) return
        setCheck({ ok: false, reason: 'missing', path: dir })
      } finally {
        if (seq === checkSeq.current) setBusy(false)
      }
    },
    [cwd, dirs]
  )

  // 打开弹层时检查一遍已有目录：目录可能被移走 / 改名，配置保留但标出来
  useEffect(() => {
    if (!open || dirs.length === 0) {
      setStatus({})
      return
    }
    let alive = true
    void Promise.all(
      dirs.map(async (dir) => {
        try {
          const r = await window.api?.sessions.validateDir(dir, cwd, [])
          return [cwdKey(dir), r] as const
        } catch {
          return [cwdKey(dir), null] as const
        }
      })
    ).then((entries) => {
      if (!alive) return
      const next: Record<string, DirCheckResult> = {}
      for (const [key, r] of entries) if (r && !r.ok) next[key] = r
      setStatus(next)
    })
    return () => {
      alive = false
    }
  }, [open, dirs, cwd])

  const onInput = (value: string): void => {
    setInput(value)
    setCheck(null)
    // 让还在飞的校验失效，别让旧输入的结果落到新输入上
    checkSeq.current++
    setBusy(false)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void validate(value), 350)
  }

  const browse = async (): Promise<void> => {
    const picked = await window.api?.sessions.pickDir(t('dirdirs.pickTitle'))
    if (!picked) return
    // 丢掉输入框里还没跑完的防抖校验，别让它盖掉选择器的结果
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    checkSeq.current++
    setInput(picked)
    setCheck(null)
    await validate(picked)
  }

  const add = (): void => {
    if (!check?.ok) return
    if (dirs.some((d) => samePath(d, check.path))) return
    onChange([...dirs, check.path].slice(0, MAX_ADD_DIRS))
    setMode('list')
    setInput('')
    setCheck(null)
  }

  const addPath = (path: string): void => {
    if (dirs.some((d) => samePath(d, path))) return
    onChange([...dirs, path].slice(0, MAX_ADD_DIRS))
  }

  const remove = (path: string): void => {
    onChange(dirs.filter((d) => !samePath(d, path)))
  }

  const recentLeft = recent.filter((r) => !dirs.some((d) => samePath(d, r.path))).slice(0, 4)
  const atMax = dirs.length >= MAX_ADD_DIRS
  const chip = dirs.length > 0
  const title = t('dirdirs.title')

  return (
    <div className="dirdirs" ref={rootRef}>
      <button
        className={`dirdirs__btn ${chip ? 'is-on' : ''} ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {chip ? (
          <>
            <IconFolder width={12} height={12} />
            <span>
              {t('dirdirs.chip')} <b>+{dirs.length}</b>
            </span>
          </>
        ) : (
          <>
            <IconPlus width={12} height={12} />
            <span>{t('dirdirs.chipAdd')}</span>
          </>
        )}
      </button>

      {open && (
        <div className="dirdirs__pop" role="dialog" aria-label={title}>
          <div className="dirdirs__head">
            <span className="dirdirs__title">{title}</span>
            <span className="dirdirs__sub">{t('dirdirs.sessionOnly')}</span>
            <button
              className="iconbtn iconbtn--sm"
              onClick={() => setOpen(false)}
              title={t('common.close')}
            >
              <IconX width={13} height={13} />
            </button>
          </div>

          {mode === 'add' ? (
            <div className="dirdirs__body">
              <div className="dirdirs__inputrow">
                <input
                  ref={inputRef}
                  className="input"
                  value={input}
                  autoFocus
                  spellCheck={false}
                  placeholder={t('dirdirs.placeholder')}
                  onChange={(e) => onInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && check?.ok) {
                      e.preventDefault()
                      add()
                    }
                  }}
                />
                <button className="btn btn--ghost" onClick={() => void browse()}>
                  {t('dirdirs.browse')}
                </button>
              </div>
              {check && (
                <div className={`dirdirs__check ${check.ok ? 'is-ok' : 'is-bad'}`}>
                  {check.ok ? (
                    <IconCheck width={13} height={13} />
                  ) : (
                    <IconAlert width={13} height={13} />
                  )}
                  <span>{t(REASON_KEY[check.reason])}</span>
                  {!check.ok && <code>{check.path}</code>}
                </div>
              )}
              <p className="dirdirs__hint">{t('dirdirs.addHint')}</p>
            </div>
          ) : (
            <div className="dirdirs__body">
              <div className="dirdirs__group">
                <span className="dirdirs__label">{t('dirdirs.workspace')}</span>
                <div className="dirdirs__row is-locked">
                  <IconFolder width={13} height={13} />
                  <span className="p" title={cwd}>
                    <b>{baseName(cwd)}</b>
                    <span className="dirdirs__full">{cwd}</span>
                  </span>
                  <span className="dirdirs__tag">{t('dirdirs.always')}</span>
                </div>
              </div>

              <div className="dirdirs__group">
                <span className="dirdirs__label">{t('dirdirs.added')}</span>
                {dirs.length === 0 ? (
                  <div className="dirdirs__empty">
                    {t('dirdirs.empty')}
                    <span>{t('dirdirs.emptyHint')}</span>
                  </div>
                ) : (
                  dirs.map((dir) => {
                    const parts = splitPath(dir)
                    const bad = status[cwdKey(dir)]
                    return (
                      <div className="dirdirs__row" key={dir}>
                        <IconFolder width={13} height={13} />
                        <span className="p" title={dir}>
                          <span className="dirdirs__dim">{parts.dir}</span>
                          <b>{parts.name}</b>
                        </span>
                        {bad && (
                          <span
                            className="dirdirs__bad"
                            title={t(REASON_KEY[bad.reason])}
                          >
                            <IconAlert width={12} height={12} />
                          </span>
                        )}
                        <button
                          className="iconbtn iconbtn--sm dirdirs__remove"
                          onClick={() => remove(dir)}
                          title={t('dirdirs.remove')}
                        >
                          <IconX width={12} height={12} />
                        </button>
                      </div>
                    )
                  })
                )}
                <button
                  className="dirdirs__add"
                  disabled={atMax}
                  onClick={() => {
                    setMode('add')
                    setInput('')
                    setCheck(null)
                    window.setTimeout(() => inputRef.current?.focus(), 0)
                  }}
                >
                  <IconPlus width={12} height={12} />
                  {atMax ? t('dirdirs.max') : t('dirdirs.add')}
                </button>
              </div>

              {recentLeft.length > 0 && (
                <div className="dirdirs__group">
                  <span className="dirdirs__label">{t('dirdirs.recent')}</span>
                  {recentLeft.map((r) => {
                    const parts = splitPath(r.path)
                    return (
                      <div className="dirdirs__row" key={r.path}>
                        <IconFolder width={13} height={13} />
                        <span className="p" title={r.path}>
                          <span className="dirdirs__dim">{parts.dir}</span>
                          <b>{parts.name}</b>
                        </span>
                        <span className="dirdirs__src" title={r.title}>
                          {r.title}
                        </span>
                        <button
                          className="iconbtn iconbtn--sm"
                          onClick={() => addPath(r.path)}
                          disabled={atMax}
                          title={atMax ? t('dirdirs.max') : t('dirdirs.addAction')}
                        >
                          <IconPlus width={12} height={12} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}

              <div className={`dirdirs__note ${running ? 'is-warn' : ''}`}>
                {running ? (
                  <IconAlert width={13} height={13} />
                ) : (
                  <IconRefresh width={13} height={13} />
                )}
                <span>{running ? t('dirdirs.runningNote') : t('dirdirs.idleNote')}</span>
              </div>
            </div>
          )}

          <div className="dirdirs__foot">
            <span className="dirdirs__count">{t('dirdirs.count', { n: dirs.length })}</span>
            {mode === 'add' ? (
              <>
                <button
                  className="btn btn--ghost"
                  onClick={() => {
                    setMode('list')
                    setInput('')
                    setCheck(null)
                  }}
                >
                  {t('common.cancel')}
                </button>
                <button className="btn btn--primary" disabled={!check?.ok || busy} onClick={add}>
                  {t('dirdirs.addAction')}
                </button>
              </>
            ) : (
              <button className="btn btn--primary" onClick={() => setOpen(false)}>
                {t('common.done')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
