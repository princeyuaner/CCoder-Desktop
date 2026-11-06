/**
 * 拖进 / 选进输入框的文本文件解码。
 *
 * 为什么渲染层要自己识别一次编码：
 *  - 这条路径拿到的是 `File` 对象，字节已经在渲染进程里，没必要为了解码
 *    再走一趟 IPC；
 *  - 主进程的 `ide-fs.ts` 用 iconv-lite（依赖 Buffer），渲染层没有 Node API，
 *    但 Chromium 的 `TextDecoder` 原生支持 GBK / Big5 / Shift-JIS 等旧编码，
 *    足够覆盖拖入文件这一场景。
 *
 * 识别顺序和主进程保持一致（见 ide-fs.ts 的 `decodeAuto`）：
 * BOM → 无 BOM 的 UTF-16/32 → 严格 UTF-8 → chardet → GB18030。
 * 前两步是确定性的；chardet 只用于没有 BOM 的旧编码，置信度不够时先看
 * GB18030 能否干净解码，最后才采用 chardet 的弱候选。
 *
 * 返回值里的 `text` 已经统一成 `\n` 换行；调用方不需要再处理 CRLF。
 * 二进制（宽字符编码确认之前出现 NUL）返回 `null`。
 */
import chardet, { type AnalyseResult } from 'chardet'
import type { IdeEncoding } from '@shared/ide'

/** 自动识别时最多看 128KB；chardet 扫完整 512KB 要接近 1 秒 */
const DETECT_SAMPLE_BYTES = 128 * 1024
/** chardet 达到这个置信度就直接采用；低于它先看 GB18030 是否解得干净 */
const DETECT_MIN_CONFIDENCE = 50
/** 二进制探测只看前 8KB（和 git / grep 一个判据） */
const BINARY_HEAD_BYTES = 8192

/** IdeEncoding → WHATWG TextDecoder 的编码名；UTF-32 需要手工解码 */
const DECODER_LABEL: Record<IdeEncoding, string> = {
  utf8: 'utf-8',
  utf8bom: 'utf-8',
  gbk: 'gb18030',
  big5: 'big5',
  shiftjis: 'shift_jis',
  eucjp: 'euc-jp',
  euckr: 'euc-kr',
  utf16le: 'utf-16le',
  utf16be: 'utf-16be',
  // 占位：UTF-32 不走 TextDecoder
  utf32le: 'utf-8',
  utf32be: 'utf-8',
  windows1252: 'windows-1252',
  windows1251: 'windows-1251',
  windows1250: 'windows-1250',
  windows1253: 'windows-1253',
  windows1254: 'windows-1254',
  windows1255: 'windows-1255',
  windows1256: 'windows-1256',
  windows1257: 'windows-1257',
  windows1258: 'windows-1258',
  windows874: 'windows-874',
  iso88592: 'iso-8859-2',
  iso88595: 'iso-8859-5',
  iso88596: 'iso-8859-6',
  iso88597: 'iso-8859-7',
  iso88598: 'iso-8859-8',
  iso88599: 'iso-8859-9',
  koi8r: 'koi8-r'
}

/** chardet 的识别结果 → 应用里的编码名；空值表示这种编码暂不支持 */
const DETECTED_ENCODING: Record<string, IdeEncoding | undefined> = {
  ASCII: 'utf8',
  'UTF-8': 'utf8',
  'UTF-16LE': 'utf16le',
  'UTF-16BE': 'utf16be',
  'UTF-32LE': 'utf32le',
  'UTF-32BE': 'utf32be',
  GB18030: 'gbk',
  Big5: 'big5',
  Shift_JIS: 'shiftjis',
  'EUC-JP': 'eucjp',
  'EUC-KR': 'euckr',
  'windows-1250': 'windows1250',
  'windows-1251': 'windows1251',
  'windows-1252': 'windows1252',
  'windows-1253': 'windows1253',
  'windows-1254': 'windows1254',
  'windows-1255': 'windows1255',
  'windows-1256': 'windows1256',
  'windows-1257': 'windows1257',
  'windows-1258': 'windows1258',
  'windows-874': 'windows874',
  'ISO-8859-1': 'windows1252',
  'ISO-8859-2': 'iso88592',
  'ISO-8859-5': 'iso88595',
  'ISO-8859-6': 'iso88596',
  'ISO-8859-7': 'iso88597',
  'ISO-8859-8': 'iso88598',
  'ISO-8859-9': 'iso88599',
  'KOI8-R': 'koi8r'
}

export interface DecodedText {
  /** 统一 `\n` 换行 */
  text: string
  /** 实际采用的编码 */
  encoding: IdeEncoding
  /** 编码是猜出来的（而非 BOM / 严格 UTF-8 这类确定性判断） */
  guessed: boolean
}

interface BomInfo {
  encoding: IdeEncoding
  size: number
}

/** BOM 检查；UTF-32LE 的 BOM 以 FF FE 开头，必须排在 UTF-16LE 前面 */
function bomOf(bytes: Uint8Array): BomInfo | null {
  if (bytes.length >= 4) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0) {
      return { encoding: 'utf32le', size: 4 }
    }
    if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff) {
      return { encoding: 'utf32be', size: 4 }
    }
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf8bom', size: 3 }
  }
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: 'utf16le', size: 2 }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: 'utf16be', size: 2 }
  }
  return null
}

/** TextDecoder 不支持 UTF-32，这里手工按 4 字节单元解 */
function decodeUtf32(bytes: Uint8Array, littleEndian: boolean): string {
  const out: string[] = []
  let i = 0
  if (bytes.length >= 4) {
    const le = bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0
    const be = bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff
    if ((littleEndian && le) || (!littleEndian && be)) i = 4
  }
  for (; i + 3 < bytes.length; i += 4) {
    const cp = littleEndian
      ? (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0
      : ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0
    if (cp > 0x10ffff) {
      out.push('�')
      continue
    }
    try {
      out.push(String.fromCodePoint(cp))
    } catch {
      out.push('�')
    }
  }
  return out.join('')
}

/** 按指定编码解码；BOM 已由调用方按需跳过 */
function decodeBytes(bytes: Uint8Array, encoding: IdeEncoding): string {
  if (encoding === 'utf32le') return decodeUtf32(bytes, true)
  if (encoding === 'utf32be') return decodeUtf32(bytes, false)
  try {
    // ignoreBOM：BOM 跳过逻辑在 bomOf / 调用方，这里不要二次吞掉正文里的 U+FEFF
    return new TextDecoder(DECODER_LABEL[encoding], { ignoreBOM: true }).decode(bytes)
  } catch {
    // 运行时不认识这个 label（理论上不会）：别让一个旧文件拖垮整次拖入
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/**
 * 无 BOM 的 UTF-16 / UTF-32。
 *
 * 这类文件的高字节里大量出现 0。按 4 字节窗口统计 NUL 落在哪个位置，
 * 就能把 LE / BE 和 16 / 32 位区分开；再解码一小段确认不是二进制，
 * 避免把恰好带 NUL 的压缩包误判成文本。
 */
function guessWideNoBom(bytes: Uint8Array): IdeEncoding | null {
  const n = Math.min(bytes.length, 4096)
  if (n < 8) return null
  const count = [0, 0, 0, 0]
  let nul = 0
  for (let i = 0; i < n; i += 1) {
    if (bytes[i] === 0) {
      nul += 1
      count[i & 3] += 1
    }
  }
  if (nul / n < 0.25) return null
  const q = n / 4
  const high = (v: number): boolean => v > q * 0.7
  const low = (v: number): boolean => v < q * 0.2
  let encoding: IdeEncoding | null = null
  if (high(count[2]) && high(count[3]) && low(count[0])) encoding = 'utf32le'
  else if (high(count[0]) && high(count[1]) && low(count[3])) encoding = 'utf32be'
  else if (high(count[1]) && high(count[3]) && low(count[0]) && low(count[2])) {
    encoding = 'utf16le'
  } else if (high(count[0]) && high(count[2]) && low(count[1]) && low(count[3])) {
    encoding = 'utf16be'
  }
  /*
   * 中文较多的 UTF-16 里，汉字的高字节不为 0，NUL 只来自空格 / 标点 / 换行，
   * 上面 70% 的阈值可能两边都差一点。这里加一条更严格、但更宽松的兜底：
   * NUL 必须**只**落在一侧，另一侧一个都没有 —— UTF-32 的另一侧必然也有
   * NUL，二进制则通常四个位置都有，因此不会被误收。
   */
  if (!encoding) {
    if (count[0] === 0 && count[2] === 0) encoding = 'utf16le'
    else if (count[1] === 0 && count[3] === 0) encoding = 'utf16be'
  }
  if (!encoding) return null
  return plausibleDecode(bytes, encoding) ? encoding : null
}

/** 解码一小段，确认没有替换字符或大量控制字符 */
function plausibleDecode(bytes: Uint8Array, encoding: IdeEncoding): boolean {
  const unit = encoding === 'utf32le' || encoding === 'utf32be' ? 4 : 2
  const take = Math.min(bytes.length, 4096)
  const sample = bytes.subarray(0, take - (take % unit))
  if (sample.length === 0) return false
  const text = decodeBytes(sample, encoding)
  let bad = 0
  let chars = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    chars += 1
    if (code === 0xfffd) return false
    if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) bad += 1
  }
  return chars > 0 && bad / chars < 0.01
}

function hasNonAscii(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] >= 0x80) return true
  }
  return false
}

/**
 * 严格 UTF-8 校验。截断的大文件可能在末尾把一个多字节字符切成两半，
 * 这时允许丢掉最后 1–3 个字节再判断 —— 不能因此把 GBK 整篇当成 UTF-8。
 */
function isValidUtf8(bytes: Uint8Array): boolean {
  if (!hasNonAscii(bytes)) return true
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let cut = 0; cut <= 3 && cut < bytes.length; cut += 1) {
    try {
      decoder.decode(cut === 0 ? bytes : bytes.subarray(0, bytes.length - cut))
      return true
    } catch {
      // 继续尝试去掉结尾的不完整字符
    }
  }
  return false
}

/**
 * 取样做传统编码识别。
 *
 * 只有整篇不是合法 UTF-8 时才会走到这里；从第一个非 ASCII 字节附近取
 * 128KB，避免长段 ASCII 前缀让 chardet 只看到 ASCII。
 */
function detectionSample(bytes: Uint8Array): Uint8Array {
  if (bytes.length <= DETECT_SAMPLE_BYTES) return bytes
  let firstHigh = -1
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] >= 0x80) {
      firstHigh = i
      break
    }
  }
  const start =
    firstHigh < 0
      ? 0
      : Math.max(0, Math.min(firstHigh - 4096, bytes.length - DETECT_SAMPLE_BYTES))
  return bytes.subarray(start, start + DETECT_SAMPLE_BYTES)
}

/** 解码结果里是否有替换字符或不可打印控制符 */
function hasBadChars(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0xfffd) return true
    if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) return true
  }
  return false
}

function detectLegacyEncoding(bytes: Uint8Array): {
  strong: IdeEncoding | null
  weak: IdeEncoding | null
} {
  let matches: AnalyseResult
  try {
    matches = chardet.analyse(detectionSample(bytes))
  } catch {
    return { strong: null, weak: null }
  }
  let weak: IdeEncoding | null = null
  for (const match of matches) {
    const encoding = DETECTED_ENCODING[match.name]
    if (!encoding) continue
    if (!weak) weak = encoding
    if (match.confidence >= DETECT_MIN_CONFIDENCE) {
      return { strong: encoding, weak }
    }
  }
  return { strong: null, weak }
}

/** 出口统一换行，调用方拿到的正文永远是 `\n` */
function done(text: string, encoding: IdeEncoding, guessed: boolean): DecodedText {
  return { text: text.replace(/\r\n?/g, '\n'), encoding, guessed }
}

/** 头 8KB 里出现 NUL；宽字符编码会在更早的步骤里被认出来，不会走到这里 */
function headHasNul(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, BINARY_HEAD_BYTES)
  for (let i = 0; i < n; i += 1) if (bytes[i] === 0) return true
  return false
}

/**
 * 字节 → 文本。返回 `null` 表示看起来是二进制，调用方应跳过这个文件。
 *
 * 和主进程 `decodeAuto` 的唯一区别是解码后端（TextDecoder vs iconv-lite），
 * 识别顺序与阈值保持一致，避免同一个文件在 IDE 和输入框里显示成两种样子。
 */
export function decodeTextBytes(bytes: Uint8Array): DecodedText | null {
  if (bytes.length === 0) return done('', 'utf8', false)

  const bom = bomOf(bytes)
  if (bom) {
    return done(decodeBytes(bytes.subarray(bom.size), bom.encoding), bom.encoding, false)
  }

  const wide = guessWideNoBom(bytes)
  if (wide) return done(decodeBytes(bytes, wide), wide, true)

  if (headHasNul(bytes)) return null
  if (isValidUtf8(bytes)) return done(decodeBytes(bytes, 'utf8'), 'utf8', false)

  const { strong, weak } = detectLegacyEncoding(bytes)
  if (strong) return done(decodeBytes(bytes, strong), strong, true)
  const gbkText = decodeBytes(bytes, 'gbk')
  if (!hasBadChars(gbkText)) return done(gbkText, 'gbk', true)
  if (weak) {
    const text = decodeBytes(bytes, weak)
    if (!hasBadChars(text)) return done(text, weak, true)
  }
  return done(gbkText, 'gbk', true)
}
