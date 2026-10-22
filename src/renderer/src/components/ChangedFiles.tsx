import { useEffect, useRef, useState } from 'react'
import type { ChangedFile } from '../changedFiles'
import { IconChevronDown } from './Icons'

/**
 * 输入框左上角、工作目录胶囊右边那颗按钮：本轮改过哪些文件。
 *
 * 数据来自 `file_change` 事件，覆盖三类来源：主对话的编辑工具、子代理
 * 的编辑工具、以及轮末磁盘快照发现的 Bash/脚本/MCP 改动。只看工具卡的
 * 话，后两类会整段消失。
 *
 * 为什么放这儿、而不是输出区上方单独占一条：它跟「这条会话写到哪去」是
 * 同一类信息，跟目录胶囊并排最省地方，也不会在每一轮开头都吃掉一行输出。
 *
 * **没有改动时整个不渲染** —— 胶囊右边就空着，不挂一个「0 个文件」。
 * 弹层往**上**开：输入区贴着窗口底部，往下没有地方。
 */
export function ChangedFiles({ files }: { files: ChangedFile[] }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // 点外面 / Esc 收起 —— 跟输入区那几个选择器一个规矩
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 发了新消息，本轮清零 —— 别让弹层挂在那儿显示上一轮的文件
  useEffect(() => {
    if (files.length === 0) setOpen(false)
  }, [files.length])

  if (files.length === 0) return null

  const added = files.reduce((n, f) => n + f.added, 0)
  const removed = files.reduce((n, f) => n + f.removed, 0)
  const deleted = files.filter((f) => f.deleted).length
  const created = files.filter((f) => f.created && !f.deleted).length
  const edited = files.length - created - deleted
  const bits: string[] = []
  if (edited > 0) bits.push(`${edited} 个修改`)
  if (created > 0) bits.push(`${created} 个新建`)
  if (deleted > 0) bits.push(`${deleted} 个删除`)

  return (
    <div className="cfwrap" ref={ref}>
      <button
        className={`cfbtn ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={`本轮改动 ${files.length} 个文件`}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span className="cfbtn__seg cfbtn__main">
          <span className="cfbtn__ico">✎</span>
          <span className="cfbtn__label">
            <b>{files.length}</b> 个文件
          </span>
        </span>
        <span className="cfbtn__seg cfbtn__stat">
          {(added > 0 || removed > 0) && (
            <span className="cfbtn__diff">
              {added > 0 && <em className="cf-add">+{added}</em>}
              {removed > 0 && <em className="cf-del">−{removed}</em>}
            </span>
          )}
          <IconChevronDown width={11} height={11} className="cfbtn__chev" />
        </span>
      </button>

      {open && (
        <div className="cfpop" role="dialog" aria-label="本轮改动的文件">
          <div className="cfpop__head">
            <span className="cfpop__glyph">✎</span>
            <span className="cfpop__title">
              本轮改动 <b>{files.length}</b> 个文件
            </span>
            <span className="cfpop__sum">
              {added > 0 && <b className="cf-add">+{added}</b>}
              {removed > 0 && <b className="cf-del">−{removed}</b>}
            </span>
          </div>

          <div className="cfpop__list">
            {files.map((f) => (
              // 完整路径进 title：列表里只放文件名和一层目录，长路径会把它撑爆
              <div className={`cfrow ${f.deleted ? 'is-deleted' : ''}`} key={f.key} title={f.path}>
                <span
                  className={`cfrow__ico ${
                    f.deleted ? 'is-del' : f.wrote ? 'is-write' : 'is-edit'
                  }`}
                >
                  {f.deleted ? '−' : f.wrote ? '＋' : '✎'}
                </span>
                <span className="cfrow__name">{f.name}</span>
                <span className="cfrow__dir">{f.dir}</span>
                {f.created && !f.deleted && <span className="cfrow__new">新</span>}
                {f.deleted && <span className="cfrow__del">删</span>}
                <span className="cfrow__diff">
                  {f.added > 0 && <b className="cf-add">+{f.added}</b>}
                  {f.removed > 0 && <b className="cf-del">−{f.removed}</b>}
                </span>
              </div>
            ))}
          </div>

          <div className="cfpop__foot">
            <span>{bits.join(' · ')}</span>
            <span>仅本轮</span>
          </div>
        </div>
      )}
    </div>
  )
}
