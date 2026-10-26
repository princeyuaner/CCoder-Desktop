import { useEffect, useRef, useState } from 'react'

export interface WorktreeEntry {
  /** 所属主工作树目录 */
  mainCwd: string
  /** 这个工作树当前检出的分支；detached 时为空串 */
  branch: string
}

/**
 * 批量查询「哪些打开的目录是 linked worktree」。
 *
 * 侧栏要把这些目录的会话并回主工作区分组，并在会话行下面显示分支。
 * 结果只和 cwd 列表有关：工作树的分支不会在会话运行期间变，所以按
 * cwd 列表做一次查询就够；新工作树加入 openedCwds 时会自动重查。
 */
export function useWorktreeMap(cwds: string[]): Record<string, WorktreeEntry> {
  const key = cwds.join('\u0000')
  const [map, setMap] = useState<Record<string, WorktreeEntry>>({})
  const seq = useRef(0)

  useEffect(() => {
    const mine = ++seq.current
    let alive = true
    const api = window.api?.vcs
    if (!cwds.length || !api) {
      setMap({})
      return
    }

    void api
      .worktreeMap({ cwds })
      .then((r) => {
        if (!alive || mine !== seq.current) return
        if (!r.ok) {
          setMap({})
          return
        }
        const next: Record<string, WorktreeEntry> = {}
        for (const entry of r.data.entries) {
          // 主工作树不需要并入自己；只需要 linked worktree
          if (!entry.worktree) continue
          next[entry.cwd] = { mainCwd: entry.mainPath, branch: entry.branch }
        }
        setMap(next)
      })
      .catch(() => {
        if (alive && mine === seq.current) setMap({})
      })

    return () => {
      alive = false
    }
    // cwds 用拼接后的 key 做依赖：调用方每次渲染都可能给新数组
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return map
}
