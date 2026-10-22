import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { PermissionMode } from '@shared/events'
import {
  CHAT_FONT_SIZES,
  CLIS,
  cliConfig,
  cliDef,
  DEFAULT_MONO_FONT,
  DEFAULT_UI_FONT,
  EFFORT_HINT,
  EFFORT_LABEL,
  EFFORT_LEVELS,
  MONO_FONT_PRESETS,
  newChannel,
  PROTOCOL_LABEL,
  SEND_KEY_LABEL,
  THEME_GROUPS,
  THEME_LABEL,
  TOOL_DETAIL_LABEL,
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
import { MODE_HINT, MODE_LABEL, PERMISSION_MODES } from '../constants'
import { applyAppearance } from '../appearance'
import { useSettings } from '../useSettings'
import { ChannelForm } from './ChannelForm'
import { IconChevronLeft, IconPlus } from './Icons'

/** 设置页的两类页面：某个 CLI 的渠道配置，或与 CLI 无关的系统设置 */
type Page = { kind: 'cli'; id: CliId } | { kind: 'general' } | { kind: 'permissions' }

export function SettingsPage({ onBack }: { onBack: () => void }): JSX.Element {
  const { settings, loading, save, test } = useSettings()
  const [page, setPage] = useState<Page>({ kind: 'cli', id: CLIS[0].id })

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

  /** 外观设置（主题/缩放/字号/字体）改一下预览一下，和落盘无关，立刻生效 */
  useEffect(() => {
    if (draft) applyAppearance(draft)
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
        void saveRef.current(pending)
        applyAppearance(pending)
      } else {
        applyAppearance(savedRef.current)
      }
    }
  }, [])

  const cliId = page.kind === 'cli' ? page.id : null
  const cfg = cliId && draft ? cliConfig(draft, cliId) : null
  const selectedId = cfg ? resolveSelection(cfg, picked) : null
  const selected = cfg?.channels.find((c) => c.id === selectedId) ?? null

  // 换 CLI / 换渠道时把上一次的测试结果收掉，免得张冠李戴
  useEffect(() => {
    setResult(null)
  }, [cliId, selectedId])

  if (!draft) return <main className="mainpane settings">加载中…</main>

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
    const c = newChannel(cliDef(cliId).protocol)
    const cur = cliConfig(draft, cliId)
    // 第一个渠道自动设为当前，省一次点击
    patchCli(cliId, { channels: [...cur.channels, c], activeChannelId: cur.activeChannelId ?? c.id })
    setPicked(c.id)
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
          返回
        </button>
        <h1 className="settings__title">设置</h1>
        <div className="settings__head-right">
          {saveState === 'error' ? (
            <>
              <span className="saved-flash saved-flash--error">保存失败</span>
              <button className="btn btn--ghost" onClick={() => void doAutoSave(draft)}>
                重试
              </button>
            </>
          ) : (
            <span className={`saved-flash ${saveState === 'saved' ? '' : 'is-busy'}`}>
              {saveState === 'saving'
                ? '保存中…'
                : saveState === 'saved'
                  ? '已自动保存'
                  : '修改后自动保存'}
            </span>
          )}
        </div>
      </header>

      <div className="settings__body">
        <nav className="settings__nav">
          <div className="settings__navgroup">系统</div>
          <NavItem active={page.kind === 'general'} onClick={() => setPage({ kind: 'general' })}>
            通用
          </NavItem>
          <NavItem active={page.kind === 'permissions'} onClick={() => setPage({ kind: 'permissions' })}>
            权限
          </NavItem>

          <div className="settings__navgroup">CLI</div>
          {CLIS.map((d) => (
            <NavItem
              key={d.id}
              active={page.kind === 'cli' && page.id === d.id}
              onClick={() => setPage({ kind: 'cli', id: d.id })}
            >
              {d.name}
              {!d.ready && <span className="settings__navtag">未接入</span>}
            </NavItem>
          ))}
        </nav>

        <div className="settings__content">
          {page.kind === 'cli' && cfg && (
            <>
              <div className="clipane">
                <div className="clipane__main">
                  <h2 className="clipane__title">{cliDef(page.id).name}</h2>
                  <p className="clipane__hint">
                    {PROTOCOL_LABEL[cliDef(page.id).protocol]}端点 · 渠道与其它 CLI 各自独立
                  </p>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={cfg.enabled}
                    onChange={(e) => patchCli(page.id, { enabled: e.target.checked })}
                  />
                  <span>{cfg.enabled ? '已启用' : '已停用'}</span>
                </label>
              </div>

              {!cliDef(page.id).ready && (
                <p className="clipane__todo">
                  这个 CLI 的适配器还没接入。渠道可以先配好存着 —— 接上就能直接用，不用重填。
                </p>
              )}

              <section className="chlist">
                <div className="chlist__head">
                  <span>渠道</span>
                  <button className="btn btn--ghost" onClick={addChannel}>
                    <IconPlus width={13} height={13} />
                    新建渠道
                  </button>
                </div>

                {cfg.channels.length === 0 && (
                  <p className="empty">
                    还没有渠道。新建一个，填入 Base URL、密钥和模型名即可开始 —— 无需登录。
                  </p>
                )}

                {cfg.channels.map((c) => (
                  <div
                    key={c.id}
                    className={`chlist__item ${c.id === selectedId ? 'is-active' : ''}`}
                  >
                    <button className="chlist__main" onClick={() => setPicked(c.id)}>
                      <span className="chlist__name">{c.name || '未命名渠道'}</span>
                      <span className="chlist__meta">{c.baseUrl || '未填 Base URL'}</span>
                    </button>
                    {c.id === cfg.activeChannelId ? (
                      <span className="badge badge--ok">使用中</span>
                    ) : (
                      <button
                        className="btn btn--ghost btn--xs"
                        onClick={() => patchCli(page.id, { activeChannelId: c.id })}
                      >
                        启用
                      </button>
                    )}
                  </div>
                ))}
              </section>

              {selected && (
                <ChannelForm
                  cli={page.id}
                  channel={selected}
                  active={selected.id === cfg.activeChannelId}
                  testing={testing}
                  result={result}
                  onChange={updateChannel}
                  onTest={() => void runTest()}
                  onDelete={() => deleteChannel(selected.id)}
                  onSetActive={() => patchCli(page.id, { activeChannelId: selected.id })}
                />
              )}

              {/* 加条分隔线：上面紧挨着渠道表单的「测试连接 / 删除渠道」按钮行，
                  不隔一下会被当成那排按钮的一部分 */}
              <section className="chform chform--sep">
                <h2 className="chform__title">思考深度</h2>
                <div className="field">
                  <label className="field__label">新会话默认</label>
                  <div className="field__body">
                    <div className="effpick">
                      {EFFORT_LEVELS.map((l) => (
                        <button
                          key={l}
                          className={`effpick__it ${l === cfg.effort ? 'is-on' : ''}`}
                          onClick={() => patchCli(page.id, { effort: l })}
                        >
                          <span className="effpick__n">{EFFORT_LABEL[l]}</span>
                          <span className="effpick__e">{l}</span>
                        </button>
                      ))}
                    </div>
                    <p className="field__hint">
                      {EFFORT_HINT[cfg.effort]}　对应 CLI 的 <code>--effort</code>。
                      会话里还能单独改，只影响那一条会话。
                    </p>
                  </div>
                </div>
              </section>
            </>
          )}

          {page.kind === 'general' && (
            <>
              <section className="chform">
                <h2 className="chform__title">工作区</h2>
                <div className="field">
                  <label className="field__label">默认工作目录</label>
                  <div className="field__body">
                    <input
                      className="input"
                      placeholder="留空 = 沿用上次打开的目录"
                      value={draft.defaultCwd}
                      onChange={(e) => patch({ defaultCwd: e.target.value })}
                    />
                    <p className="field__hint">
                      新会话默认在哪个项目目录里启动（决定会话归属哪个工作区）
                    </p>
                  </div>
                </div>
              </section>

              <section className="chform chform--sep">
                <h2 className="chform__title">外观</h2>

                <div className="field">
                  <label className="field__label">主题</label>
                  <div className="field__body">
                    <select
                      className="input"
                      value={draft.theme}
                      onChange={(e) => patch({ theme: e.target.value as ThemeMode })}
                    >
                      {THEME_GROUPS.map((g) => (
                        <optgroup key={g.label} label={g.label}>
                          {g.themes.map((t) => (
                            <option key={t} value={t}>
                              {THEME_LABEL[t]}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    <p className="field__hint">
                      主题只换配色，布局不变。「跟随系统」会随 Windows 的深浅色模式在深色 / 浅色之间切换。
                    </p>
                  </div>
                </div>

                <div className="field">
                  <label className="field__label">界面缩放</label>
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
                      缩放整个界面（含侧栏与设置页）。100% 为标准，觉得字小可以先调这个。
                    </p>
                  </div>
                </div>

                <div className="field">
                  <label className="field__label">对话字号</label>
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
                      影响对话正文、输入框和 Markdown；代码块会跟着小一档。
                    </p>
                  </div>
                </div>

                <div className="field">
                  <label className="field__label">界面字体</label>
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
                          {p.label}
                        </option>
                      ))}
                      <option value="__custom__">自定义…</option>
                    </select>
                    {uiFontIsCustom && (
                      <input
                        className="input field__sub"
                        value={draft.uiFont}
                        placeholder="CSS font-family，例如：My Font, Microsoft YaHei, sans-serif"
                        onChange={(e) => patch({ uiFont: e.target.value })}
                        onBlur={() => {
                          if (!draft.uiFont.trim()) patch({ uiFont: DEFAULT_UI_FONT })
                        }}
                      />
                    )}
                    <p className="field__hint">
                      选「自定义」可以直接填字体名或多个字体；没装的字体会自动回落到后面的备选。
                    </p>
                  </div>
                </div>

                <div className="field">
                  <label className="field__label">等宽字体</label>
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
                          {p.label}
                        </option>
                      ))}
                      <option value="__custom__">自定义…</option>
                    </select>
                    {monoFontIsCustom && (
                      <input
                        className="input field__sub"
                        value={draft.monoFont}
                        placeholder="CSS font-family，例如：Fira Code, Consolas, monospace"
                        onChange={(e) => patch({ monoFont: e.target.value })}
                        onBlur={() => {
                          if (!draft.monoFont.trim()) patch({ monoFont: DEFAULT_MONO_FONT })
                        }}
                      />
                    )}
                    <p className="field__hint">代码块、路径、工具输出用的字体。</p>
                  </div>
                </div>
              </section>

              <section className="chform chform--sep">
                <h2 className="chform__title">对话</h2>

                <div className="field">
                  <label className="field__label">显示消息时间</label>
                  <div className="field__body">
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={draft.showTimestamps}
                        onChange={(e) => patch({ showTimestamps: e.target.checked })}
                      />
                      <span>{draft.showTimestamps ? '显示' : '隐藏'}</span>
                    </label>
                    <p className="field__hint">在你自己发的每条消息下方显示发送时间。</p>
                  </div>
                </div>

                <div className="field">
                  <label className="field__label">思考过程</label>
                  <div className="field__body">
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={draft.thinkingOpen}
                        onChange={(e) => patch({ thinkingOpen: e.target.checked })}
                      />
                      <span>{draft.thinkingOpen ? '默认展开' : '默认折叠'}</span>
                    </label>
                    <p className="field__hint">
                      折叠时只显示一行摘要；展开后仍可逐条手动收起。
                    </p>
                  </div>
                </div>

                <div className="field">
                  <label className="field__label">工具调用</label>
                  <div className="field__body">
                    <select
                      className="input"
                      value={draft.toolDetail}
                      onChange={(e) => patch({ toolDetail: e.target.value as ToolDetail })}
                    >
                      {(Object.keys(TOOL_DETAIL_LABEL) as ToolDetail[]).map((d) => (
                        <option key={d} value={d}>
                          {TOOL_DETAIL_LABEL[d]}
                        </option>
                      ))}
                    </select>
                    <p className="field__hint">
                      「隐藏」只影响对话页；工具调用在「轨迹」页仍然完整可见。
                    </p>
                  </div>
                </div>
              </section>

              <section className="chform chform--sep">
                <h2 className="chform__title">输入</h2>

                <div className="field">
                  <label className="field__label">发送快捷键</label>
                  <div className="field__body">
                    <select
                      className="input"
                      value={draft.sendKey}
                      onChange={(e) => patch({ sendKey: e.target.value as SendKey })}
                    >
                      {(Object.keys(SEND_KEY_LABEL) as SendKey[]).map((k) => (
                        <option key={k} value={k}>
                          {SEND_KEY_LABEL[k]}
                        </option>
                      ))}
                    </select>
                    <p className="field__hint">
                      中文输入法组合期间按 Enter 不会误发送（输入法自身的候选确认不受影响）。
                    </p>
                  </div>
                </div>
              </section>
            </>
          )}

          {page.kind === 'permissions' && (
            <section className="chform">
              <h2 className="chform__title">权限</h2>
              <div className="field">
                <label className="field__label">新会话默认权限模式</label>
                <div className="field__body">
                  <select
                    className="input"
                    value={draft.permissionMode}
                    onChange={(e) => patch({ permissionMode: e.target.value as PermissionMode })}
                  >
                    {PERMISSION_MODES.map((m) => (
                      <option key={m} value={m}>
                        {MODE_LABEL[m]} —— {MODE_HINT[m]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </section>
          )}
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
