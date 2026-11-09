import { useEffect, useState } from 'react'
import type { MessageKey } from '@shared/i18n/catalog'
import {
  VOICE_ERROR_KEY,
  VOICE_PRESETS,
  type VoiceProvider,
  type VoiceSettings
} from '@shared/voice'
import { useI18n } from '../i18n'

const PROVIDERS: {
  id: VoiceProvider
  icon: string
  badgeKey: MessageKey
  descKey: MessageKey
}[] = [
  {
    id: 'siliconflow',
    icon: 'SF',
    badgeKey: 'voice.provider.free',
    descKey: 'voice.provider.siliconflowDesc'
  },
  {
    id: 'groq',
    icon: 'GQ',
    badgeKey: 'voice.provider.quota',
    descKey: 'voice.provider.groqDesc'
  },
  {
    id: 'custom',
    icon: '{ }',
    badgeKey: 'voice.provider.customBadge',
    descKey: 'voice.provider.customDesc'
  }
]

const PROVIDER_LABEL: Record<VoiceProvider, MessageKey> = {
  siliconflow: 'voice.provider.siliconflow',
  groq: 'voice.provider.groq',
  custom: 'voice.provider.custom'
}

const KEY_PAGE: Record<Exclude<VoiceProvider, 'custom'>, string> = {
  siliconflow: 'https://cloud.siliconflow.cn/account/ak',
  groq: 'https://console.groq.com/keys'
}

/**
 * 设置 → 系统 → 语音输入。
 *
 * 只做云端 OpenAI 兼容接口。服务商预设只填地址和模型，Key 始终由用户自己
 * 保管；地址和模型都可手改，免费政策变了也不用改代码。
 */
export function VoiceSettingsPanel({
  value,
  onChange
}: {
  value: VoiceSettings
  onChange: (next: VoiceSettings) => void
}): JSX.Element {
  const { t } = useI18n()
  const [reveal, setReveal] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{
    ok: boolean
    text: string
  } | null>(null)

  const patch = (p: Partial<VoiceSettings>): void => onChange({ ...value, ...p })

  // 改了地址 / Key / 模型之后，上一次的「连接正常」就不再作数
  useEffect(() => {
    setTestResult(null)
  }, [value.provider, value.baseUrl, value.apiKey, value.model])

  const pickProvider = (provider: VoiceProvider): void => {
    if (provider === 'custom') {
      patch({ provider })
      return
    }
    const preset = VOICE_PRESETS[provider]
    patch({ provider, baseUrl: preset.baseUrl, model: preset.model })
  }

  const openKeyPage = (): void => {
    if (value.provider === 'custom') return
    window.open(KEY_PAGE[value.provider], '_blank', 'noopener')
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await window.api?.voice.test(value)
      if (!res) {
        setTestResult({ ok: false, text: t('voice.error.unsupported') })
        return
      }
      if (res.ok) {
        setTestResult({ ok: true, text: t('voice.conn.testOk', { ms: res.latencyMs }) })
      } else {
        const base = t(VOICE_ERROR_KEY[res.error])
        setTestResult({
          ok: false,
          text: res.detail ? `${base} · ${res.detail}` : base
        })
      }
    } catch {
      setTestResult({ ok: false, text: t('voice.error.network') })
    } finally {
      setTesting(false)
    }
  }

  return (
    <>
      <div className="voice-head">
        <h2 className="voice-title">{t('voice.title')}</h2>
        <p className="voice-lead">{t('voice.lead')}</p>
      </div>

      <section className="chform">
        <div className="voice-enable">
          <div className="voice-enable__main">
            <h3 className="chform__title">{t('voice.enable.title')}</h3>
            <p className="field__hint">{t('voice.enable.hint')}</p>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={value.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
          </label>
        </div>
      </section>

      <section className="chform chform--sep">
        <div className="voice-section-head">
          <h3 className="chform__title">{t('voice.provider.title')}</h3>
        </div>
        <p className="field__hint voice-provider-lead">{t('voice.provider.lead')}</p>
        <div className="voice-providers">
          {PROVIDERS.map((p) => {
            const active = value.provider === p.id
            const model =
              p.id === 'custom'
                ? t('voice.provider.customModel')
                : VOICE_PRESETS[p.id].model
            return (
              <button
                type="button"
                key={p.id}
                className={`voice-provider${active ? ' is-on' : ''}${
                  p.id === 'custom' ? ' is-wide' : ''
                }`}
                aria-pressed={active}
                onClick={() => pickProvider(p.id)}
              >
                <span className="voice-provider__radio" />
                <span className="voice-provider__top">
                  <span className="voice-provider__ico">{p.icon}</span>
                  <span className="voice-provider__name">{t(PROVIDER_LABEL[p.id])}</span>
                  <span
                    className={`voice-provider__badge is-${p.id === 'groq' ? 'quota' : p.id}`}
                  >
                    {t(p.badgeKey)}
                  </span>
                </span>
                <span className="voice-provider__model">{model}</span>
                <span className="voice-provider__desc">{t(p.descKey)}</span>
              </button>
            )
          })}
        </div>
        <p className="field__hint">{t('voice.provider.freeNote')}</p>
      </section>

      <section className="chform chform--sep">
        <div className="voice-section-head">
          <h3 className="chform__title">{t('voice.conn.title')}</h3>
          <span className="voice-saved">{t('voice.conn.autoSave')}</span>
        </div>

        <div className="field">
          <label className="field__label">{t('voice.conn.baseUrl')}</label>
          <div className="field__body">
            <input
              className="input"
              value={value.baseUrl}
              spellCheck={false}
              onChange={(e) => patch({ baseUrl: e.target.value })}
            />
            <p className="field__hint">{t('voice.conn.baseUrlHint')}</p>
          </div>
        </div>

        <div className="field">
          <label className="field__label">{t('voice.conn.apiKey')}</label>
          <div className="field__body">
            <div className="input-row">
              <input
                className="input"
                type={reveal ? 'text' : 'password'}
                value={value.apiKey}
                spellCheck={false}
                autoComplete="off"
                placeholder="sk-..."
                onChange={(e) => patch({ apiKey: e.target.value })}
              />
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setReveal((v) => !v)}
              >
                {reveal ? t('voice.conn.hide') : t('voice.conn.show')}
              </button>
            </div>
            <p className="field__hint">
              {t('voice.conn.keyHint')}
              {value.provider !== 'custom' && (
                <>
                  {' '}
                  <button type="button" className="voice-link" onClick={openKeyPage}>
                    {t('voice.conn.getKey')} ↗
                  </button>
                </>
              )}
            </p>
          </div>
        </div>

        <div className="field">
          <label className="field__label">{t('voice.conn.model')}</label>
          <div className="field__body">
            <input
              className="input"
              value={value.model}
              spellCheck={false}
              onChange={(e) => patch({ model: e.target.value })}
            />
            <p className="field__hint">{t('voice.conn.modelHint')}</p>
          </div>
        </div>

        <div className="field">
          <label className="field__label" />
          <div className="field__body voice-testrow">
            <button
              type="button"
              className="btn btn--primary"
              disabled={testing}
              onClick={() => void test()}
            >
              {testing ? t('voice.conn.testing') : t('voice.conn.test')}
            </button>
            {testResult && (
              <span
                className={`voice-testmsg ${testResult.ok ? 'is-ok' : 'is-err'}`}
                title={testResult.text}
              >
                {testResult.ok ? '✓ ' : '! '}
                {testResult.text}
              </span>
            )}
          </div>
        </div>
      </section>

      <section className="chform chform--sep">
        <div className="voice-section-head">
          <h3 className="chform__title">{t('voice.recog.title')}</h3>
        </div>

        <div className="field">
          <label className="field__label">{t('voice.recog.language')}</label>
          <div className="field__body">
            <select
              className="input"
              value={value.language}
              onChange={(e) =>
                patch({ language: e.target.value as VoiceSettings['language'] })
              }
            >
              <option value="auto">{t('voice.recog.languageAuto')}</option>
              <option value="zh">{t('voice.recog.languageZh')}</option>
              <option value="en">{t('voice.recog.languageEn')}</option>
            </select>
            <p className="field__hint">{t('voice.recog.languageHint')}</p>
          </div>
        </div>

        <div className="field">
          <label className="field__label">{t('voice.recog.insert')}</label>
          <div className="field__body">
            <div className="voice-seg">
              <button
                type="button"
                className={value.insertMode === 'caret' ? 'is-on' : ''}
                onClick={() => patch({ insertMode: 'caret' })}
              >
                {t('voice.recog.insertCaret')}
              </button>
              <button
                type="button"
                className={value.insertMode === 'append' ? 'is-on' : ''}
                onClick={() => patch({ insertMode: 'append' })}
              >
                {t('voice.recog.insertAppend')}
              </button>
            </div>
            <p className="field__hint">{t('voice.recog.insertHint')}</p>
          </div>
        </div>

        <div className="field">
          <label className="field__label">{t('voice.recog.autoSend')}</label>
          <div className="field__body">
            <label className="switch">
              <input
                type="checkbox"
                checked={value.autoSend}
                onChange={(e) => patch({ autoSend: e.target.checked })}
              />
              <span>{t('voice.recog.autoSendLabel')}</span>
            </label>
            <p className="field__hint voice-warn-hint">
              {t('voice.recog.autoSendHint')}
            </p>
          </div>
        </div>

        <div className="field">
          <label className="field__label">{t('voice.recog.hotkey')}</label>
          <div className="field__body voice-keyrow">
            <kbd>Ctrl</kbd>
            <span>+</span>
            <kbd>Shift</kbd>
            <span>+</span>
            <kbd>M</kbd>
            <span className="voice-keyrow__hint">{t('voice.recog.hotkeyHint')}</span>
          </div>
        </div>
      </section>

      <section className="chform chform--sep">
        <div className="voice-privacy">
          <span className="voice-privacy__ico">
            <svg
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M8 1.8 13.2 4v4.2c0 3.2-2.2 5.4-5.2 6-3-.6-5.2-2.8-5.2-6V4z" />
            </svg>
          </span>
          <div>
            <b>{t('voice.privacy.title')}</b>
            <p>{t('voice.privacy.body')}</p>
          </div>
        </div>
      </section>
    </>
  )
}
