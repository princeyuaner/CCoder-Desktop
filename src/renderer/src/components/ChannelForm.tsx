import { useState, type ReactNode } from 'react'
import {
  cliDef,
  PROTOCOL_LABEL,
  type AuthMode,
  type Channel,
  type ChannelTestResult,
  type CliId,
  type EnvVar
} from '@shared/settings'
import { IconPlus } from './Icons'

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
  const [reveal, setReveal] = useState(false)
  const set = <K extends keyof Channel>(k: K, v: Channel[K]): void =>
    onChange({ ...channel, [k]: v })

  const def = cliDef(cli)
  const anthropic = def.protocol === 'anthropic'

  const setEnv = (i: number, patch: Partial<EnvVar>): void => {
    const next = channel.extraEnv.map((e, j) => (j === i ? { ...e, ...patch } : e))
    set('extraEnv', next)
  }

  return (
    <div className="chform">
      <div className="chform__head">
        <h2 className="chform__title">{channel.name || '未命名渠道'}</h2>
        {active ? (
          <span className="badge badge--ok">当前使用</span>
        ) : (
          <button className="btn btn--ghost" onClick={onSetActive}>
            设为当前
          </button>
        )}
      </div>

      <Field label="名称">
        <input className="input" value={channel.name} onChange={(e) => set('name', e.target.value)} />
      </Field>

      <Field label="协议类型" hint={`由所属 CLI 决定 —— 它只认${PROTOCOL_LABEL[def.protocol]}端点`}>
        <input className="input" value={PROTOCOL_LABEL[def.protocol]} disabled />
      </Field>

      <Field
        label="Base URL"
        hint={
          anthropic
            ? '例：https://api.deepseek.com/anthropic —— 末尾斜杠会被自动去掉'
            : '例：https://api.openai.com/v1 —— 末尾斜杠会被自动去掉'
        }
      >
        <input
          className="input"
          placeholder={anthropic ? 'https://…/anthropic' : 'https://…/v1'}
          value={channel.baseUrl}
          onChange={(e) => set('baseUrl', e.target.value)}
        />
      </Field>

      <Field
        label="认证方式"
        hint={
          anthropic
            ? '选错会一直 401：多数中转网关用 Bearer，Anthropic 官方用 x-api-key'
            : 'OpenAI 兼容端点一律用 Bearer（Authorization: Bearer …）'
        }
      >
        <select
          className="input"
          value={channel.authMode}
          onChange={(e) => set('authMode', e.target.value as AuthMode)}
        >
          <option value="token">Bearer Token（Authorization: Bearer …）</option>
          <option value="key">API Key（x-api-key: …）</option>
        </select>
      </Field>

      <Field label="密钥 / Token" hint="保存在本机，用系统级加密（Windows DPAPI）">
        <div className="input-row">
          <input
            className="input"
            type={reveal ? 'text' : 'password'}
            placeholder="sk-..."
            value={channel.authToken}
            onChange={(e) => set('authToken', e.target.value)}
          />
          <button className="btn btn--ghost" onClick={() => setReveal((r) => !r)}>
            {reveal ? '隐藏' : '显示'}
          </button>
        </div>
      </Field>

      <Field label="模型" hint="填该端点认的模型名，会以 --model 传给 CLI">
        <input
          className="input"
          placeholder="deepseek-chat"
          value={channel.model}
          onChange={(e) => set('model', e.target.value)}
        />
      </Field>

      <Field
        label="可选模型（可选）"
        hint="一行一个。会出现在会话里的模型选择器里；留空则只能手填。"
      >
        <textarea
          className="input"
          rows={3}
          placeholder={'deepseek-chat\ndeepseek-reasoner'}
          value={(channel.models ?? []).join('\n')}
          // 不 filter 掉空行 —— 一过滤，按回车产生的那一行立刻消失，就再也换不了行了
          onChange={(e) => set('models', e.target.value.split('\n'))}
        />
      </Field>

      <Field label="快模型（可选）" hint="后台小任务用；留空则不注入">
        <input
          className="input"
          value={channel.smallFastModel}
          onChange={(e) => set('smallFastModel', e.target.value)}
        />
      </Field>

      <Field label="额外环境变量" hint="原样注入 CLI 进程，如 HTTP_PROXY">
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
                title="删除"
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
            添加变量
          </button>
        </div>
      </Field>

      <div className="chform__actions">
        <button className="btn btn--primary" onClick={onTest} disabled={testing}>
          {testing ? '测试中…' : '测试连接'}
        </button>
        <div className="chform__spacer" />
        <button className="btn btn--danger" onClick={onDelete}>
          删除渠道
        </button>
      </div>

      {result && (
        <div className={`testresult ${result.ok ? 'is-ok' : 'is-fail'}`}>
          <div className="testresult__head">
            {result.ok ? '✓ 连接正常' : '✗ 连接失败'}
            <span className="testresult__latency">{result.latencyMs} ms</span>
          </div>
          <pre className="testresult__msg">{result.message}</pre>
        </div>
      )}
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
