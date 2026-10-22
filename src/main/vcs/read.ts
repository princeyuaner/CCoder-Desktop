import { open, stat } from 'node:fs/promises'

export interface CappedRead {
  text: string
  binary: boolean
  truncated: boolean
  directory: boolean
  size: number
}

/**
 * 读取未跟踪文件做「整份新增」diff。只读前 2MB，避免一个巨大的
 * 未跟踪文件（日志、数据库转储）把主进程内存打满。
 */
export async function readCapped(abs: string, max = 2 * 1024 * 1024): Promise<CappedRead> {
  const st = await stat(abs)
  if (!st.isFile()) {
    return {
      text: '',
      binary: false,
      truncated: false,
      directory: st.isDirectory(),
      size: st.size
    }
  }

  const take = Math.min(st.size, max)
  const fd = await open(abs, 'r')
  try {
    const buf = Buffer.alloc(take)
    if (take > 0) await fd.read(buf, 0, take, 0)
    const head = buf.subarray(0, Math.min(buf.length, 8192))
    const binary = head.includes(0)
    return {
      text: binary ? '' : buf.toString('utf8'),
      binary,
      truncated: st.size > take,
      directory: false,
      size: st.size
    }
  } finally {
    await fd.close()
  }
}
