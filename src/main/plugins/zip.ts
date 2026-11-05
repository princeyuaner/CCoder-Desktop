import { inflateRawSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

/**
 * 最小 ZIP 解压器。
 *
 * 只支持 store(0) / deflate(8)，不支持 zip64 和加密；插件包本来就应该小。
 * 不引第三方依赖，避免 electron-builder 把 node_modules 排除后运行时缺包。
 */

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const MAX_ENTRIES = 2000
const MAX_TOTAL_BYTES = 64 * 1024 * 1024

function findEocd(buf: Buffer): number {
  const start = Math.max(0, buf.length - 0xffff - 22)
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

function safeTarget(root: string, name: string): string {
  const rel = name.replace(/\\/g, '/')
  if (!rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) {
    throw new Error('zip-absolute-path')
  }
  const parts = rel.split('/').filter((p) => p !== '')
  if (!parts.length || parts.some((p) => p === '.' || p === '..')) {
    throw new Error('zip-path-traversal')
  }
  const out = resolve(root, parts.join('/'))
  if (out !== root && !out.startsWith(root + sep)) throw new Error('zip-path-traversal')
  return out
}

export function extractZip(buffer: Buffer, destination: string): void {
  const eocd = findEocd(buffer)
  if (eocd < 0) throw new Error('zip-eocd-missing')

  const count = buffer.readUInt16LE(eocd + 10)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (count === 0xffff || centralOffset === 0xffffffff) throw new Error('zip64-unsupported')
  if (count > MAX_ENTRIES) throw new Error('zip-too-many-entries')

  const root = resolve(destination)
  mkdirSync(root, { recursive: true })

  let offset = centralOffset
  let totalBytes = 0

  for (let index = 0; index < count; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new Error('zip-central-invalid')
    }

    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const externalAttrs = buffer.readUInt32LE(offset + 38)
    const localOffset = buffer.readUInt32LE(offset + 42)

    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw new Error('zip64-unsupported')
    }

    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    offset += 46 + nameLength + extraLength + commentLength

    const unixMode = (externalAttrs >>> 16) & 0xffff
    if ((unixMode & 0xf000) === 0xa000) throw new Error('zip-symlink-unsupported')

    const isDir = name.endsWith('/')
    if (isDir) {
      mkdirSync(safeTarget(root, name), { recursive: true })
      continue
    }

    const target = safeTarget(root, name)
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error('zip-local-invalid')
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buffer.length) throw new Error('zip-truncated')

    totalBytes += uncompressedSize
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('zip-too-large')

    const data = buffer.subarray(dataStart, dataEnd)
    mkdirSync(dirname(target), { recursive: true })
    if (method === 0) {
      writeFileSync(target, data)
    } else if (method === 8) {
      writeFileSync(target, inflateRawSync(data))
    } else {
      throw new Error(`zip-unsupported-compression:${method}`)
    }
  }
}
