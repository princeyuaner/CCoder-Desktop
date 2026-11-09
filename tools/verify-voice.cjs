/*
 * 语音输入自检：
 *   1. WAV 头 / 采样编码正确；
 *   2. 设置的默认值与非法输入归一化；
 *   3. OpenAI 兼容转写请求的 URL / Bearer / multipart 字段；
 *   4. 401 / 429 / 5xx / 纯文本响应的错误映射；
 *   5. 测试连接能走真实链路（本地假服务器）。
 *
 * 不碰真实服务商、不需要 Key、不访问麦克风。
 *
 * 用法（先 npx esbuild 打包，见 package.json 的 verify:voice）：
 *   node tools/verify-voice.cjs
 */
const assert = require('node:assert/strict')
const http = require('node:http')

const { transcribeVoice, testVoice } = require('../.tmp-build/voice-service.cjs')
const { normalizeVoiceSettings } = require('../.tmp-build/voice-shared.cjs')
const { encodeWavPcm16, silentWav } = require('../.tmp-build/voice-wav.cjs')

let passed = 0
const test = async (name, fn) => {
  await fn()
  passed++
  console.log('  ok', name)
}

const baseSettings = (over = {}) =>
  normalizeVoiceSettings({
    enabled: true,
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'test-key',
    model: 'test-model',
    ...over
  })

async function main() {
  console.log('══ WAV 编码 ══')
  await test('RIFF/WAVE 头、采样率、data 长度', () => {
    const samples = new Float32Array([0, 1, -1])
    const wav = encodeWavPcm16(samples, 16000)
    const view = new DataView(wav.buffer)
    assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF')
    assert.equal(String.fromCharCode(...wav.slice(8, 12)), 'WAVE')
    assert.equal(view.getUint32(24, true), 16000)
    assert.equal(view.getUint16(22, true), 1)
    assert.equal(view.getUint16(34, true), 16)
    assert.equal(view.getUint32(40, true), 6)
    assert.equal(wav.length, 44 + 6)
    assert.equal(view.getInt16(44, true), 0)
    assert.equal(view.getInt16(46, true), 0x7fff)
    assert.equal(view.getInt16(48, true), -0x8000)
  })
  await test('静音 WAV 长度符合 16k / 16bit / 单声道', () => {
    assert.equal(silentWav(0.1).length, 44 + 1600 * 2)
  })

  console.log('\n══ 设置归一化 ══')
  await test('空对象落到硅基流动默认值', () => {
    const v = normalizeVoiceSettings(undefined)
    assert.equal(v.enabled, true)
    assert.equal(v.provider, 'siliconflow')
    assert.equal(v.baseUrl, 'https://api.siliconflow.cn/v1')
    assert.equal(v.model, 'FunAudioLLM/SenseVoiceSmall')
    assert.equal(v.language, 'auto')
    assert.equal(v.insertMode, 'caret')
    assert.equal(v.autoSend, false)
  })
  await test('Groq 预设 + 非法字段回落', () => {
    const v = normalizeVoiceSettings({
      provider: 'groq',
      language: 'de',
      insertMode: 'other',
      autoSend: 'yes'
    })
    assert.equal(v.baseUrl, 'https://api.groq.com/openai/v1')
    assert.equal(v.model, 'whisper-large-v3-turbo')
    assert.equal(v.language, 'auto')
    assert.equal(v.insertMode, 'caret')
    assert.equal(v.autoSend, false)
  })
  await test('自定义服务商不套预设', () => {
    const v = normalizeVoiceSettings({ provider: 'custom' })
    assert.equal(v.baseUrl, '')
    assert.equal(v.model, '')
  })

  console.log('\n══ HTTP 链路 ══')
  let last = null
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      last = {
        url: req.url,
        auth: req.headers.authorization,
        type: req.headers['content-type'] || '',
        body
      }
      const json = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      if (req.url.startsWith('/401/')) return json(401, { error: { message: 'invalid key' } })
      if (req.url.startsWith('/429/')) return json(429, { error: { message: 'rate limit' } })
      if (req.url.startsWith('/500/')) return json(500, { error: { message: 'boom' } })
      if (req.url.startsWith('/text/')) {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('纯文本结果')
        return
      }
      json(200, { text: '你好，世界。' })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const at = (path) => `http://127.0.0.1:${port}${path}`

  try {
    await test('multipart：地址、Bearer、model、file 字段', async () => {
      const res = await transcribeVoice(
        baseSettings({ baseUrl: at('/v1'), language: 'zh' }),
        { data: silentWav(0.1), mime: 'audio/wav' }
      )
      assert.equal(res.ok, true)
      assert.equal(res.text, '你好，世界。')
      assert.equal(last.url, '/v1/audio/transcriptions')
      assert.equal(last.auth, 'Bearer test-key')
      assert.match(last.type, /^multipart\/form-data; boundary=/)
      assert.match(last.body, /name="model"\r\n\r\ntest-model/)
      assert.match(last.body, /name="file"; filename="audio.wav"/)
      assert.match(last.body, /name="language"\r\n\r\nzh/)
    })

    await test('baseUrl 已带 endpoint 时不重复拼接', async () => {
      const res = await transcribeVoice(
        baseSettings({ baseUrl: at('/v1/audio/transcriptions'), language: 'zh' }),
        { data: silentWav(0.1), mime: 'audio/wav' }
      )
      assert.equal(res.ok, true)
      assert.equal(last.url, '/v1/audio/transcriptions')
    })

    await test('纯文本响应也能解析', async () => {
      const res = await transcribeVoice(baseSettings({ baseUrl: at('/text/v1') }), {
        data: silentWav(0.1),
        mime: 'audio/wav'
      })
      assert.equal(res.ok, true)
      assert.equal(res.text, '纯文本结果')
    })

    await test('401 → unauthorized', async () => {
      const res = await transcribeVoice(baseSettings({ baseUrl: at('/401/v1') }), {
        data: silentWav(0.1),
        mime: 'audio/wav'
      })
      assert.equal(res.ok, false)
      assert.equal(res.error, 'unauthorized')
      assert.match(res.detail, /invalid key/)
    })

    await test('429 → rate-limit', async () => {
      const res = await transcribeVoice(baseSettings({ baseUrl: at('/429/v1') }), {
        data: silentWav(0.1),
        mime: 'audio/wav'
      })
      assert.equal(res.ok, false)
      assert.equal(res.error, 'rate-limit')
    })

    await test('500 → server', async () => {
      const res = await transcribeVoice(baseSettings({ baseUrl: at('/500/v1') }), {
        data: silentWav(0.1),
        mime: 'audio/wav'
      })
      assert.equal(res.ok, false)
      assert.equal(res.error, 'server')
    })

    await test('测试连接走同一链路', async () => {
      const res = await testVoice(baseSettings({ baseUrl: at('/v1') }))
      assert.equal(res.ok, true)
      assert.equal(typeof res.latencyMs, 'number')
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  console.log('\n══ 配置校验 ══')
  await test('关闭时直接拒绝', async () => {
    const res = await transcribeVoice(baseSettings({ enabled: false }), {
      data: silentWav(0.1),
      mime: 'audio/wav'
    })
    assert.equal(res.ok, false)
    assert.equal(res.error, 'disabled')
  })
  await test('缺 Key 时不发请求', async () => {
    const res = await transcribeVoice(baseSettings({ apiKey: '' }), {
      data: silentWav(0.1),
      mime: 'audio/wav'
    })
    assert.equal(res.ok, false)
    assert.equal(res.error, 'no-key')
  })
  await test('空音频拒绝', async () => {
    const res = await transcribeVoice(baseSettings(), {
      data: new Uint8Array(0),
      mime: 'audio/wav'
    })
    assert.equal(res.ok, false)
    assert.equal(res.error, 'empty')
  })

  console.log(`\n✅ ${passed} 项通过`)
}

main().catch((e) => {
  console.error('\n❌', e)
  process.exit(1)
})
