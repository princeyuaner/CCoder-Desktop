import { useCallback, useEffect, useState } from 'react'
import {
  sessionMetaKey,
  type SessionMeta,
  type SessionMetaMap,
  type StoredSession
} from '@shared/session'
import { tr } from './i18n'
import { notify } from './notice'

/**
 * 会话的本地元数据（重命名 / 置顶 / 归档）。
 *
 * 主进程是唯一真相：这里只缓存一份快照，每次修改都用主进程返回的整份
 * map 覆盖 —— 不自己拼，避免两边对"空字段该删还是该留"的理解不一致。
 */
export function useSessionMeta(): {
  meta: SessionMetaMap
  /** 元数据读完没 —— 打开已有会话要等它，才能拿到这条会话自己的模型 */
  loading: boolean
  /** 只要身份三件套：调用方不必凑齐 StoredSession 的展示字段 */
  update: (
    session: Pick<StoredSession, 'id' | 'cwd' | 'cli'>,
    patch: SessionMeta
  ) => Promise<boolean>
} {
  const [meta, setMeta] = useState<SessionMetaMap>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    const api = window.api?.sessions
    if (!api) {
      setLoading(false)
      return
    }
    void api
      .meta()
      .then((m) => {
        if (alive && m) setMeta(m)
      })
      .catch(() => {
        // 读不到元数据不该影响会话列表，按"没有改过名字"显示
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const update = useCallback(
    async (
      session: Pick<StoredSession, 'id' | 'cwd' | 'cli'>,
      patch: SessionMeta
    ): Promise<boolean> => {
      try {
        const next = await window.api?.sessions.setMeta({
          cli: session.cli,
          cwd: session.cwd,
          id: session.id,
          patch
        })
        if (next) {
          setMeta(next)
          return true
        }
      } catch {
        // 落到下面统一提示
      }
      notify(tr('errors.sessionMetaFailed'))
      return false
    },
    []
  )

  return { meta, loading, update }
}

/** 取一条会话的元数据；没有就是空对象 */
export function metaOf(session: StoredSession, meta: SessionMetaMap): SessionMeta {
  return meta[sessionMetaKey(session.cli, session.cwd, session.id)] ?? {}
}

/** 显示标题：用户改过就用改过的，否则回落到 CLI 记录里的首条消息 */
export function displayTitle(session: StoredSession, meta: SessionMetaMap): string {
  return metaOf(session, meta).title || session.title
}
