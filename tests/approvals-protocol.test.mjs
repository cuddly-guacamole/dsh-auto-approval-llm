/**
 * Client approval responder contract tests.
 *
 * Covers the protocol-agnostic core (shared.ts), the remote protocol adapter
 * (`pendingInteractions`) and the static wiring anchors. All watcher flows
 * run against the compiled lib/ output with injected poll/grace timings and
 * a stubbed fetch (review-status routed per callId; FEEDBACK body asserted).
 */
import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  parseCountdown,
  canonicalPendingKey,
  answerOnce,
  startReviewPolling,
  createBreakerGuard,
  computeTextNodeRewrites,
  answeredApprovals,
  FEEDBACK_ROUTE,
  REVIEW_STATUS_ROUTE,
} from '../lib/client/approvals/shared.js'
import { watchRemoteApprovals } from '../lib/client/approvals/remote.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(cond, what, timeout = 2000) {
  const start = Date.now()
  for (;;) {
    if (cond()) return
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for: ${what}`)
    await sleep(10)
  }
}

const originalFetch = globalThis.fetch
beforeEach(() => {
  answeredApprovals.clear()
  globalThis.fetch = originalFetch
})
after(() => {
  globalThis.fetch = originalFetch
})

/**
 * fetch stub for the two plugin routes.
 * statusByCallId: callId → review-status value; 'down' simulates an HTTP
 *   failure (transient — keep observing); absent → HTTP 200 body {ok:false}
 *   (host-side resolution signal → undefined status).
 */
function routeFetch({ statusByCallId = {}, feedbackLog = [], fetchLog = [] } = {}) {
  return async (url, init) => {
    fetchLog.push({ url, init })
    if (url === REVIEW_STATUS_ROUTE) {
      const callId = init?.headers?.['x-auto-approval-call-id']
      const value = statusByCallId[callId]
      if (value === 'down') return { ok: false }
      return { ok: true, json: async () => (value === undefined ? { ok: false } : { ok: true, value }) }
    }
    if (url === FEEDBACK_ROUTE) {
      feedbackLog.push(JSON.parse(init.body))
      return { ok: true, json: async () => ({ ok: true }) }
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
}

/**
 * fetch stub for the plugin routes that also records how many review-status
 * fetches are in flight at once (probe.peak) and can delay each response —
 * reproduces F4: a response slower than pollMs let every interval tick stack
 * a second request for the same callId (multi-request storm). With the
 * in-flight guard, probe.peak must stay 1 even under bursts.
 */
function slowReviewFetch({ statusByCallId = {}, delayMs = 0, feedbackLog = [] } = {}) {
  const probe = { active: 0, peak: 0, calls: [] }
  const fn = async (url, init) => {
    probe.active++
    probe.peak = Math.max(probe.peak, probe.active)
    probe.calls.push({ url, init })
    try {
      if (url === REVIEW_STATUS_ROUTE) {
        if (delayMs) await sleep(delayMs)
        const callId = init?.headers?.['x-auto-approval-call-id']
        const value = statusByCallId[callId]
        if (value === 'down') return { ok: false }
        return { ok: true, json: async () => (value === undefined ? { ok: false } : { ok: true, value }) }
      }
      if (url === FEEDBACK_ROUTE) {
        feedbackLog.push(JSON.parse(init.body))
        return { ok: true, json: async () => ({ ok: true }) }
      }
      throw new Error(`unexpected fetch: ${url}`)
    } finally {
      probe.active--
    }
  }
  return { fn, probe }
}

function fakeCtx(services = {}) {
  const disposers = []
  return {
    ctx: {
      get: (name) => services[name],
      effect: (fn) => {
        const d = fn()
        if (typeof d === 'function') disposers.push(d)
      },
    },
    cleanup() {
      for (const d of disposers.splice(0)) d()
    },
  }
}

function fakeRemoteEnv() {
  const subs = new Set()
  let map = new Map()
  return {
    uiSession: {
      pendingInteractions: {
        getSnapshot: () => map,
        subscribe: (fn) => {
          subs.add(fn)
          return () => subs.delete(fn)
        },
      },
    },
    setMap: (m) => {
      map = m
      for (const fn of [...subs]) fn()
    },
  }
}

// ── pure functions ─────────────────────────────────────────────────────────

test('parseCountdown: real host marker parses with action mapping and seconds floor', () => {
  assert.deepEqual(parseCountdown('[dsh-auto-approval-llm] ⏳ will auto-approve in 42s'), { seconds: 42, action: 'allow' })
  assert.deepEqual(parseCountdown('[dsh-auto-approval-llm] ⏳ will auto-reject in 7s'), { seconds: 7, action: 'reject' })
  // The host appends "if no response" after the seconds; the parser anchors on
  // the marker prefix and keeps matching (same as pre-0.0.12).
  assert.deepEqual(parseCountdown('[dsh-auto-approval-llm] ⏳ will auto-approve in 10s if no response'), { seconds: 10, action: 'allow' })
  // 0s normalizes to 1s so the hijack countdown never freezes at 0.
  assert.equal(parseCountdown('[dsh-auto-approval-llm] ⏳ will auto-approve in 0s').seconds, 1)
  assert.equal(parseCountdown('[dsh-auto-approval-llm] ⏳ will auto-reject in 00s').seconds, 1)
})

test('parseCountdown: absent marker or non-matching shape returns null', () => {
  assert.equal(parseCountdown(undefined), null)
  assert.equal(parseCountdown(''), null)
  assert.equal(parseCountdown('will auto-approve in 10s'), null, 'bare text without the marker prefix is not anchored')
  assert.equal(parseCountdown('[dsh-auto-approval-llm] will auto-approve in 10s'), null, 'missing ⏳ is not anchored')
  assert.equal(parseCountdown('[dsh-auto-approval-llm] ⏳ will auto-approve in 10 seconds'), null)
  assert.equal(parseCountdown('[dsh-auto-approval-llm] ⏳ will maybe-approve in 10s'), null)
})

test('canonicalPendingKey: sessionId:callId, null without callId', () => {
  assert.equal(canonicalPendingKey('s1', 'c1'), 's1:c1')
  assert.equal(canonicalPendingKey('s1', undefined), null)
  assert.equal(canonicalPendingKey('s1', ''), null)
})

// ── answerOnce ─────────────────────────────────────────────────────────────

test('answerOnce: posts FEEDBACK (auto:true) then responds; the guard blocks a second answer', async () => {
  const feedbackLog = []
  globalThis.fetch = routeFetch({ feedbackLog })
  const responds = []
  const handle = { sessionId: 's1', key: 's1:c1', callId: 'c1', respond: async (o) => { responds.push(o) } }
  await answerOnce(handle, 'allowed-once')
  await answerOnce(handle, 'allowed-once')
  await answerOnce(handle, 'rejected')
  assert.deepEqual(responds, ['allowed-once'], 'only the first responder wins')
  assert.equal(feedbackLog.length, 1)
  assert.deepEqual(feedbackLog[0], { callId: 'c1', outcome: 'allowed-once', auto: true })
})

test('answerOnce: respond rejection is swallowed; no retry and no second FEEDBACK', async () => {
  const feedbackLog = []
  globalThis.fetch = routeFetch({ feedbackLog })
  let responds = 0
  const handle = {
    sessionId: 's1',
    key: 's1:c2',
    callId: 'c2',
    respond: async () => {
      responds++
      throw new Error('#settled')
    },
  }
  await answerOnce(handle, 'rejected')
  await answerOnce(handle, 'rejected')
  assert.equal(responds, 1, 'a settled approval must never be answered twice')
  assert.equal(feedbackLog.length, 1)
  assert.deepEqual(feedbackLog[0], { callId: 'c2', outcome: 'rejected', auto: true })
})

// ── startReviewPolling (state machine, injected timing) ────────────────────

test('startReviewPolling: status-less handle (no callId) never polls', async () => {
  const fetchLog = []
  globalThis.fetch = routeFetch({ fetchLog })
  const poller = startReviewPolling({ sessionId: 's1', key: null }, () => true, { pollMs: 10 })
  await sleep(80)
  poller.dispose()
  assert.equal(fetchLog.length, 0, 'a status-less ask must never spawn a poller')
})

test('startReviewPolling: review-status is polled per callId via header; countdown → llm follow answers', async () => {
  const statuses = { c1: { phase: 'countdown', action: 'allow', seconds: 30 } }
  const feedbackLog = []
  const fetchLog = []
  globalThis.fetch = routeFetch({ statusByCallId: statuses, feedbackLog, fetchLog })
  const responds = []
  const handle = { sessionId: 's1', key: 's1:c1', callId: 'c1', respond: async (o) => { responds.push(o) } }
  const poller = startReviewPolling(handle, () => true, { pollMs: 10 })
  await until(() => fetchLog.length >= 1, 'first poll fired')
  assert.equal(fetchLog[0].init?.headers?.['x-auto-approval-call-id'], 'c1', 'call id travels in the header')
  await sleep(40)
  statuses.c1 = { phase: 'follow', source: 'llm', action: 'allow', seconds: 0 }
  await until(() => responds.length === 1, 'follow answered')
  assert.deepEqual(responds, ['allowed-once'])
  assert.equal(feedbackLog.length, 1)
  assert.deepEqual(feedbackLog[0], { callId: 'c1', outcome: 'allowed-once', auto: true })
  poller.dispose()
})

test('startReviewPolling: human follow only detaches — no answer, no FEEDBACK, poller stops', async () => {
  const fetchLog = []
  const feedbackLog = []
  globalThis.fetch = routeFetch({ statusByCallId: { c1: { phase: 'follow', source: 'human', action: 'reject', seconds: 0 } }, feedbackLog, fetchLog })
  const responds = []
  const handle = { sessionId: 's1', key: 's1:c1', callId: 'c1', respond: async (o) => { responds.push(o) } }
  const poller = startReviewPolling(handle, () => true, { pollMs: 10 })
  await sleep(60)
  poller.dispose()
  assert.equal(responds.length, 0)
  assert.equal(feedbackLog.length, 0)
  assert.equal(fetchLog.length, 1, 'the immediate poll observed the human follow and detached')
})

test('startReviewPolling: abort follow never answers (host already settled the ask)', async () => {
  const statuses = { c1: { phase: 'countdown', action: 'allow', seconds: 30 } }
  const feedbackLog = []
  globalThis.fetch = routeFetch({ statusByCallId: statuses, feedbackLog })
  const responds = []
  const handle = { sessionId: 's1', key: 's1:c1', callId: 'c1', respond: async (o) => { responds.push(o) } }
  const poller = startReviewPolling(handle, () => true, { pollMs: 10 })
  await sleep(40)
  statuses.c1 = { phase: 'follow', source: 'abort', action: 'reject', seconds: 0 }
  await sleep(60)
  poller.dispose()
  assert.equal(responds.length, 0)
  assert.equal(feedbackLog.length, 0)
})

test('startReviewPolling: countdown action maps to the right outcome per source action', async () => {
  const statuses = { ca: { phase: 'countdown', action: 'reject', seconds: 30 }, cb: { phase: 'countdown', action: 'allow', seconds: 30 } }
  globalThis.fetch = routeFetch({ statusByCallId: statuses })
  const responds = []
  const pollerA = startReviewPolling({ sessionId: 's1', key: 's1:ca', callId: 'ca', respond: async (o) => responds.push(['ca', o]) }, () => true, { pollMs: 10 })
  const pollerB = startReviewPolling({ sessionId: 's1', key: 's1:cb', callId: 'cb', respond: async (o) => responds.push(['cb', o]) }, () => true, { pollMs: 10 })
  await sleep(30)
  statuses.ca = { phase: 'follow', source: 'timeout', action: 'reject', seconds: 0 }
  statuses.cb = { phase: 'follow', source: 'timeout', action: 'allow', seconds: 0 }
  await until(() => responds.length === 2, 'both follow answers landed')
  assert.deepEqual(responds.sort(), [['ca', 'rejected'], ['cb', 'allowed-once']])
  pollerA.dispose()
  pollerB.dispose()
})

test('startReviewPolling: status vanishes after countdown → grace fallback answers with the recorded action', async () => {
  const statuses = { c1: { phase: 'countdown', action: 'reject', seconds: 30 } }
  const feedbackLog = []
  globalThis.fetch = routeFetch({ statusByCallId: statuses, feedbackLog })
  const responds = []
  const handle = { sessionId: 's1', key: 's1:c1', callId: 'c1', respond: async (o) => { responds.push(o) } }
  const poller = startReviewPolling(handle, () => true, { pollMs: 10, graceMs: 60 })
  await sleep(50) // countdown observed; then the host stops publishing
  statuses.c1 = undefined
  const start = Date.now()
  await until(() => responds.length === 1, 'grace fallback answered')
  assert.ok(Date.now() - start >= 40, 'the fallback only fires after the grace window')
  assert.deepEqual(responds, ['rejected'])
  assert.equal(feedbackLog.length, 1)
  assert.deepEqual(feedbackLog[0], { callId: 'c1', outcome: 'rejected', auto: true })
  poller.dispose()
})

test('startReviewPolling: grace fallback skips answering when the approval already left pending', async () => {
  const statuses = { c1: { phase: 'countdown', action: 'allow', seconds: 30 } }
  const feedbackLog = []
  globalThis.fetch = routeFetch({ statusByCallId: statuses, feedbackLog })
  const responds = []
  const handle = { sessionId: 's1', key: 's1:c1', callId: 'c1', respond: async (o) => { responds.push(o) } }
  let stillPending = true
  const poller = startReviewPolling(handle, () => stillPending, { pollMs: 10, graceMs: 30 })
  await sleep(50)
  stillPending = false
  statuses.c1 = undefined
  await sleep(70)
  poller.dispose()
  assert.equal(responds.length, 0, 'the isStillPending re-check gates the recorded-action fallback')
  assert.equal(feedbackLog.length, 0)
})

test('startReviewPolling: a re-published same countdown cancels the armed grace (F2/M9)', async () => {
  const statuses = { c1: { phase: 'countdown', action: 'reject', seconds: 30 } }
  const feedbackLog = []
  globalThis.fetch = routeFetch({ statusByCallId: statuses, feedbackLog })
  const responds = []
  const handle = { sessionId: 's1', key: 's1:c1', callId: 'c1', respond: async (o) => { responds.push(o) } }
  const poller = startReviewPolling(handle, () => true, { pollMs: 10, graceMs: 60 })
  await sleep(40) // countdown observed → meta = countdown:reject:30
  statuses.c1 = undefined // status-window gap → grace armed
  await sleep(30)
  // The same countdown value is re-published while the grace is armed: a live
  // host countdown must always supersede the locally recorded action (R002),
  // so the grace has to be cancelled — even on the identical-value early
  // return. Without the fix the grace would fire mid-countdown and close the
  // official panel with the stale recorded action.
  statuses.c1 = { phase: 'countdown', action: 'reject', seconds: 30 }
  await sleep(120) // well past the 60ms grace that was armed before the re-publish
  poller.dispose()
  assert.equal(responds.length, 0, 'a cancelled grace must never answer a still-live countdown')
  assert.equal(feedbackLog.length, 0)
})

test('startReviewPolling: transient server errors keep observing and never resolve', async () => {
  const fetchLog = []
  globalThis.fetch = routeFetch({ statusByCallId: { c1: 'down' }, fetchLog })
  const responds = []
  const handle = { sessionId: 's1', key: 's1:c1', callId: 'c1', respond: async (o) => { responds.push(o) } }
  const poller = startReviewPolling(handle, () => true, { pollMs: 10 })
  await sleep(80)
  poller.dispose()
  assert.ok(fetchLog.length >= 3, 'poller keeps observing while the server is sick')
  assert.equal(responds.length, 0)
})

test('startReviewPolling: onDetach fires exactly once and late dispose is a no-op', async () => {
  const statuses = { c1: { phase: 'follow', source: 'human', action: 'reject', seconds: 0 } }
  globalThis.fetch = routeFetch({ statusByCallId: statuses })
  const detached = []
  const poller = startReviewPolling({ sessionId: 's1', key: 's1:c1', callId: 'c1', respond: async () => {} }, () => true, {
    pollMs: 10,
    onDetach: (k) => detached.push(k),
  })
  await until(() => detached.length === 1, 'detach notified the watcher')
  poller.dispose()
  poller.dispose()
  await sleep(30)
  assert.deepEqual(detached, ['s1:c1'], 'the tombstone signal fires exactly once')
})

// ── F4 in-flight guard (slow responses must never stack polls) ─────────────

test('startReviewPolling: F4 — slow responses never stack concurrent polls (pollNow burst + fast ticks)', async () => {
  // Pre-fix: every pollNow() and every 10ms interval tick entered poll() and
  // awaited the 50ms fetch concurrently — a multi-request storm for one
  // callId. The in-flight guard caps it at exactly one outstanding request.
  const { fn, probe } = slowReviewFetch({ statusByCallId: {}, delayMs: 50 })
  globalThis.fetch = fn
  const poller = startReviewPolling({ sessionId: 's1', key: 's1:c1', callId: 'c1', respond: async () => {} }, () => true, { pollMs: 10 })
  for (let i = 0; i < 20; i++) poller.pollNow()
  await sleep(250) // several interval ticks land while responses are still slow
  poller.dispose()
  assert.equal(probe.peak, 1, 'never more than one in-flight review-status request')
  assert.ok(probe.calls.length >= 4, 'the poller kept observing (guard did not stall it)')
  assert.ok(probe.calls.length < 20, 'requests were serialized, not amplified')
})

test('startReviewPolling: F4 regression — fast responses keep polling normally and the countdown → llm-follow chain answers once', async () => {
  const statuses = { c1: { phase: 'countdown', action: 'allow', seconds: 30 } }
  const feedbackLog = []
  const { fn, probe } = slowReviewFetch({ statusByCallId: statuses, delayMs: 0, feedbackLog })
  globalThis.fetch = fn
  const responds = []
  const handle = { sessionId: 's1', key: 's1:c1', callId: 'c1', respond: async (o) => { responds.push(o) } }
  const poller = startReviewPolling(handle, () => true, { pollMs: 10 })
  await until(() => probe.calls.length >= 1, 'first poll fired')
  const countBefore = probe.calls.length
  await sleep(60)
  assert.ok(probe.calls.length > countBefore, 'fast polling continues at the interval rate')
  statuses.c1 = { phase: 'follow', source: 'llm', action: 'allow', seconds: 0 }
  await until(() => responds.length === 1, 'follow answered')
  await sleep(40)
  assert.deepEqual(responds, ['allowed-once'])
  assert.equal(feedbackLog.length, 1)
  assert.deepEqual(feedbackLog[0], { callId: 'c1', outcome: 'allowed-once', auto: true })
  assert.equal(probe.peak, 1)
  poller.dispose()
})

// ── remote watcher (alpha.1 pendingInteractions) ───────────────────────────

test('remote watcher: pendingInteractions countdown → llm follow answers via pending.answer', async () => {
  const statuses = { c9: { phase: 'countdown', action: 'reject', seconds: 30 } }
  const feedbackLog = []
  globalThis.fetch = routeFetch({ statusByCallId: statuses, feedbackLog })
  const answerCalls = []
  const item = {
    kind: 'approval',
    key: 'approval:1',
    sessionId: 's1',
    callId: 'c9',
    reason: 'edit files',
    result: null,
    answer: async (o) => { answerCalls.push(o) },
  }
  const env = fakeRemoteEnv()
  const { ctx, cleanup } = fakeCtx({ uiSession: env.uiSession })
  watchRemoteApprovals(ctx, { pollMs: 10 })
  env.setMap(new Map([['s1', item]]))
  await sleep(40)
  statuses.c9 = { phase: 'follow', source: 'llm', action: 'reject', seconds: 0 }
  await until(() => answerCalls.length === 1, 'answered via pending.answer')
  assert.deepEqual(answerCalls, ['rejected'])
  assert.deepEqual(feedbackLog, [{ callId: 'c9', outcome: 'rejected', auto: true }])
  cleanup()
})

test('remote watcher: answer() rejection is silently swallowed (already settled); no retry', async () => {
  const statuses = { c9: { phase: 'countdown', action: 'allow', seconds: 30 } }
  const feedbackLog = []
  globalThis.fetch = routeFetch({ statusByCallId: statuses, feedbackLog })
  let answerCalls = 0
  const item = {
    kind: 'approval',
    key: 'approval:2',
    sessionId: 's1',
    callId: 'c9',
    result: null,
    answer: async (o) => {
      answerCalls++
      throw new Error('#settled')
    },
  }
  const env = fakeRemoteEnv()
  const { ctx, cleanup } = fakeCtx({ uiSession: env.uiSession })
  watchRemoteApprovals(ctx, { pollMs: 10 })
  env.setMap(new Map([['s1', item]]))
  await sleep(40)
  statuses.c9 = { phase: 'follow', source: 'llm', action: 'allow', seconds: 0 }
  await until(() => answerCalls === 1, 'first answer attempted')
  await sleep(80)
  assert.equal(answerCalls, 1, 'a settled interaction is never answered twice')
  assert.equal(feedbackLog.length, 1)
  cleanup()
})

test('remote watcher: item leaving the snapshot detaches the poller; re-add re-arms (tombstone lifecycle)', async () => {
  const statuses = { c9: { phase: 'countdown', action: 'allow', seconds: 30 } }
  const fetchLog = []
  globalThis.fetch = routeFetch({ statusByCallId: statuses, fetchLog })
  const item = {
    kind: 'approval',
    key: 'approval:3',
    sessionId: 's1',
    callId: 'c9',
    result: null,
    answer: async () => {},
  }
  const env = fakeRemoteEnv()
  const { ctx, cleanup } = fakeCtx({ uiSession: env.uiSession })
  watchRemoteApprovals(ctx, { pollMs: 10 })
  env.setMap(new Map([['s1', item]]))
  await until(() => fetchLog.length >= 1, 'armed')
  env.setMap(new Map()) // interaction removed by the host
  const stopped = fetchLog.length
  await sleep(60)
  assert.ok(fetchLog.length <= stopped + 1, 'no polling after the interaction left the snapshot')
  env.setMap(new Map([['s1', item]]))
  await until(() => fetchLog.length > stopped + 1, 'a fresh re-add re-arms')
  cleanup()
})

test('remote watcher: per-entry arming by the item callId it carries (no map.get singletons)', async () => {
  const statuses = {
    ca: { phase: 'countdown', action: 'allow', seconds: 30 },
    cb: { phase: 'countdown', action: 'reject', seconds: 30 },
  }
  const fetchLog = []
  globalThis.fetch = routeFetch({ statusByCallId: statuses, fetchLog })
  const answers = []
  const itemA = { kind: 'approval', key: 'approval:4', sessionId: 's1', callId: 'ca', result: null, answer: async (o) => { answers.push(['ca', o]) } }
  const itemB = { kind: 'approval', key: 'approval:5', sessionId: 's2', callId: 'cb', result: null, answer: async (o) => { answers.push(['cb', o]) } }
  const env = fakeRemoteEnv()
  const { ctx, cleanup } = fakeCtx({ uiSession: env.uiSession })
  watchRemoteApprovals(ctx, { pollMs: 10 })
  env.setMap(new Map([['s1', itemA], ['s2', itemB]]))
  await until(() => fetchLog.length >= 2, 'both entries armed')
  await sleep(30)
  statuses.ca = { phase: 'follow', source: 'llm', action: 'allow', seconds: 0 }
  statuses.cb = { phase: 'follow', source: 'llm', action: 'reject', seconds: 0 }
  await until(() => answers.length === 2, 'both answered independently')
  assert.deepEqual(answers.sort(), [['ca', 'allowed-once'], ['cb', 'rejected']])
  cleanup()
})

test('remote watcher: replacing the same-session entry disposes the old poller (precedence overshadows)', async () => {
  const statuses = { cOld: { phase: 'countdown', action: 'allow', seconds: 30 }, cNew: { phase: 'countdown', action: 'allow', seconds: 30 } }
  const fetchLog = []
  globalThis.fetch = routeFetch({ statusByCallId: statuses, fetchLog })
  const oldItem = { kind: 'approval', key: 'approval:6', sessionId: 's1', callId: 'cOld', result: null, answer: async () => {} }
  const newItem = { kind: 'approval', key: 'approval:7', sessionId: 's1', callId: 'cNew', result: null, answer: async () => {} }
  const env = fakeRemoteEnv()
  const { ctx, cleanup } = fakeCtx({ uiSession: env.uiSession })
  watchRemoteApprovals(ctx, { pollMs: 10 })
  env.setMap(new Map([['s1', oldItem]]))
  await until(() => fetchLog.length >= 1, 'old entry armed')
  const cOldFetches = fetchLog.filter((f) => f.init?.headers?.['x-auto-approval-call-id'] === 'cOld').length
  env.setMap(new Map([['s1', newItem]]))
  await until(() => fetchLog.filter((f) => f.init?.headers?.['x-auto-approval-call-id'] === 'cNew').length >= 1, 'new entry armed')
  await sleep(60)
  const cOldAfter = fetchLog.filter((f) => f.init?.headers?.['x-auto-approval-call-id'] === 'cOld').length
  assert.equal(cOldAfter, cOldFetches, 'the overshadowed old entry stops polling')
  cleanup()
})

test('remote watcher: no uiSession service → idle watcher, no subscriptions', async () => {
  const fetchLog = []
  globalThis.fetch = routeFetch({ fetchLog })
  const { ctx, cleanup } = fakeCtx({})
  watchRemoteApprovals(ctx)
  await sleep(50)
  assert.equal(fetchLog.length, 0)
  cleanup()
})

// ── breaker anti-hijack guard (createBreakerGuard, F5) ──────────────────────

function fakeBreakerButtons() {
  const mkBtn = (text, disabled = false) => ({ textContent: text, disabled, isConnected: true })
  const mkPanel = (...buttons) => ({ querySelectorAll: () => [...buttons] })
  return { mkBtn, mkPanel }
}

test('breaker guard: React re-render swaps button nodes — the NEW nodes stay disabled (F5)', async () => {
  const { mkBtn, mkPanel } = fakeBreakerButtons()
  const guard = createBreakerGuard(() => 60)
  const r1 = mkBtn('拒绝')
  const a1 = mkBtn('允许一次')
  guard.apply(mkPanel(r1, a1), 'k1')
  assert.equal(r1.disabled, true, 'first scan disables the original nodes')
  assert.equal(a1.disabled, true)
  // React re-render: brand-new node objects; the old ones leave the DOM.
  r1.isConnected = false
  a1.isConnected = false
  const r2 = mkBtn('拒绝')
  const a2 = mkBtn('允许一次')
  guard.apply(mkPanel(r2, a2), 'k1') // scan fires again inside the window
  assert.equal(r2.disabled, true, 'the re-rendered reject node must be disabled (F5)')
  assert.equal(a2.disabled, true, 'the re-rendered allow node must be disabled (F5)')
  await sleep(90) // window expires
  assert.equal(r2.disabled, false, 'expiry restores the CURRENT (re-rendered) node')
  assert.equal(a2.disabled, false)
  guard.dispose()
})

test('breaker guard: expiry restores the pre-guard state; a still-matching panel re-arms a fresh window', async () => {
  const { mkBtn, mkPanel } = fakeBreakerButtons()
  const guard = createBreakerGuard(() => 50)
  const reject = mkBtn('拒绝')
  const allow = mkBtn('允许一次', true) // React keeps this one disabled on its own
  const panel = mkPanel(reject, allow)
  guard.apply(panel, 'k1')
  assert.equal(reject.disabled, true)
  assert.equal(allow.disabled, true)
  await sleep(80) // past the window
  assert.equal(reject.disabled, false, 'a node enabled before the guard is restored')
  assert.equal(allow.disabled, true, 'a node disabled before the guard stays disabled')
  guard.apply(panel, 'k1') // rolling window: the breaker text is still visible
  assert.equal(reject.disabled, true, 'a fresh window re-disables the buttons')
  guard.dispose()
})

test('breaker guard: window 0 is a complete no-op (default behavior unchanged)', () => {
  const { mkBtn, mkPanel } = fakeBreakerButtons()
  const guard = createBreakerGuard(() => 0)
  const reject = mkBtn('拒绝')
  const allow = mkBtn('允许一次')
  guard.apply(mkPanel(reject, allow), 'k1')
  assert.equal(reject.disabled, false, 'a 0 window never disables anything')
  assert.equal(allow.disabled, false)
  guard.prune(new Set()) // safe no-ops
  guard.dispose()
  guard.apply(mkPanel(reject, allow), 'k1') // no throw after dispose
  assert.equal(reject.disabled, false)
})

test('breaker guard: prune cancels windows for panels that left the DOM', async () => {
  const { mkBtn, mkPanel } = fakeBreakerButtons()
  const guard = createBreakerGuard(() => 40)
  const a = mkBtn('拒绝')
  const aAllow = mkBtn('允许一次')
  const b = mkBtn('拒绝')
  const bAllow = mkBtn('允许一次')
  guard.apply(mkPanel(a, aAllow), 'ka')
  guard.apply(mkPanel(b, bAllow), 'kb')
  guard.prune(new Set(['ka']))
  await sleep(70)
  assert.equal(a.disabled, false, 'the live key restored after its window expired')
  assert.equal(b.disabled, true, 'the pruned key never restores (timer was cancelled)')
  guard.dispose()
})

test('breaker guard: dispose cancels pending windows — no late restore, no timer leak', async () => {
  const { mkBtn, mkPanel } = fakeBreakerButtons()
  const guard = createBreakerGuard(() => 30)
  const reject = mkBtn('拒绝')
  const allow = mkBtn('允许一次')
  guard.apply(mkPanel(reject, allow), 'k1')
  assert.equal(reject.disabled, true, 'window armed')
  guard.dispose() // teardown mid-window
  await sleep(70) // past the original window
  assert.equal(reject.disabled, true, 'dispose cancelled the timer: no late restore may fire')
  assert.equal(allow.disabled, true)
})

// ── edit-diff marker stripping (computeTextNodeRewrites, F6) ───────────────

const DS = '[dsh-edit-diff]'
const DE = '[/dsh-edit-diff]'

test('computeTextNodeRewrites: single text node with a complete pair removes the block, keeps surrounding text', () => {
  assert.deepEqual(computeTextNodeRewrites([`before${DS}diff${DE}after`], DS, DE), ['beforeafter'])
  assert.deepEqual(computeTextNodeRewrites([`${DS}diff${DE}tail`], DS, DE), ['tail'], 'block at the very start')
  assert.deepEqual(computeTextNodeRewrites([`head${DS}diff${DE}`], DS, DE), ['head'], 'block at the very end')
})

test('computeTextNodeRewrites: markers split across two text nodes are removed exactly', () => {
  const out = computeTextNodeRewrites([`A${DS}first`, `second${DE}B`], DS, DE)
  assert.deepEqual(out, ['A', 'B'])
})

test('computeTextNodeRewrites: markers split across three text nodes are removed exactly', () => {
  const out = computeTextNodeRewrites(['pre', DS, 'mid', DE, 'post'], DS, DE)
  // 'mid' sits between the markers — it is diff body, so it goes too.
  assert.deepEqual(out, ['pre', '', '', '', 'post'])
  // The rewritten join equals the legacy textContent rewrite output.
  assert.equal(out.join(''), 'prepost')
})

test('computeTextNodeRewrites: no markers → texts unchanged (idempotent)', () => {
  const texts = ['hello', ' world']
  assert.deepEqual(computeTextNodeRewrites(texts, DS, DE), texts)
  // A complete pair already removed: rewrites are stable (no re-stripping).
  const once = computeTextNodeRewrites([`a${DS}x${DE}b`], DS, DE)
  assert.deepEqual(computeTextNodeRewrites(once, DS, DE), once)
})

test('computeTextNodeRewrites: forged or half markers are left alone (reverse case)', () => {
  // A lone START marker with no END must consume nothing.
  assert.deepEqual(computeTextNodeRewrites(['echo [dsh-edit-diff] hi'], DS, DE), ['echo [dsh-edit-diff] hi'])
  // A lone END marker with no START must consume nothing.
  assert.deepEqual(computeTextNodeRewrites(['echo [/dsh-edit-diff] hi'], DS, DE), ['echo [/dsh-edit-diff] hi'])
  // Only the pair's own span is removed from a larger text; the rest survives.
  assert.deepEqual(computeTextNodeRewrites([`cmd ${DS}inner${DE} ok`], DS, DE), ['cmd  ok'])
})

test('computeTextNodeRewrites: trailing newlines after the block are trimmed like the legacy rewrite', () => {
  assert.deepEqual(computeTextNodeRewrites([`head${DS}x${DE}\n\n`], DS, DE), ['head'])
  // A newline between the block and following text is a MIDDLE newline — the
  // legacy `\n+$` trim never touched those, and neither does the rewrite.
  assert.deepEqual(computeTextNodeRewrites([`head${DS}x${DE}\n`, 'tail'], DS, DE), ['head\n', 'tail'])
})

// ── static wiring anchors ──────────────────────────────────────────────────

test('static anchors: remote-only wiring stays pinned; the legacy adapter is gone', () => {
  const remote = readFileSync(new URL('../src/client/approvals/remote.ts', import.meta.url), 'utf8')
  assert.ok(remote.includes('pendingInteractions'), 'remote adapter must subscribe to pendingInteractions')
  assert.ok(remote.includes('.answer('), 'remote adapter must answer through pending.answer')
  const shared = readFileSync(new URL('../src/client/approvals/shared.ts', import.meta.url), 'utf8')
  assert.ok(!shared.includes('snapshot.pending'), 'the legacy snapshot.pending source must be gone from the shared core')
  const client = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  assert.ok(client.includes('watchRemoteApprovals(ctx)'), 'apply() must mount the remote watcher')
  assert.ok(!client.includes('watchLegacyApprovals'), 'the legacy watcher mount must be gone')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(Array.isArray(pkg.dsh?.client?.inject), 'dsh.client.inject must be an array')
  assert.ok(!pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-runtime'), 'the dead inject reference must be gone')
  assert.equal(pkg.dsh.client.inject.length, 5, 'the remaining inject entries stay untouched')
})

test('static anchors: breaker guard is mounted via the shared factory (F5 wiring pinned)', () => {
  const shared = readFileSync(new URL('../src/client/approvals/shared.ts', import.meta.url), 'utf8')
  const client = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  assert.ok(shared.includes('export function createBreakerGuard'), 'the factory must be exported from the shared core')
  assert.ok(client.includes('const breaker = createBreakerGuard(() => breakerAntiHijackMs)'), 'index.ts must mount the guard with a live window read')
  assert.ok(client.includes('breaker.apply(panel, key)'), 'scan must apply the guard per live panel')
  assert.ok(client.includes('breaker.prune(liveKeys)'), 'cleanup must prune vanished breaker keys')
  assert.ok(client.includes('breaker.dispose()'), 'dispose must release every breaker timer')
})

test('static anchors: the guard is armed by the breaker marker, not by localized copy', () => {
  // The guard's internals were well covered while the trigger reaching them was
  // not, so a host note written in English only and a client testing for the
  // Chinese word "熔断" shipped from v0.0.1 and the window never armed. Pin the
  // trigger itself: it must come from the shared detector.
  const client = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.ok(client.includes('if (hasBreakerNote(text)) breaker.apply(panel, key)'), 'scan must arm the guard through the shared detector')
  assert.ok(!/\/熔断\/\.test/.test(client), 'the localized-word trigger must be gone')
  assert.ok(host.includes('breakerNote(limitText, reasons)'), 'the host must write the note through the shared builder')
  assert.ok(!host.includes('⚠️ Breaker: model was'), 'the old inline note must be gone from the host')
})

test('static anchors: hideDiffBlock strips via text-node rewrites, never textContent rewrite (F6 pinned)', () => {
  const shared = readFileSync(new URL('../src/client/approvals/shared.ts', import.meta.url), 'utf8')
  const client = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  assert.ok(client.includes('computeTextNodeRewrites(texts, DIFF_START, DIFF_END)'), 'index.ts must route stripping through the pure rewrite function')
  assert.ok(client.includes('collectTextNodes'), 'index.ts must walk text nodes (never rewrites element children)')
  assert.ok(!client.includes('el.textContent = cleaned'), 'the structure-destroying textContent rewrite must be gone (F6)')
  assert.ok(shared.includes('export function computeTextNodeRewrites'), 'the rewrite function must be exported for testability')
})