/**
 * NDJSON 分帧。
 *
 * 不用 readline：它会在 `\r\n` 上剥离 `\r`，也表达不了"这行是垃圾"和
 * "这是合法消息"的区别。这里只负责切分，合法性交给 parseLine。
 */
export class NdjsonDecoder {
  /**
   * 未完成行的片段。
   *
   * 不能直接把整个 buffer 拼成字符串再 split：一条几 MB 的 tool_result
   * 会按 64KB 分块到达，每次都重拼 + 重扫整个 buffer 是 O(n²)。
   * 这里只在 chunk 内找换行；跨块的行攒片段，闭合时 join 一次。
   */
  private parts: string[] = []

  /** 投入一个数据块，返回其中所有**完整**的行（不含换行符） */
  push(chunk: string): string[] {
    const out: string[] = []
    let start = 0
    for (;;) {
      const nl = chunk.indexOf('\n', start)
      if (nl < 0) {
        if (start < chunk.length) this.parts.push(chunk.slice(start))
        break
      }

      let line: string
      if (this.parts.length > 0) {
        this.parts.push(chunk.slice(start, nl))
        line = this.parts.join('')
        this.parts = []
      } else {
        line = chunk.slice(start, nl)
      }
      // `\r` 只有确认后面是 `\n` 时才剥掉；CRLF 落在块边界时整行留待下一块
      out.push(line.endsWith('\r') ? line.slice(0, -1) : line)
      start = nl + 1
    }
    return out
  }

  /** 流结束时吐出残留 */
  flush(): string[] {
    if (this.parts.length === 0) return []
    const rest = this.parts.join('')
    this.parts = []
    if (!rest) return []
    return [rest.endsWith('\r') ? rest.slice(0, -1) : rest]
  }
}

/**
 * 解析单行。**永不抛错** —— 非法行是预期输入，不是异常。
 *
 * 实测 stdout 会混入 `[claude-code:unrecognized_model] {...}` 这类前缀行，
 * 所以"不是合法 JSON"是常态，必须安静跳过。
 */
export function parseLine(line: string): Record<string, unknown> | null {
  const t = (line ?? '').trim()
  if (!t || !t.startsWith('{')) return null
  try {
    const v = JSON.parse(t) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {
    // 预期
  }
  return null
}
