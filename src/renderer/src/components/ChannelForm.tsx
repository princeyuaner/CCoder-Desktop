import { useState, type ReactNode } from 'react'
import {
  cliDef,
  PROTOCOL_LABEL_KEY,
  type AuthMode,
  type Channel,
  type ChannelTestResult,
  type CliId,
  type EnvVar
} from '@shared/settings'
import { IconPlus } from './Icons'
import { useI18n } from '../i18n'

interface Props {
  /** 这条渠道属于哪个 CLI —— 协议、示例 URL、认证方式都由它决定 */
  cli: CliId
  channel: Channel
  onChange: (c: Channel) => void
  onTest: () => void
  onDelete: () => void
  onSetActive: () => void
  testing: boolean
  result: ChannelTestResult | null
  active: boolean
}

export function ChannelForm({
  cli,
  channel,
  onChange,
  onTest,
  onDelete,
  onSetActive,
  testing,
  result,
  active
}: Props): JSX.Element {
  const { t } = useI18n()
  const [reveal, setReveal] = useState(false)
  const set = <K extends keyof Channel>(k: K, v: Channel[K]): void =>
    onChange({ ...channel, [k]: v })

  const def = cliDef(cli)
  const anthropic = def.protocol === 'anthropic'
  const deepseek = def.protocol === 'deepseek'

  const setEnv = (i: number, patch: Partial<EnvVar>): void => {
    const next = channel.extraEnv.map((e, j) => (j === i ? { ...e, ...patch } : e))
    set('extraEnv', next)
  }

  return (
    <div className="chform">
      <div className="chform__head">
        <h2 className="chform__title">
          {channel.name || t('settings.channel.unnamed')}
        </h2>
        {active ? (
          <span className="badge badge--ok">{t('channel.current')}</span>
        ) : (
          <button className="btn btn--ghost" onClick={onSetActive}>
            {t('channel.setActive')}
          </button>
        )}
      </div>

      <Field label={t('channel.field.name')}>
        <input className="input" value={channel.name} onChange={(e) => set('name', e.target.value)} />
      </Field>

      <Field
        label={t('channel.field.protocol')}
        hint={t('channel.protocolHint', { protocol: t(PROTOCOL_LABEL_KEY[def.protocol]) })}
      >
        <input className="input" value={t(PROTOCOL_LABEL_KEY[def.protocol])} disabled />
      </Field>

      <Field
        label="Base URL"
        hint={
          anthropic
            ? t('channel.baseUrl.anthropicPlaceholder')
            : deepseek
              ? t('channel.baseUrl.dshPlaceholder')
              : t('channel.baseUrl.openaiPlaceholder')
        }
      >
        <input
          className="input"
          placeholder={
            anthropic
              ? t('channel.baseUrl.inputAnthropic')
              : deepseek
                ? t('channel.baseUrl.inputDsh')
                : t('channel.baseUrl.inputOpenai')
          }
          value={channel.baseUrl}
          onChange={(e) => set('baseUrl', e.target.value)}
        />
      </Field>

      {!anthropic && !deepseek && (
        <Field label={t('channel.modelProtocol.label')} hint={t('channel.modelProtocol.hint')}>
          <input className="input" value="Responses API" disabled />
        </Field>
      )}

      {deepseek && (
        <Field
          label={t('channel.modelProtocol.label')}
          hint={t('channel.modelProtocol.dshHint')}
        >
          <input
            className="input"
            value={t('channel.modelProtocol.dshLabel')}
            disabled
          />
        </Field>
      )}

      {deepseek ? (
        <Field label={t('channel.auth.label')} hint={t('channel.auth.hintDsh')}>
          <input
            className="input"
            value="Bearer Token (DEEPSEEK_API_KEY)"
            disabled
          />
        </Field>
      ) : (
        <Field
          label={t('channel.auth.label')}
          hint={
            anthropic
              ? t('channel.auth.hintAnthropic')
              : t('channel.auth.hintOpenai')
          }
        >
          <select
            className="input"
            value={channel.authMode}
            onChange={(e) => set('authMode', e.target.value as AuthMode)}
          >
            <option value="token">Bearer Token (Authorization: Bearer …)</option>
            <option value="key">API Key (x-api-key: …)</option>
          </select>
        </Field>
      )}

      <Field
        label={t('channel.key.label')}
        hint={
          anthropic
            ? t('channel.key.hintAnthropic')
            : deepseek
              ? t('channel.key.hintDsh')
              : t('channel.key.hintOpenai')
        }
      >
        <div className="input-row">
          <input
            className="input"
            type={reveal ? 'text' : 'password'}
            placeholder="sk-..."
            value={channel.authToken}
            onChange={(e) => set('authToken', e.target.value)}
          />
          <button className="btn btn--ghost" onClick={() => setReveal((r) => !r)}>
            {reveal ? t('channel.reveal.hide') : t('channel.reveal.show')}
          </button>
        </div>
      </Field>

      <Field label={t('channel.model.label')} hint={t('channel.model.hint')}>
        <ModelList channel={channel} onChange={onChange} />
      </Field>

      {anthropic && (
        <Field label={t('channel.fastModel.label')} hint={t('channel.fastModel.hint')}>
          <input
            className="input"
            value={channel.smallFastModel}
            onChange={(e) => set('smallFastModel', e.target.value)}
          />
        </Field>
      )}

      <Field label={t('channel.env.label')} hint={t('channel.env.hint')}>
        <div className="envlist">
          {channel.extraEnv.map((e, i) => (
            <div className="envlist__row" key={i}>
              <input
                className="input"
                placeholder="KEY"
                value={e.key}
                onChange={(ev) => setEnv(i, { key: ev.target.value })}
              />
              <input
                className="input"
                placeholder="value"
                value={e.value}
                onChange={(ev) => setEnv(i, { value: ev.target.value })}
              />
              <button
                className="iconbtn"
                title={t('channel.delete')}
                onClick={() => set('extraEnv', channel.extraEnv.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
          <button
            className="btn btn--ghost"
            onClick={() => set('extraEnv', [...channel.extraEnv, { key: '', value: '' }])}
          >
            <IconPlus width={13} height={13} />
            {t('channel.addEnv')}
          </button>
        </div>
      </Field>

      <div className="chform__actions">
        <button className="btn btn--primary" onClick={onTest} disabled={testing}>
          {testing ? t('channel.testing') : t('channel.test')}
        </button>
        <div className="chform__spacer" />
        <button className="btn btn--danger" onClick={onDelete}>
          {t('channel.deleteChannel')}
        </button>
      </div>

      {result && (
        <div className={`testresult ${result.ok ? 'is-ok' : 'is-fail'}`}>
          <div className="testresult__head">
            {result.ok ? t('channel.test.ok') : t('channel.test.fail')}
            <span className="testresult__latency">{result.latencyMs} ms</span>
          </div>
          <pre className="testresult__msg">{result.message}</pre>
        </div>
      )}
    </div>
  )
}

/**
 * 模型列表：默认模型就是第一行，其余行落在 Channel.models。
 *
 * 不另建一个 `defaultModel` 字段 —— 现有数据模型里 `model` 已经是默认模型，
 * 多一个字段只会让"当前用哪个"出现两个真相。
 */
function ModelList({
  channel,
  onChange
}: {
  channel: Channel
  onChange: (c: Channel) => void
}): JSX.Element {
  const { t } = useI18n()
  const rows = [channel.model, ...(channel.models ?? [])]

  const write = (next: string[]): void => {
    onChange({
      ...channel,
      model: next[0] ?? '',
      models: next.slice(1)
    })
  }

  const setRow = (i: number, value: string): void => {
    const next = rows.slice()
    next[i] = value
    write(next)
  }

  const setDefault = (i: number): void => {
    if (i === 0) return
    const next = rows.slice()
    const old = next[0]
    next[0] = next[i]
    next[i] = old
    write(next)
  }

  const add = (): void => write([...rows, ''])

  const remove = (i: number): void => {
    if (rows.length <= 1) return
    write(rows.filter((_, j) => j !== i))
  }

  return (
    <div className="modellist">
      {rows.map((m, i) => (
        <div className={`modelrow ${i === 0 ? 'is-default' : ''}`} key={i}>
          <input
            className="input"
            value={m}
            placeholder={t('channel.model.placeholder')}
            aria-label={t('channel.model.aria')}
            onChange={(e) => setRow(i, e.target.value)}
          />
          <label
            className="modelrow__default"
            title={
              i === 0
                ? t('channel.model.defaultTitle')
                : t('channel.model.setDefaultTitle')
            }
          >
            <input
              type="radio"
              name={`default-model-${channel.id}`}
              checked={i === 0}
              onChange={() => setDefault(i)}
            />
            <span className="when-on">{t('channel.model.default')}</span>
            <span className="when-off">{t('channel.model.setDefault')}</span>
          </label>
          <button
            type="button"
            className="iconbtn modelrow__del"
            aria-label={t('channel.model.deleteAria')}
            title={
              rows.length <= 1
                ? t('channel.model.keepOne')
                : t('channel.model.deleteTitle')
            }
            disabled={rows.length <= 1}
            onClick={() => remove(i)}
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className="btn modeladd" onClick={add}>
        <IconPlus width={13} height={13} />
        {t('channel.addModel')}
      </button>
    </div>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="field">
      <label className="field__label">{label}</label>
      <div className="field__body">
        {children}
        {hint && <p className="field__hint">{hint}</p>}
      </div>
    </div>
  )
}
