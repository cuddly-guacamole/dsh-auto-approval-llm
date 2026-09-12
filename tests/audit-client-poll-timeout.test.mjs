/**
 * A review-status request that never settles used to hold the poller's
 * `inFlight` guard for the rest of the tab's life: the interval kept ticking,
 * every tick declined, and the ask could no longer be observed or answered —
 * the official panel then stayed open until the host timer resolved it. The one
 * request is now bounded, so a hung connection costs one poll instead of the
 * watcher.
 * Run: node --test tests/audit-client-poll-timeout.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { startReviewPolling, pollAbortSignal, POLL_TIMEOUT_MARGIN_MS } from '../lib/client/approvals/shared.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(5)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** fetch stub: the first call hangs until its own AbortSignal fires. */
function hangingFirstFetch(onRequest) {
  let calls = 0
  return async (url, init) => {
    calls += 1
    onRequest(calls, init)
    if (calls === 1) {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: { phase: 'follow', source: 'timeout', action: 'reject', seconds: 0 } }),
    }
  }
}

test('a hung review-status request does not wedge the poller', async (t) => {
  const originalFetch = globalThis.fetch
  const requestInits = []
  globalThis.fetch = hangingFirstFetch((call, init) => requestInits.push(init))
  t.after(() => { globalThis.fetch = originalFetch })
  const responds = []
  const handle = { sessionId: 's1', key: 's1:c1', callId: 'c1', respond: async (outcome) => { responds.push(outcome) } }
  const poller = startReviewPolling(handle, () => true, { pollMs: 10, pollTimeoutMs: 40 })
  t.after(() => poller.dispose())
  await until(() => responds.length > 0, 'the follow to be answered after the hung request aborted')
  assert.deepEqual(responds, ['rejected'])
  assert.equal(requestInits.length >= 1, true)
  assert.ok(requestInits[0].signal instanceof AbortSignal, 'every poll carries an abort signal')
  assert.equal(requestInits[0].signal.aborted, true, 'the hung request was aborted')
})

test('pollAbortSignal bounds a request and defaults leave slack over the long poll', () => {
  const signal = pollAbortSignal(15)
  assert.ok(signal instanceof AbortSignal)
  assert.equal(signal.aborted, false)
  assert.ok(POLL_TIMEOUT_MARGIN_MS >= 1_000, 'the margin must cover a long poll that answers at its own budget')
})

test('both pollers bound their request (bundle anchors)', () => {
  const shared = readFileSync(fileURLToPath(new URL('../lib/client/approvals/shared.js', import.meta.url)), 'utf8')
  const watch = readFileSync(fileURLToPath(new URL('../lib/client/approvals/session-watch.js', import.meta.url)), 'utf8')
  assert.match(shared, /signal: pollAbortSignal\(pollTimeoutMs\)/, 'the per-approval poller bounds its request')
  assert.match(watch, /signal: pollAbortSignal\(pollTimeoutMs\)/, 'the session watcher bounds its request')
})
