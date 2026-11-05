import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginHostContext } from '../src/main/plugins/context'
import {
  deletePluginStorage,
  getPluginStorage,
  inspectPluginDirectory,
  installFromDirectory,
  listPlugins,
  readPluginRuntime,
  setPluginEnabled,
  setPluginStorage,
  uninstallPlugin
} from '../src/main/plugins/store'
import { extractZip } from '../src/main/plugins/zip'
import {
  installMarketPlugin,
  listMarket,
  normalizeMarketIndex
} from '../src/main/plugins/marketplace'

const root = process.cwd()
const temp = mkdtempSync(join(tmpdir(), 'ccoder-plugins-'))
const ctx: PluginHostContext = {
  root: join(temp, 'plugins'),
  dataRoot: join(temp, 'plugin-data'),
  statePath: join(temp, 'plugins-state.json'),
  appVersion: '1.2.24',
  devMarketIndex: join(root, 'docs', 'plugins', 'index.json'),
  preferDevMarket: true
}

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

try {
  console.log('plugin store')
  const healthDir = join(root, 'docs', 'plugins', 'examples', 'ccoder-demo-health')
  const installed = installFromDirectory(ctx, healthDir)
  check('install local js plugin', installed.ok, installed.error)
  check('list has one plugin', installed.list.plugins.length === 1)
  check('plugin is enabled', installed.list.plugins[0]?.enabled === true)
  check(
    'contributions exposed',
    (installed.list.plugins[0]?.permissions.length ?? 0) > 0
  )

  const preview = inspectPluginDirectory(ctx, healthDir)
  check('inspect local manifest', preview.ok && preview.manifest?.id === 'ccoder-demo-health')
  check('inspect local size', (preview.size ?? 0) > 0)

  const runtime = readPluginRuntime(ctx, 'ccoder-demo-health')
  check('runtime loaded', !!runtime)
  check('main.js text present', !!runtime?.main && runtime.main.includes('activate'))
  check('css runtime null (no styles.css)', runtime?.css === null)

  setPluginStorage(ctx, 'ccoder-demo-health', 'note', 'hello')
  const stored = getPluginStorage(ctx, 'ccoder-demo-health', 'note')
  check('storage roundtrip', stored.ok && stored.value === 'hello')
  deletePluginStorage(ctx, 'ccoder-demo-health', 'note')
  check('storage delete', getPluginStorage(ctx, 'ccoder-demo-health', 'note').value === null)

  const disabled = setPluginEnabled(ctx, 'ccoder-demo-health', false)
  check('disable plugin', disabled.ok)
  check('runtime null when disabled', readPluginRuntime(ctx, 'ccoder-demo-health') === null)
  check('enable plugin', setPluginEnabled(ctx, 'ccoder-demo-health', true).ok)

  console.log('zip extraction')
  const zipPath = join(root, 'docs', 'plugins', 'artifacts', 'ccoder-demo-health-0.1.0.zip')
  const unzipped = join(temp, 'unzipped')
  extractZip(readFileSync(zipPath), unzipped)
  check('extract zip', existsSync(join(unzipped, 'manifest.json')))
  check('extract main.js', existsSync(join(unzipped, 'main.js')))

  const marqueeZip = join(
    root,
    'docs',
    'plugins',
    'artifacts',
    'ccoder-composer-marquee-0.1.0.zip'
  )
  const marqueeUnzipped = join(temp, 'marquee-unzipped')
  extractZip(readFileSync(marqueeZip), marqueeUnzipped)
  check('extract marquee manifest', existsSync(join(marqueeUnzipped, 'manifest.json')))
  check(
    'marquee css targets running state',
    readFileSync(join(marqueeUnzipped, 'styles.css'), 'utf8').includes(':has(.send.is-stop)')
  )

  console.log('market')
  const rawIndex = JSON.parse(
    readFileSync(join(root, 'docs', 'plugins', 'index.json'), 'utf8')
  ) as unknown
  const index = normalizeMarketIndex(rawIndex)
  check('normalize index', !!index && index.plugins.length === 3)
  check('index fields', index?.plugins[0]?.versions[0]?.sha256?.length === 64)
  const marquee = index?.plugins.find((p) => p.id === 'ccoder-composer-marquee')
  check(
    'marquee market entry',
    marquee?.versions[0]?.tier === 'declarative' &&
      marquee.versions[0].permissions.length === 0
  )

  void listMarket(ctx, true).then(async (market) => {
    check('market fallback index', market.ok, market.error)
    check('market source is file', market.source.startsWith('file://'))
    const marketInstall = await installMarketPlugin(ctx, 'ccoder-demo-theme')
    check('market install from file url', marketInstall.ok, marketInstall.error)
    check(
      'market plugin listed',
      marketInstall.list.plugins.some((p) => p.id === 'ccoder-demo-theme')
    )

    const marqueeInstall = await installMarketPlugin(ctx, 'ccoder-composer-marquee')
    check('market install marquee', marqueeInstall.ok, marqueeInstall.error)
    const marqueeRuntime = readPluginRuntime(ctx, 'ccoder-composer-marquee')
    check(
      'marquee css loaded',
      !!marqueeRuntime?.css?.includes(':has(.send.is-stop)')
    )

    const removed = uninstallPlugin(ctx, 'ccoder-demo-health')
    check('uninstall plugin', removed.ok)
    check(
      'plugin removed from list',
      !removed.list.plugins.some((p) => p.id === 'ccoder-demo-health')
    )

    if (failures > 0) {
      console.error(`\n${failures} check(s) failed`)
      process.exitCode = 1
    } else {
      console.log('\nall plugin checks passed')
    }
    if (!process.env.KEEP_PLUGIN_TMP) rmSync(temp, { recursive: true, force: true })
  })
} catch (e) {
  console.error(e)
  process.exitCode = 1
  if (!process.env.KEEP_PLUGIN_TMP) rmSync(temp, { recursive: true, force: true })
}
