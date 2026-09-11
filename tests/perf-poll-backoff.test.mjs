/**
 * dsh-auto-approval-llm · review-status poller failure backoff.
 *
 * The poller used to keep the base cadence through any failure: `!res.ok` and a
 * thrown fetch both returned into a `setInterval` that never slowed down, so a
 * broken route left every pending approval issuing 2 requests/second forever.
 *
 * Backoff is deliberately one-directional: it slows the cadence, it never stops
 * observing, and it never resolves an approval. The negative cases below pin
 * exactly that — a delay that reaches zero, or a poller that gives up after N
 * failures, must fail this file.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  startReviewPolling,
  nextPollDelayMs,
  MAX_POLL_BACKOFF_MS,
  REVIEW_STATUS_ROUTE,
} from '../lib/client/approvals/shared.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(cond, what, timeout = 3000) {
  const start = Date.now()
  for (;;) {
    if (cond()) return
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for: ${what}`)
    await sleep(10)
  }
}

/** Route stub whose health flips at will; records every request. */
function flakyFetch(log, isDown) {
  return async (url, init) => {
    log.push({ url, init, at: Date.now() })
    if (url !== REVIEW_STATUS_ROUTE) throw new Error(`unexpected fetch: ${url}`)
    if (isDown()) return { ok: false }
    return { ok: true, json: async () => ({ ok: true, value: { phase: 'countdown', action: 'reject', seconds: 30 } }) }
  }
}

function handle() {
  return { sessionId: 's1', key: 's1:c1', callId: 'c1', respond: async () => {} }
}

test('nextPollDelayMs: exponential from the base cadence, capped', () => {
  assert.equal(nextPollDelayMs(0, 500, 5_000), 500)
  assert.equal(nextPollDelayMs(1, 500, 5_000), 1_000)
  assert.equal(nextPollDelayMs(2, 500, 5_000), 2_000)
  assert.equal(nextPollDelayMs(3, 500, 5_000), 4_000)
  assert.equal(nextPollDelayMs(4, 500, 5_000), 5_000)
  assert.equal(nextPollDelayMs(10, 500, 5_000), 5_000)
})

test('nextPollDelayMs: the delay is always positive and capped (never stops observing)', () => {
  for (const failures of [1, 2, 3, 5, 20, 100, 1_000]) {
    const delay = nextPollDelayMs(failures, 200, MAX_POLL_BACKOFF_MS)
    assert.ok(delay > 0, `delay must stay positive at ${failures} failures`)
    assert.ok(delay <= MAX_POLL_BACKOFF_MS, `delay must stay capped at ${failures} failures`)
  }
})

test('nextPollDelayMs: degenerate inputs fall back to the base cadence, never NaN', () => {
  // Anything that is not a positive count is "no failures yet".
  for (const failures of [0, -1, -1_000, Number.NaN]) {
    assert.equal(nextPollDelayMs(failures, 500, 5_000), 500, `failures=${failures} must mean the base cadence`)
  }
  // A count large enough to overflow the exponent still returns a finite,
  // capped value rather than Infinity.
  const huge = nextPollDelayMs(Number.POSITIVE_INFINITY, 500, 5_000)
  assert.ok(Number.isFinite(huge) && huge === 5_000, `expected the cap, got ${huge}`)
  const over = nextPollDelayMs(1_000, 500, 5_000)
  assert.ok(Number.isFinite(over) && over === 5_000)
})

test('integration: a failing route is polled with declining frequency', async (t) => {
  const log = []
  let down = false
  globalThis.fetch = flakyFetch(log, () => down)
  const poller = startReviewPolling(handle(), () => true, { pollMs: 20 })
  t.after(() => poller.dispose())

  // Baseline in the same window on a healthy route: the interval alone issues
  // roughly one request per pollMs. Measured here rather than assumed so the
  // comparison below cannot pass vacuously against a changed pollMs.
  await until(() => log.length >= 5, 'the healthy cadence was observed')
  const healthyFrom = log.length
  await sleep(400)
  const healthy = log.length - healthyFrom
  assert.ok(healthy >= 10, `baseline cadence too low to compare (${healthy})`)

  // Same window with the route failing: the cadence must decline sharply.
  down = true
  await until(() => log.length >= healthyFrom + healthy + 3, 'the first failures were observed')
  const failingFrom = log.length
  await sleep(400)
  const failing = log.length - failingFrom

  assert.ok(failing <= 6, `expected the cadence to decline, added ${failing} requests in 400ms`)
  assert.ok(failing * 2 < healthy, `failing cadence ${failing} must be well below healthy ${healthy}`)
})

test('integration: observation continues through a long outage (never gives up)', async (t) => {
  const log = []
  globalThis.fetch = flakyFetch(log, () => true)
  const poller = startReviewPolling(handle(), () => true, { pollMs: 20 })
  t.after(() => poller.dispose())

  // The demand behind "back off, never stop": an outage long enough to climb
  // several backoff steps must still produce new requests. Waiting for a count
  // past the first few failures is what gives this teeth — an implementation
  // that observed briefly and then gave up (leaving the approval to the grace
  // timer) would never reach it and would time out here.
  await until(() => log.length >= 8, 'observation continued across several backoff steps', 10_000)
  assert.ok(log.length >= 8, 'the poller must keep observing while the route stays down')
})

test('integration: pollNow still realigns during a hold-off', async (t) => {
  const log = []
  globalThis.fetch = flakyFetch(log, () => true)
  const poller = startReviewPolling(handle(), () => true, { pollMs: 20 })
  t.after(() => poller.dispose())

  // Climb to a hold-off far longer than the 200ms pollNow gap, so a request
  // issued right after the call can only come from the forced path.
  await until(() => log.length >= 6, 'the hold-off grew past the pollNow gap')
  await sleep(210)
  const before = log.length
  poller.pollNow()
  await until(() => log.length > before, 'pollNow issued a request despite the hold-off', 150)
})

test('integration: a recovered route returns to the base cadence', async (t) => {
  const log = []
  let down = true
  globalThis.fetch = flakyFetch(log, () => down)
  const poller = startReviewPolling(handle(), () => true, { pollMs: 20 })
  t.after(() => poller.dispose())

  await until(() => log.length >= 3, 'the first failures were observed')
  const before = log.length
  down = false
  // Recovery must not wait out a grown delay: the first success resets it.
  await until(() => log.length >= before + 2, 'polling resumed after recovery', 2_000)
})
