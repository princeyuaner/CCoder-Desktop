/**
 * dsh 会话文件的读取与解压。
 *
 * 放在独立模块里，是因为它同时被主进程（回退路径）和 worker 使用：
 * fzstd 是**同步整份解压**，放在主线程上对大会话会直接卡住所有窗口。
 * worker 入口见 `history-worker.ts`。
 */
import { promises as fsp } from 'node:fs'
import { decompress } from 'fzstd'

const ZSTD_MAGIC = 0xfd2fb528

/**
 * 压缩文件大小上限。
 *
 * fzstd 没有流式接口，解压结果是整份 Buffer 常驻内存；几百 MB 的会话
 * 在 worker 里也会 OOM。超过上限的会话直接放弃回放（极罕见），
 * 好过把整个应用拖死。
 */
const MAX_COMPRESSED_BYTES = 32 * 1024 * 1024

/**
 * 一个 zstd 帧的字节长度；数据不够（文件正在追加）返回 -1。
 *
 * 只需要走完帧头和每个 block 的 3 字节头 —— block 负载直接按长度跳过，
 * 不用真的读它。这样从文件头就能确定第一帧的边界。
 */
function frameLength(buf: Buffer, start: number): number {
  if (buf.length - start < 8) return -1
  if (buf.readUInt32LE(start) !== ZSTD_MAGIC) return -1

  let p = start + 4
  const desc = buf[p++]
  const fcsFlag = desc >> 6
  const singleSegment = (desc >> 5) & 1
  const checksum = (desc >> 2) & 1
  const dictFlag = desc & 3

  if (!singleSegment) {
    if (p >= buf.length) return -1
    p += 1 // Window_Descriptor
  }
  p += [0, 1, 2, 4][dictFlag]
  p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : 1 << fcsFlag
  if (p > buf.length) return -1

  for (;;) {
    if (p + 3 > buf.length) return -1
    const header = buf.readUIntLE(p, 3)
    p += 3
    const last = header & 1
    const type = (header >> 1) & 3
    const size = header >>> 3
    if (type === 3) return -1 // reserved
    p += type === 1 ? 1 : size // RLE 只存 1 字节
    if (p > buf.length) return -1
    if (last) break
  }
  if (checksum) p += 4
  return p > buf.length ? -1 : p - start
}

/** 解压整份文件；尾部帧不完整时只回放已经写完的部分 */
export function decodeZstd(buf: Buffer): string {
  if (buf.length === 0) return ''
  try {
    return Buffer.from(decompress(buf)).toString('utf8')
  } catch {
    // 正在写入：跳过最后一个不完整的帧
  }

  const parts: Buffer[] = []
  let p = 0
  while (p < buf.length) {
    const n = frameLength(buf, p)
    if (n <= 0) break
    parts.push(buf.subarray(p, p + n))
    p += n
  }
  if (parts.length === 0) return ''
  try {
    return Buffer.from(decompress(Buffer.concat(parts))).toString('utf8')
  } catch {
    return ''
  }
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

/** 解压后的 JSONL → 记录数组 */
export function parseDshRecords(text: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      const rec = obj(JSON.parse(line))
      if (rec) records.push(rec)
    } catch {
      // 损坏 / 截断的行跳过
    }
  }
  return records
}

/** 读一份 dsh 会话文件并解析成记录；文件过大时抛错，由调用方决定怎么提示 */
export async function readDshRecords(file: string): Promise<Record<string, unknown>[]> {
  const st = await fsp.stat(file)
  if (st.size > MAX_COMPRESSED_BYTES) {
    throw new Error(`dsh transcript too large: ${st.size} bytes`)
  }
  const raw = await fsp.readFile(file)
  const text = decodeZstd(raw)
  if (!text) return []
  return parseDshRecords(text)
}
