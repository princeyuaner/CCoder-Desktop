import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { PermissionMode } from '@shared/events'
import {
  CHAT_FONT_SIZES,
  CLIS,
  cliConfig,
  cliDef,
  DEFAULT_MONO_FONT,
  DEFAULT_UI_FONT,
  EFFORT_HINT_KEY,
  EFFORT_LABEL_KEY,
  effortLevelsFor,
  LANGUAGE_LABEL_KEY,
  MONO_FONT_PRESETS,
  newChannel,
  PROTOCOL_LABEL_KEY,
  SEND_KEY_LABEL_KEY,
  THEME_GROUPS,
  THEME_LABEL_KEY,
  TOOL_DETAIL_LABEL_KEY,
  UI_FONT_PRESETS,
  UI_ZOOM_LEVELS,
  type Channel,
  type ChannelTestResult,
  type CliConfig,
  type CliId,
  type SendKey,
  type Settings,
  type ThemeMode,
  type ToolDetail
} from '@shared/settings'
import { MODE_HINT_KEY, MODE_LABEL_KEY, PERMISSION_MODES } from '../constants'
import { LANGUAGES, resolveLanguage, type LanguageSetting } from '@shared/i18n'
import { applyAppearance } from '../appearance'
import { applyLanguageSetting, getSystemLocale, useI18n } from '../i18n'
import { useSettings } from '../useSettings'
import { useCodexStatus } from '../useCodexStatus'
import { useClaudeAuth } from '../useClaudeAuth'
import { useDshStatus } from '../useDshStatus'
import { useUpdater } from '../useUpdater'
import { AboutPanel } from './AboutPanel'
import { ChannelForm } from './ChannelForm'
import { ClaudeAuthPanel } from './ClaudeAuthPanel'
import { CodexStatusPanel } from './CodexStatusPanel'
import { DshStatusPanel } from './DshStatusPanel'
import { McpManagerPage } from './McpManagerPage'
import { SkillsManagerPage } from './SkillsManagerPage'
import { IconChevronLeft, IconPlus } from './Icons'

/** 设置页的几类页面：某个 CLI 的渠道配置、与 CLI 无关的系统设置，或关于/更新 */
type Page =
  | { kind: 'cli'; id: CliId }
  | { kind: 'general' }
  | { kind: 'permissions' }
  | { kind: 'mcp' }
  | { kind: 'skills' }
  | { kind: 'about' }

export function SettingsPage({
  onBack,
  initialPage
}: {
  onBack: () => void
  /** 从旧 MCP 迁移提示跳进来时直接打开 MCP 页 */
  initialPage?: 'mcp' | 'skills'
}): JSX.Element {
  const { t } = useI18n()
  const { settings, loading, save, test } = useSettings()
  const [page, setPage] = useState<Page>(() =>
    initialPage === 'mcp'
      ? { kind: 'mcp' }
      : initialPage === 'skills'
        ? { kind: 'skills' }
        : { kind: 'cli', id: CLIS[0].id }
  )
  /**
   * Codex 的安装 / 登录状态。hook 必须无条件调用；真正探测由 enabled 控制 ——
   * 只有停在 Codex 页时才起 app-server。
   */
  const codexStatus = useCodexStatus(page.kind === 'cli' && page.id === 'codex')
  /** Claude 的官方登录状态。同样只在停在 Claude 页时探测。 */
  const claudeAuth = useClaudeAuth(page.kind === 'cli' && page.id === 'claude')
  /**
   * DeepSeek Harness 的安装 / Node / DSH_HOME 状态。
   *
   * 每个渠道一个 DSH_HOME，所以状态卡要跟着凭据来源走：channel 模式显示
   * 当前渠道的 home，official 模式（Harness 自己的凭据）显示共享的 `~/.dsh`。
   * 用已保存的 settings 而不是 draft —— 渠道增删会自动落盘，状态卡晚一拍刷新
   * 没关系，没必要跟着每次击键重新探测。
   */
  const storedDshCfg = settings ? cliConfig(settings, 'dsh') : null
  const dshChannelId =
    storedDshCfg?.authMode === 'channel' ? storedDshCfg.activeChannelId : null
  const dshStatus = useDshStatus(page.kind === 'cli' && page.id === 'dsh', dshChannelId)
  /** 版本与更新状态。和右下角的更新提醒共用主进程里的同一份状态。 */
  const updater = useUpdater()
  /** 退出登录前提醒用：当前有多少条会话在跑 */
  const [runningSessions, setRunningSessions] = useState(0)

  // 编辑副本：改动先落在 draft，停手后自动落盘（不需要点保存）
  const [draft, setDraft] = useState<Settings | null>(null)
  /**
   * 选中哪个渠道是**派生**出来的，picked 只记「用户点过哪个」。
   * 这样切 CLI、删渠道之后不用手动纠正选中项 —— 它自己会回落到
   * 该 CLI 的当前渠道、再回落到第一个。
   */
  const [picked, setPicked] = useState<string | null>(null)
  const [result, setResult] = useState<ChannelTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  /** 自动保存的状态：输入中 → 保存中 → 已自动保存，失败时可以重试 */
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  /** 字体下拉是否切到了「自定义」——当前值不在预设里时也会算自定义 */
  const [uiFontCustom, setUiFontCustom] = useState(false)
  const [monoFontCustom, setMonoFontCustom] = useState(false)

  useEffect(() => {
    if (loading || draft !== null) return
    setDraft(settings)
  }, [loading, settings, draft])

  // 退出登录只会影响"下一轮"请求，先让用户知道有几条会话还在跑
  useEffect(() => {
    if (page.kind !== 'cli' || page.id !== 'claude') return
    let alive = true
    void window.api?.session
      .running()
      .then((ids) => {
        if (alive) setRunningSessions(ids.length)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [page])

  /** 外观和语言改一下预览一下，和落盘无关，立刻生效 */
  useEffect(() => {
    if (!draft) return
    applyLanguageSetting(draft.language)
    applyAppearance(draft)
  }, [draft])

  /** 已保存的那份，用来判断有没有改动、以及离开时要不要兜底落盘 */
  const savedRef = useRef(settings)
  useEffect(() => {
    savedRef.current = settings
  }, [settings])

  const draftRef = useRef<Settings | null>(draft)
  useEffect(() => {
    draftRef.current = draft
  }, [draft])

  const saveRef = useRef(save)
  useEffect(() => {
    saveRef.current = save
  }, [save])

  const autoSaveTimer = useRef<number | null>(null)

  const doAutoSave = useCallback(
    async (next: Settings): Promise<void> => {
      setSaveState('saving')
      try {
        const fresh = await save(next)
        // 保存期间用户没再改的话，把 draft 对齐到主进程规范化后的结果
        // （比如空字体回落到默认字体栈），否则会一直「有改动」而反复保存
        setDraft((cur) => (cur && JSON.stringify(cur) === JSON.stringify(next) ? fresh : cur))
        setSaveState('saved')
      } catch {
        // 保存失败：语言预览回滚到已保存的那份，别让界面停在一个没落盘的语言上
        applyLanguageSetting(savedRef.current.language)
        setSaveState('error')
      }
    },
    [save]
  )

  /**
   * 改完自动保存。320ms 防抖：连打字时不会每敲一个字就写一次盘，
   * 但停手后很快落盘 —— 用户不需要记得点「保存」。
   */
  useEffect(() => {
    if (!draft) return
    if (JSON.stringify(draft) === JSON.stringify(settings)) return
    setSaveState('saving')
    if (autoSaveTimer.current !== null) window.clearTimeout(autoSaveTimer.current)
    autoSaveTimer.current = window.setTimeout(() => {
      autoSaveTimer.current = null
      void doAutoSave(draft)
    }, 320)
    return () => {
      if (autoSaveTimer.current !== null) {
        window.clearTimeout(autoSaveTimer.current)
        autoSaveTimer.current = null
      }
    }
  }, [draft, settings, doAutoSave])

  /**
   * 离开设置页：还没落盘的改动立刻补一次，别让最后一下改动丢掉；
   * 同时把外观留在「最终要生效的那份」上，避免返回聊天时闪一下旧主题。
   */
  useEffect(() => {
    return () => {
      if (autoSaveTimer.current !== null) {
        window.clearTimeout(autoSaveTimer.current)
        autoSaveTimer.current = null
      }
      const pending = draftRef.current
      const unsaved = !!pending && JSON.stringify(pending) !== JSON.stringify(savedRef.current)
      if (pending && unsaved) {
        applyLanguageSetting(pending.language)
        void saveRef.current(pending).catch(() => {
          applyLanguageSetting(savedRef.current.language)
        })
        applyAppearance(pending)
      } else {
        applyLanguageSetting(savedRef.current.language)
        applyAppearance(savedRef.current)
      }
    }
  }, [])

  const cliId = page.kind === 'cli' ? page.id : null
  const cfg = cliId && draft ? cliConfig(draft, cliId) : null
  const selectedId = cfg ? resolveSelection(cfg, picked) : null
  const selected = cfg?.channels.find((c) => c.id === selectedId) ?? null
  /** 当前渠道是否已经带了凭据 —— Codex 有它就不必登录 ChatGPT */
  const activeCfgChannel = cfg?.channels.find((c) => c.id === cfg.activeChannelId) ?? null

  // 换 CLI / 换渠道时把上一次的测试结果收掉，免得张冠李戴
  useEffect(() => {
    setResult(null)
  }, [cliId, selectedId])

  if (!draft) return <main className="mainpane settings">{t('settings.loading')}</main>

  /** 当前字体是不是预设之一；不是就展开自定义输入框 */
  const uiFontIsCustom =
    uiFontCustom || !UI_FONT_PRESETS.some((p) => p.value === draft.uiFont)
  const monoFontIsCustom =
    monoFontCustom || !MONO_FONT_PRESETS.some((p) => p.value === draft.monoFont)

  const patch = (p: Partial<Settings>): void => setDraft({ ...draft, ...p })

  const patchCli = (id: CliId, p: Partial<CliConfig>): void =>
    patch({ clis: { ...draft.clis, [id]: { ...cliConfig(draft, id), ...p } } })

  const updateChannel = (c: Channel): void => {
    if (!cliId) return
    patchCli(cliId, {
      channels: cliConfig(draft, cliId).channels.map((x) => (x.id === c.id ? c : x))
    })
  }

  const addChannel = (): void => {
    if (!cliId) return
    // 协议由所属 CLI 决定：在 Codex 下新建的渠道天生就是 OpenAI 协议
    const c = newChannel(cliDef(cliId).protocol, t('settings.channel.newName'))
    const cur = cliConfig(draft, cliId)
    // 第一个渠道自动设为当前，省一次点击；Claude 下新建渠道也意味着
    // 用户想用渠道模式，顺手切回去
    patchCli(cliId, {
      channels: [...cur.channels, c],
      activeChannelId: cur.activeChannelId ?? c.id,
      ...((cliId === 'claude' || cliId === 'dsh') && cur.channels.length === 0
        ? { authMode: 'channel' as const }
        : {})
    })
    setPicked(c.id)
  }

  /** 启用某个渠道 —— Claude 下这一步同时切回渠道模式 */
  const activateChannel = (id: string): void => {
    if (!cliId) return
    patchCli(cliId, {
      activeChannelId: id,
      ...(cliId === 'claude' || cliId === 'dsh'
        ? { authMode: 'channel' as const }
        : {})
    })
  }

  const deleteChannel = (id: string): void => {
    if (!cliId) return
    const cur = cliConfig(draft, cliId)
    const rest = cur.channels.filter((c) => c.id !== id)
    patchCli(cliId, {
      channels: rest,
      activeChannelId: cur.activeChannelId === id ? (rest[0]?.id ?? null) : cur.activeChannelId
    })
    setPicked(null)
  }

  const runTest = async (): Promise<void> => {
    if (!selected) return
    setTesting(true)
    setResult(null)
    try {
      setResult(await test(selected))
    } finally {
      setTesting(false)
    }
  }

  return (
    <main className="mainpane settings">
      <header className="settings__head">
        <button className="btn btn--ghost" onClick={onBack}>
          <IconChevronLeft width={14} height={14} />
          {t('common.back')}
        </button>
        <h1 className="settings__title">{t('settings.title')}</h1>
        <div className="settings__head-right">
          {page.kind === 'mcp' || page.kind === 'skills' ? (
            <span className="saved-flash is-busy">
              {t(page.kind === 'mcp' ? 'mcp.saveHint' : 'skill.saveHint')}
            </span>
          ) : saveState === 'error' ? (
            <>
              <span className="saved-flash saved-flash--error">{t('settings.save.failed')}</span>
              <button className="btn btn--ghost" onClick={() => void doAutoSave(draft)}>
                {t('common.retry')}
              </button>
            </>
          ) : (
            <span className={`saved-flash ${saveState === 'saved' ? '' : 'is-busy'}`}>
              {saveState === 'saving'
                ? t('settings.save.saving')
                : saveState === 'saved'
                  ? t('settings.save.saved')
                  : t('settings.save.auto')}
            </span>
          )}
        </div>
      </header>

      <div className="settings__body">
        <nav className="settings__nav">
          <div className="settings__navgroup">{t('settings.nav.system')}</div>
          <NavItem active={page.kind === 'general'} onClick={() => setPage({ kind: 'general' })}>
            {t('settings.nav.general')}
          </NavItem>
          <NavItem active={page.kind === 'permissions'} onClick={() => setPage({ kind: 'permissions' })}>
            {t('settings.nav.permissions')}
          </NavItem>
          <NavItem active={page.kind === 'mcp'} onClick={() => setPage({ kind: 'mcp' })}>
            {t('settings.nav.mcp')}
          </NavItem>
          <NavItem active={page.kind === 'skills'} onClick={() => setPage({ kind: 'skills' })}>
            {t('settings.nav.skills')}
          </NavItem>

          <div className="settings__navgroup">{t('settings.nav.cli')}</div>
          {CLIS.map((d) => (
            <NavItem
              key={d.id}
              active={page.kind === 'cli' && page.id === d.id}
              onClick={() => setPage({ kind: 'cli', id: d.id })}
            >
              {d.name}
              {!d.ready && (
                <span className="settings__navtag">{t('settings.nav.notReady')}</span>
              )}
            </NavItem>
          ))}

          <NavItem active={page.kind === 'about'} onClick={() => setPage({ kind: 'about' })}>
            {t('settings.nav.about')}
          </NavItem>
        </nav>

        <div className={`settings__content${page.kind === 'mcp' || page.kind === 'skills' ? ' settings__content--wide' : ''}`}>
          {page.kind === 'cli' && cfg && (
            <>
              {page.id === 'codex' && (
                <CodexStatusPanel
                  status={codexStatus.status}
                  loading={codexStatus.loading}
                  error={codexStatus.error}
                  onRefresh={() => void codexStatus.refresh()}
                  hasChannelKey={!!activeCfgChannel?.authToken.trim()}
                />
              )}

              {page.id === 'claude' && (
                <ClaudeAuthPanel
                  auth={claudeAuth}
                  authMode={cfg.authMode}
                  officialModel={cfg.officialModel}
                  runningSessions={runningSessions}
                  onAuthMode={(m) => patchCli('claude', { authMode: m })}
                  onOfficialModel={(v) => patchCli('claude', { officialModel: v })}
                />
              )}

              {page.id === 'dsh' && (
                <DshStatusPanel
                  status={dshStatus.status}
                  loading={dshStatus.loading}
                  error={dshStatus.error}
                  onRefresh={() => void dshStatus.refresh()}
                  authMode={cfg.authMode}
                  onAuthMode={(m) => patchCli('dsh', { authMode: m })}
                  officialModel={cfg.officialModel}
                  onOfficialModel={(v) => patchCli('dsh', { officialModel: v })}
                  hasChannelKey={!!activeCfgChannel?.authToken.trim()}
                />
              )}

              <div className="clipane">
                <div className="clipane__main">
                  <h2 className="clipane__title">{cliDef(page.id).name}</h2>
                  <p className="clipane__hint">
                    {t('settings.cli.endpoint', { protocol: t(PROTOCOL_LABEL_KEY[cliDef(page.id).protocol]) })}
                  </p>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={cfg.enabled}
                    onChange={(e) => patchCli(page.id, { enabled: e.target.checked })}
                  />
                  <span>{cfg.enabled ? t('common.enabled') : t('common.disabled')}</span>
                </label>
              </div>

              {!cliDef(page.id).ready && (
                <p className="clipane__todo">{t('settings.cli.notReadyBody')}</p>
              )}

              {page.id === 'codex' && (
                <p className="section-lead">{t('settings.codex.lead')}</p>
              )}

              {(page.id === 'claude' || page.id === 'dsh') && cfg.authMode === 'official' ? (
                <p className="section-lead">
                  {page.id === 'dsh'
                    ? t('settings.dsh.officialLead')
                    : t('settings.claude.officialLead')}
                </p>
              ) : (
                <>
              <section className="chlist">
                <div className="chlist__head">
                  <span>{t('settings.channels')}</span>
                  <button className="btn btn--ghost" onClick={addChannel}>
                    <IconPlus width={13} height={13} />
                    {t('settings.channel.new')}
                  </button>
                </div>

                {cfg.channels.length === 0 && (
                  <p className="empty">
                    {t('settings.channel.empty')}
                    {page.id === 'claude'
                      ? t('settings.channel.emptyClaude')
                      : page.id === 'dsh'
                        ? t('settings.channel.emptyDsh')
                        : '.'}
                  </p>
                )}

                {cfg.channels.map((c) => (
                  <div
                    key={c.id}
                    className={`chlist__item ${c.id === selectedId ? 'is-active' : ''}`}
                  >
                    <button className="chlist__main" onClick={() => setPicked(c.id)}>
                      <span className="chlist__name">{c.name || t('settings.channel.unnamed')}</span>
                      <span className="chlist__meta">{c.baseUrl || t('settings.channel.noBaseUrl')}</span>
                    </button>
                    {c.id === cfg.activeChannelId && cfg.authMode === 'channel' ? (
                      <span className="badge badge--ok">{t('settings.channel.inUse')}</span>
                    ) : (
                      <button
                        className="btn btn--ghost btn--xs"
                        onClick={() => activateChannel(c.id)}
                      >
                        {t('settings.channel.activate')}
                      </button>
                    )}
                  </div>
                ))}
              </section>

              {selected && (
                <ChannelForm
                  cli={page.id}
                  channel={selected}
                  active={
                    selected.id === cfg.activeChannelId &&
                    ((page.id !== 'claude' && page.id !== 'dsh') ||
                      cfg.authMode === 'channel')
                  }
                  testing={testing}
                  result={result}
                  onChange={updateChannel}
                  onTest={() => void runTest()}
                  onDelete={() => deleteChannel(selected.id)}
                  onSetActive={() => activateChannel(selected.id)}
                />
              )}
                </>
              )}

              {/* 加条分隔线：上面紧挨着渠道表单的「测试连接 / 删除渠道」按钮行，
                  不隔一下会被当成那排按钮的一部分 */}
              <section className="chform chform--sep">
                <h2 className="chform__title">{t('settings.cli.effortTitle')}</h2>
                <div className="field">
                  <label className="field__label">{t('settings.cli.effortDefault')}</label>
                  <div className="field__body">
                    <div className="effpick">
                      {effortLevelsFor(page.id).map((l) => (
                        <button
                          key={l}
                          className={`effpick__it ${l === cfg.effort ? 'is-on' : ''}`}
                          onClick={() => patchCli(page.id, { effort: l })}
                        >
                          <span className="effpick__n">{t(EFFORT_LABEL_KEY[l])}</span>
                          <span className="effpick__e">{l}</span>
                        </button>
                      ))}
                    </div>
                    <p className="field__hint">
                      {t(EFFORT_HINT_KEY[cfg.effort])}
                      {page.id === 'codex'
                        ? t('settings.cli.effortCodex')
                        : page.id === 'dsh'
                          ? t('settings.cli.effortDsh')
                          : t('settings.cli.effortClaude')}
                      {t('settings.cli.effortNote')}
                    </p>
                  </div>
                </div>
              </section>
            </>
          )}

          {page.kind === 'mcp' && (
            <McpManagerPage
              cwd={draft.defaultCwd.trim() || draft.openedCwds[0] || ''}
              openedCwds={draft.openedCwds}
              dshAuthMode={storedDshCfg?.authMode}
              dshChannelId={dshChannelId}
            />
          )}

          {page.kind === 'skills' && (
            <SkillsManagerPage
              cwd={draft.defaultCwd.trim() || draft.openedCwds[0] || ''}
              openedCwds={draft.openedCwds}
            />
          )}

          {page.kind === 'general' && (
            <>
              <section className="chform">
                <h2 className="chform__title">{t('settings.language.section')}</h2>
                <div className="field">
                  <label className="field__label">{t('settings.language.label')}</label>
                  <div className="field__body">
                    <select
                      className="input"
                      value={draft.language}
                      onChange={(e) =>
                        patch({ language: e.target.value as LanguageSetting })
                      }
                    >
                      {LANGUAGES.map((l) => (
                        <option key={l} value={l}>
                          {t(LANGUAGE_LABEL_KEY[l])}
                        </option>
                      ))}
                    </select>
                    <p className="field__hint">
                      {draft.language === 'system'
                        ? t('language.systemCurrent', {
                            language: t(
                              LANGUAGE_LABEL_KEY[
                                resolveLanguage(draft.language, getSystemLocale())
                              ]
                            )
                          })
                        : t('settings.language.hint')}
                    </p>
                  </div>
                </div>
              </section>

              <section className="chform chform--sep">
                <h2 className="chform__title">{t('settings.workspace')}</h2>
                <div className="field">
                  <label className="field__label">{t('settings.general.defaultCwd')}</label>
                  <div className="field__body">
                    <input
                      className="input"
                      placeholder={t('settings.general.defaultCwdPlaceholder')}
                      value={draft.defaultCwd}
                      onChange={(e) => patch({ defaultCwd: e.target.value })}
                    />
                    <p className="field__hint">
                      {t('settings.general.defaultCwdHint')}
                    </p>
                  </div>
                </div>
              </section>

              <section className="chform chform--sep">
                <h2 className="chform__title">{t('settings.appearance')}</h2>

                <div className="field">
                  <label className="field__label">{t('settings.theme.label')}</label>
                  <div className="field__body">
                    <select
                      className="input"
                      value={draft.theme}
                      onChange={(e) => patch({ theme: e.target.value as ThemeMode })}
                    >
                      {THEME_GROUPS.map((g) => (
                        <optgroup key={g.labelKey} label={t(g.labelKey)}>
                          {g.themes.map((theme) => (
                            <option key={theme} value={theme}>
                              {t(THEME_LABEL_KEY[theme])}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    <p className="field__hint">
                      {t('settings.theme.hint')}
                    </p>
                  </div>
                </div>

                <div className="field">
                  <label className="field__label">{t('settings.zoom')}</label>
                  <div className="field__body">
                    <select
                      className="input"
                      value={draft.uiZoom}
                      onChange={(e) => patch({ uiZoom: Number(e.target.value) })}
                    >
                      {UI_ZOOM_LEVELS.map((z) => (
                        <option key={z} value={z}>
                          {Math.round(z * 100)}%
                        </option>
                      ))}
                    </select>
                    <p className="field__hint">
                      {t('settings.zoomHint')}
                    </p>
                  </div>
                </div>

                <div className="field">
                  <label className="field__label">{t('settings.chatFontSize')}</label>
                  <div className="field__body">
                    <select
                      className="input"
                      value={draft.chatFontSize}
                      onChange={(e) => patch({ chatFontSize: Number(e.target.value) })}
                    >
                      {CHAT_FONT_SIZES.map((n) => (
                        <option key={n} value={n}>
                          {n}px
                        </option>
                      ))}
                    </select>
                    <p className="field__hint">
                      {t('settings.chatFontSizeHint')}
                    </p>
                  </div>
                </div>

                <div className="field">
                  <label className="field__label">{t('settings.uiFont')}</label>
                  <div className="field__body">
                    <select
                      className="input"
                      value={uiFontIsCustom ? '__custom__' : draft.uiFont}
                      onChange={(e) => {
                        if (e.target.value === '__custom__') {
                          setUiFontCustom(true)
                          return
                        }
                        setUiFontCustom(false)
                        patch({ uiFont: e.target.value })
                      }}
                    >
                      {UI_FONT_PRESETS.map((p) => (
                        <option key={p.value} value={p.value}>
                          {t(p.labelKey)}
                        </option>
                      ))}
                      <option value="__custom__">{t('settings.custom')}</option>
                    </select>
                    {uiFontIsCustom && (
                      <input
                        className="input field__sub"
                        value={draft.uiFont}
                        placeholder={t('settings.uiFontPlaceholder')}
                        onChange={(e) => patch({ uiFont: e.target.value })}
                        onBlur={() => {
                          if (!draft.uiFont.trim()) patch({ uiFont: DEFAULT_UI_FONT })
                        }}
                      />
                    )}
                    <p className="field__hint">
                      {t('settings.uiFontHint')}
                    </p>
                  </div>
                </div>

                <div className="field">
                  <label className="field__label">{t('settings.monoFont')}</label>
                  <div className="field__body">
                    <select
                      className="input"
                      value={monoFontIsCustom ? '__custom__' : draft.monoFont}
                      onChange={(e) => {
                        if (e.target.value === '__custom__') {
                          setMonoFontCustom(true)
                          return
                        }
                        setMonoFontCustom(false)
                        patch({ monoFont: e.target.value })
                      }}
                    >
                      {MONO_FONT_PRESETS.map((p) => (
                        <option key={p.value} value={p.value}>
                          {t(p.labelKey)}
                        </option>
                      ))}
                      <option value="__custom__">{t('settings.custom')}</option>
                    </select>
                    {monoFontIsCustom && (
                      <input
                        className="input field__sub"
                        value={draft.monoFont}
                        placeholder={t('settings.monoFontPlaceholder')}
                        onChange={(e) => patch({ monoFont: e.target.value })}
                        onBlur={() => {
                          if (!draft.monoFont.trim()) patch({ monoFont: DEFAULT_MONO_FONT })
                        }}
                      />
                    )}
                    <p className="field__hint">{t('settings.monoFontHint')}</p>
                  </div>
                </div>
              </section>

              <section className="chform chform--sep">
                <h2 className="chform__title">{t('settings.chat')}</h2>

                <div className="field">
                  <label className="field__label">{t('settings.showTimestamps')}</label>
                  <div className="field__body">
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={draft.showTimestamps}
                        onChange={(e) => patch({ showTimestamps: e.target.checked })}
                      />
                      <span>{draft.showTimestamps ? t('settings.showTimestamps.on') : t('settings.showTimestamps.off')}</span>
                    </label>
                    <p className="field__hint">{t('settings.showTimestampsHint')}</p>
                  </div>
                </div>

                <div className="field">
                  <label className="field__label">{t('settings.thinking')}</label>
                  <div className="field__body">
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={draft.thinkingOpen}
                        onChange={(e) => patch({ thinkingOpen: e.target.checked })}
                      />
                      <span>{draft.thinkingOpen ? t('settings.thinking.expand') : t('settings.thinking.collapse')}</span>
                    </label>
                    <p className="field__hint">
                      {t('settings.thinkingHint')}
                    </p>
                  </div>
                </div>

                <div className="field">
                  <label className="field__label">{t('settings.toolDetail')}</label>
                  <div className="field__body">
                    <select
                      className="input"
                      value={draft.toolDetail}
                      onChange={(e) => patch({ toolDetail: e.target.value as ToolDetail })}
                    >
                      {(Object.keys(TOOL_DETAIL_LABEL_KEY) as ToolDetail[]).map((d) => (
                        <option key={d} value={d}>
                          {t(TOOL_DETAIL_LABEL_KEY[d])}
                        </option>
                      ))}
                    </select>
                    <p className="field__hint">
                      {t('settings.toolDetailHint')}
                    </p>
                  </div>
                </div>
              </section>

              <section className="chform chform--sep">
                <h2 className="chform__title">{t('settings.input')}</h2>

                <div className="field">
                  <label className="field__label">{t('settings.sendKey')}</label>
                  <div className="field__body">
                    <select
                      className="input"
                      value={draft.sendKey}
                      onChange={(e) => patch({ sendKey: e.target.value as SendKey })}
                    >
                      {(Object.keys(SEND_KEY_LABEL_KEY) as SendKey[]).map((k) => (
                        <option key={k} value={k}>
                          {t(SEND_KEY_LABEL_KEY[k])}
                        </option>
                      ))}
                    </select>
                    <p className="field__hint">
                      {t('settings.sendKeyHint')}
                    </p>
                  </div>
                </div>
              </section>
            </>
          )}

          {page.kind === 'permissions' && (
            <section className="chform">
              <h2 className="chform__title">{t('settings.permissions')}</h2>
              <div className="field">
                <label className="field__label">{t('settings.permissionDefault')}</label>
                <div className="field__body">
                  <select
                    className="input"
                    value={draft.permissionMode}
                    onChange={(e) => patch({ permissionMode: e.target.value as PermissionMode })}
                  >
                    {PERMISSION_MODES.map((m) => (
                      <option key={m} value={m}>
                        {t(MODE_LABEL_KEY[m])} —— {t(MODE_HINT_KEY[m])}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </section>
          )}

          {page.kind === 'about' && <AboutPanel updater={updater} />}
        </div>
      </div>
    </main>
  )
}

/** 用户点过且还在列表里 → 用它；否则用该 CLI 的当前渠道；再否则用第一个 */
function resolveSelection(cfg: CliConfig, picked: string | null): string | null {
  if (picked && cfg.channels.some((c) => c.id === picked)) return picked
  if (cfg.activeChannelId && cfg.channels.some((c) => c.id === cfg.activeChannelId)) {
    return cfg.activeChannelId
  }
  return cfg.channels[0]?.id ?? null
}

function NavItem({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <button className={`settings__navitem ${active ? 'is-active' : ''}`} onClick={onClick}>
      {children}
    </button>
  )
}
