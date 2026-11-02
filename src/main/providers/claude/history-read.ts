import { promises as fsp } from 'node:fs'

/**
 * 读 Claude Code 自己写的 jsonl 会话记录。
 *
 * 抽出来是因为它要同时供**主进程**和 **history worker** 使用：大会话的
 * `split + JSON.parse` 是同步的，放在主线程会卡住所有窗口的 IPC 和流式
 * 事件。worker 里跑同一份代码，行为不会漂移。
 *
 * 这里只做「读 + 解析成记录」，不负责回放成 AgentEvent —— 回放在
 * `history.ts`，worker 和主线程共用。
 */

/** 单份会话最多回放这么多条记录，防一份异常大的文件把界面拖死 */
export const MAX_RECORDS = 20_000

/**
 * 大文件先只读尾部：回放本来也只保留最后 `MAX_RECORDS` 条。
 * 从 4MB 起步，条数不够再成倍往前扩，直到覆盖到文件头或攒够条数。
 */
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024
const TRANSCRIPT_TAIL_GROW = 8
/**
 * 尾部最多往前扩到这里。
 *
 * 图片多的会话是「字节多、记录少」：4MB 够不到 20000 条就会 4MB→32MB→256MB
 * 一路读下去，几百 MB 的字符串 + 同步 JSON.parse 会把主进程卡死。
 * 到上限就只回放已经读到的记录 —— 宁可少几条，也不要把内存打爆。
 */
const TRANSCRIPT_TAIL_MAX_BYTES = 32 * 1024 * 1024

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

export async function readRange(file: string, start: number, bytes: number): Promise<string> {
  if (bytes <= 0) return ''
  const fh = await fsp.open(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, start)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

function parseRecordLines(text: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    try {
      const v = JSON.parse(line) as unknown
      const o = obj(v)
      if (o) records.push(o)
    } catch {
      // 截断/损坏的行跳过
    }
  }
  return records
}

export async function readClaudeRecords(
  file: string,
  size: number
): Promise<Record<string, unknown>[]> {
  let bytes = Math.min(size, TRANSCRIPT_TAIL_BYTES)
  for (;;) {
    const start = Math.max(0, size - bytes)
    const text = await readRange(file, start, bytes)
    // 从文件中间开始读，第一行很可能是半条记录 —— 丢掉它
    const nl = text.indexOf('\n')
    const body = start > 0 ? (nl >= 0 ? text.slice(nl + 1) : '') : text
    const records = parseRecordLines(body)
    if (start === 0) return records.slice(-MAX_RECORDS)
    if (records.length >= MAX_RECORDS) return records.slice(-MAX_RECORDS)
    const next = Math.min(size, bytes * TRANSCRIPT_TAIL_GROW)
    if (next === bytes || next > TRANSCRIPT_TAIL_MAX_BYTES) {
      return records.slice(-MAX_RECORDS)
    }
    bytes = next
  }
}
