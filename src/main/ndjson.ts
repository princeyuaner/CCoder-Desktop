/**
 * NDJSON 分帧。
 *
 * 不用 readline：它会在 `\r\n` 上剥离 `\r`，也表达不了"这行是垃圾"和
 * "这是合法消息"的区别。这里只负责切分，合法性交给 parseLine。
 */
export class NdjsonDecoder {
  private buffer = ''

  /** 投入一个数据块，返回其中所有**完整**的行（不含换行符） */
  push(chunk: string): string[] {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    // `\r` 要等确认后面是不是 `\n` 才能决定去留；CRLF 落在块边界时整行留待下一块
    return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  }

  /** 流结束时吐出残留 */
  flush(): string[] {
    const rest = this.buffer
    this.buffer = ''
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
