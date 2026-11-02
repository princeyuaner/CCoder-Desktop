/**
 * 主进程里的受限并发工具。
 *
 * 目录扫描 / 批量 stat 动辄几百上千项，一次性 `Promise.all` 会把文件描述符
 * 和磁盘队列打满；串行又浪费往返延迟。16 路左右通常能吃掉大部分等待。
 */
export const IO_CONCURRENCY = 16

/** 按并发上限执行 map，**结果顺序与输入一致** */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return []
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}
