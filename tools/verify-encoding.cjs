#!/usr/bin/env node
/**
 * IDE 编码自动检测 / 写回的验证。
 *
 * 先打包主进程模块：
 *   npx esbuild src/main/ide-fs.ts --bundle --platform=node --format=cjs \
 *     --outfile=tools/_ide-fs.cjs
 *   node tools/verify-encoding.cjs
 *
 * 不启动 Electron。临时目录放在仓库的 .tmp-build 下，避免 Windows 上
 * 某些环境对系统临时目录的权限限制。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const iconv = require('iconv-lite')
const { readTextFile, saveTextFile } = require('./_ide-fs.cjs')

const repo = path.join(__dirname, '..')
const buildDir = path.join(repo, '.tmp-build')
fs.mkdirSync(buildDir, { recursive: true })
const root = fs.mkdtempSync(path.join(buildDir, 'encoding-verify-'))

let failed = 0
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}${detail === undefined ? '' : `\n    ${JSON.stringify(detail)}`}`)
  }
}

function put(rel, bytes) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, bytes)
}

function putText(rel, text, encoding) {
  put(rel, iconv.encode(text, encoding))
}

async function read(rel, encoding) {
  return readTextFile(root, rel, encoding)
}

const longGbk = '中文测试，这是一个编码检测样例。'.repeat(8)
const longBig5 = '中文測試，這是一個編碼檢測樣本。'.repeat(8)
const longSJis = '日本語のテストです。文字コードの判定を行います。'.repeat(6)
const longEucJp = '日本語のテストです。'.repeat(10)
const longEucKr = '한국어 인코딩 테스트입니다.'.repeat(10)
const longLatin = 'Café déjà vu — naïve façade, résumé. '.repeat(8)
const longCyrillic = 'Привет мир, это тест кодировки. '.repeat(8)
const longGreek = 'Ελληνικό κείμενο δοκιμής για την ανίχνευση κωδικοποίησης. '.repeat(8)
const longPolish = 'Zażółć gęślą jaźń, to jest test kodowania. '.repeat(8)

async function testAutoDetect() {
  console.log('自动识别')

  const cases = [
    ['utf8', 'utf8', '中文测试，hello 世界 😀'],
    ['gbk', 'gbk', longGbk],
    ['big5', 'big5', longBig5],
    ['shiftjis', 'shift_jis', longSJis],
    ['eucjp', 'euc-jp', longEucJp],
    ['euckr', 'euc-kr', longEucKr],
    ['latin1', 'win1252', longLatin],
    ['cp1251', 'win1251', longCyrillic],
    ['greek', 'iso88597', longGreek],
    ['polish', 'iso88592', longPolish],
    ['koi8r', 'koi8r', longCyrillic]
  ]
  for (const [name, codec, text] of cases) {
    putText(`auto-${name}.txt`, text, codec)
    const file = await read(`auto-${name}.txt`)
    check(
      `${name} → ${file.encoding}`,
      file.text === text && file.encodingAuto === true,
      { encoding: file.encoding, head: file.text.slice(0, 24) }
    )
  }

  // ASCII 是 UTF-8 的子集，按 UTF-8 打开即可
  putText('ascii.txt', 'hello world\nsecond line\n', 'utf8')
  let file = await read('ascii.txt')
  check('纯 ASCII → utf8', file.encoding === 'utf8' && file.text === 'hello world\nsecond line\n')

  // 空文件
  put('empty.txt', Buffer.alloc(0))
  file = await read('empty.txt')
  check('空文件 → utf8', file.encoding === 'utf8' && file.text === '' && file.binary === false)
}

async function testBom() {
  console.log('BOM / UTF-16 / UTF-32')

  const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('带 BOM 的中文', 'utf8')])
  put('bom-utf8.txt', utf8Bom)
  let file = await read('bom-utf8.txt')
  check('UTF-8 BOM → utf8bom', file.encoding === 'utf8bom' && file.text === '带 BOM 的中文', file.text)

  putText('bom-utf16le.txt', 'Hello 世界 UTF-16 LE', 'utf16-le')
  put('bom-utf16le.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), fs.readFileSync(path.join(root, 'bom-utf16le.txt'))]))
  file = await read('bom-utf16le.txt')
  check('UTF-16 LE BOM → utf16le', file.encoding === 'utf16le' && file.text === 'Hello 世界 UTF-16 LE', file.text)

  put('bom-utf16be.txt', Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode('Hello 世界 UTF-16 BE', 'utf16-be')]))
  file = await read('bom-utf16be.txt')
  check('UTF-16 BE BOM → utf16be', file.encoding === 'utf16be' && file.text === 'Hello 世界 UTF-16 BE', file.text)

  put('bom-utf32le.txt', Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), iconv.encode('Hello 世界 UTF-32 LE', 'utf32-le')]))
  file = await read('bom-utf32le.txt')
  check('UTF-32 LE BOM → utf32le', file.encoding === 'utf32le' && file.text === 'Hello 世界 UTF-32 LE', file.text)

  put('bom-utf32be.txt', Buffer.concat([Buffer.from([0, 0, 0xfe, 0xff]), iconv.encode('Hello 世界 UTF-32 BE', 'utf32-be')]))
  file = await read('bom-utf32be.txt')
  check('UTF-32 BE BOM → utf32be', file.encoding === 'utf32be' && file.text === 'Hello 世界 UTF-32 BE', file.text)
}

async function testNoBomWide() {
  console.log('无 BOM 的 UTF-16')

  put('nobom-utf16le.txt', iconv.encode('Hello UTF-16 without BOM', 'utf16-le'))
  let file = await read('nobom-utf16le.txt')
  check('UTF-16 LE 无 BOM', file.encoding === 'utf16le' && file.text === 'Hello UTF-16 without BOM', {
    encoding: file.encoding,
    text: file.text
  })

  put('nobom-utf16be.txt', iconv.encode('Hello UTF-16 without BOM', 'utf16-be'))
  file = await read('nobom-utf16be.txt')
  check('UTF-16 BE 无 BOM', file.encoding === 'utf16be' && file.text === 'Hello UTF-16 without BOM', {
    encoding: file.encoding,
    text: file.text
  })
}

async function testManualOverride() {
  console.log('手动编码 / 自动模式')

  putText('manual-gbk.txt', longGbk, 'gbk')
  const auto = await read('manual-gbk.txt')
  check('默认自动识别为 gbk', auto.encoding === 'gbk' && auto.encodingAuto === true)

  const forced = await read('manual-gbk.txt', 'utf8')
  check(
    '强制 UTF-8 打开 GBK 文件',
    forced.encoding === 'utf8' && forced.encodingAuto === false && forced.text !== longGbk,
    { encoding: forced.encoding, auto: forced.encodingAuto }
  )

  const back = await read('manual-gbk.txt')
  check('再次自动识别恢复原文', back.text === longGbk && back.encodingAuto === true)

  putText('manual-bom.txt', '带 BOM', 'utf8')
  put('manual-bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(path.join(root, 'manual-bom.txt'))]))
  const stripBom = await read('manual-bom.txt', 'utf8')
  check('强制 UTF-8 时去掉 BOM', stripBom.text === '带 BOM' && !stripBom.text.startsWith('﻿'))
}

async function testSave() {
  console.log('保存时写回')

  putText('save-gbk.txt', '第一行\r\n', 'gbk')
  const readBack = await read('save-gbk.txt')
  check('GBK 文件换行识别为 CRLF', readBack.eol === 'crlf')

  const saved = await saveTextFile({
    cwd: root,
    rel: 'save-gbk.txt',
    text: '第一行\n第二行：中文\n',
    eol: 'crlf',
    encoding: 'gbk'
  })
  check('GBK 保存成功', saved.ok === true, saved)
  if (saved.ok) {
    const bytes = fs.readFileSync(path.join(root, 'save-gbk.txt'))
    check('GBK 字节按 GB18030 解码一致', iconv.decode(bytes, 'gb18030') === '第一行\r\n第二行：中文\r\n')
    check('保存后重新读取仍是 gbk', (await read('save-gbk.txt')).encoding === 'gbk')
  }

  const bomSaved = await saveTextFile({
    cwd: root,
    rel: 'save-bom.txt',
    text: 'BOM 文件\n',
    encoding: 'utf8bom'
  })
  const bomBytes = fs.readFileSync(path.join(root, 'save-bom.txt'))
  check(
    'UTF-8 BOM 保存带 BOM',
    bomSaved.ok === true &&
      bomBytes[0] === 0xef &&
      bomBytes[1] === 0xbb &&
      bomBytes[2] === 0xbf
  )

  const utf16Saved = await saveTextFile({
    cwd: root,
    rel: 'save-utf16.txt',
    text: 'UTF-16 保存\n',
    encoding: 'utf16le'
  })
  const utf16Bytes = fs.readFileSync(path.join(root, 'save-utf16.txt'))
  check(
    'UTF-16 LE 保存带 BOM',
    utf16Saved.ok === true && utf16Bytes[0] === 0xff && utf16Bytes[1] === 0xfe
  )

  // GB18030 能表示全部 Unicode（包括 emoji），不会丢字符
  const gbkEmoji = await saveTextFile({
    cwd: root,
    rel: 'save-gbk-emoji.txt',
    text: '中文😀\n',
    encoding: 'gbk'
  })
  check(
    'GB18030 可以保存 emoji 并原样读回',
    gbkEmoji.ok === true && (await read('save-gbk-emoji.txt')).text === '中文😀\n',
    gbkEmoji
  )

  putText('save-w1252.txt', 'plain\n', 'win1252')
  const before = fs.readFileSync(path.join(root, 'save-w1252.txt'))
  const lossy = await saveTextFile({
    cwd: root,
    rel: 'save-w1252.txt',
    text: '中文😀',
    encoding: 'windows1252'
  })
  const after = fs.readFileSync(path.join(root, 'save-w1252.txt'))
  check(
    'Windows-1252 无法表示的字符拒绝保存',
    lossy.ok === false && lossy.code === 'unknown' && before.equals(after),
    lossy
  )
}

async function testLimits() {
  console.log('截断 / 二进制 / 取样')

  put('binary.bin', Buffer.from([0, 1, 2, 3, 0, 0, 0, 0]))
  const binary = await read('binary.bin')
  check('含 NUL 的二进制', binary.binary === true && binary.editable === false)

  // 2MB 之后的内容读不到，但编码仍应按前半段识别
  const big = '中文内容'.repeat(600000) // 约 7.2MB UTF-8
  putText('big-utf8.txt', big, 'utf8')
  const bigFile = await read('big-utf8.txt')
  check(
    '截断的 UTF-8 大文件仍识别为 utf8',
    bigFile.truncated === true && bigFile.encoding === 'utf8' && bigFile.text.length > 0,
    { truncated: bigFile.truncated, encoding: bigFile.encoding }
  )

  const bigGbk = '中文内容'.repeat(600000)
  putText('big-gbk.txt', bigGbk, 'gbk')
  const bigGbkFile = await read('big-gbk.txt')
  check(
    '截断的 GBK 大文件仍识别为 gbk',
    bigGbkFile.truncated === true && bigGbkFile.encoding === 'gbk',
    { truncated: bigGbkFile.truncated, encoding: bigGbkFile.encoding }
  )

  // 长 ASCII 前缀之后才出现 GBK 内容：取样必须跳过前缀
  const prefix = 'const x = 1;\n'.repeat(30000) // 约 390KB
  putText('late-gbk.txt', prefix + longGbk, 'gbk')
  const late = await read('late-gbk.txt')
  check(
    '长 ASCII 前缀后的 GBK 内容',
    late.encoding === 'gbk' && late.text.endsWith(longGbk.slice(-20)),
    { encoding: late.encoding, tail: late.text.slice(-20) }
  )
}

async function main() {
  await testAutoDetect()
  await testBom()
  await testNoBomWide()
  await testManualOverride()
  await testSave()
  await testLimits()

  fs.rmSync(root, { recursive: true, force: true })
  console.log('')
  if (failed > 0) {
    console.error(`编码验证失败：${failed} 项`)
    process.exit(1)
  }
  console.log('编码验证全部通过')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
