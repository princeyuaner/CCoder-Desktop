/*
 * 验证设置的加密落盘往返。这是最容易悄悄出错的一条链路：
 * 加密失败、编码错、原子改名出错，都会让用户的密钥丢失或损坏。
 *
 * 顺带验证 v1 → v2 的迁移：v1 的渠道是全局的，v2 挂在 clis.claude 下。
 * 迁移写错就是"用户升级后渠道全没了"，必须有用例守着。
 *
 * 用法：先 esbuild 打包 settings-store，再 electron tools/verify-settings.cjs
 * 不参与打包，随时可删。
 */
const { app, safeStorage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

// 用临时目录，绝不碰用户真实的 settings.json
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-verify-'))
app.setPath('userData', dir)

const { loadSettings, saveSettings } = require('./_settings-store.cjs')

const SECRET = 'sk-super-secret-abcdef123456'
const SECRET2 = 'sk-codex-secret-987654321'

function fail(msg) {
  console.error('FAIL:', msg)
  app.exit(1)
}

function channel(id, name, token) {
  return {
    id,
    name,
    kind: 'anthropic',
    baseUrl: 'https://example.test/anthropic/',
    model: 'm-1',
    smallFastModel: '',
    authMode: 'token',
    authToken: token,
    extraEnv: [{ key: 'HTTP_PROXY', value: 'http://127.0.0.1:1' }]
  }
}

app.whenReady().then(() => {
  console.log('userData =', dir)
  console.log('safeStorage 可用 =', safeStorage.isEncryptionAvailable())

  const demo = {
    clis: {
      claude: {
        enabled: true,
        activeChannelId: 'c1',
        channels: [channel('c1', '测试渠道', SECRET)]
      },
      codex: {
        enabled: false,
        activeChannelId: 'x1',
        channels: [channel('x1', 'OpenAI 中转', SECRET2)]
      }
    },
    permissionMode: 'acceptEdits',
    defaultCwd: 'C:/proj',
    theme: 'light',
    uiZoom: 1.1,
    chatFontSize: 16,
    uiFont: 'My UI Font, sans-serif',
    monoFont: 'My Mono Font, monospace',
    showTimestamps: true,
    thinkingOpen: true,
    toolDetail: 'compact',
    sendKey: 'ctrlEnter'
  }

  saveSettings(demo)

  // 1) 磁盘上不能出现明文密钥（两个 CLI 的都不能）
  const onDisk = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')
  if (onDisk.includes(SECRET)) fail('claude 的密钥以明文写进了 settings.json')
  if (onDisk.includes(SECRET2)) fail('codex 的密钥以明文写进了 settings.json')
  console.log('PASS 磁盘无明文密钥')

  // 2) 加密可用时，落盘必须是加密态；且渠道必须挂在 clis 下（v2 形态）
  const parsed = JSON.parse(onDisk)
  if (parsed.channels) fail('落盘仍是 v1 的扁平 channels')
  const secretField = parsed.clis.claude.channels[0].secret
  if (safeStorage.isEncryptionAvailable() && secretField.v !== 1) {
    fail(`safeStorage 可用但落盘是明文降级 (v=${secretField.v})`)
  }
  console.log('PASS 落盘形态 v =', secretField.v)

  // 3) 读回来必须逐字段一致
  const back = loadSettings()
  const c = back.clis.claude.channels[0]
  const checks = [
    ['authToken', c.authToken, SECRET],
    ['baseUrl', c.baseUrl, 'https://example.test/anthropic/'],
    ['model', c.model, 'm-1'],
    ['name', c.name, '测试渠道'],
    ['authMode', c.authMode, 'token'],
    ['activeChannelId', back.clis.claude.activeChannelId, 'c1'],
    ['codex 密钥', back.clis.codex.channels[0].authToken, SECRET2],
    ['codex activeChannelId', back.clis.codex.activeChannelId, 'x1'],
    ['codex enabled', back.clis.codex.enabled, false],
    ['permissionMode', back.permissionMode, 'acceptEdits'],
    ['defaultCwd', back.defaultCwd, 'C:/proj'],
    ['extraEnv[0].key', c.extraEnv[0].key, 'HTTP_PROXY'],
    // 外观 / 对话 / 输入：漏写任何一个，重启后都会悄悄回到默认值
    ['theme', back.theme, 'light'],
    ['uiZoom', back.uiZoom, 1.1],
    ['chatFontSize', back.chatFontSize, 16],
    ['uiFont', back.uiFont, 'My UI Font, sans-serif'],
    ['monoFont', back.monoFont, 'My Mono Font, monospace'],
    ['showTimestamps', back.showTimestamps, true],
    ['thinkingOpen', back.thinkingOpen, true],
    ['toolDetail', back.toolDetail, 'compact'],
    ['sendKey', back.sendKey, 'ctrlEnter']
  ]
  for (const [label, got, want] of checks) {
    if (got !== want) fail(`${label}: 期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`)
  }
  console.log('PASS 往返一致（21 个字段）')

  // 4) 两个 CLI 的渠道必须互不串门
  if (back.clis.claude.channels.length !== 1 || back.clis.codex.channels.length !== 1) {
    fail('两个 CLI 的渠道列表串了')
  }
  if (back.clis.claude.channels[0].id === back.clis.codex.channels[0].id) {
    fail('两个 CLI 拿到了同一个渠道')
  }
  console.log('PASS 渠道按 CLI 隔离')

  // 5) 重复保存要幂等
  saveSettings(back)
  const again = loadSettings()
  if (again.clis.claude.channels[0].authToken !== SECRET) fail('二次保存后密钥丢失')
  if (again.clis.codex.channels[0].authToken !== SECRET2) fail('二次保存后 codex 密钥丢失')
  console.log('PASS 重复保存幂等')

  // 6) v1 → v2 迁移：老的扁平格式读进来必须落到 clis.claude，且密钥能解开
  const old = channel('old-1', '老渠道', SECRET)
  delete old.authToken
  old.secret = safeStorage.isEncryptionAvailable()
    ? { v: 1, enc: safeStorage.encryptString(SECRET).toString('base64') }
    : { v: 0, plain: SECRET }
  const v1 = {
    activeChannelId: 'old-1',
    permissionMode: 'plan',
    defaultCwd: 'C:/old',
    channels: [old]
  }
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(v1), 'utf8')
  const migrated = loadSettings()
  if (migrated.clis.claude.channels.length !== 1) fail('v1 渠道没有迁移到 clis.claude')
  if (migrated.clis.claude.channels[0].authToken !== SECRET) fail('v1 迁移后密钥丢失')
  if (migrated.clis.claude.activeChannelId !== 'old-1') fail('v1 的 activeChannelId 没有迁移')
  if (migrated.permissionMode !== 'plan') fail('v1 的 permissionMode 没有迁移')
  if (migrated.clis.codex.channels.length !== 0) fail('迁移凭空造出了 codex 渠道')
  // 老文件没有外观字段 —— 必须回落到「保持原来的深色外观」
  if (migrated.theme !== 'dark' || migrated.uiZoom !== 1 || migrated.chatFontSize !== 14) {
    fail('v1 迁移后的外观默认值不对')
  }
  if (migrated.toolDetail !== 'full' || migrated.sendKey !== 'enter' || migrated.thinkingOpen) {
    fail('v1 迁移后的对话 / 输入默认值不对')
  }
  console.log('PASS v1 → v2 迁移')

  // 7) 坏文件不能导致崩溃
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ this is not json')
  const recovered = loadSettings()
  if (recovered.clis.claude.channels.length !== 0) fail('坏文件没有回退到默认值')
  if (!recovered.clis.codex) fail('坏文件回退后 codex 配置缺失')
  console.log('PASS 坏文件回退默认值')

  console.log('\n全部通过 ✓')
  app.exit(0)
})
