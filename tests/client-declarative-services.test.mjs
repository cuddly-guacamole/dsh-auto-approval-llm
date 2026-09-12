// The client approval watcher used to reach `uiSession.pendingInteractions`
// through a bounded 500ms×30 probe loop, because the service is a browser-side
// dynamic package that may register after the plugin mounts. The migration
// declares the services as inject dependencies instead: cordis holds the
// plugin pending until each one is observable, so the probe window (and its
// give-up / visibility-re-probe machinery) is retired.
//
// Two failure modes are pinned here: the declaration must name the services the
// watcher actually resolves, and no probe symbol may survive in source or in
// the compiled watcher.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { watchRemoteApprovals } from '../lib/client/approvals/remote.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entrySource = readFileSync(join(root, 'src/client/index.ts'), 'utf8')
const remoteSource = readFileSync(join(root, 'src/client/approvals/remote.ts'), 'utf8')
const remoteBundle = readFileSync(join(root, 'lib/client/approvals/remote.js'), 'utf8')

const RETIRED_PROBE_SYMBOLS = [
  'startProbing',
  'armVisibilityProbe',
  'clearProbeTimer',
  'detachVisibilityProbe',
  'retryTimer',
  'gaveUp',
  'armOnce',
  'retryMs',
  'maxRetries',
  'UI_SESSION_MAX_RETRIES',
  'UI_SESSION_RETRY_MS',
]

test('the client entry declares the approval services it resolves', () => {
  const match = /export const inject = \[([^\]]*)\]/.exec(entrySource)
  assert.ok(match, 'the entry must declare inject')
  const inject = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  for (const service of ['sessions', 'remote', 'uiSession', 'slots']) {
    assert.ok(inject.includes(service), `${service} must be a declared inject dependency`)
  }
  assert.equal(new Set(inject).size, inject.length, 'no duplicate declarations')
})

test('the watcher binds pendingInteractions without any probe interval', () => {
  assert.ok(remoteSource.includes("ctx.get('uiSession')"), 'the watcher resolves uiSession from the container')
  assert.ok(!remoteSource.includes('setInterval'), 'no interval may stand between apply and subscribe')
  assert.ok(!remoteSource.includes('visibilitychange'), 'the visibility re-probe must be gone')
  assert.ok(remoteBundle.includes('pendingInteractions'), 'the compiled watcher still binds the snapshot service')
})

test('no retired probe symbol survives in the watcher, source or bundle', () => {
  for (const [where, text] of [['source', remoteSource], ['bundle', remoteBundle]]) {
    for (const symbol of RETIRED_PROBE_SYMBOLS) {
      assert.ok(!text.includes(symbol), `${where}: retired probe symbol ${symbol} must not survive`)
    }
  }
})

test('a protocol without uiSession warns once instead of idling in silence', () => {
  const warns = []
  const originalWarn = console.warn
  console.warn = (...args) => { warns.push(args.join(' ')) }
  try {
    const never = () => null
    const fakeCtx = { get: () => undefined, effect: () => never }
    watchRemoteApprovals(fakeCtx)
    assert.equal(warns.length, 1, 'exactly one warn breaks the silence')
    assert.ok(warns[0].includes('uiSession.pendingInteractions unavailable'), 'the warn names the missing service')
    assert.ok(warns[0].includes('auto-close disabled'), 'the warn states the consequence')
  } finally {
    console.warn = originalWarn
  }
})

test('the watcher subscribes on apply when the service is present', () => {
  let subscribed = false
  const never = () => null
  const fakeCtx = {
    get: (name) => name === 'uiSession'
      ? { pendingInteractions: { getSnapshot: () => new Map(), subscribe: () => { subscribed = true; return never } } }
      : undefined,
    effect: () => never,
  }
  watchRemoteApprovals(fakeCtx)
  assert.equal(subscribed, true, 'the watcher must subscribe at apply, with no probe delay')
})
