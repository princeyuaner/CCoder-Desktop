import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { formatRelativeTime, type ResolvedLocale } from '@shared/i18n'
import { baseName } from '@shared/path'
import { sameCwd } from '@shared/settings'
import {
  worktreeSlug,
  type VcsBranch,
  type VcsBranchListData,
  type VcsRepo
} from '@shared/vcs'
import { useI18n } from '../i18n'
import {
  IconAlert,
  IconArrowRight,
  IconBranch,
  IconCheck,
  IconChevronDown,
  IconFolder,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconX
} from './Icons'

/** 新分支的默认命名前缀。用户可以改后面的部分。 */
const BRANCH_PREFIX = 'ccoder/'

type Mode = 'existing' | 'create'

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  /** 不是 Git 仓库 / 没装 git：跳过分支选择，直接开 */
  | { phase: 'plain'; reason: string }
  | { phase: 'ready'; repo: VcsRepo; data: VcsBranchListData }

interface Props {
  /** 在哪个工作区开新会话 */
  cwd: string
  onCancel: () => void
  /** 分支/工作树已经就绪，用这个目录真正开会话 */
  onStart: (targetCwd: string) => void
}

function joinPath(root: string, name: string): string {
  const sep = root.includes('\\') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${sep}${name}`
}

/** `origin/feat/x` → `feat/x`；本地分支原样返回 */
function remoteShort(name: string): string {
  const i = name.indexOf('/')
  return i < 0 ? '' : name.slice(i + 1)
}

export function NewSessionDialog({ cwd, onCancel, onStart }: Props): JSX.Element {
  const { t, locale } = useI18n()
  const dlgRef = useRef<HTMLElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const branchFieldRef = useRef<HTMLDivElement>(null)
  const baseFieldRef = useRef<HTMLDivElement>(null)

  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const [mode, setMode] = useState<Mode>('existing')
  /** 选中的分支用完整 ref 做身份：本地和远程可能同名 */
  const [selectedRef, setSelectedRef] = useState('')
  const [baseRef, setBaseRef] = useState('')
  const [query, setQuery] = useState('')
  const [suffix, setSuffix] = useState('')
  /** 用户碰过分支名输入框才开始报「必填」，刚切到新建页时保持安静 */
  const [nameTouched, setNameTouched] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [baseOpen, setBaseOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [submitError, setSubmitError] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setState({ phase: 'loading' })
    setSubmitError('')
    const api = window.api?.vcs
    if (!api) {
      setState({ phase: 'error', message: t('errors.notElectron') })
      return
    }
    try {
      const detected = await api.detect(cwd)
      if (!detected.ok) {
        setState({ phase: 'error', message: detected.error.message })
        return
      }
      const repo = detected.data.repo
      if (!repo || repo.kind !== 'git') {
        setState({ phase: 'plain', reason: t('newSession.notRepo') })
        return
      }
      const listed = await api.branches({ cwd })
      if (!listed.ok) {
        setState({ phase: 'error', message: listed.error.message })
        return
      }
      const data = listed.data
      const locals = data.branches.filter((b) => !b.remote)
      // 默认选当前分支；detached HEAD 没有「当前」，退到第一条本地分支
      const initial = locals.find((b) => b.current) ?? locals[0]
      setSelectedRef(initial?.ref ?? '')
      // detached HEAD 没有「当前分支」，起点留空 → 用 HEAD
      setBaseRef(data.detached ? '' : (initial?.ref ?? ''))
      setMode(initial ? 'existing' : 'create')
      setQuery('')
      setSuffix('')
      setNameTouched(false)
      setPickerOpen(false)
      setBaseOpen(false)
      setState({ phase: 'ready', repo, data })
    } catch (err) {
      setState({
        phase: 'error',
        message: err instanceof Error ? err.message : t('errors.unknownReason')
      })
    }
  }, [cwd, t])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    dlgRef.current?.focus()
  }, [])

  useEffect(() => {
    if (mode === 'create') nameRef.current?.focus()
  }, [mode])

  useEffect(() => {
    if (pickerOpen) searchRef.current?.focus()
  }, [pickerOpen])

  /** 点空白处收起下拉；先于 click 触发，所以「创建新分支…」还能收到点击 */
  useEffect(() => {
    if (!pickerOpen && !baseOpen) return
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node
      if (pickerOpen && !branchFieldRef.current?.contains(target)) setPickerOpen(false)
      if (baseOpen && !baseFieldRef.current?.contains(target)) setBaseOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [pickerOpen, baseOpen])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      // 正在建工作树：别让 Esc 把弹窗收掉，创建还在后台继续
      if (busy) return
      if (pickerOpen) setPickerOpen(false)
      else if (baseOpen) setBaseOpen(false)
      else onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pickerOpen, baseOpen, busy, onCancel])

  const ready = state.phase === 'ready' ? state : null
  const data = ready?.data ?? null

  const localBranches = useMemo(
    () =>
      data
        ? data.branches
            .filter((b) => !b.remote)
            // 当前分支排最前，其次是最近的提交
            .sort((a, b) => Number(b.current) - Number(a.current))
        : [],
    [data]
  )
  const remoteBranches = useMemo(() => {
    if (!data) return []
    const locals = new Set(data.branches.filter((b) => !b.remote).map((b) => b.name))
    return data.branches.filter((b) => {
      if (!b.remote) return false
      const short = remoteShort(b.name)
      // 本地已经有同名分支时不再列远程那条，避免选到两份「main」
      return !!short && !locals.has(short)
    })
  }, [data])

  const selected: VcsBranch | null = useMemo(() => {
    if (!data) return null
    return data.branches.find((b) => b.ref === selectedRef) ?? null
  }, [data, selectedRef])

  const base: VcsBranch | null = useMemo(() => {
    if (!data) return null
    return data.branches.find((b) => b.ref === baseRef) ?? null
  }, [data, baseRef])

  // 用户可能直接粘贴完整分支名，避免拼成 ccoder/ccoder/xxx
  const branchSuffix = suffix.trim().replace(/^ccoder\//, '')
  const fullName = `${BRANCH_PREFIX}${branchSuffix}`

  /** 新分支名校验；返回错误文案，空串表示可用（空输入不在这里报错） */
  const nameError = useMemo(() => {
    if (mode !== 'create') return ''
    const value = branchSuffix
    if (!value) return ''
    if (
      value.startsWith('-') ||
      value.endsWith('/') ||
      value.endsWith('.') ||
      value.includes('..') ||
      value.includes('@{') ||
      /[\s\0~^:?*[\]\\]/.test(value)
    ) {
      return t('newSession.nameInvalid')
    }
    if (localBranches.some((b) => b.name === fullName)) {
      return t('newSession.nameExists')
    }
    return ''
  }, [mode, branchSuffix, fullName, localBranches, t])

  const q = query.trim().toLowerCase()
  const matches = (b: VcsBranch): boolean =>
    !q || b.name.toLowerCase().includes(q) || b.subject.toLowerCase().includes(q)
  const shownLocal = localBranches.filter(matches)
  const shownRemote = remoteBranches.filter(matches)

  /**
   * 目标位置。
   *
   * 新分支、别的分支 → 工作树；分支已经在某个工作树里 → 复用它；
   * 只有「当前分支」才允许直接留在当前目录。这样多会话并行时不会互相
   * 把工作区切换到对方的分支上。
   */
  const target = useMemo(() => {
    if (!data) return null
    if (mode === 'create') {
      const slug = branchSuffix ? worktreeSlug(fullName) : ''
      return {
        placement: 'worktree' as const,
        // 还没输入名字时显示工作树根目录，而不是拼出半截路径
        path: slug ? joinPath(data.defaultRoot, slug) : data.defaultRoot,
        reuse: false,
        create: true
      }
    }
    if (!selected) return null
    if (!selected.remote && selected.current) {
      return { placement: 'current' as const, path: cwd, reuse: false, create: false }
    }
    if (selected.worktree) {
      return {
        placement: 'worktree' as const,
        path: selected.worktree,
        reuse: true,
        create: false
      }
    }
    const name = selected.remote ? remoteShort(selected.name) : selected.name
    return {
      placement: 'worktree' as const,
      path: joinPath(data.defaultRoot, worktreeSlug(name)),
      reuse: false,
      create: true
    }
  }, [data, mode, selected, fullName, branchSuffix, cwd])

  /** 空输入只在「碰过 / 点过创建」后提示必填 */
  const shownNameError =
    mode === 'create'
      ? nameError || (nameTouched && !branchSuffix ? t('newSession.nameRequired') : '')
      : ''

  const canStart =
    !busy &&
    !!target &&
    (mode === 'create' ? !!branchSuffix && !nameError : !!selected)

  const runWorktree = async (
    branch: string,
    baseName: string | undefined,
    path: string,
    createBranch: boolean,
    track = false
  ): Promise<void> => {
    setBusy(true)
    setSubmitError('')
    try {
      const api = window.api?.vcs
      if (!api) {
        setSubmitError(t('errors.notElectron'))
        setBusy(false)
        return
      }
      const r = await api.worktreeAdd({
        cwd,
        path,
        branch,
        ...(baseName ? { base: baseName } : {}),
        createBranch,
        ...(track ? { track: true } : {})
      })
      if (!r.ok) {
        setSubmitError(r.error.message)
        setBusy(false)
        return
      }
      const created = r.data.worktrees.find((w) => sameCwd(w.path, path))
      onStart(created?.path ?? path)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : t('errors.unknownReason'))
      setBusy(false)
    }
  }

  const submit = async (): Promise<void> => {
    if (!ready || !target || busy) return
    if (mode === 'create') {
      if (!branchSuffix) {
        setNameTouched(true)
        return
      }
      if (nameError) {
        setSubmitError(nameError)
        return
      }
      await runWorktree(fullName, base?.name, target.path, true)
      return
    }
    if (!selected) return

    // 当前分支：不用建工作树，直接在这个目录里开
    if (target.placement === 'current') {
      onStart(cwd)
      return
    }
    // 分支已经检出过：复用那个目录，不再创建工作树
    if (target.reuse) {
      onStart(target.path)
      return
    }
    if (selected.remote) {
      const local = remoteShort(selected.name)
      // 本地新建一条同名分支，并让它跟踪选中的远程分支
      await runWorktree(local, selected.name, target.path, true, true)
      return
    }
    await runWorktree(selected.name, undefined, target.path, false)
  }

  const pickBranch = (b: VcsBranch): void => {
    setSelectedRef(b.ref)
    setPickerOpen(false)
    setSubmitError('')
  }

  const switchMode = (next: Mode): void => {
    setMode(next)
    setPickerOpen(false)
    setBaseOpen(false)
    setSubmitError('')
    if (next === 'create') setNameTouched(false)
    if (next === 'create' && !baseRef) {
      const current = localBranches.find((b) => b.current) ?? localBranches[0]
      if (current) setBaseRef(current.ref)
    }
  }

  const startLabel =
    mode === 'create'
      ? t('newSession.createStart')
      : target?.placement === 'worktree'
        ? t('newSession.startInWorktree')
        : t('newSession.start')

  const onSubmitKey = (e: ReactKeyboardEvent): void => {
    if (e.key !== 'Enter' || !canStart) return
    e.preventDefault()
    void submit()
  }

  return (
    <div className="ns">
      <div className="ns__scrim" onClick={busy ? undefined : onCancel} />
      <section
        className="ns__dlg"
        ref={dlgRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-busy={busy}
        aria-label={t('newSession.title')}
      >
        <header className="ns__head">
          <div className="ns__heading">
            <h2 className="ns__title">{t('newSession.title')}</h2>
            <p className="ns__repo">
              <IconFolder width={13} height={13} />
              <span>{baseName(cwd)}</span>
              <span className="ns__sep">/</span>
              <code>{cwd}</code>
            </p>
          </div>
          <button
            className="ns__close"
            onClick={onCancel}
            disabled={busy}
            title={t('common.close')}
          >
            <IconX width={14} height={14} />
          </button>
        </header>

        {state.phase === 'loading' && (
          <div className="ns__loading">
            <span className="ns__spinner" />
            <span>{t('newSession.loading')}</span>
          </div>
        )}

        {state.phase === 'error' && (
          <div className="ns__plain">
            <IconAlert width={20} height={20} />
            <p className="ns__plain-title">{t('newSession.loadFailed')}</p>
            <p className="ns__plain-body">{state.message}</p>
            <div className="ns__plain-acts">
              <button className="btn" onClick={() => void load()}>
                <IconRefresh width={12} height={12} />
                {t('common.retry')}
              </button>
            </div>
          </div>
        )}

        {state.phase === 'plain' && (
          <div className="ns__plain">
            <IconBranch width={22} height={22} />
            <p className="ns__plain-title">{state.reason}</p>
            <p className="ns__plain-body">{t('newSession.plainBody')}</p>
          </div>
        )}

        {ready && (
          <>
            <div className={`ns__body ${busy ? 'is-busy' : ''}`}>
              <div className="ns__tabs" role="tablist">
                <button
                  className={`ns__tab ${mode === 'existing' ? 'is-on' : ''}`}
                  role="tab"
                  aria-selected={mode === 'existing'}
                  disabled={busy}
                  onClick={() => switchMode('existing')}
                >
                  {t('newSession.tabExisting')}
                </button>
                <button
                  className={`ns__tab ${mode === 'create' ? 'is-on' : ''}`}
                  role="tab"
                  aria-selected={mode === 'create'}
                  disabled={busy}
                  onClick={() => switchMode('create')}
                >
                  {t('newSession.tabCreate')}
                </button>
              </div>

              {mode === 'existing' ? (
                <>
                  <div className="ns__label-row">
                    <span className="ns__label">{t('newSession.branch')}</span>
                    <span className="ns__hint">{t('newSession.branchHint')}</span>
                  </div>
                  <div className="ns__field" ref={branchFieldRef}>
                    <button
                      className={`ns__select ${pickerOpen ? 'is-open' : ''}`}
                      disabled={busy}
                      onClick={() => {
                        setPickerOpen((v) => !v)
                        setBaseOpen(false)
                      }}
                    >
                      <IconBranch className="ns__select-icon" width={14} height={14} />
                      <span className="ns__select-value">
                        {selected ? selected.name : t('newSession.noBranch')}
                      </span>
                      {selected?.current && (
                        <span className="ns__tag ns__tag--current">
                          {t('newSession.currentTag')}
                        </span>
                      )}
                      {selected?.worktree && !selected.current && (
                        <span className="ns__tag ns__tag--used">
                          {t('newSession.worktreeTag')}
                        </span>
                      )}
                      <IconChevronDown className="ns__select-chev" width={11} height={11} />
                    </button>

                    {pickerOpen && (
                      <div className="ns__menu">
                        <div className="ns__search">
                          <IconSearch width={13} height={13} />
                          <input
                            ref={searchRef}
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder={t('newSession.search')}
                            spellCheck={false}
                            disabled={busy}
                          />
                        </div>
                        <div className="ns__menu-scroll">
                          {shownLocal.length > 0 && (
                            <>
                              <div className="ns__group">
                                {t('newSession.local')} <span>{shownLocal.length}</span>
                              </div>
                              {shownLocal.map((b) => (
                                <BranchRow
                                  key={b.ref}
                                  branch={b}
                                  selected={b.ref === selectedRef}
                                  locale={locale}
                                  onPick={() => pickBranch(b)}
                                />
                              ))}
                            </>
                          )}
                          {shownRemote.length > 0 && (
                            <>
                              <div className="ns__group">
                                {t('newSession.remote')} <span>{shownRemote.length}</span>
                              </div>
                              {shownRemote.map((b) => (
                                <BranchRow
                                  key={b.ref}
                                  branch={b}
                                  selected={b.ref === selectedRef}
                                  locale={locale}
                                  onPick={() => pickBranch(b)}
                                />
                              ))}
                            </>
                          )}
                          {shownLocal.length === 0 && shownRemote.length === 0 && (
                            <p className="ns__menu-empty">{t('newSession.noMatch')}</p>
                          )}
                        </div>
                        <button
                          className="ns__create-entry"
                          disabled={busy}
                          onClick={() => switchMode('create')}
                        >
                          <IconPlus width={13} height={13} />
                          {t('newSession.createEntry')}
                        </button>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="ns__form">
                  <div>
                    <div className="ns__label-row">
                      <span className="ns__label">{t('newSession.branchName')}</span>
                      <span className="ns__hint">{t('newSession.branchNameHint')}</span>
                    </div>
                    <div className={`ns__input ${shownNameError ? 'is-err' : ''}`}>
                      <span className="ns__prefix">{BRANCH_PREFIX}</span>
                      <input
                        ref={nameRef}
                        value={suffix}
                        onChange={(e) => {
                          setSuffix(e.target.value)
                          setNameTouched(true)
                          setSubmitError('')
                        }}
                        onKeyDown={onSubmitKey}
                        onPaste={(e) => {
                          // 直接粘贴完整分支名时去掉前缀，输入框里不出现两个 ccoder/
                          const text = e.clipboardData.getData('text')
                          if (text.startsWith(BRANCH_PREFIX)) {
                            e.preventDefault()
                            setSuffix(text.slice(BRANCH_PREFIX.length))
                            setNameTouched(true)
                          }
                        }}
                        placeholder={t('newSession.branchNamePlaceholder')}
                        spellCheck={false}
                        disabled={busy}
                        autoComplete="off"
                      />
                      {branchSuffix && !nameError && (
                        <span className="ns__ok">
                          <IconCheck width={11} height={11} />
                          {t('newSession.available')}
                        </span>
                      )}
                    </div>
                    {shownNameError ? (
                      <p className="ns__form-error">{shownNameError}</p>
                    ) : (
                      <p className="ns__form-note">
                        {branchSuffix
                          ? t('newSession.fullName', { name: fullName })
                          : t('newSession.branchNameHint2')}
                      </p>
                    )}
                  </div>

                  <div>
                    <div className="ns__label-row">
                      <span className="ns__label">{t('newSession.base')}</span>
                      <span className="ns__hint">{t('newSession.baseHint')}</span>
                    </div>
                    <div className="ns__field" ref={baseFieldRef}>
                      <button
                        className={`ns__base ${baseOpen ? 'is-open' : ''}`}
                        disabled={busy}
                        onClick={() => {
                          setBaseOpen((v) => !v)
                          setPickerOpen(false)
                        }}
                      >
                        <IconBranch className="ns__select-icon" width={13} height={13} />
                        <span className="ns__select-value">
                          {base ? base.name : t('newSession.head')}
                        </span>
                        {base?.current && (
                          <span className="ns__tag ns__tag--current">
                            {t('newSession.currentTag')}
                          </span>
                        )}
                        <IconChevronDown className="ns__select-chev" width={11} height={11} />
                      </button>
                      {baseOpen && (
                        <div className="ns__menu ns__menu--base">
                          <div className="ns__menu-scroll">
                            {localBranches.length === 0 && (
                              <p className="ns__menu-empty">{t('newSession.noBase')}</p>
                            )}
                            {localBranches.map((b) => (
                              <button
                                key={b.ref}
                                className={`ns__brow ${b.ref === baseRef ? 'is-sel' : ''}`}
                                onClick={() => {
                                  setBaseRef(b.ref)
                                  setBaseOpen(false)
                                }}
                              >
                                <span className="ns__brow-check">
                                  {b.ref === baseRef && <IconCheck width={11} height={11} />}
                                </span>
                                <span className="ns__brow-name">{b.name}</span>
                                {b.current && (
                                  <span className="ns__tag ns__tag--current">
                                    {t('newSession.currentTag')}
                                  </span>
                                )}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <div className="ns__placing">
                <div className="ns__label-row">
                  <span className="ns__label">{t('newSession.placement')}</span>
                  <span className="ns__hint">{t('newSession.placementHint')}</span>
                </div>
                <div className="ns__places">
                  <div
                    className={`ns__place ${
                      target?.placement === 'current' ? 'is-on' : 'is-off'
                    }`}
                  >
                    <span className="ns__place-top">
                      <span className="ns__radio" />
                      {t('newSession.placeCurrent')}
                    </span>
                    <span className="ns__place-sub">
                      {target?.placement === 'current'
                        ? t('newSession.placeCurrentSub')
                        : mode === 'create'
                          ? t('newSession.placeCurrentNewBranch')
                          : t('newSession.placeCurrentOther')}
                    </span>
                  </div>
                  <div
                    className={`ns__place ${
                      target?.placement === 'worktree' ? 'is-on' : 'is-off'
                    }`}
                  >
                    <span className="ns__place-top">
                      <span className="ns__radio" />
                      {t('newSession.placeWorktree')}
                      {target?.placement === 'worktree' && (
                        <span className="ns__badge">
                          {target.reuse ? t('newSession.reuse') : t('newSession.recommended')}
                        </span>
                      )}
                    </span>
                    <span className="ns__place-sub">
                      {target?.placement !== 'worktree'
                        ? t('newSession.placeWorktreeUnavailable')
                        : target.reuse
                          ? t('newSession.placeWorktreeReuse')
                          : selected?.remote
                            ? t('newSession.remoteTrack', {
                                name: remoteShort(selected.name),
                                remote: selected.name
                              })
                            : t('newSession.placeWorktreeSub')}
                    </span>
                  </div>
                </div>
                {target && (
                  <div className="ns__wtpath">
                    <IconBranch width={12} height={12} />
                    <code>{target.path}</code>
                    <span>
                      {target.placement === 'current'
                        ? t('newSession.pathCurrent')
                        : target.reuse
                          ? t('newSession.pathExisting')
                          : t('newSession.pathCreate')}
                    </span>
                  </div>
                )}
              </div>

              {submitError && (
                <div className="ns__alert" role="alert">
                  <IconAlert width={14} height={14} />
                  <span>{submitError}</span>
                </div>
              )}
            </div>

            <footer className="ns__foot">
              <span className="ns__esc">
                <kbd>Esc</kbd>
                {t('common.cancel')}
              </span>
              <button className="btn ns__cancel" onClick={onCancel} disabled={busy}>
                {t('common.cancel')}
              </button>
              <button
                className="btn btn--primary ns__start"
                disabled={!canStart}
                onClick={() => void submit()}
              >
                {busy ? t('newSession.starting') : startLabel}
                {!busy && <IconArrowRight width={12} height={12} />}
              </button>
            </footer>
          </>
        )}

        {state.phase === 'plain' && (
          <footer className="ns__foot">
            <span className="ns__esc">
              <kbd>Esc</kbd>
              {t('common.cancel')}
            </span>
            <button className="btn ns__cancel" onClick={onCancel}>
              {t('common.cancel')}
            </button>
            <button className="btn btn--primary ns__start" onClick={() => onStart(cwd)}>
              {t('newSession.start')}
              <IconArrowRight width={12} height={12} />
            </button>
          </footer>
        )}

        {state.phase === 'error' && (
          <footer className="ns__foot">
            <button className="btn ns__cancel" onClick={onCancel}>
              {t('common.cancel')}
            </button>
            <button className="btn btn--primary ns__start" onClick={() => onStart(cwd)}>
              {t('newSession.startAnyway')}
              <IconArrowRight width={12} height={12} />
            </button>
          </footer>
        )}
      </section>
    </div>
  )
}

function BranchRow({
  branch,
  selected,
  locale,
  onPick
}: {
  branch: VcsBranch
  selected: boolean
  locale: ResolvedLocale
  onPick: () => void
}): JSX.Element {
  const { t } = useI18n()
  const remoteName = branch.remote ? branch.name.slice(0, branch.name.indexOf('/') + 1) : ''
  const short = branch.remote ? branch.name.slice(remoteName.length) : branch.name
  const when = formatRelativeTime(branch.date, locale, 'short')

  return (
    <button
      className={`ns__brow ${selected ? 'is-sel' : ''}`}
      onClick={onPick}
      title={branch.subject || branch.name}
    >
      <span className="ns__brow-check">{selected && <IconCheck width={11} height={11} />}</span>
      <span className="ns__brow-name">
        {remoteName && <span className="ns__brow-remote">{remoteName}</span>}
        {short}
      </span>
      {branch.current && (
        <span className="ns__tag ns__tag--current">{t('newSession.currentTag')}</span>
      )}
      {branch.worktree && !branch.current && (
        <span className="ns__tag ns__tag--used">{t('newSession.worktreeTag')}</span>
      )}
      {when && <span className="ns__brow-meta">{when}</span>}
    </button>
  )
}
