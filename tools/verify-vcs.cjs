/*
 * Git / SVN 适配器验证。不依赖 Electron：
 *   npx esbuild src/main/vcs/index.ts --bundle --platform=node --format=cjs --outfile=tools/_vcs.cjs
 *   node tools/verify-vcs.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const vcs = require('./_vcs.cjs')

let failed = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok   ${label}`)
  else {
    failed++
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  }
}

function sh(bin, args, cwd) {
  return execFileSync(bin, args, { cwd, encoding: 'utf8', windowsHide: true })
}

function temp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // Windows 上 svn/git 句柄可能还没完全释放
  }
}

function gitFixture() {
  const dir = temp('ccoder-git-')
  sh('git', ['init', '-b', 'main', dir])
  sh('git', ['config', 'user.name', 'ccoder-verify'], dir)
  sh('git', ['config', 'user.email', 'verify@example.invalid'], dir)
  sh('git', ['config', 'core.autocrlf', 'false'], dir)
  sh('git', ['config', 'commit.gpgsign', 'false'], dir)
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n')
  fs.writeFileSync(path.join(dir, 'b.txt'), 'bee\n')
  return dir
}

async function testGit() {
  console.log('Git')
  const dir = gitFixture()
  try {
    const det = await vcs.detect(dir)
    check('detect git', det.ok && det.data.repo?.kind === 'git', JSON.stringify(det))
    if (!det.ok || !det.data.repo) return

    let st = await vcs.status({ cwd: dir })
    check('initial status has 2 untracked', st.ok && st.data.counts.untracked === 2, JSON.stringify(st))

    let r = await vcs.stage({ cwd: dir, opId: 'g-stage-1', paths: ['a.txt', 'b.txt'] })
    check('stage', r.ok && r.data.affected === 2, JSON.stringify(r))

    st = await vcs.status({ cwd: dir })
    check('staged count = 2', st.ok && st.data.counts.staged === 2, JSON.stringify(st))

    r = await vcs.commit({ cwd: dir, opId: 'g-commit-1', message: 'init\n' })
    check('commit', r.ok && r.data.files === 2, JSON.stringify(r))

    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n')
    st = await vcs.status({ cwd: dir })
    check('modified shows unstaged', st.ok && st.data.counts.unstaged === 1, JSON.stringify(st))

    let d = await vcs.diff({ cwd: dir, rel: 'a.txt', source: 'working' })
    check('working diff has +two', d.ok && d.data.diff.includes('+two'), JSON.stringify(d))

    r = await vcs.stage({ cwd: dir, opId: 'g-stage-2', paths: ['a.txt'] })
    check('stage modified', r.ok, JSON.stringify(r))
    st = await vcs.status({ cwd: dir })
    check('staged modified', st.ok && st.data.files.some((f) => f.rel === 'a.txt' && f.staged), JSON.stringify(st))

    d = await vcs.diff({ cwd: dir, rel: 'a.txt', source: 'staged' })
    check('staged diff has +two', d.ok && d.data.diff.includes('+two'), JSON.stringify(d))

    d = await vcs.diff({ cwd: dir, rel: 'a.txt', source: 'working' })
    check('working diff empty after stage', d.ok && d.data.diff.trim() === '', JSON.stringify(d))

    d = await vcs.diff({ cwd: dir, rel: 'a.txt', source: 'head' })
    check('head diff still has +two', d.ok && d.data.diff.includes('+two'), JSON.stringify(d))

    r = await vcs.commit({ cwd: dir, opId: 'g-commit-2', message: 'second\n' })
    check('second commit', r.ok, JSON.stringify(r))

    const log = await vcs.log({ cwd: dir, limit: 5 })
    check('log has 2 entries', log.ok && log.data.entries.length === 2, JSON.stringify(log))
    check('log subject', log.ok && log.data.entries[0].subject === 'second', JSON.stringify(log))

    const detail = await vcs.commitDetail({ cwd: dir, id: log.ok ? log.data.entries[0].id : '' })
    check('commit detail has a.txt', detail.ok && detail.data.files.some((f) => f.rel === 'a.txt'), JSON.stringify(detail))

    // discard: 修改后还原
    fs.writeFileSync(path.join(dir, 'b.txt'), 'changed\n')
    r = await vcs.discard({ cwd: dir, opId: 'g-discard-1', paths: ['b.txt'] })
    check('discard tracked', r.ok, JSON.stringify(r))
    const content = fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')
    check('discard restored content', content === 'bee\n', content)

    // untracked diff
    fs.writeFileSync(path.join(dir, 'new.txt'), 'hello\n')
    d = await vcs.diff({ cwd: dir, rel: 'new.txt', source: 'working' })
    check('untracked diff', d.ok && d.data.untracked && d.data.diff.includes('+hello'), JSON.stringify(d))

    // unstage
    await vcs.stage({ cwd: dir, opId: 'g-stage-3', paths: ['new.txt'] })
    r = await vcs.unstage({ cwd: dir, opId: 'g-unstage-1', paths: ['new.txt'] })
    check('unstage', r.ok, JSON.stringify(r))
    st = await vcs.status({ cwd: dir })
    check('unstage returns untracked', st.ok && st.data.files.some((f) => f.rel === 'new.txt' && f.untracked), JSON.stringify(st))
  } finally {
    cleanup(dir)
  }
}

function svnFixture() {
  const base = temp('ccoder-svn-')
  const repo = path.join(base, 'repo')
  const wc = path.join(base, 'wc')
  sh('svnadmin', ['create', repo])
  const url = require('node:url').pathToFileURL(repo).href
  sh('svn', ['checkout', '--non-interactive', '--no-auth-cache', url, wc])
  return { base, repo, wc, url }
}

async function testSvn() {
  console.log('SVN')
  const { base, wc } = svnFixture()
  try {
    fs.writeFileSync(path.join(wc, 'a.txt'), 'one\n')
    const det = await vcs.detect(wc)
    check('detect svn', det.ok && det.data.repo?.kind === 'svn', JSON.stringify(det))
    check(
      'svn worktrees capability off',
      det.ok && det.data.repo?.capabilities.worktrees === false,
      JSON.stringify(det)
    )
    const wt = await vcs.worktreeList({ cwd: wc })
    check('svn worktrees unsupported', !wt.ok && wt.error.code === 'unsupported', JSON.stringify(wt))
    if (!det.ok || !det.data.repo) return

    let st = await vcs.status({ cwd: wc })
    check('svn untracked', st.ok && st.data.files.some((f) => f.rel === 'a.txt' && f.untracked), JSON.stringify(st))

    let r = await vcs.stage({ cwd: wc, opId: 's-add-1', paths: ['a.txt'] })
    check('svn add', r.ok, JSON.stringify(r))

    st = await vcs.status({ cwd: wc })
    check('svn added', st.ok && st.data.files.some((f) => f.rel === 'a.txt' && f.status === 'A'), JSON.stringify(st))

    r = await vcs.commit({ cwd: wc, opId: 's-commit-1', message: 'init', paths: ['a.txt'] })
    check('svn commit', r.ok && r.data.revision >= 1, JSON.stringify(r))

    fs.writeFileSync(path.join(wc, 'a.txt'), 'one\ntwo\n')
    st = await vcs.status({ cwd: wc })
    check('svn modified', st.ok && st.data.files.some((f) => f.rel === 'a.txt' && f.status === 'M'), JSON.stringify(st))

    let d = await vcs.diff({ cwd: wc, rel: 'a.txt', source: 'working' })
    check('svn diff +two', d.ok && d.data.diff.includes('+two'), JSON.stringify(d))

    r = await vcs.commit({ cwd: wc, opId: 's-commit-2', message: 'second', paths: ['a.txt'] })
    check('svn second commit', r.ok && r.data.revision >= 2, JSON.stringify(r))

    const log = await vcs.log({ cwd: wc, limit: 5 })
    check('svn log entries', log.ok && log.data.entries.length >= 2, JSON.stringify(log))
    check('svn log subject', log.ok && log.data.entries[0].subject === 'second', JSON.stringify(log))

    if (log.ok && log.data.entries[0]) {
      const detail = await vcs.commitDetail({ cwd: wc, id: log.data.entries[0].id })
      check('svn commit detail', detail.ok && detail.data.files.length >= 1, JSON.stringify(detail))
    }

    // revert
    fs.writeFileSync(path.join(wc, 'a.txt'), 'dirty\n')
    r = await vcs.revert({ cwd: wc, opId: 's-revert-1', paths: ['a.txt'] })
    check('svn revert', r.ok, JSON.stringify(r))
    check('svn revert content', fs.readFileSync(path.join(wc, 'a.txt'), 'utf8') === 'one\ntwo\n')

    // update clean wc
    r = await vcs.update({ cwd: wc, opId: 's-update-1' })
    check('svn update', r.ok && typeof r.data.revision === 'number', JSON.stringify(r))
  } finally {
    cleanup(base)
  }
}

async function testGitConflict() {
  console.log('Git conflict')
  const dir = gitFixture()
  try {
    sh('git', ['add', '-A'], dir)
    sh('git', ['commit', '-m', 'init'], dir)
    sh('git', ['checkout', '-b', 'feature'], dir)
    fs.writeFileSync(path.join(dir, 'a.txt'), 'feature\n')
    sh('git', ['commit', '-am', 'feature'], dir)
    sh('git', ['checkout', 'main'], dir)
    fs.writeFileSync(path.join(dir, 'a.txt'), 'main\n')
    sh('git', ['commit', '-am', 'main'], dir)
    try {
      sh('git', ['merge', 'feature'], dir)
    } catch {
      // expected conflict
    }

    let st = await vcs.status({ cwd: dir })
    check('git conflict reported', st.ok && st.data.files.some((f) => f.rel === 'a.txt' && f.conflict), JSON.stringify(st))

    let r = await vcs.resolve({ cwd: dir, opId: 'gc-working', paths: ['a.txt'], side: 'working' })
    check('git refuses markers', !r.ok && r.error.code === 'conflict', JSON.stringify(r))

    r = await vcs.resolve({ cwd: dir, opId: 'gc-ours', paths: ['a.txt'], side: 'ours' })
    check('git resolve ours', r.ok, JSON.stringify(r))
    check('git ours content', fs.readFileSync(path.join(dir, 'a.txt'), 'utf8') === 'main\n')

    st = await vcs.status({ cwd: dir })
    check('git conflict cleared', st.ok && !st.data.files.some((f) => f.conflict), JSON.stringify(st))
  } finally {
    cleanup(dir)
  }
}

async function testSvnConflict() {
  console.log('SVN conflict')
  const { base, wc, url } = svnFixture()
  const wc2 = path.join(base, 'wc2')
  try {
    sh('svn', ['checkout', '--non-interactive', '--no-auth-cache', url, wc2])
    fs.writeFileSync(path.join(wc, 'a.txt'), 'one\n')
    sh('svn', ['add', '--non-interactive', '--no-auth-cache', path.join(wc, 'a.txt')], wc)
    sh('svn', ['commit', '--non-interactive', '--no-auth-cache', '-m', 'init', path.join(wc, 'a.txt')], wc)
    sh('svn', ['update', '--non-interactive', '--no-auth-cache', wc2], wc2)

    fs.writeFileSync(path.join(wc, 'a.txt'), 'one\nfrom wc1\n')
    sh('svn', ['commit', '--non-interactive', '--no-auth-cache', '-m', 'wc1', path.join(wc, 'a.txt')], wc)

    fs.writeFileSync(path.join(wc2, 'a.txt'), 'one\nfrom wc2\n')
    try {
      sh('svn', ['update', '--non-interactive', '--no-auth-cache', '--accept', 'postpone', wc2], wc2)
    } catch {
      // expected conflict
    }

    let st = await vcs.status({ cwd: wc2 })
    check('svn conflict reported', st.ok && st.data.files.some((f) => f.rel === 'a.txt' && f.conflict), JSON.stringify(st))
    check('svn conflict letter C', st.ok && st.data.files.some((f) => f.rel === 'a.txt' && f.status === 'C'), JSON.stringify(st))

    let r = await vcs.resolve({ cwd: wc2, opId: 'sc-working', paths: ['a.txt'], side: 'working' })
    check('svn refuses markers', !r.ok && r.error.code === 'conflict', JSON.stringify(r))

    r = await vcs.resolve({ cwd: wc2, opId: 'sc-ours', paths: ['a.txt'], side: 'ours' })
    check('svn resolve mine-full', r.ok, JSON.stringify(r))
    st = await vcs.status({ cwd: wc2 })
    check('svn conflict cleared', st.ok && !st.data.files.some((f) => f.conflict), JSON.stringify(st))

    // lock 展示（锁 + 修改才会出现在变更列表里）
    sh('svn', ['lock', '--non-interactive', '--no-auth-cache', path.join(wc, 'a.txt')], wc)
    fs.writeFileSync(path.join(wc, 'a.txt'), 'one\nlocked\n')
    st = await vcs.status({ cwd: wc })
    check('svn lock reported', st.ok && st.data.files.some((f) => f.rel === 'a.txt' && f.lock), JSON.stringify(st))
    sh('svn', ['revert', '--non-interactive', '--no-auth-cache', path.join(wc, 'a.txt')], wc)
    sh('svn', ['unlock', '--non-interactive', '--no-auth-cache', path.join(wc, 'a.txt')], wc)
  } finally {
    cleanup(base)
  }
}

async function testGitUnborn() {
  console.log('Git unborn')
  const dir = temp('ccoder-git-unborn-')
  try {
    sh('git', ['init', '-b', 'main', dir])
    sh('git', ['config', 'user.name', 'verify'], dir)
    sh('git', ['config', 'user.email', 'verify@example.invalid'], dir)
    sh('git', ['config', 'core.autocrlf', 'false'], dir)
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n')

    const det = await vcs.detect(dir)
    check('unborn branch detected', det.ok && det.data.repo?.branch === 'main' && !det.data.repo?.detached, JSON.stringify(det))

    let st = await vcs.status({ cwd: dir })
    check('unborn status untracked', st.ok && st.data.files.some((f) => f.rel === 'a.txt' && f.untracked), JSON.stringify(st))

    await vcs.stage({ cwd: dir, opId: 'u-stage', paths: ['a.txt'] })
    const r = await vcs.commit({ cwd: dir, opId: 'u-commit', message: 'initial' })
    check('unborn first commit', r.ok && !!r.data.id, JSON.stringify(r))
  } finally {
    cleanup(dir)
  }
}

async function testGitSubdir() {
  console.log('Git subdirectory')
  const dir = gitFixture()
  const sub = path.join(dir, 'sub')
  try {
    fs.mkdirSync(sub)
    fs.writeFileSync(path.join(sub, 'a.txt'), 'sub one\n')
    fs.writeFileSync(path.join(dir, 'root.txt'), 'root\n')
    sh('git', ['add', '-A'], dir)
    sh('git', ['commit', '-m', 'init'], dir)

    fs.writeFileSync(path.join(sub, 'a.txt'), 'sub one\nchanged\n')
    fs.writeFileSync(path.join(dir, 'root.txt'), 'root\nchanged\n')

    const det = await vcs.detect(sub)
    check('subdir prefix', det.ok && det.data.repo?.workspacePrefix === 'sub', JSON.stringify(det))
    let st = await vcs.status({ cwd: sub })
    check('subdir status only a.txt', st.ok && st.data.files.length === 1 && st.data.files[0].rel === 'a.txt', JSON.stringify(st))

    const d = await vcs.diff({ cwd: sub, rel: 'a.txt', source: 'working' })
    check('subdir diff', d.ok && d.data.diff.includes('+changed'), JSON.stringify(d))

    await vcs.stage({ cwd: sub, opId: 'sd-stage', paths: ['a.txt'] })
    const c = await vcs.commit({ cwd: sub, opId: 'sd-commit', message: 'sub commit' })
    check('subdir commit', c.ok, JSON.stringify(c))
    st = await vcs.status({ cwd: sub })
    check('subdir clean', st.ok && st.data.clean, JSON.stringify(st))

    const rootStatus = await vcs.status({ cwd: dir })
    check('root still dirty', rootStatus.ok && rootStatus.data.files.some((f) => f.rel === 'root.txt'), JSON.stringify(rootStatus))
  } finally {
    cleanup(dir)
  }
}

async function testGitWorktrees() {
  console.log('Git worktrees')
  const dir = gitFixture()
  const wtRoot = `${dir}.worktrees`
  const created = []
  try {
    const det = await vcs.detect(dir)
    check(
      'git worktrees capability on',
      det.ok && det.data.repo?.capabilities.worktrees === true,
      JSON.stringify(det)
    )

    sh('git', ['add', '-A'], dir)
    sh('git', ['commit', '-m', 'base'], dir)

    let list = await vcs.worktreeList({ cwd: dir })
    check('worktree list one entry', list.ok && list.data.worktrees.length === 1, JSON.stringify(list))
    check(
      'worktree main/current flags',
      list.ok &&
        list.data.worktrees[0].main &&
        list.data.worktrees[0].current &&
        list.data.worktrees[0].exists &&
        list.data.worktrees[0].branch === 'main',
      JSON.stringify(list)
    )
    check(
      'worktree default root is sibling',
      list.ok &&
        path.resolve(list.data.defaultRoot) === path.resolve(path.dirname(dir), `${path.basename(dir)}.worktrees`),
      JSON.stringify(list)
    )

    const target = path.join(wtRoot, 'feature-a')
    created.push(target)
    const add = await vcs.worktreeAdd({
      cwd: dir,
      opId: 'wt-add-1',
      path: target,
      branch: 'feature-a',
      base: 'main'
    })
    check('worktree add', add.ok && add.data.worktrees.length === 2, JSON.stringify(add))
    check('worktree dir has checkout', fs.existsSync(path.join(target, 'a.txt')))
    check(
      'worktree branch exists',
      sh('git', ['-C', dir, 'show-ref', '--verify', 'refs/heads/feature-a']).includes('feature-a')
    )
    const mainStatus = await vcs.status({ cwd: dir })
    check('main worktree stays clean', mainStatus.ok && mainStatus.data.clean, JSON.stringify(mainStatus))

    const dup = await vcs.worktreeAdd({
      cwd: dir,
      opId: 'wt-add-dup',
      path: path.join(wtRoot, 'feature-a2'),
      branch: 'feature-a',
      base: 'main'
    })
    check('duplicate branch rejected', !dup.ok && dup.error.code === 'branch-in-use', JSON.stringify(dup))

    const inside = await vcs.worktreeAdd({
      cwd: dir,
      opId: 'wt-add-inside',
      path: path.join(dir, 'nested'),
      branch: 'nested-branch',
      base: 'main'
    })
    check('target inside repo rejected', !inside.ok && inside.error.code === 'invalid-path', JSON.stringify(inside))

    const relative = await vcs.worktreeAdd({
      cwd: dir,
      opId: 'wt-add-relative',
      path: 'relative-tree',
      branch: 'relative-branch',
      base: 'main'
    })
    check('relative target rejected', !relative.ok && relative.error.code === 'invalid-path', JSON.stringify(relative))

    fs.mkdirSync(path.join(wtRoot, 'non-empty'), { recursive: true })
    fs.writeFileSync(path.join(wtRoot, 'non-empty', 'x.txt'), 'x\n')
    const nonEmpty = await vcs.worktreeAdd({
      cwd: dir,
      opId: 'wt-add-nonempty',
      path: path.join(wtRoot, 'non-empty'),
      branch: 'non-empty-branch',
      base: 'main'
    })
    check('non-empty target rejected', !nonEmpty.ok && nonEmpty.error.code === 'invalid-path', JSON.stringify(nonEmpty))

    const linked = await vcs.worktreeList({ cwd: target })
    check('linked list keeps main first', linked.ok && linked.data.worktrees[0].main, JSON.stringify(linked))
    check(
      'linked list marks current',
      linked.ok && linked.data.worktrees.find((w) => path.resolve(w.path) === path.resolve(target))?.current,
      JSON.stringify(linked)
    )

    const sub = path.join(dir, 'sub')
    fs.mkdirSync(sub)
    const fromSub = await vcs.worktreeAdd({
      cwd: sub,
      opId: 'wt-add-sub',
      path: path.join(wtRoot, 'from-sub'),
      branch: 'from-sub',
      base: 'main'
    })
    created.push(path.join(wtRoot, 'from-sub'))
    check('add from subdirectory', fromSub.ok && fromSub.data.worktrees.length === 3, JSON.stringify(fromSub))

    const removeMain = await vcs.worktreeRemove({ cwd: dir, opId: 'wt-rm-main', path: dir })
    check('cannot remove main', !removeMain.ok && removeMain.error.code === 'invalid-path', JSON.stringify(removeMain))

    const removeCurrent = await vcs.worktreeRemove({ cwd: target, opId: 'wt-rm-current', path: target })
    check('cannot remove current', !removeCurrent.ok && removeCurrent.error.code === 'invalid-path', JSON.stringify(removeCurrent))

    fs.writeFileSync(path.join(target, 'a.txt'), 'dirty\n')
    const dirty = await vcs.worktreeRemove({ cwd: dir, opId: 'wt-rm-dirty', path: target })
    check('dirty remove rejected', !dirty.ok && dirty.error.code === 'dirty', JSON.stringify(dirty))
    check('dirty worktree still exists', fs.existsSync(target))

    const forced = await vcs.worktreeRemove({
      cwd: dir,
      opId: 'wt-rm-force',
      path: target,
      force: true
    })
    check('forced remove', forced.ok && !fs.existsSync(target), JSON.stringify(forced))
    check(
      'branch kept after remove',
      sh('git', ['-C', dir, 'show-ref', '--verify', 'refs/heads/feature-a']).includes('feature-a')
    )

    const lockedTarget = path.join(wtRoot, 'locked-b')
    created.push(lockedTarget)
    const addLocked = await vcs.worktreeAdd({
      cwd: dir,
      opId: 'wt-add-locked',
      path: lockedTarget,
      branch: 'locked-b',
      base: 'main'
    })
    check('add locked fixture', addLocked.ok, JSON.stringify(addLocked))
    sh('git', ['-C', dir, 'worktree', 'lock', lockedTarget])
    const locked = await vcs.worktreeRemove({
      cwd: dir,
      opId: 'wt-rm-locked',
      path: lockedTarget,
      force: true
    })
    check('locked remove rejected', !locked.ok && locked.error.code === 'locked', JSON.stringify(locked))
    sh('git', ['-C', dir, 'worktree', 'unlock', lockedTarget])

    const missing = path.join(wtRoot, 'missing-c')
    created.push(missing)
    const addMissing = await vcs.worktreeAdd({
      cwd: dir,
      opId: 'wt-add-missing',
      path: missing,
      branch: 'missing-c',
      base: 'main'
    })
    check('add missing fixture', addMissing.ok, JSON.stringify(addMissing))
    fs.rmSync(missing, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })

    const beforePrune = await vcs.worktreeList({ cwd: dir })
    check(
      'missing worktree reported',
      beforePrune.ok &&
        beforePrune.data.worktrees.find((w) => path.resolve(w.path) === path.resolve(missing))?.exists === false,
      JSON.stringify(beforePrune)
    )

    const pruned = await vcs.worktreePrune({ cwd: dir, opId: 'wt-prune-1' })
    check('prune removes stale record', pruned.ok && pruned.data.pruned >= 1, JSON.stringify(pruned))
    check(
      'pruned path reported',
      pruned.ok && pruned.data.prunedPaths.some((p) => path.resolve(p) === path.resolve(missing)),
      JSON.stringify(pruned)
    )
    check(
      'missing branch preserved',
      sh('git', ['-C', dir, 'show-ref', '--verify', 'refs/heads/missing-c']).includes('missing-c')
    )
  } finally {
    for (const p of created) {
      if (!fs.existsSync(p)) continue
      try {
        sh('git', ['-C', dir, 'worktree', 'remove', '--force', p])
      } catch {
        // 已经 remove 过或 git 认为它不是工作树
      }
    }
    cleanup(wtRoot)
    cleanup(dir)
  }
}

async function testSvnSubdir() {
  console.log('SVN subdirectory')
  const { base, wc } = svnFixture()
  const sub = path.join(wc, 'sub')
  try {
    fs.mkdirSync(sub)
    fs.writeFileSync(path.join(sub, 'a.txt'), 'sub one\n')
    fs.writeFileSync(path.join(wc, 'root.txt'), 'root\n')
    sh('svn', ['add', '--non-interactive', '--no-auth-cache', sub, path.join(wc, 'root.txt')], wc)
    sh('svn', ['commit', '--non-interactive', '--no-auth-cache', '-m', 'init', wc], wc)

    fs.writeFileSync(path.join(sub, 'a.txt'), 'sub one\nchanged\n')
    fs.writeFileSync(path.join(wc, 'root.txt'), 'root\nchanged\n')

    const det = await vcs.detect(sub)
    check('svn subdir prefix', det.ok && det.data.repo?.workspacePrefix === 'sub', JSON.stringify(det))
    let st = await vcs.status({ cwd: sub })
    check('svn subdir status only a.txt', st.ok && st.data.files.length === 1 && st.data.files[0].rel === 'a.txt', JSON.stringify(st))

    const d = await vcs.diff({ cwd: sub, rel: 'a.txt', source: 'working' })
    check('svn subdir diff', d.ok && d.data.diff.includes('+changed'), JSON.stringify(d))

    const c = await vcs.commit({ cwd: sub, opId: 'ss-commit', message: 'sub commit', paths: ['a.txt'] })
    check('svn subdir commit', c.ok, JSON.stringify(c))
    st = await vcs.status({ cwd: sub })
    check('svn subdir clean', st.ok && st.data.clean, JSON.stringify(st))

    const rootStatus = await vcs.status({ cwd: wc })
    check('svn root still dirty', rootStatus.ok && rootStatus.data.files.some((f) => f.rel === 'root.txt'), JSON.stringify(rootStatus))
  } finally {
    cleanup(base)
  }
}

async function testGitRemote() {
  console.log('Git remote')
  const base = temp('ccoder-git-remote-')
  const origin = path.join(base, 'origin.git')
  const repo = path.join(base, 'repo')
  const other = path.join(base, 'other')
  try {
    sh('git', ['init', '--bare', origin], base)
    sh('git', ['init', '-b', 'main', repo], base)
    sh('git', ['config', 'user.name', 'verify'], repo)
    sh('git', ['config', 'user.email', 'verify@example.invalid'], repo)
    sh('git', ['config', 'core.autocrlf', 'false'], repo)
    sh('git', ['remote', 'add', 'origin', origin], repo)
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
    sh('git', ['add', '-A'], repo)
    sh('git', ['commit', '-m', 'init'], repo)

    let push = await vcs.push({ cwd: repo, opId: 'r-push-1', setUpstream: true })
    check('push set upstream', push.ok, JSON.stringify(push))

    const det = await vcs.detect(repo)
    check('detect upstream', det.ok && det.data.repo?.remote === 'origin' && !!det.data.repo?.upstream, JSON.stringify(det))

    sh('git', ['clone', '-b', 'main', origin, other], base)
    sh('git', ['config', 'user.name', 'other'], other)
    sh('git', ['config', 'user.email', 'other@example.invalid'], other)
    fs.writeFileSync(path.join(other, 'b.txt'), 'two\n')
    sh('git', ['add', '-A'], other)
    sh('git', ['commit', '-m', 'other'], other)
    sh('git', ['push', 'origin', 'main'], other)

    const fetch = await vcs.fetch({ cwd: repo, opId: 'r-fetch' })
    check('fetch', fetch.ok, JSON.stringify(fetch))
    const pull = await vcs.pull({ cwd: repo, opId: 'r-pull' })
    check('pull ff-only', pull.ok, JSON.stringify(pull))
    check('pulled file exists', fs.existsSync(path.join(repo, 'b.txt')))

    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nlocal\n')
    sh('git', ['commit', '-am', 'local'], repo)
    const push2 = await vcs.push({ cwd: repo, opId: 'r-push-2' })
    check('push with upstream', push2.ok, JSON.stringify(push2))
  } finally {
    cleanup(base)
  }
}

async function main() {
  await testGit()
  await testGitUnborn()
  await testGitConflict()
  await testGitSubdir()
  await testGitWorktrees()
  await testGitRemote()
  await testSvn()
  await testSvnConflict()
  await testSvnSubdir()
  console.log(failed ? `\n${failed} failed` : '\nall passed')
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
