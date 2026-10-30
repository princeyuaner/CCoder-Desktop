/**
 * 枚举本机已安装的字体族。
 *
 * Chromium 没有「列出所有系统字体」的公开接口（Local Font Access API 还要
 * 用户逐次授权），所以只能在主进程按平台问系统要名单：
 * Windows 读字体注册表、macOS 问 system_profiler、Linux 用 fc-list。
 *
 * 结果在进程内缓存 —— 设置页每次打开都会来要，但字体在运行期间基本不变。
 * 枚举失败时回空数组，让设置页退回原来的预设列表，绝不阻塞设置页。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

let cached: string[] | null = null
let inflight: Promise<string[]> | null = null

export function listSystemFonts(): Promise<string[]> {
  if (cached) return Promise.resolve(cached)
  inflight ??= collect()
    .catch(() => [] as string[])
    .then((fonts) => {
      cached = fonts
      inflight = null
      return fonts
    })
  return inflight
}

async function collect(): Promise<string[]> {
  const raw =
    process.platform === 'win32'
      ? await windowsFontNames()
      : process.platform === 'darwin'
        ? await macFontNames()
        : await linuxFontNames()
  return normalizeFamilies(raw)
}

/* ── Windows ───────────────────────────────────────────────── */

/**
 * 走 PowerShell 而不是 `reg query`：注册表里的字体名可能是中文（宋体、微软雅黑），
 * 控制台默认按 OEM 代码页输出，Node 按 UTF-8 解码就会变成乱码。
 * 这里显式把输出编码钉成 UTF-8，再用 JSON 传回来，免得按行切分时踩到空格。
 */
const PS_FONT_SCRIPT = [
  '$out=@();',
  "foreach($k in @('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',",
  "'HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts')){",
  'if(Test-Path $k){$p=Get-ItemProperty $k;',
  "foreach($n in $p.PSObject.Properties){if($n.Name -notlike 'PS*'){$out+=$n.Name}}}};",
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
  'ConvertTo-Json -InputObject @($out) -Compress'
].join(' ')

async function windowsFontNames(): Promise<string[]> {
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_FONT_SCRIPT],
    { timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }
  )
  const parsed: unknown = JSON.parse(stdout.trim() || '[]')
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
}

/* ── macOS ─────────────────────────────────────────────────── */

async function macFontNames(): Promise<string[]> {
  const { stdout } = await run('system_profiler', ['SPFontsDataType'], {
    timeout: 20_000,
    maxBuffer: 32 * 1024 * 1024
  })
  const names: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s+Family:\s*(.+?)\s*$/.exec(line)
    if (m) names.push(m[1])
  }
  return names
}

/* ── Linux ─────────────────────────────────────────────────── */

async function linuxFontNames(): Promise<string[]> {
  const { stdout } = await run('fc-list', ['--format=%{family}\n'], {
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024
  })
  const names: string[] = []
  for (const line of stdout.split('\n')) {
    // fc-list 同一行可能用逗号列出同一个字体在多个语种下的家族名
    for (const part of line.split(',')) names.push(part)
  }
  return names
}

/* ── 归一化 ───────────────────────────────────────────────── */

/** 注册表名尾巴上的格式标注，如 `Arial (TrueType)`；`Courier 10,12,15 (120)` 这种老式点阵字体也在这里去掉后缀去重 */
const TYPE_SUFFIX = /\s*(?:\((?:TrueType|OpenType|Type 1|PostScript|CFF|All res)\)|\(\d+\))\s*$/i

/** 单个字重的入口（`Arial Bold`）应归并回家族名，否则列表里会有一堆重复项 */
const STYLE_SUFFIX =
  /(?:\s+(?:Bold|Italic|Oblique|Light|SemiLight|Semibold|SemiBold|DemiBold|Black|Heavy|Medium|Thin|ExtraLight|ExtraBold|Regular|Book))+$/i

/**
 * 图标字体 / emoji 字体不是给人看正文用的，选中也只会让界面变成一排方框。
 * 只按名字过滤已知的那几个 —— 宁可漏，也别误伤名字里恰好带 symbol 的正常字体。
 */
const NON_TEXT_FONT =
  /^\s*(?:Segoe (?:MDL2|Fluent) Assets|Fluent Icons|Material Icons|Material Symbols|Font Awesome|Marlett|Webdings|Wingdings|Symbol)\b/i

function normalizeFamilies(raw: string[]): string[] {
  const seen = new Map<string, string>()
  for (const item of raw) {
    const stripped = item.replace(TYPE_SUFFIX, '')
    // `Microsoft YaHei & Microsoft YaHei UI (TrueType)` 是同一份文件里的两个家族
    for (const half of stripped.split('&')) {
      const name = half.replace(STYLE_SUFFIX, '').replace(/\s+/g, ' ').trim()
      if (!name || name.startsWith('@') || NON_TEXT_FONT.test(name)) continue
      const key = name.toLowerCase()
      if (!seen.has(key)) seen.set(key, name)
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}
