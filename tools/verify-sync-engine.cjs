/*
 * 目录同步引擎的真实磁盘验证。
 *   npx esbuild src/main/sync/engine.ts --bundle --platform=node --format=cjs \
 *     --external:electron --outfile=tools/_sync-engine.cjs
 *   npx esbuild src/main/sync/target.ts --bundle --platform=node --format=cjs \
 *     --external:electron --outfile=tools/_sync-target.cjs
 *   node node_modules/electron/cli.js tools/verify-sync-engine.cjs
 */
// 既能在 Electron 里跑，也能在普通 Node 里跑（bundle 时 electron 被 stub 掉）。
const electron = require('electron')
const app = electron && electron.app ? electron.app : null
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { SyncEngine } = require('./_sync-engine.cjs')
const { LocalTarget } = require('./_sync-target.cjs')

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccoder-sync-engine-'))
const NL = String.fromCharCode(10)

let failed = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok   ${label}`)
  else {
    failed++
    console.error(`  FAIL ${label}${detail === undefined ? '' : `\n       ${JSON.stringify(detail)}`}`)
  }
}

function mkdir(p) {
  fs.mkdirSync(p, { recursive: true })
}
function put(root, rel, text) {
  const full = path.join(root, rel)
  mkdir(path.dirname(full))
  fs.writeFileSync(full, text)
}
function del(root, rel) {
  fs.rmSync(path.join(root, rel), { force: true, recursive: true })
}
function exists(root, rel) {
  return fs.existsSync(path.join(root, rel))
}
function config(src, dst, extra) {
  return {
    enabled: true,
    src,
    dst,
    syncRoots: [],
    exclude: [],
    settleMs: 1500,
    sweepMs: 0,
    deleteMissing: true,
    ...(extra || {})
  }
}
function run(engine) {
  return engine.runRound(true)
}

async function scenario() {
  const src = path.join(base, 'src')
  const dst = path.join(base, 'dst')
  mkdir(src)
  mkdir(dst)
  put(src, 'a.txt', 'one')
  put(src, 'dir/b.txt', 'two')
  put(src, 'skip.log', 'noise')
  put(src, 'node_modules/x.js', 'noise')
  put(src, 'dist/y.js', 'noise')
  put(src, 'excluded/z.txt', 'noise')
  put(src, 'x.tmp2', 'exclude me')
  put(dst, 'manual.txt', 'target-only')

  const cfg = config(src, dst, { exclude: ['excluded', '*.tmp2'] })
  const target = new LocalTarget(dst, () => cfg)
  const engine = new SyncEngine(src, target, () => cfg, path.join(base, 'baseline-a.json'), () => {})

  console.log('scenario: first round applies all three filter layers')
  let r = await run(engine)
  check('copied a.txt + dir/b.txt only', r.copied === 2, r)
  check('target has a.txt', exists(dst, 'a.txt'))
  check('target has dir/b.txt', exists(dst, 'dir/b.txt'))
  check('junk dir node_modules skipped', !exists(dst, 'node_modules/x.js'))
  check('junk dir dist skipped', !exists(dst, 'dist/y.js'))
  check('junk suffix .log skipped', !exists(dst, 'skip.log'))
  check('excluded path skipped', !exists(dst, 'excluded/z.txt'))
  check('exclude glob skipped', !exists(dst, 'x.tmp2'))
  check('target-only file untouched', exists(dst, 'manual.txt'))
  check('round is ok', r.ok === true, r)

  console.log('scenario: steady state does nothing')
  r = await run(engine)
  check('nothing to do', r.nothingToDo === true, r)
  check('no copy', r.copied === 0, r)

  console.log('scenario: source edit is pushed')
  put(src, 'a.txt', 'one plus more')
  r = await run(engine)
  check('copied one file', r.copied === 1, r)
  check('target content updated', fs.readFileSync(path.join(dst, 'a.txt'), 'utf8') === 'one plus more')

  console.log('scenario: source delete mirrors to target')
  del(src, 'dir/b.txt')
  r = await run(engine)
  check('deleted one file', r.deleted === 1, r)
  check('target file gone', !exists(dst, 'dir/b.txt'))
  check('pruned empty dir', r.pruned.includes('dir'), r)

  console.log('scenario: target edited elsewhere is never deleted')
  put(src, 'c.txt', 'c-one')
  await run(engine)
  fs.writeFileSync(path.join(dst, 'c.txt'), 'c-changed-elsewhere')
  del(src, 'c.txt')
  r = await run(engine)
  check('not deleted', r.deleted === 0, r)
  check('kept with targetModified', r.kept.some((k) => k.rel === 'c.txt' && k.why === 'targetModified'), r.kept)
  check('target copy still there', exists(dst, 'c.txt'))

  console.log('scenario: deleteMissing=false only warns')
  put(src, 'd.txt', 'd-one')
  await run(engine)
  del(src, 'd.txt')
  cfg.deleteMissing = false
  r = await run(engine)
  check('not deleted', r.deleted === 0, r)
  check('kept with autoDeleteOff', r.kept.some((k) => k.rel === 'd.txt' && k.why === 'autoDeleteOff'), r.kept)
  check('target copy still there', exists(dst, 'd.txt'))
}

async function rootsScenario() {
  const src = path.join(base, 'src-roots')
  const dst = path.join(base, 'dst-roots')
  mkdir(src)
  mkdir(dst)
  put(src, 'root.txt', 'root')
  put(src, 'only/keep.txt', 'keep')
  put(src, 'other/drop.txt', 'drop')
  const cfg = config(src, dst, { syncRoots: ['only'] })
  const engine = new SyncEngine(
    src,
    new LocalTarget(dst, () => cfg),
    () => cfg,
    path.join(base, 'baseline-b.json'),
    () => {}
  )
  console.log('scenario: syncRoots limits the subtree')
  const r = await run(engine)
  check('only one file copied', r.copied === 1, r)
  check('only/keep.txt copied', exists(dst, 'only/keep.txt'))
  check('other/drop.txt not copied', !exists(dst, 'other/drop.txt'))
  check('root.txt not copied', !exists(dst, 'root.txt'))
}

const done = (code) => {
  if (app) app.exit(code)
  else process.exit(code)
}

const start = app ? app.whenReady() : Promise.resolve()
start
  .then(async () => {
    try {
      await scenario()
      await rootsScenario()
    } catch (e) {
      failed++
      console.error('  FAIL unexpected exception', e)
    }
    console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILURE(S)`)
    done(failed === 0 ? 0 : 1)
  })
  .catch((e) => {
    console.error(e)
    done(1)
  })
