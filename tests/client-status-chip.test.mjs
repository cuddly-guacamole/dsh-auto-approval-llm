// Client approval status chip.
//
// The countdown used to be written into the official panel buttons: the client
// matched the buttons by their localized labels ("拒绝"/"Reject") and rewrote
// their text every 200ms through a document-level MutationObserver. The chip
// replaces that path with a display store fed by the host's structured
// review-status payload, so the panel keeps its own DOM and no trigger depends
// on official copy.
//
// Two failure modes matter here: the store must render the state the host
// actually published (never a locally invented one), and the retired hijack
// path must not creep back into the bundle.
import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  approvalStatusStore,
  chipState,
  coarseMinutes,
  createApprovalStatusStore,
  TERMINAL_TTL_MS,
} from '../lib/client/approvals/status-store.js'
import { startReviewPolling, FEEDBACK_ROUTE, REVIEW_STATUS_ROUTE } from '../lib/client/approvals/shared.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientBundle = readFileSync(join(root, 'lib/client.js'), 'utf8')
const sharedSource = readFileSync(join(root, 'src/client/approvals/shared.ts'), 'utf8')
const clientSource = readFileSync(join(root, 'src/client/index.ts'), 'utf8')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(cond, what, timeout = 2000) {
  const start = Date.now()
  for (;;) {
    if (cond()) return
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for: ${what}`)
    await sleep(5)
  }
}

// ── store semantics ───────────────────────────────────────────────────────

test('an armed pending with no host status renders as waiting for a human', () => {
  const store = createApprovalStatusStore(() => 1_000)
  store.observePending('s1', 'c1')
  assert.equal(chipState(store.activeFor('s1', 1_000), 1_000, false).kind, 'awaiting')
})

test('a published countdown walks locally from its anchor', () => {
  let now = 1_000
  const store = createApprovalStatusStore(() => now)
  store.observePending('s1', 'c1')
  store.publishStatus('s1', 'c1', { phase: 'countdown', action: 'allow', seconds: 12 })
  assert.deepEqual(chipState(store.activeFor('s1', now), now, false), { kind: 'countdown', seconds: 12, coarse: false, action: 'allow' })
  now = 5_000
  assert.equal(chipState(store.activeFor('s1', now), now, false).seconds, 8)
  now = 13_000
  assert.deepEqual(chipState(store.activeFor('s1', now), now, false), { kind: 'imminent', action: 'allow' })
})

test('a countdown above the coarse threshold stops showing digits', () => {
  const now = 1_000
  const store = createApprovalStatusStore(() => now)
  store.publishStatus('s1', 'c1', { phase: 'countdown', action: 'reject', seconds: 42 })
  assert.deepEqual(chipState(store.activeFor('s1', now), now, false), { kind: 'countdown', seconds: 42, coarse: true, action: 'reject' })
  assert.equal(coarseMinutes(42), 1)
  assert.equal(coarseMinutes(181), 4)
})

test('an older revision never rewinds a newer countdown', () => {
  const now = 1_000
  const store = createApprovalStatusStore(() => now)
  store.publishStatus('s1', 'c1', { phase: 'countdown', action: 'allow', seconds: 8, revision: 4 })
  store.publishStatus('s1', 'c1', { phase: 'countdown', action: 'allow', seconds: 30, revision: 3 })
  assert.equal(store.activeFor('s1', now).seconds, 8, 'the replayed payload must be inert')
  store.publishStatus('s1', 'c1', { phase: 'countdown', action: 'allow', seconds: 5, revision: 5 })
  assert.equal(store.activeFor('s1', now).seconds, 5, 'a newer revision re-anchors')
})

test('the host published remaining time wins over the rounded seconds field', () => {
  const now = 1_000
  const store = createApprovalStatusStore(() => now)
  store.publishStatus('s1', 'c1', { phase: 'countdown', action: 'allow', seconds: 30, remainingMs: 4_500, revision: 1 })
  assert.equal(chipState(store.activeFor('s1', now), now, false).seconds, 5)
})

test('each follow source maps to its own settled chip state', () => {
  const store = createApprovalStatusStore(() => 1_000)
  const cases = [
    [{ source: 'llm', action: 'allow' }, { kind: 'allowed', by: 'llm' }],
    [{ source: 'llm', action: 'reject' }, { kind: 'rejected', by: 'llm' }],
    [{ source: 'timeout', action: 'allow' }, { kind: 'timeout', action: 'allow' }],
    [{ source: 'timeout', action: 'reject' }, { kind: 'timeout', action: 'reject' }],
    [{ source: 'human', action: 'allow' }, { kind: 'human' }],
    [{ source: 'abort', action: 'reject' }, { kind: 'cancelled' }],
    [{ action: 'reject' }, { kind: 'rejected', by: 'host' }],
  ]
  for (const [status, expected] of cases) {
    store.resolve('s1', 'c1', status.source, status.action)
    assert.deepEqual(chipState(store.activeFor('s1', 1_000), 1_000, false), expected, JSON.stringify(status))
    store.clearSession('s1')
  }
})

test('a settled ask stays readable for a bounded window, then clears', () => {
  let now = 1_000
  const store = createApprovalStatusStore(() => now)
  store.observePending('s1', 'c1')
  store.publishStatus('s1', 'c1', { phase: 'countdown', action: 'allow', seconds: 5 })
  store.resolve('s1', 'c1', 'llm', 'allow')
  now = 1_000 + TERMINAL_TTL_MS
  assert.equal(chipState(store.activeFor('s1', now), now, false).kind, 'allowed')
  now = 1_000 + TERMINAL_TTL_MS + 1
  assert.equal(chipState(store.activeFor('s1', now), now, false).kind, 'empty')
})

test('a poll that briefly misses the countdown does not repaint the chip', () => {
  // Observed live: the panel appeared ~8s into a locked-category countdown and
  // the chip flicked to "waiting for a human" for one poll before returning to
  // the countdown, because the poller confirmed "no countdown" over a record
  // that already carried one.
  let now = 1_000
  const store = createApprovalStatusStore(() => now)
  store.observePending('s1', 'c1')
  store.publishStatus('s1', 'c1', { phase: 'countdown', action: 'reject', seconds: 10 })
  store.confirmAwaiting('s1', 'c1')
  assert.equal(chipState(store.activeFor('s1', now), now, false).kind, 'countdown')
  // The watcher re-observing the same ask when its panel appears must not
  // downgrade the running countdown either (the other half of the same bug).
  store.observePending('s1', 'c1')
  assert.equal(chipState(store.activeFor('s1', now), now, false).kind, 'countdown')
  // An ask that never published a countdown still reports waiting for a human.
  store.dropPending('s1', 'c1')
  now = 2_000
  store.observePending('s1', 'c2')
  store.confirmAwaiting('s1', 'c2')
  assert.equal(chipState(store.activeFor('s1', now), now, false).kind, 'awaiting')
})

test('a finished ask is not revived by the host still listing it', () => {
  // The host keeps a settled ask in its session list for its own retention
  // window. Without the tombstone the discovery poll rebuilds the record every
  // window and the same outcome blinks for minutes (observed live).
  let now = 1_000
  const store = createApprovalStatusStore(() => now)
  store.resolve('s1', 'c1', 'llm', 'allow')
  now += TERMINAL_TTL_MS + 1
  assert.equal(chipState(store.activeFor('s1', now), now, false).kind, 'empty')
  store.resolve('s1', 'c1', 'llm', 'allow')
  store.publishStatus('s1', 'c1', { phase: 'countdown', action: 'allow', seconds: 6 })
  store.observePending('s1', 'c1')
  assert.equal(chipState(store.activeFor('s1', now), now, false).kind, 'empty', 'the shown outcome must not come back')
  // A different ask in the same session is unaffected.
  store.resolve('s1', 'c2', 'timeout', 'reject')
  assert.equal(chipState(store.activeFor('s1', now), now, false).kind, 'timeout')
  // Leaving the session must not release the memory either: the host keeps
  // listing the settled ask, so coming back within its window would light the
  // same outcome up again.
  store.clearSession('s1')
  store.resolve('s1', 'c1', 'llm', 'allow')
  assert.equal(chipState(store.activeFor('s1', now), now, false).kind, 'empty')
})

test('an open ask leaves the chip when its pending goes away', () => {
  let now = 1_000
  const store = createApprovalStatusStore(() => now)
  store.publishStatus('s1', 'c1', { phase: 'countdown', action: 'allow', seconds: 9 })
  store.dropPending('s1', 'c1')
  assert.equal(chipState(store.activeFor('s1', now), now, false).kind, 'empty')
  // A settled record keeps its window instead: the panel closing is exactly
  // when the chip has to stay readable.
  store.resolve('s1', 'c2', 'llm', 'reject')
  store.dropPending('s1', 'c2')
  assert.equal(chipState(store.activeFor('s1', now), now, false).kind, 'rejected')
})

test('offline freezes the last confirmed remaining instead of walking the clock', () => {
  let now = 1_000
  const store = createApprovalStatusStore(() => now)
  store.publishStatus('s1', 'c1', { phase: 'countdown', action: 'allow', seconds: 20 })
  now = 9_000
  const live = chipState(store.activeFor('s1', now), now, false)
  assert.equal(live.seconds, 12)
  assert.deepEqual(chipState(store.activeFor('s1', now), now + 60_000, true), { kind: 'offline', seconds: 20, action: 'allow' })
})

test('a live ask outranks a settled one while both are on the chip', () => {
  const now = 1_000
  const store = createApprovalStatusStore(() => now)
  store.resolve('s1', 'old', 'llm', 'allow')
  store.publishStatus('s1', 'new', { phase: 'countdown', action: 'allow', seconds: 7 })
  assert.equal(chipState(store.activeFor('s1', now), now, false).kind, 'countdown')
})

test('the breaker flag wins over the waiting state', () => {
  const now = 1_000
  const store = createApprovalStatusStore(() => now)
  store.observePending('s1', 'c1', true)
  assert.equal(chipState(store.activeFor('s1', now), now, false).kind, 'breaker')
})

test('subscribers are notified on every publish and released on unsubscribe', () => {
  const store = createApprovalStatusStore(() => 1_000)
  let hits = 0
  const unsubscribe = store.subscribe(() => { hits += 1 })
  store.publishStatus('s1', 'c1', { phase: 'countdown', action: 'allow', seconds: 3 })
  assert.equal(hits, 1)
  unsubscribe()
  store.resolve('s1', 'c1', 'llm', 'allow')
  assert.equal(hits, 1, 'a released listener must not be called again')
})

// ── wiring: the poller feeds the store (not just the store in isolation) ──

const originalFetch = globalThis.fetch
beforeEach(() => { globalThis.fetch = originalFetch })
after(() => { globalThis.fetch = originalFetch })

test('the poller mirrors the host payload into the chip store, then settles it', async (t) => {
  const sessionId = 'chip-wiring-session'
  let status = { phase: 'countdown', action: 'allow', seconds: 9, revision: 1 }
  const answered = []
  globalThis.fetch = async (url, init) => {
    if (url === REVIEW_STATUS_ROUTE) {
      return { ok: true, json: async () => ({ ok: true, value: status }) }
    }
    if (url === FEEDBACK_ROUTE) {
      answered.push(JSON.parse(init.body))
      return { ok: true, json: async () => ({ ok: true }) }
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
  const poller = startReviewPolling(
    { sessionId, key: `${sessionId}:call-1`, callId: 'call-1', respond: async () => { answered.push('responded') } },
    () => true,
    { pollMs: 20 },
  )
  t.after(() => {
    poller.dispose()
    approvalStatusStore.clearSession(sessionId)
  })

  await until(() => approvalStatusStore.activeFor(sessionId, Date.now())?.phase === 'countdown', 'countdown record')
  const record = approvalStatusStore.activeFor(sessionId, Date.now())
  assert.equal(record.seconds, 9, 'the chip shows what the host published')
  assert.equal(record.action, 'allow')

  status = { phase: 'follow', action: 'allow', source: 'llm' }
  await until(() => approvalStatusStore.activeFor(sessionId, Date.now())?.phase === 'follow', 'terminal record')
  const settled = approvalStatusStore.activeFor(sessionId, Date.now())
  assert.equal(settled.source, 'llm')
  await until(() => answered.includes('responded'), 'the poller still answers the approval')
})

test('a status-less ask lands on the chip as waiting for a human', async (t) => {
  const sessionId = 'chip-awaiting-session'
  // The watcher registers the pending before the poller runs; the poller only
  // has to confirm that the host published no countdown for it.
  approvalStatusStore.observePending(sessionId, 'call-2')
  globalThis.fetch = async (url) => {
    if (url === REVIEW_STATUS_ROUTE) return { ok: true, json: async () => ({ ok: false }) }
    throw new Error(`unexpected fetch: ${url}`)
  }
  const poller = startReviewPolling(
    { sessionId, key: `${sessionId}:call-2`, callId: 'call-2', respond: async () => {} },
    () => true,
    { pollMs: 20 },
  )
  t.after(() => {
    poller.dispose()
    approvalStatusStore.clearSession(sessionId)
  })
  await until(() => approvalStatusStore.activeFor(sessionId, Date.now())?.awaiting === true, 'awaiting record')
})

// ── retirement anchors ────────────────────────────────────────────────────

test('the retired button-hijack path leaves no trace in source or bundle', () => {
  for (const [where, text] of [['bundle', clientBundle], ['source', clientSource]]) {
    for (const gone of ['hijackApprovalButtons', 'updatePanel', 'parseCountdown', 'setInterval(apply']) {
      assert.ok(!text.includes(gone), `${where}: retired symbol ${gone} must not survive`)
    }
  }
  // The breaker guard still finds the official buttons by their localized
  // labels (it has to disable them), so the regex survives in the shared core;
  // what must be gone is the retired panel-side copy in the client entry.
  assert.ok(!/拒绝\|Reject/.test(clientSource), 'the panel-side button-label regex must be gone from the entry')
  assert.ok(!sharedSource.includes('export function parseCountdown'), 'the countdown text parser must be gone')
  assert.ok(!sharedSource.includes('formatCountdownSuffix'), 'the button suffix formatter must be gone')
})

test('the session control carries the status label and owns no separate surface', () => {
  assert.ok(clientSource.includes("'conversation.session.header.utilities'"), 'the header slot must be used')
  assert.ok(clientSource.includes('dsa-sessionSplit'), 'the control must render as a split control')
  assert.ok(clientSource.includes('dsa-sessionChevron'), 'the chevron must own the history overlay')
  assert.ok(clientSource.includes("const controlLabel = statusLabel ?? t('panel.button')"), 'idle must fall back to the control name')
  assert.ok(clientBundle.includes('dsa-sessionSplit'), 'the split styles must ship in the bundle')
  assert.ok(!clientSource.includes("id: 'auto-approval-llm-status-chip'"), 'the standalone chip must be gone')
  assert.ok(!clientSource.includes("'conversation.input.dock'"), 'the composer-dock capsule must be gone')
})

test('the surviving panel decorations are still mounted (no over-deletion)', () => {
  assert.ok(clientSource.includes('function installApprovalPanelDecorations'), 'the decoration pass must remain')
  assert.ok(clientSource.includes('if (hasBreakerNote(text)) breaker.apply(panel, key)'), 'the breaker guard must still arm from the marker')
  assert.ok(clientSource.includes('breaker.prune(liveKeys)'), 'the breaker sweep must remain')
  assert.ok(clientSource.includes('createTrailingThrottle(scan'), 'the throttled scan must remain')
  assert.ok(clientSource.includes('data-dsa-edit-diff'), 'the edit-diff preview must remain')
  assert.ok(!clientSource.includes('const intervals = new Map'), 'the per-panel interval registry must be gone')
})
