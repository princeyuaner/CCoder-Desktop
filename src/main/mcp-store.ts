import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { CLI_IDS, type CliId } from '../shared/settings'
import {
  normalizeLegacyMcpServer,
  type LegacyMcpServerConfig,
  type McpKeyValue
} from '../shared/mcp'

/**
 * 旧版 CCoder 私有 MCP store。
 *
 * 新版本不再写入这里；它只用于两件事：
 *  1. 迁移预览/执行时读取旧条目；
 *  2. 迁移完成前继续给会话做兼容注入，避免升级瞬间丢 MCP。
 *
 * 密钥沿用 settings-store 的策略：优先 safeStorage（Windows DPAPI），
 * 拿不到时才降级明文并在 v 上标记。
 */
interface StoredSecret {
  v: 1 | 0
  enc?: string
  plain?: string
}

interface StoredKV {
  key: string
  value: StoredSecret
}

type StoredMcpServer = Omit<LegacyMcpServerConfig, 'env' | 'headers'> & {
  env: StoredKV[]
  headers: StoredKV[]
}

interface StoredFile {
  v: 1
  servers: Partial<Record<CliId, StoredMcpServer[]>>
}

export function legacyStorePath(): string {
  return join(app.getPath('userData'), 'mcp-servers.json')
}

function seal(plain: string): StoredSecret {
  if (!plain) return { v: 0, plain: '' }
  if (safeStorage.isEncryptionAvailable()) {
    return { v: 1, enc: safeStorage.encryptString(plain).toString('base64') }
  }
  return { v: 0, plain }
}

function unseal(s: StoredSecret | undefined): string {
  if (!s) return ''
  if (s.v === 1 && s.enc) {
    try {
      return safeStorage.decryptString(Buffer.from(s.enc, 'base64'))
    } catch {
      // 换机器 / 换用户后旧密文解不开，当作空而不是崩掉
      return ''
    }
  }
  return s.plain ?? ''
}

function readFile(): StoredFile {
  try {
    const raw = JSON.parse(readFileSync(legacyStorePath(), 'utf8')) as Partial<StoredFile>
    return { v: 1, servers: raw.servers && typeof raw.servers === 'object' ? raw.servers : {} }
  } catch {
    return { v: 1, servers: {} }
  }
}

function writeFile(data: StoredFile): void {
  const target = legacyStorePath()
  mkdirSync(join(target, '..'), { recursive: true })
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, target)
}

function fromStored(s: StoredMcpServer): LegacyMcpServerConfig {
  return normalizeLegacyMcpServer({
    ...s,
    env: (s.env ?? []).map((kv) => ({ key: kv.key, value: unseal(kv.value) })) as McpKeyValue[],
    headers: (s.headers ?? []).map((kv) => ({ key: kv.key, value: unseal(kv.value) })) as McpKeyValue[]
  })
}

function toStored(s: LegacyMcpServerConfig): StoredMcpServer {
  return {
    ...s,
    env: s.env.map((kv) => ({ key: kv.key, value: seal(kv.value) })),
    headers: s.headers.map((kv) => ({ key: kv.key, value: seal(kv.value) }))
  }
}

export function loadMcpServers(cli: CliId): LegacyMcpServerConfig[] {
  const all = readFile()
  return (all.servers[cli] ?? []).map(fromStored)
}

export function loadAllMcpServers(): Record<CliId, LegacyMcpServerConfig[]> {
  const all = readFile()
  const out = {} as Record<CliId, LegacyMcpServerConfig[]>
  for (const id of CLI_IDS) out[id] = (all.servers[id] ?? []).map(fromStored)
  return out
}

export function countLegacyServers(): number {
  const all = loadAllMcpServers()
  return CLI_IDS.reduce((n, cli) => n + all[cli].length, 0)
}

/** 迁移执行期间从旧 store 里移除已经成功写进原生配置的条目 */
export function deleteMcpServer(cli: CliId, id: string): LegacyMcpServerConfig[] {
  const all = readFile()
  const list = (all.servers[cli] ?? []).map(fromStored).filter((s) => s.id !== id)
  all.servers[cli] = list.map(toStored)
  writeFile(all)
  return list
}

/** 迁移前把整份旧文件复制一份（保留加密原样） */
export function backupLegacyStore(dest: string): void {
  const src = legacyStorePath()
  if (!existsSync(src)) return
  mkdirSync(join(dest, '..'), { recursive: true })
  copyFileSync(src, dest)
}

/** 全部迁移成功后改名旧文件，让兼容注入自然变空 */
export function renameLegacyStore(): string | null {
  const src = legacyStorePath()
  if (!existsSync(src)) return null
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  let dest = `${src}.migrated-${ts}`
  let i = 2
  while (existsSync(dest)) dest = `${src}.migrated-${ts}-${i++}`
  renameSync(src, dest)
  return dest
}
