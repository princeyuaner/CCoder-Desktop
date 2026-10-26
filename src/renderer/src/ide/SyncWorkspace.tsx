import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { MessageKey } from '@shared/i18n'
import {
  SYNC_JUNK,
  type SyncChange,
  type SyncConfig,
  type SyncProblem,
  type SyncRun,
  type SyncSnapshot
} from '@shared/sync'
import { useI18n } from '../i18n'
import type { SyncApiState } from './useSync'

interface Props {
  cwd: string
  sync: SyncApiState
  logOpen: boolean
  onOpenLog: () => void
  onCloseLog: () => void
  onNotice: (message: string) => void
}

function Ico({ d, size = 14 }: { d: string; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="ide-ico" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

const P = {
  sync: 'M12.5 5A5.5 5.5 0 0 0 3 7M3 3.5V7h3.5M3.5 11A5.5 5.5 0 0 0 13 9M13 12.5V9h-3.5',
  folder: 'M2 4.2h4.2l1.4 1.8H14v7.2H2z',
  arrow: 'M3 8h9M9 4.5L12.5 8 9 11.5',
  refresh: 'M13 8a5 5 0 1 1-1.6-3.7M13 2.5V5h-2.5',
  play: 'M5 3.5l7.5 4.5L5 12.5z',
  pause: 'M5.5 3.5v9M10.5 3.5v9',
  lock: 'M5 7V5a3 3 0 0 1 6 0v2M4 7h8v6H4z',
  warn: 'M8 2l6 11H2zM8 6v3M8 11.5h.01',
  check: 'M3 8.5l3 3L13 4.5',
  log: 'M3 4h10M3 8h10M3 12h7',
  more: 'M3.4 8h.01M8 8h.01M12.6 8h.01',
  x: 'M4 4l8 8M12 4l-8 8',
  chevron: 'M6 3.5L10.5 8 6 12.5'
} as const

const RUN_KEY: Record<SyncRun, MessageKey> = {
  disabled: 'sync.state.disabled',
  stopped: 'sync.state.stopped',
  occupied: 'sync.state.occupied',
  running: 'sync.state.running',
  failed: 'sync.state.failed'
}

const PROBLEM_KEY: Record<SyncProblem, MessageKey> = {
  noSrc: 'sync.problem.noSrc',
  noDst: 'sync.problem.noDst',
  srcMissing: 'sync.problem.srcMissing',
  dstMissing: 'sync.problem.dstMissing',
  sameDir: 'sync.problem.sameDir',
  nested: 'sync.problem.nested'
}

const KEPT_KEY = {
  targetModified: 'sync.attention.targetModified',
  autoDeleteOff: 'sync.attention.autoDeleteOff',
  sourceIncomplete: 'sync.attention.sourceIncomplete'
} as const

function clock(ms: number): string {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}

function parseList(raw: string): string[] {
  return raw
    .split(/[,，\n\r\t]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function sameConfig(a: SyncConfig | null, b: SyncConfig): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b)
}

function changeMark(kind: SyncChange['kind']): { mark: string; cls: string } {
  if (kind === 'copy') return { mark: '+', cls: 'is-add' }
  if (kind === 'delete') return { mark: '−', cls: 'is-del' }
  if (kind === 'failed') return { mark: '!', cls: 'is-bad' }
  return { mark: '!', cls: 'is-warn' }
}

function lineClass(line: string): string {
  if (line.includes('[错误]') || line.includes('[失败]')) return 'is-bad'
  if (line.includes('[提醒]') || line.includes('[退避]')) return 'is-warn'
  if (line.includes('[完成]')) return 'is-ok'
  if (line.includes('[待') || line.includes('[事件]') || line.includes('[巡检]')) return 'is-info'
  return ''
}

export function SyncWorkspace({
  cwd,
  sync,
  logOpen,
  onOpenLog,
  onCloseLog,
  onNotice
}: Props): JSX.Element {
  const { t } = useI18n()
  const cfg = sync.state?.config ?? null
  const snapshot: SyncSnapshot | undefined = sync.state?.snapshot

  const [draft, setDraft] = useState<SyncConfig | null>(cfg)
  const draftRef = useRef<SyncConfig | null>(cfg)
  const saveTimer = useRef<number | null>(null)
  const saveRef = useRef(sync.save)
  saveRef.current = sync.save
  const draftCwd = useRef(cwd)

  const [rootsText, setRootsText] = useState('')
  const [rootsReady, setRootsReady] = useState(false)
  const [settleText, setSettleText] = useState('')
  const [sweepText, setSweepText] = useState('')
  const [numsReady, setNumsReady] = useState(false)
  const [addingExclude, setAddingExclude] = useState(false)
  const [newExclude, setNewExclude] = useState('')
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // 工作区切换 / 首次拿到配置时填草稿；之后状态推送不覆盖用户正在编辑的值。
  useEffect(() => {
    if (draftCwd.current !== cwd) {
      draftCwd.current = cwd
      draftRef.current = cfg
      setDraft(cfg)
      setRootsReady(false)
      setNumsReady(false)
      return
    }
    if (!draftRef.current && cfg) {
      draftRef.current = cfg
      setDraft(cfg)
    }
  }, [cwd, cfg])

  useEffect(() => {
    if (!draft || rootsReady) return
    setRootsText(draft.syncRoots.join(', '))
    setRootsReady(true)
  }, [draft, rootsReady])

  useEffect(() => {
    if (!draft || numsReady) return
    setSettleText(String(draft.settleMs))
    setSweepText(String(draft.sweepMs))
    setNumsReady(true)
  }, [draft, numsReady])

  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current)
        saveTimer.current = null
        const pending = draftRef.current
        if (pending) void saveRef.current(pending)
      }
    }
  }, [])

  const scheduleSave = (next: SyncConfig, delay = 320): void => {
    draftRef.current = next
    setDraft(next)
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null
      void (async () => {
        const sent = next
        const fresh = await sync.save(sent)
        // 保存期间用户又改了的话，别拿旧响应覆盖新草稿
        if (fresh) {
          setSavedAt(Date.now())
          if (sameConfig(draftRef.current, sent)) {
            draftRef.current = fresh
            setDraft(fresh)
            setSettleText(String(fresh.settleMs))
            setSweepText(String(fresh.sweepMs))
          }
        }
      })()
    }, delay)
  }

  const patch = (p: Partial<SyncConfig>, delay = 320): void => {
    const cur = draftRef.current
    if (!cur) return
    scheduleSave({ ...cur, ...p }, delay)
  }

  const browse = async (which: 'src' | 'dst'): Promise<void> => {
    const picked = await sync.pickDir(which)
    if (picked) patch({ [which]: picked } as Partial<SyncConfig>, 0)
  }

  const run: SyncRun = snapshot?.run ?? 'disabled'
  const busy = snapshot?.busy ?? false
  const problem = snapshot?.problem ?? null
  const watched = snapshot?.watchedDirs ?? 0
  const needsSetup =
    run === 'disabled' || (run === 'stopped' && (problem === 'noSrc' || problem === 'noDst'))
  const occupied = run === 'occupied'
  const canRun = !!draft?.enabled && (run === 'running' || run === 'failed') && !busy
  const actionLabel = busy
    ? t('sync.header.syncing')
    : run === 'failed'
      ? t('sync.header.retry')
      : run === 'occupied'
        ? t('sync.header.waiting')
        : run === 'running'
          ? t('sync.header.syncNow')
          : t('sync.header.start')

  const stateText =
    busy && run === 'running' ? t('sync.state.busy') : t(RUN_KEY[run])
  const detail = (() => {
    if (run === 'occupied') return t('sync.occupiedBy', { workspace: snapshot?.occupiedBy ?? '' })
    if (run === 'disabled') return t('sync.problem.disabledHint')
    if (problem) return t(PROBLEM_KEY[problem])
    if (snapshot?.error) return snapshot.error
    return ''
  })()

  const lastText = snapshot?.lastRoundAtMs
    ? t('sync.header.last', {
        time: clock(snapshot.lastRoundAtMs),
        cost:
          (snapshot.lastCostMs ?? 0) >= 1000
            ? t('sync.time.sec', { n: ((snapshot.lastCostMs ?? 0) / 1000).toFixed(1) })
            : t('sync.time.ms', { n: Math.round(snapshot.lastCostMs ?? 0) })
      })
    : t('sync.header.never')

  const totalChanges =
    (snapshot?.copied ?? 0) +
    (snapshot?.deleted ?? 0) +
    (snapshot?.failed ?? 0) +
    (snapshot?.keptItems.length ?? 0)
  const visibleChanges = snapshot?.changes.slice(0, 4) ?? []
  const hiddenChanges = Math.max(0, totalChanges - visibleChanges.length)

  const attention = useMemo(() => {
    const rows: { rel: string; why: string; kind: 'bad' | 'warn'; error?: boolean }[] = []
    if (snapshot?.error) {
      rows.push({ rel: '', why: snapshot.error, kind: 'bad', error: true })
    }
    for (const f of snapshot?.failedItems ?? []) {
      rows.push({ rel: f.rel, why: f.reason, kind: 'bad' })
    }
    for (const k of snapshot?.keptItems ?? []) {
      rows.push({ rel: k.rel, why: t(KEPT_KEY[k.why]), kind: 'warn' })
    }
    return rows
  }, [snapshot, t])

  const logLines = snapshot?.log ?? []
  const logPreview = logLines.slice(-4)

  const onSyncNow = async (): Promise<void> => {
    const r = await sync.syncNow()
    if (!r.ok && r.message) onNotice(r.message)
  }

  const onOpenTarget = async (): Promise<void> => {
    const r = await sync.openTarget()
    if (!r.ok && r.message) onNotice(r.message)
  }

  const addExclude = (): void => {
    const v = newExclude.trim()
    if (v) {
      const cur = draftRef.current
      if (cur && !cur.exclude.includes(v.toLowerCase())) {
        patch({ exclude: [...cur.exclude, v.toLowerCase()] }, 0)
      }
    }
    setNewExclude('')
    setAddingExclude(false)
  }

  const removeExclude = (value: string): void => {
    const cur = draftRef.current
    if (!cur) return
    patch({ exclude: cur.exclude.filter((x) => x !== value) }, 0)
  }

  if (sync.loading && !draft) {
    return <section className="sync-workspace sync-workspace--loading">{t('sync.loading')}</section>
  }

  return (
    <section className="sync-workspace">
      <header className="sync-head">
        <div className="sync-titlewrap">
          <span className="sync-ico">
            <Ico d={P.sync} size={17} />
          </span>
          <div className="sync-titlebox">
            <div className="sync-title">{t('sync.title')}</div>
            <div className="sync-sub">
              <span className="sync-path" title={draft?.src || cwd}>
                {draft?.src || cwd}
              </span>
              <span className="sync-arrow">→</span>
              <span className={`sync-path ${draft?.dst ? '' : 'is-empty'}`} title={draft?.dst || ''}>
                {draft?.dst || t('sync.problem.noDst')}
              </span>
            </div>
          </div>
        </div>

        <div className="sync-headright">
          <span className={`sync-state ${run === 'failed' ? 'is-bad' : run === 'occupied' ? 'is-warn' : run === 'running' ? 'is-run' : 'is-off'}`}>
            <i />
            {t(RUN_KEY[run])}
          </span>
          <span className="sync-last">{lastText}</span>
          <span className="sync-hsep" />
          {draft?.dst && (
            <button className="sync-btn sync-btn--ghost" onClick={() => void onOpenTarget()}>
              {t('sync.header.openTarget')}
            </button>
          )}
          <button
            className="sync-btn sync-btn--primary"
            disabled={!canRun}
            onClick={() => void onSyncNow()}
          >
            <Ico d={busy ? P.refresh : P.play} size={12} />
            {actionLabel}
          </button>
          {draft?.enabled && (run === 'running' || run === 'failed') && (
            <button
              className="sync-iconbtn"
              title={t('sync.header.pause')}
              onClick={() => patch({ enabled: false }, 0)}
            >
              <Ico d={P.pause} size={13} />
            </button>
          )}
          <button className="sync-iconbtn" title={t('sync.status.viewLog')} onClick={onOpenLog}>
            <Ico d={P.log} size={13} />
          </button>
        </div>
      </header>

      <div className="sync-scroll">
        <div className="sync-grid">
          {/* ── 左栏 ── */}
          <div className="sync-col">
            <div className="sync-card">
              <div className="sync-card-head">
                <span>{t('sync.status.title')}</span>
                <button className="sync-link" onClick={onOpenLog}>
                  {t('sync.status.viewLog')}
                </button>
              </div>
              <div className="sync-bigstate">
                <i className={`sync-dot ${run === 'failed' ? 'is-bad' : run === 'occupied' ? 'is-warn' : run === 'running' ? 'is-ok' : 'is-off'}`} />
                {stateText}
                {busy && run !== 'running' && <span className="sync-side">{t('sync.state.busy')}</span>}
              </div>
              {detail && <div className={`sync-meta ${run === 'disabled' ? 'is-muted' : ''}`}>{detail}</div>}
              <div className="sync-stats">
                <div>
                  <b>{snapshot?.copied ?? 0}</b>
                  <span>{t('sync.status.copied')}</span>
                </div>
                <div>
                  <b>{snapshot?.deleted ?? 0}</b>
                  <span>{t('sync.status.deleted')}</span>
                </div>
                <div>
                  <b className={(snapshot?.failed ?? 0) > 0 ? 'is-bad' : 'is-ok'}>
                    {snapshot?.failed ?? 0}
                  </b>
                  <span>{t('sync.status.failed')}</span>
                </div>
              </div>
              {(run === 'running' || run === 'failed' || busy) && (
                <>
                  <div className="sync-watch">
                    <Ico d={P.folder} size={11} />
                    {watched > 0
                      ? t('sync.status.watching', { n: watched })
                      : t('sync.status.scanning')}
                    {(snapshot?.hints ?? 0) > 0 && (
                      <>
                        <span>·</span>
                        {t('sync.status.hints', { n: snapshot?.hints ?? 0 })}
                      </>
                    )}
                    {(draft?.sweepMs ?? 0) > 0 && (
                      <>
                        <span>·</span>
                        {t('sync.status.sweep', { n: Math.round((draft?.sweepMs ?? 0) / 1000) })}
                      </>
                    )}
                  </div>
                  {snapshot?.firstRun && (
                    <div className="sync-watch is-warn">{t('sync.status.firstRun')}</div>
                  )}
                </>
              )}
            </div>

            {needsSetup && (
              <div className="sync-card sync-setupcard">
                <div className="sync-setup-ico">
                  <Ico d={P.sync} size={21} />
                </div>
                <h3>{t('sync.setup.title')}</h3>
                <p>{t('sync.setup.body')}</p>
                <div className="sync-steps">
                  <div className={`sync-step ${draft?.src ? 'is-done' : ''}`}>
                    <i>1</i>
                    <div>
                      {t('sync.setup.step1')}
                      <small>{t('sync.setup.step1Hint')}</small>
                    </div>
                  </div>
                  <div className={`sync-step ${draft?.dst ? 'is-done' : ''}`}>
                    <i>2</i>
                    <div>
                      {t('sync.setup.step2')}
                      <small>{t('sync.setup.step2Hint')}</small>
                    </div>
                  </div>
                  <div className={`sync-step ${draft?.enabled ? 'is-done' : ''}`}>
                    <i>3</i>
                    <div>
                      {t('sync.setup.step3')}
                      <small>{t('sync.setup.step3Hint')}</small>
                    </div>
                  </div>
                </div>
                <div className="sync-callout">{t('sync.setup.callout')}</div>
              </div>
            )}

            {occupied && (
              <div className="sync-card sync-busycard">
                <div className="sync-busy-ico">
                  <Ico d={P.lock} size={21} />
                </div>
                <h3>{t('sync.state.occupied')}</h3>
                <p>{t('sync.occupiedHint')}</p>
                <div className="sync-who">
                  <Ico d={P.lock} size={11} />
                  <span>{t('sync.occupiedBy', { workspace: snapshot?.occupiedBy ?? '' })}</span>
                </div>
                <div className="sync-watch is-warn">{t('sync.retry60')}</div>
              </div>
            )}

            {!needsSetup && !occupied && (
              <div className="sync-card">
                <div className="sync-card-head">
                  <span>{t('sync.changes.title')}</span>
                  {totalChanges > 0 && (
                    <button className="sync-link" onClick={onOpenLog}>
                      {t('sync.changes.all', { n: totalChanges })}
                    </button>
                  )}
                </div>
                <div className="sync-list">
                  {visibleChanges.length === 0 && (
                    <div className="sync-empty">{t('sync.changes.empty')}</div>
                  )}
                  {visibleChanges.map((c, i) => {
                    const { mark, cls } = changeMark(c.kind)
                    const why =
                      c.kind === 'failed'
                        ? t('sync.changes.failed')
                        : c.kind === 'kept'
                          ? t('sync.changes.kept')
                          : ''
                    return (
                      <div className="sync-row" key={`${c.rel}-${c.kind}-${i}`}>
                        <span className={`sync-mark ${cls}`}>{mark}</span>
                        <span className="sync-rowpath" title={c.rel}>
                          {c.rel}
                        </span>
                        {why && (
                          <span className="sync-rowwhy" title={c.kind === 'failed' ? c.reason : undefined}>
                            {why}
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
                <div className="sync-listfoot">
                  <span>
                    {t('sync.changes.summary', {
                      copied: snapshot?.copied ?? 0,
                      deleted: snapshot?.deleted ?? 0,
                      pruned: snapshot?.pruned ?? 0
                    })}
                  </span>
                  {(snapshot?.failed ?? 0) > 0 ? (
                    <span className="is-bad">{t('sync.changes.retryHint', { n: snapshot?.failed ?? 0 })}</span>
                  ) : hiddenChanges > 0 ? (
                    <button className="sync-more" onClick={onOpenLog}>
                      {t('sync.changes.more', { n: hiddenChanges })}
                    </button>
                  ) : null}
                </div>
              </div>
            )}

            {attention.length > 0 && (
              <div className="sync-card">
                <div className="sync-card-head">
                  <span>{t('sync.attention.title')}</span>
                  <span className="sync-badge is-bad">{t('sync.attention.count', { n: attention.length })}</span>
                </div>
                <div className="sync-attnlist">
                  {attention.slice(0, 6).map((a, i) => (
                    <div className={`sync-attn ${a.kind === 'bad' ? 'is-bad' : 'is-warn'}`} key={`${a.rel}-${i}`}>
                      <div className="sync-attn-p">
                        <span className="sync-tag">{a.kind === 'bad' ? '✕' : '!'}</span>
                        {a.rel ? (
                          <span title={a.rel}>{a.rel}</span>
                        ) : (
                          <span>{t('sync.state.failed')}</span>
                        )}
                      </div>
                      <span className="sync-attn-why">{a.why}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="sync-card">
              <div className="sync-card-head">
                <span>{t('sync.log.title')}</span>
                <button className="sync-link" onClick={onOpenLog}>
                  {t('sync.log.all')}
                </button>
              </div>
              {logPreview.length === 0 ? (
                <div className="sync-empty">{t('sync.log.empty')}</div>
              ) : (
                <div className="sync-logbox">
                  {logPreview.map((line, i) => (
                    <div key={i} className={lineClass(line)}>
                      {line}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ── 右栏：配置 ── */}
          {draft ? (
            <div className="sync-card sync-formcard">
              <div className="sync-formhead">
                <div>
                  <div className="sync-formtitle">{t('sync.form.title')}</div>
                  <div className="sync-formsub">{t('sync.form.sub')}</div>
                </div>
                <span className={`sync-autosave ${needsSetup && !draft.dst ? 'is-warn' : ''}`}>
                  {needsSetup && !draft.dst
                    ? t('sync.form.incomplete')
                    : savedAt
                      ? `${t('sync.form.saved')} · ${clock(savedAt)}`
                      : t('sync.form.autoSave')}
                </span>
              </div>

              {sync.error && <div className="sync-formerror">{sync.error}</div>}

              <div className="sync-frow">
                <div className="sync-fmain">
                  <div className="sync-flabel">{t('sync.form.enable')}</div>
                  <div className="sync-fdesc">{t('sync.form.enableHint')}</div>
                </div>
                <label className="sync-switch">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(e) => patch({ enabled: e.target.checked }, 0)}
                  />
                  <span className="sync-switch-ui" />
                </label>
              </div>

              <div className="sync-frow sync-frow--stack">
                <div className="sync-flabel">{t('sync.form.src')}</div>
                <div className="sync-fdesc">{t('sync.form.srcHint')}</div>
                <div className="sync-pathrow">
                  <div className="sync-pathfield">
                    <Ico d={P.folder} size={13} />
                    <input
                      value={draft.src}
                      spellCheck={false}
                      onChange={(e) => patch({ src: e.target.value })}
                    />
                  </div>
                  <button className="sync-browse" onClick={() => void browse('src')}>
                    {t('sync.form.browse')}
                  </button>
                </div>
              </div>

              <div className="sync-frow sync-frow--stack">
                <div className="sync-flabel">{t('sync.form.dst')}</div>
                <div className="sync-fdesc">{t('sync.form.dstHint')}</div>
                <div className="sync-pathrow">
                  <div className={`sync-pathfield ${draft.dst ? '' : 'is-empty'}`}>
                    <Ico d={P.folder} size={13} />
                    <input
                      value={draft.dst}
                      spellCheck={false}
                      placeholder={t('sync.problem.noDst')}
                      onChange={(e) => patch({ dst: e.target.value })}
                    />
                  </div>
                  <button className="sync-browse" onClick={() => void browse('dst')}>
                    {t('sync.form.browse')}
                  </button>
                </div>
                <div className="sync-dirnote">
                  <Ico d={P.arrow} size={12} />
                  <span>{t('sync.form.direction')}</span>
                </div>
              </div>

              <div className="sync-frow sync-frow--stack">
                <div className="sync-flabel">{t('sync.form.roots')}</div>
                <div className="sync-fdesc">{t('sync.form.rootsHint')}</div>
                <input
                  className="sync-input"
                  value={rootsText}
                  spellCheck={false}
                  placeholder={t('sync.form.rootsPlaceholder')}
                  onChange={(e) => {
                    setRootsText(e.target.value)
                    patch({ syncRoots: parseList(e.target.value) })
                  }}
                  onBlur={() => {
                    const cur = draftRef.current
                    if (cur) setRootsText(cur.syncRoots.join(', '))
                  }}
                />
              </div>

              <div className="sync-frow sync-frow--stack">
                <div className="sync-flabel">{t('sync.form.exclude')}</div>
                <div className="sync-fdesc">{t('sync.form.excludeHint')}</div>
                <div className="sync-chips">
                  {draft.exclude.map((value) => (
                    <span className="sync-chip" key={value}>
                      {value}
                      <button title={t('common.delete')} onClick={() => removeExclude(value)}>
                        ×
                      </button>
                    </span>
                  ))}
                  {addingExclude ? (
                    <input
                      autoFocus
                      className="sync-chipinput"
                      value={newExclude}
                      placeholder="dist"
                      spellCheck={false}
                      onChange={(e) => setNewExclude(e.target.value)}
                      onBlur={addExclude}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          addExclude()
                        } else if (e.key === 'Escape') {
                          setNewExclude('')
                          setAddingExclude(false)
                        }
                      }}
                    />
                  ) : (
                    <button className="sync-chip sync-chip--add" onClick={() => setAddingExclude(true)}>
                      {t('sync.form.addExclude')}
                    </button>
                  )}
                </div>
              </div>

              <div className="sync-frow">
                <div className="sync-fmain">
                  <div className="sync-flabel">{t('sync.form.deleteMissing')}</div>
                  <div className="sync-fdesc">{t('sync.form.deleteMissingHint')}</div>
                </div>
                <label className="sync-switch">
                  <input
                    type="checkbox"
                    checked={draft.deleteMissing}
                    onChange={(e) => patch({ deleteMissing: e.target.checked }, 0)}
                  />
                  <span className="sync-switch-ui" />
                </label>
              </div>

              <div className="sync-frow sync-frow--stack">
                <div className="sync-flabel">{t('sync.form.rhythm')}</div>
                <div className="sync-fdesc">{t('sync.form.rhythmHint')}</div>
                <div className="sync-two">
                  <label className="sync-time">
                    <span>{t('sync.form.settle')}</span>
                    <div>
                      <input
                        value={settleText}
                        inputMode="numeric"
                        onChange={(e) => setSettleText(e.target.value.replace(/[^\d]/g, ''))}
                        onBlur={() => {
                          const n = Number(settleText)
                          const next = Number.isFinite(n) && n > 0 ? Math.round(n) : 1500
                          setSettleText(String(next))
                          patch({ settleMs: next }, 0)
                        }}
                      />
                      <em>{t('sync.form.ms')}</em>
                    </div>
                  </label>
                  <label className="sync-time">
                    <span>{t('sync.form.sweep')}</span>
                    <div>
                      <input
                        value={sweepText}
                        inputMode="numeric"
                        onChange={(e) => setSweepText(e.target.value.replace(/[^\d]/g, ''))}
                        onBlur={() => {
                          const n = Number(sweepText)
                          const next = Number.isFinite(n) && n > 0 ? Math.round(n) : 0
                          setSweepText(String(next))
                          patch({ sweepMs: next }, 0)
                        }}
                      />
                      <em>{t('sync.form.ms')}</em>
                    </div>
                  </label>
                </div>
                <div className="sync-fdesc">{t('sync.form.sweepZero')}</div>
              </div>

              <details className="sync-adv">
                <summary>
                  <Ico d={P.chevron} size={9} />
                  {t('sync.form.junk')}
                  <span className="sync-advcount">
                    {t('sync.form.junkCounts', {
                      dirs: SYNC_JUNK.dirNames.length,
                      files: SYNC_JUNK.fileNames.length,
                      suffixes: SYNC_JUNK.suffixes.length,
                      prefixes: SYNC_JUNK.prefixes.length
                    })}
                  </span>
                </summary>
                <div className="sync-advbody">{t('sync.form.junkBody')}</div>
              </details>

              <div className="sync-formfoot">
                <Ico d={P.check} size={11} />
                {needsSetup && !draft.dst ? (
                  <span className="is-warn">{t('sync.form.waitingDst')}</span>
                ) : (
                  <span>{t('sync.form.autoSave')}</span>
                )}
              </div>
            </div>
          ) : (
            <div className="sync-card sync-formcard">
              <div className="sync-empty">{t('sync.loading')}</div>
            </div>
          )}
        </div>
      </div>

      {logOpen && (
        <div className="sync-logpop" role="dialog" aria-label={t('sync.log.popupTitle')}>
          <div className="sync-logpop-head">
            <span>{t('sync.log.popupTitle')}</span>
            <span className={`sync-state ${run === 'failed' ? 'is-bad' : run === 'occupied' ? 'is-warn' : run === 'running' ? 'is-run' : 'is-off'}`}>
              <i />
              {t(RUN_KEY[run])}
            </span>
            <button className="sync-logpop-x" title={t('common.close')} onClick={onCloseLog}>
              <Ico d={P.x} size={12} />
            </button>
          </div>
          <div className="sync-logpop-body">
            {logLines.length === 0 ? (
              <div className="sync-empty">{t('sync.log.empty')}</div>
            ) : (
              logLines.map((line, i) => (
                <div key={i} className={lineClass(line)}>
                  {line}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </section>
  )
}
