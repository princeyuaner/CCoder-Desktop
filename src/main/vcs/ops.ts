import { randomUUID } from 'node:crypto'
import { t } from '../i18n'
import { VcsOpError } from './exec'
import { vcsKey } from './queue'

interface ActiveOp {
  controller: AbortController
  cwd: string
}

const active = new Map<string, ActiveOp>()

export interface StartedOp {
  opId: string
  signal: AbortSignal
  done: () => void
}

/** 注册一个可取消操作；opId 重复说明界面重复提交，直接拒绝 */
export function startOp(opId: string | undefined, cwd: string): StartedOp {
  const id = opId || randomUUID()
  if (active.has(id)) throw new VcsOpError('busy', t('vcsError.busy'))
  const controller = new AbortController()
  active.set(id, { controller, cwd: vcsKey(cwd) })
  return {
    opId: id,
    signal: controller.signal,
    done: () => active.delete(id)
  }
}

export function cancelOp(opId: string): boolean {
  const op = active.get(opId)
  if (!op) return false
  op.controller.abort()
  return true
}
