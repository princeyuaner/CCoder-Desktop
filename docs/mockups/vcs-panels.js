/* 设计稿：Git / SVN 版本控制面板。只用于评审，不参与打包。 */
const variant = new URLSearchParams(location.search).get('v') || 'a'

const ICONS = {
  files: '<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/>',
  file: '<path d="M4 1.8h5l3 3v9.4H4z"/><path d="M9 1.8v3h3"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4L14 14"/>',
  branch: '<circle cx="4.5" cy="3.5" r="1.6"/><circle cx="11.5" cy="12.5" r="1.6"/><path d="M4.5 5.1v3.4a4 4 0 0 0 4 4h1.4"/>',
  history: '<path d="M3 8a5 5 0 1 0 1.5-3.5"/><path d="M3 2.5V5h2.5"/><path d="M8 5v3l2 1.2"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5V5h-2.5"/>',
  more: '<circle cx="3.5" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12.5" cy="8" r="1"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  minus: '<path d="M3 8h10"/>',
  undo: '<path d="M6 5L3 8l3 3"/><path d="M3 8h6a4 4 0 0 1 0 8H7"/>',
  lock: '<path d="M5 7V5a3 3 0 0 1 6 0v2"/><rect x="4" y="7" width="8" height="6" rx="1"/>',
  sparkle: '<path d="M8 1.8l1.3 3.4 3.4 1.3-3.4 1.3L8 11.2 6.7 7.8 3.3 6.5l3.4-1.3z"/><path d="M12.5 11.5l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z"/>',
  warning: '<path d="M8 2l6 11H2z"/><path d="M8 6v3M8 11.5h.01"/>',
  check: '<path d="M3 8.5l3 3L13 4.5"/>',
  down: '<path d="M8 3v9M4.5 8.5L8 12l3.5-3.5"/>',
  up: '<path d="M8 13V4M4.5 7.5L8 4l3.5 3.5"/>',
  send: '<path d="M2.4 8.1L13.4 3.4 10.7 13.3 8 9.1z"/><path d="M8 9.1l5.4-5.7"/>',
  diff: '<path d="M4 3v10M4 13l-2-2M4 13l2-2"/><path d="M9 4h4M9 8h4M9 12h2"/>',
  gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1"/>',
  folder: '<path d="M2 4.2h4l1.3 1.5H14v6.5H2z"/>',
  panel: '<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M10 3v10"/>',
  external: '<path d="M9 3h4v4M13 3L7 9"/><path d="M6 4H3v9h9v-3"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>'
}

const icon = (n, s = 13) =>
  `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 16 16">${ICONS[n] || ''}</svg>`

const GIT = {
  kind: 'git',
  label: 'Git',
  branch: 'main',
  sync: '↑2 ↓1',
  repoPath: 'CCoder-Desktop',
  commitMsg: 'fix: 恢复会话时重建后台任务状态',
  commitCount: 3,
  conflict: false,
  groups: [
    {
      title: '暂存的更改', count: 2,
      rows: [
        { st: 'M', name: 'session-manager.ts', dir: 'src/main', stat: [12, 3], checked: true, hot: true },
        { st: 'A', name: 'vcs-panel.ts', dir: 'src/renderer/src', stat: [86, 0], checked: true }
      ]
    },
    {
      title: '更改', count: 4,
      rows: [
        { st: 'M', name: 'Composer.tsx', dir: 'src/renderer/src/components', stat: [24, 6] },
        { st: 'M', name: 'Transcript.tsx', dir: 'src/renderer/src/components', stat: [8, 2] },
        { st: 'M', name: 'ide.css', dir: 'src/renderer/src/styles', stat: [31, 4] },
        { st: 'D', name: 'legacy-vcs.ts', dir: 'src/main', stat: [0, 18] }
      ]
    },
    {
      title: '未跟踪', count: 2,
      rows: [
        { st: '?', name: 'vcs-panels.html', dir: 'docs/mockups' },
        { st: '?', name: 'notes.md', dir: 'docs' }
      ]
    }
  ],
  recent: [
    { id: 'a1b2c3d', msg: 'fix: 恢复会话时重建后台任务状态', time: '2 分钟前' },
    { id: '9f8e7d6', msg: 'feat: IDE 选区发送到聊天', time: '1 小时前' },
    { id: 'c4d5e6f', msg: 'chore: 主题候选与浅色修正', time: '昨天' }
  ]
}

const SVN = {
  kind: 'svn',
  label: 'SVN',
  branch: 'r1284',
  sync: 'trunk',
  repoPath: 'trunk',
  commitMsg: 'r1284: 修复会话恢复后的任务状态',
  commitCount: 4,
  conflict: true,
  groups: [
    {
      title: '待提交', count: 4,
      rows: [
        { st: 'M', name: 'session-manager.ts', dir: 'src/main', stat: [12, 3], checked: true, hot: true },
        { st: 'A', name: 'vcs-svn.ts', dir: 'src/main/providers', stat: [64, 0], checked: true },
        { st: 'M', name: 'ide.css', dir: 'src/renderer/src/styles', stat: [18, 2], checked: true, lock: true },
        { st: 'D', name: 'legacy-vcs.ts', dir: 'src/main', stat: [0, 18], checked: true }
      ]
    },
    {
      title: '未纳入版本控制', count: 2,
      rows: [
        { st: '?', name: 'vcs-panels.html', dir: 'docs/mockups' },
        { st: '?', name: 'notes.md', dir: 'docs' }
      ]
    },
    {
      title: '冲突', count: 1,
      rows: [{ st: 'C', name: 'package-lock.json', dir: '' }]
    }
  ],
  recent: [
    { id: 'r1284', msg: '修复会话恢复后的任务状态', time: '2 分钟前' },
    { id: 'r1283', msg: 'IDE 选区发送到聊天', time: '1 小时前' },
    { id: 'r1282', msg: '新增浅色主题', time: '昨天' }
  ]
}

const stClass = (st) => (st === '?' ? 's-q' : 's-' + st.toLowerCase())
const statHtml = (f) =>
  f.stat
    ? `<span class="fstat"><b class="add">+${f.stat[0]}</b><b class="del">−${f.stat[1]}</b></span>`
    : ''

function rowA(f, v) {
  const action = v.kind === 'git' ? '暂存' : '标记为已解决'
  return `<div class="frow${f.hot ? ' hot' : ''}">
    <span class="st ${stClass(f.st)}">${f.st}</span>
    <span class="fname">${f.name}</span>
    <span class="fdir">${f.dir || ''}</span>
    ${f.lock ? `<span class="lock" title="已锁定">${icon('lock', 10)}</span>` : ''}
    ${statHtml(f)}
    <span class="facs">
      <button class="fbtn" title="${action}">${icon(f.st === 'C' ? 'check' : 'plus', 10)}</button>
      <button class="fbtn" title="还原">${icon('undo', 10)}</button>
    </span>
  </div>`
}

function groupA(g, v) {
  return `<div class="group">
    <div class="ghead">
      <span class="gchev">▾</span>
      <span class="gtitle">${g.title}</span>
      <span class="gcount">${g.count}</span>
      <span class="gacts"><button class="gbtn">${icon('plus', 10)}</button><button class="gbtn">${icon('undo', 10)}</button></span>
    </div>
    ${g.rows.map((f) => rowA(f, v)).join('')}
  </div>`
}

function rowB(f, v) {
  return `<div class="frow${f.hot ? ' hot' : ''}">
    <span class="cb${f.checked ? ' on' : ''}">${f.checked ? icon('check', 8) : ''}</span>
    <span class="st ${stClass(f.st)}">${f.st}</span>
    <span class="fname">${f.name}</span>
    <span class="fdir">${f.dir || ''}</span>
    ${f.lock ? `<span class="lock" title="已锁定">${icon('lock', 10)}</span>` : ''}
    ${statHtml(f)}
  </div>`
}

function groupB(g, v) {
  return `<div class="group">
    <div class="ghead">
      <span class="gchev">▾</span>
      <span class="gtitle">${g.title}</span>
      <span class="gcount">${g.count}</span>
      <span class="gacts"><button class="gbtn">${icon('plus', 10)}</button></span>
    </div>
    ${g.rows.map((f) => rowB(f, v)).join('')}
  </div>`
}

function groupC(g, v) {
  return `<div class="group groupC">
    <div class="ghead">
      <span class="gchev">▾</span>
      <span class="gtitle">${g.title}</span>
      <span class="gcount">${g.count}</span>
    </div>
    ${g.rows.map((f) => rowB(f, v)).join('')}
  </div>`
}

/* ── diff ─────────────────────────────────────────────── */
const DIFF = [
  ['hunk', '@@ -188,8 +188,12 @@ export class SessionManager {'],
  ['ctx', 188, 188, '  private async ensureProc(s: LiveSession) {'],
  ['del', 189, null, '    if (!s.proc) await this.spawn(s)'],
  ['del', 190, null, '    return s.proc'],
  ['add', null, 189, '    if (!s.proc) {'],
  ['add', null, 190, '      await this.spawn(s)'],
  ['add', null, 191, '      this.emitStatus(s)'],
  ['add', null, 192, '    }'],
  ['add', null, 193, '    return s.proc!'],
  ['ctx', 191, 194, '  }'],
  ['ctx', 192, 195, ''],
  ['ctx', 193, 196, '  private emitStatus(s: LiveSession) {'],
  ['add', null, 197, '    // 进程重建后补一次状态，执行台不会停在旧状态'],
  ['ctx', 194, 198, '    this.onStatus?.(s)'],
  ['ctx', 195, 199, '  }']
]

function diffRows(limit) {
  return DIFF.slice(0, limit || DIFF.length).map((r) => {
    if (r[0] === 'hunk') return `<div class="dh">${r[1]}</div>`
    const [, oldN, newN, code] = r
    const cls = r[0] === 'add' ? ' add' : r[0] === 'del' ? ' del' : ''
    const sign = r[0] === 'add' ? '+' : r[0] === 'del' ? '−' : ' '
    return `<div class="drow${cls}">
      <span class="ln">${oldN ?? ''}</span>
      <span class="ln">${newN ?? ''}</span>
      <span class="sign">${sign}</span>
      <span class="code">${code || ' '}</span>
    </div>`
  }).join('')
}

/* ── 公共外壳 ─────────────────────────────────────────── */
function titlebar() {
  return `<div class="tbar">
    <span class="logo">C</span>
    <span class="brand">CCoder IDE</span>
    <span class="div"></span>
    <span class="ws">CCoder-Desktop</span>
    <span class="detach">独立窗口</span>
    <span class="wctl"><span class="wc">−</span><span class="wc">□</span><span class="wc close">×</span></span>
  </div>`
}

function toolbar(v) {
  return `<div class="toolbar">
    <div class="quick">${icon('search', 13)}<span>搜索文件、符号或命令</span><kbd>Ctrl P</kbd></div>
    <div class="tright">
      <span class="chip">${icon('branch', 12)} ${v.kind === 'git' ? v.branch : 'trunk'}</span>
      <span class="syncchip">${v.kind === 'git' ? v.sync : v.branch}</span>
      <button class="tbtn">${icon('refresh', 13)}</button>
      <span class="livepill">可提交</span>
    </div>
  </div>`
}

function activity(active) {
  const btn = (key, name, badge) => `<button class="actbtn${active === key ? ' on' : ''}">
    ${icon(name, 17)}${badge ? `<span class="abadge">${badge}</span>` : ''}
  </button>`
  return `<nav class="act">
    ${btn('files', 'files')}
    ${btn('search', 'search')}
    ${btn('vcs', 'branch', 7)}
    ${btn('history', 'history')}
  </nav>`
}

function statusbar(v) {
  return `<div class="sbar">
    <span class="sbranch">${icon('branch', 11)} ${v.kind === 'git' ? v.branch : 'trunk'}</span>
    <span>${v.kind === 'git' ? '7 变更' : `${v.commitCount} 待提交 · 1 冲突`}</span>
    <span class="sright">
      <span>src/main/session-manager.ts</span>
      <span>${v.label}${v.kind === 'svn' ? ' · ' + v.branch : ''}</span>
    </span>
  </div>`
}

/* ── 方案 A：侧栏 ─────────────────────────────────────── */
function sideA(v) {
  return `<aside class="side">
    <div class="shead">
      <span>源代码管理</span>
      <span class="shtools"><button class="ico">${icon('refresh', 12)}</button><button class="ico">${icon('more', 12)}</button></span>
    </div>
    <div class="repo">
      <span class="vcs ${v.kind}">${v.label}</span>
      <span class="branch">${v.kind === 'git' ? v.branch : v.branch}</span>
      <span class="repoPath">${v.kind === 'git' ? v.repoPath : v.sync}</span>
      ${v.kind === 'git'
        ? `<span class="sync">${v.sync}</span>`
        : `<button class="updatebtn">${icon('down', 10)} 更新</button>`}
      <button class="ico">${icon('refresh', 11)}</button>
    </div>
    <div class="msgbox">
      <textarea>${v.commitMsg}</textarea>
      <div class="msgfoot">
        <button class="ai">${icon('sparkle', 10)} AI 生成</button>
        <span>Ctrl+Enter</span>
      </div>
    </div>
    <button class="commitbtn">${icon('check', 12)} 提交 ${v.commitCount} 个文件 <span class="caret">▾</span></button>
    ${v.conflict ? `<div class="warnbar">${icon('warning', 11)} 1 个冲突待解决</div>` : ''}
    <div class="clist">${v.groups.map((g) => groupA(g, v)).join('')}</div>
    <div class="recent">
      <div class="rhead">最近${v.kind === 'git' ? '提交' : '修订'} <span>${v.recent.length}</span></div>
      ${v.recent.map((r) => `<div class="rrow"><span class="rid">${r.id}</span><span class="rmsg">${r.msg}</span><span class="rtime">${r.time}</span></div>`).join('')}
    </div>
  </aside>`
}

function editorA(v) {
  return `<main class="editor">
    <div class="tabs">
      <div class="tab on">${icon('diff', 12)} session-manager.ts <span class="diffdot"></span><span class="x">×</span></div>
      <div class="tab">${icon('file', 12)} Composer.tsx <span class="x">×</span></div>
    </div>
    <div class="crumbs">
      <span>src</span><span>/</span><span>main</span><span>/</span><span class="crumbfile">session-manager.ts</span>
      <span class="right">
        <span class="fstat"><b class="add">+12</b><b class="del">−3</b></span>
        <button class="crumbact">${icon('plus', 10)} ${v.kind === 'git' ? '暂存' : '提交'}</button>
        <button class="crumbact">${icon('undo', 10)} 还原</button>
        <button class="crumbact">${icon('send', 10)} 发送到聊天</button>
      </span>
    </div>
    <div class="diffbody">${diffRows()}</div>
  </main>`
}

function renderA(v) {
  return `<div class="win">
    ${titlebar()}
    ${toolbar(v)}
    <div class="ibody">
      ${activity('vcs')}
      ${sideA(v)}
      ${editorA(v)}
    </div>
    ${statusbar(v)}
  </div>`
}

/* ── 方案 B：独立版本控制工作区 ───────────────────────── */
function reviewCard(v) {
  if (v.kind === 'git') {
    return `<div class="aicum">
      <div class="aich">${icon('sparkle', 12)} AI 审阅 <span class="risk low">低风险</span></div>
      <p>改动集中在会话恢复路径：子进程重建后会补发一次状态事件，执行台不会停在「已完成」。</p>
      <div class="aichips"><span>影响 2 条执行路径</span><span>无公开 API 变更</span><span>建议补 resume 测试</span></div>
    </div>`
  }
  return `<div class="aicum">
    <div class="aich">${icon('sparkle', 12)} AI 审阅 <span class="risk high">需处理冲突</span></div>
    <p>会话恢复的改动可以提交；<b style="color:#e0af68">package-lock.json</b> 有冲突，ide.css 仍被锁定，需先解决再提交到 trunk。</p>
    <div class="aichips"><span>1 个冲突文件</span><span>1 个锁定文件</span><span>影响 3 条路径</span></div>
  </div>`
}

function renderB(v) {
  const isGit = v.kind === 'git'
  return `<div class="win">
    ${titlebar()}
    ${toolbar(v)}
    <div class="ibody">
      ${activity('vcs')}
      <main class="vws">
        <div class="vtop">
          <div class="vtitle">${icon('branch', 15)} 源代码管理
            <span class="vcs ${v.kind}">${v.label}</span>
            <span class="branch">${v.branch}</span>
            <span class="repoPath">${isGit ? v.repoPath : v.sync}</span>
          </div>
          <div class="vtopacts">
            ${isGit
              ? `<span class="sync">↑2 ↓1</span><button class="btn">${icon('down', 11)} 拉取</button><button class="btn">${icon('up', 11)} 推送</button>`
              : `<button class="btn">${icon('down', 11)} 更新</button>`}
            <button class="btn ghost">${icon('more', 12)}</button>
          </div>
        </div>
        <div class="vtabs">
          <button class="vtab on">更改 <span>${isGit ? 7 : 7}</span></button>
          <button class="vtab">历史</button>
          <button class="vtab">${isGit ? '分支' : '修订'}</button>
          <span class="spacer"></span>
          <span class="vmeta">${isGit ? 'ahead 2 · behind 1' : 'r1284 · trunk'}</span>
        </div>
        <div class="vgrid">
          <section class="vleft">
            ${v.conflict ? `<div class="warnbar big">${icon('warning', 12)} 1 个文件冲突，解决后才能提交 <button class="link">打开冲突</button></div>` : ''}
            <div class="vmsg">
              <div class="vmsgh">提交信息 <button class="ai">${icon('sparkle', 10)} AI 生成</button></div>
              <textarea>${v.commitMsg}</textarea>
              <div class="vmsgf"><span>${isGit ? 'Ctrl+Enter 提交' : '提交到 trunk'}</span><span>${v.commitCount} 个文件</span></div>
            </div>
            <div class="vcommitrow">
              <button class="btn primary wide">${icon('check', 12)} 提交 ${v.commitCount} 个文件</button>
              <button class="btn">▾</button>
            </div>
            <div class="vlist">${v.groups.map((g) => groupB(g, v)).join('')}</div>
            <div class="vrecent">
              <div class="rhead">最近${isGit ? '提交' : '修订'} <span>${v.recent.length}</span></div>
              ${v.recent.map((r) => `<div class="rrow"><span class="rid">${r.id}</span><span class="rmsg">${r.msg}</span><span class="rtime">${r.time}</span></div>`).join('')}
            </div>
          </section>
          <section class="vright">
            ${reviewCard(v)}
            <div class="vdiffhead">
              <span class="vfile">${icon('file', 12)} session-manager.ts <em>M</em></span>
              <span class="vdir">src/main</span>
              <span class="fstat"><b class="add">+12</b><b class="del">−3</b></span>
              <span class="vacts">
                <button>${icon('plus', 10)} ${isGit ? '暂存' : '提交'}</button>
                <button>${icon('undo', 10)} 还原</button>
                <button>${icon('send', 10)} 发送到聊天</button>
              </span>
            </div>
            <div class="diffbody">${diffRows()}</div>
            <div class="vbar">
              <span>已选 ${v.commitCount} 个文件</span>
              <span class="fstat"><b class="add">+82</b><b class="del">−14</b></span>
              <span class="spacer"></span>
              <button class="btn">${icon('send', 11)} 发送 diff 到聊天</button>
              <button class="btn primary">${isGit ? '提交并推送' : '更新并提交'}</button>
            </div>
          </section>
        </div>
      </main>
    </div>
    ${statusbar(v)}
  </div>`
}

/* ── 方案 C：主窗口右侧变更审阅台 ─────────────────────── */
function reviewCardC(v) {
  if (v.kind === 'git') {
    return `<div class="aicum small">
      <div class="aich">${icon('sparkle', 11)} 本轮改动摘要 <span class="risk low">低风险</span></div>
      <p>3 个文件，集中在会话恢复路径；没有公开 API 变更。</p>
    </div>`
  }
  return `<div class="aicum small">
    <div class="aich">${icon('sparkle', 11)} 本轮改动摘要 <span class="risk high">需处理冲突</span></div>
    <p>4 个文件待提交到 trunk；package-lock.json 有冲突，ide.css 仍被锁定。</p>
  </div>`
}

function renderC(v) {
  const isGit = v.kind === 'git'
  return `<div class="win appwin">
    <div class="tbar">
      <span class="logo">C</span>
      <span class="brand">CCoder</span>
      <span class="div"></span>
      <span class="ws">CCoder-Desktop</span>
      <span class="wctl"><span class="wc">−</span><span class="wc">□</span><span class="wc close">×</span></span>
    </div>
    <div class="cbody">
      <aside class="csb">
        <button class="newbtn">${icon('plus', 13)} 新会话</button>
        <div class="cgrp">工作区</div>
        <div class="cws">${icon('folder', 12)} CCoder-Desktop <span class="cwsn">3</span></div>
        <div class="csess on"><span class="csdot"></span><span class="cstitle">修复登录流程</span><span class="cstime">运行中</span></div>
        <div class="csess"><span class="csdot" style="background:#55555c"></span><span class="cstitle">IDE 选中代码发送到聊天</span><span class="cstime">52 分钟</span></div>
        <div class="csess"><span class="csdot" style="background:#55555c"></span><span class="cstitle">转写区工具卡文件名可点</span><span class="cstime">昨天</span></div>
        <div class="cgrp" style="margin-top:10px">其它</div>
        <div class="cws">${icon('folder', 12)} ccoder-plugins <span class="cwsn">8</span></div>
        <div class="csb-foot">${icon('gear', 13)} 设置</div>
      </aside>

      <main class="cchat">
        <div class="chead">
          <span class="ctitle">修复登录流程</span>
          <span class="badge">标准模式</span>
          <span class="spacer"></span>
          <button class="iconbtn">${icon('panel', 13)}</button>
          <button class="iconbtn">${icon('more', 14)}</button>
        </div>
        <div class="cmsgs">
          <div class="cuser">把会话恢复后的后台任务状态也一起修了</div>
          <div class="cai">已定位到 <b>session-manager.ts</b> 的恢复路径，补一次状态事件即可。</div>
          <div class="ctool">
            <span class="tico">✎</span><span class="tname">Edit session-manager.ts</span>
            <span class="tdir">src/main</span>
            <span class="fstat"><b class="add">+12</b><b class="del">−3</b></span>
            <span class="tok">✓</span>
          </div>
          <div class="cai dim">这一轮改动了 3 个文件，右侧可以审阅并提交。</div>
        </div>
        <div class="ccomposer">
          <div class="cchips">
            <span class="chip">模型 DeepSeek</span><span class="chip">标准</span><span class="chip">中等</span>
            <span class="spacer"></span><span class="cctx">12% 上下文</span>
          </div>
          <div class="cinput">继续修复登录后的会话恢复…<span class="sendbtn">↑</span></div>
          <div class="cstatus">3 轮 7 步 · 12.4k tok</div>
        </div>
      </main>

      <aside class="cdock">
        <div class="docktabs">
          <button class="dtab on">变更 <span>7</span></button>
          <button class="dtab">执行台</button>
          <span class="spacer"></span>
          <button class="iconbtn">${icon('more', 13)}</button>
        </div>
        <div class="dockhead">
          <span class="dtitle">工作区变更</span>
          <span class="vcs ${v.kind}">${v.label}</span>
          <span class="branch">${v.branch}</span>
          <span class="sync">${isGit ? v.sync : v.sync}</span>
          <span class="spacer"></span>
          ${isGit ? `<button class="btn xs">${icon('refresh', 10)}</button>` : `<button class="btn xs">${icon('down', 10)} 更新</button>`}
        </div>
        ${reviewCardC(v)}
        <div class="seg">
          <button class="segon">本轮 3</button>
          <button>工作区 7</button>
          <span class="selall">全选</span>
        </div>
        <div class="dlist">${v.groups.slice(0, 2).map((g) => groupC(g, v)).join('')}</div>
        <div class="dpreview">
          <div class="dph">${icon('file', 11)} session-manager.ts <span class="fstat"><b class="add">+12</b><b class="del">−3</b></span><span class="spacer"></span><button class="link">展开全部</button></div>
          <div class="diffbody mini">${diffRows(6)}</div>
        </div>
        <div class="dcommit">
          <textarea>${v.commitMsg}</textarea>
          <div class="dcrow">
            <span>${v.commitCount} 个文件</span>
            <button class="ai">${icon('sparkle', 10)}</button>
            <span class="spacer"></span>
            <button class="btn primary">${isGit ? '提交' : '提交到 trunk'}</button>
          </div>
        </div>
      </aside>
    </div>
    ${statusbar(v)}
  </div>`
}

/* ── 页面 ─────────────────────────────────────────────── */
const META = {
  a: {
    opt: '方案 A',
    title: '侧栏式源代码管理',
    desc: '沿用现有 IDE 三栏，把「变更」升级成完整的 Git / SVN 面板。改动最小，和当前布局最连贯。',
    pills: ['改动最小', '与现有 IDE 一致', '提交信息区偏窄', '窄 diff']
  },
  b: {
    opt: '方案 B',
    title: '独立版本控制工作区',
    desc: '新增一个全宽视图：左侧改动清单与提交框，右侧完整 diff 和 AI 审阅，底部提交栏。适合大改动审阅。',
    pills: ['审阅空间最大', 'AI 摘要 + 提交信息', '新增一个视图', '实现成本中等']
  },
  c: {
    opt: '方案 C',
    title: '聊天侧边变更审阅',
    desc: '把变更审阅放进主窗口右侧 Dock，和对话上下文并排。由输入框的「本轮改动」按钮打开。',
    pills: ['离对话最近', '改完直接审', '占用主窗口宽度', '需与执行台共用 Dock']
  }
}

function boardHead(m) {
  return `<div class="boardhead">
    <div class="kicker"><span class="opt">${m.opt}</span><h1>${m.title}</h1></div>
    <p class="desc">${m.desc}</p>
    <div class="pills">${m.pills.map((p, i) => `<span class="${i === 2 ? 'warn' : ''}">${p}</span>`).join('')}</div>
  </div>`
}

function shot(v, renderer, hint) {
  return `<div class="shot">
    <div class="shothead">
      <span class="dot ${v.kind}"></span>
      <b>${v.kind === 'git' ? 'Git 仓库' : 'SVN 仓库'}</b>
      <span>${v.kind === 'git' ? '暂存 / 提交 / 推送' : '待提交 / 更新 / 冲突'}</span>
      <span class="hint">${hint}</span>
    </div>
    ${renderer(v)}
  </div>`
}

const m = META[variant] || META.a
const renderer = variant === 'b' ? renderB : variant === 'c' ? renderC : renderA
const hint =
  variant === 'c'
    ? '从输入框左上角的「本轮改动」打开'
    : 'Git / SVN 同一套界面，按工作区自动识别仓库类型'

document.getElementById('stage').innerHTML =
  boardHead(m) +
  shot(GIT, renderer, hint) +
  shot(SVN, renderer, hint)
