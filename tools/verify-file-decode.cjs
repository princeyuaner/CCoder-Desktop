/*
 * 拖入文件编码识别回归测试。
 *
 * 用法：
 *   npx esbuild src/renderer/src/text-decode.ts --bundle --platform=node --format=cjs \
 *     --alias:@shared=./src/shared --outfile=tools/_text-decode.cjs
 *   node tools/verify-file-decode.cjs
 *
 * 不碰磁盘、不启动 Electron：只断言字节 → 文本的识别顺序和解码结果。
 * 不参与打包。
 */
const assert = require('node:assert/strict')
const iconv = require('iconv-lite')
const { decodeTextBytes } = require('./_text-decode.cjs')

let passed = 0

function check(label, bytes, expected) {
  const got = decodeTextBytes(new Uint8Array(bytes))
  assert.ok(got, `${label}: expected text, got binary`)
  assert.equal(got.encoding, expected.encoding, `${label}: encoding`)
  if (expected.text !== undefined) {
    assert.equal(got.text, expected.text, `${label}: text`)
  }
  passed += 1
}

/* ── 确定性路径 ─────────────────────────────────────────── */

const utf8 = '你好，世界！\n第二行带 CRLF\r\n第三行\n'
check('utf8 / crlf 归一化', Buffer.from(utf8, 'utf8'), {
  encoding: 'utf8',
  text: '你好，世界！\n第二行带 CRLF\n第三行\n'
})

check('utf8 纯 ASCII', Buffer.from('hello world\n', 'ascii'), {
  encoding: 'utf8',
  text: 'hello world\n'
})

check(
  'utf8 BOM',
  Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('中文\n', 'utf8')]),
  { encoding: 'utf8bom', text: '中文\n' }
)

check(
  'utf16le BOM',
  Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode('中文 UTF-16LE\n', 'utf16-le')]),
  { encoding: 'utf16le', text: '中文 UTF-16LE\n' }
)

check(
  'utf16be BOM',
  Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode('中文 UTF-16BE\n', 'utf16-be')]),
  { encoding: 'utf16be', text: '中文 UTF-16BE\n' }
)

/* 无 BOM 的宽字符编码：旧实现会把 NUL 当二进制直接跳过 */
check(
  'utf16le 无 BOM（含中文）',
  iconv.encode('没有 BOM 的 UTF-16LE 文件\n第二行\n', 'utf16-le'),
  { encoding: 'utf16le', text: '没有 BOM 的 UTF-16LE 文件\n第二行\n' }
)

check(
  'utf16be 无 BOM（纯 ASCII）',
  iconv.encode('plain ascii in utf16be\n', 'utf16-be'),
  { encoding: 'utf16be', text: 'plain ascii in utf16be\n' }
)

check(
  'utf32le BOM',
  Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x00]), iconv.encode('UTF-32LE 文本\n', 'utf32-le')]),
  { encoding: 'utf32le', text: 'UTF-32LE 文本\n' }
)

check('空文件', Buffer.alloc(0), { encoding: 'utf8', text: '' })

/* ── 传统编码：chardet + TextDecoder ───────────────────── */

const zhText =
  '这是一段用于编码识别的中文文本。它包含常见的汉字和标点，' +
  '长度足够让统计式识别给出稳定的结果。\n第二行继续写一些内容，' +
  '确保样本不会因为太短而被误判。\n第三行：编码检测。\n'
check('GBK', iconv.encode(zhText, 'gbk'), { encoding: 'gbk', text: zhText })

const twText =
  '這是一段用來辨識編碼的繁體中文文字，包含常見的漢字與標點。' +
  '長度足夠讓統計式辨識給出穩定的結果。\n第二行繼續寫一些內容，' +
  '確保樣本不會因為太短而被誤判。\n第三行：編碼偵測。\n'
check('Big5', iconv.encode(twText, 'big5'), { encoding: 'big5', text: twText })

const jaText =
  'これは文字コード判定のための日本語テキストです。よく使われる漢字と' +
  'ひらがな、カタカナ、句読点を含んでいます。\n二行目にも文章を続けて、' +
  'サンプルが短すぎて誤判定されないようにしています。\n三行目：文字コード。\n'
check('Shift-JIS', iconv.encode(jaText, 'shiftjis'), { encoding: 'shiftjis', text: jaText })

const koText =
  '이것은 문자 인코딩 감지를 위한 한국어 텍스트입니다. 자주 쓰는 한글과 ' +
  '문장 부호를 포함하고 있습니다.\n두 번째 줄에도 내용을 이어서 샘플이 ' +
  '너무 짧아 잘못 판정되지 않도록 합니다.\n세 번째 줄: 인코딩 감지.\n'
check('EUC-KR', iconv.encode(koText, 'euckr'), { encoding: 'euckr', text: koText })

/* ── 截断与二进制 ───────────────────────────────────────── */

const cut = Buffer.from('中文内容', 'utf8')
check('UTF-8 末尾被截断半个字符', cut.subarray(0, cut.length - 1), {
  encoding: 'utf8',
  text: '中文内�'
})

const pngHeader = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00
])
assert.equal(decodeTextBytes(new Uint8Array(pngHeader)), null, 'PNG 头应判定为二进制')
passed += 1

const withNul = Buffer.from('正常文本\u0000后面还有内容', 'utf8')
assert.equal(decodeTextBytes(new Uint8Array(withNul)), null, '含 NUL 的普通文本应判定为二进制')
passed += 1

console.log(`verify-file-decode: ${passed} 项通过`)
