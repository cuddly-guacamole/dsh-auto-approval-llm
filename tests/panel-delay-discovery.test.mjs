/**
 * dsh-auto-approval-llm · panel hold + session discovery contracts.
 *
 * The official approval panel is held back for `panelDelayMs` so a countdown
 * ask cannot take over the composer; during that window the client's only
 * source is the session-scoped discovery route, and "show it now" releases the
 * held panel through the reveal route. Three things have to stay true:
 *
 *  1. a settled ask never forwards its panel afterwards (gate cancel);
 *  2. the long poll answers on change, on budget, and on client disconnect;
 *  3. the discovery/reveal routes keep the same auth and method fences as the
 *     existing routes and never invent a panel for an unknown ask.
 *
 * Run: node --test tests/panel-delay-discovery.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  approvalStateForTests,
  boundedHoldMs,
  createPanelGate,
  holdWhileUnchanged,
  holdWhileValue,
  installRevealRoute,
  installSessionReviewStatusRoute,
  installReviewStatusRoute,
  sessionReviewFingerprint,
  withRemaining,
} from '../lib/index.js'
import { followResolution } from '../lib/auto/decision.js'
import { SESSION_REVIEW_STATUS_ROUTE } from '../lib/client/approvals/shared.js'
import { approvalStatusStore } from '../lib/client/approvals/status-store.js'
import { watchSessionApprovals } from '../lib/client/approvals/session-watch.js'

const LOOPBACK = { method: 'GET', headers: { host: 'localhost:3080' }, socket: { remoteAddress: '127.0.0.1' } }
const REMOTE = { method: 'GET', headers: { host: 'evil.example' }, socket: { remoteAddress: '203.0.113.9' } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(cond, what, timeout = 2000) {
  const start = Date.now()
  for (;;) {
    if (cond()) return
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for: ${what}`)
    await sleep(5)
  }
}

function capture(installer, ...args) {
  const registrations = []
  const ctx = {
    get: (name) => (name === 'webServer' ? { register: (desc) => registrations.push(desc) } : undefined),
    effect: (fn) => fn(),
  }
  installer(ctx, ...args)
  assert.ok(registrations.length >= 1, 'at least one registration')
  return registrations
}

function fakeRes() {
  const state = { statusCode: 0, body: '', on: undefined, off: undefined }
  const listeners = new Map()
  const res = {
    setHeader: () => {},
    writeHead: (code) => { state.statusCode = code },
    end: (chunk) => { state.body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk) },
    on: (event, fn) => {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
    },
    off: (event, fn) => {
      const list = listeners.get(event) ?? []
      listeners.set(event, list.filter((entry) => entry !== fn))
    },
    emit: (event) => {
      for (const fn of [...(listeners.get(event) ?? [])]) fn()
    },
  }
  return { res, state }
}

async function callJson(handler, req) {
  const { res, state } = fakeRes()
  await handler(req, res)
  return { status: state.statusCode, body: state.body ? JSON.parse(state.body) : null }
}

// ── panel gate ────────────────────────────────────────────────────────────

test('the panel gate is absent when the hold is disabled or the ask has no call id', () => {
  assert.equal(createPanelGate('call-1', 0), undefined, '0 must keep the panel immediate')
  assert.equal(createPanelGate(undefined, 3000), undefined, 'a callId-less ask has nothing to hold')
})

test('the panel gate opens after the delay', async () => {
  const gate = createPanelGate('gate-delay', 20)
  assert.equal(gate.isCancelled(), false)
  const started = Date.now()
  await gate.wait()
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 15, 'the gate must not open early')
  assert.ok(elapsed < 1_000, `the gate must open on its own timer (waited ${elapsed}ms)`)
  assert.equal(gate.isCancelled(), false, 'opening on the timer is not a cancellation')
})

test('a cancelled gate opens without claiming the panel', async () => {
  const gate = createPanelGate('gate-cancel', 5_000)
  const started = Date.now()
  gate.cancel()
  await gate.wait()
  const elapsed = Date.now() - started
  assert.equal(gate.isCancelled(), true, 'a settled ask must never forward its panel')
  assert.ok(elapsed < 1_000, `a cancelled gate must be released, not wait out the delay (waited ${elapsed}ms)`)
})

test('the reveal path releases a held gate early', async () => {
  const gate = createPanelGate('gate-reveal', 5_000)
  const started = Date.now()
  // The reveal route calls the stored release callback.
  const registrations = capture(installRevealRoute)
  const handler = registrations[0].handler
  const { status, body } = await callJson(handler, {
    ...LOOPBACK,
    method: 'POST',
    headers: { host: 'localhost:3080', 'x-auto-approval-call-id': 'gate-reveal' },
  })
  await gate.wait()
  assert.equal(status, 200)
  assert.deepEqual(body, { ok: true, value: { revealed: true } })
  assert.ok(Date.now() - started < 4_000, 'the release must not wait out the delay')
})

test('boundedHoldMs clamps the requested hold', () => {
  assert.equal(boundedHoldMs(undefined), 0)
  assert.equal(boundedHoldMs(''), 0)
  assert.equal(boundedHoldMs('0'), 0)
  assert.equal(boundedHoldMs('-5'), 0)
  assert.equal(boundedHoldMs('abc'), 0)
  assert.equal(boundedHoldMs('500'), 500)
  assert.equal(boundedHoldMs('600000'), 20_000, 'the ceiling is the server hold budget')
})

test('the hold answers on budget and on client disconnect', async () => {
  const budget = fakeRes()
  const started = Date.now()
  await holdWhileUnchanged('no-such-call', 30, budget.res)
  const budgetElapsed = Date.now() - started
  assert.ok(budgetElapsed >= 25, 'the hold honours its budget')
  assert.ok(budgetElapsed < 1_000, `the budget path must answer promptly (waited ${budgetElapsed}ms)`)
  assert.equal(budget.state.body, '', 'a hold writes nothing itself')

  // The disconnect path is only covered by its wall clock: with the close
  // listener gone the hold still resolves, just after the whole 5s budget, so
  // every other assertion here stays green.
  const disconnected = fakeRes()
  const disconnectStarted = Date.now()
  const pending = holdWhileUnchanged('no-such-call', 5_000, disconnected.res)
  disconnected.res.emit('close')
  await pending
  const disconnectElapsed = Date.now() - disconnectStarted
  assert.ok(disconnectElapsed < 1_000, `a client disconnect must release the hold, not wait out the budget (waited ${disconnectElapsed}ms)`)
  assert.equal(disconnected.state.body, '', 'a released hold writes nothing itself')
})

// ── published status shape ────────────────────────────────────────────────

test('the client-facing status derives remaining time from the host deadline', () => {
  const status = { risk: 'LOW', phase: 'countdown', action: 'allow', seconds: 8, expiresAt: Date.now() + 3_000 }
  const live = withRemaining(status)
  assert.ok(live.remainingMs > 2_000 && live.remainingMs <= 3_000, 'remaining follows the host clock, not the published seconds')
  // A stale deadline can never outrun the countdown the client was told about.
  assert.equal(withRemaining({ ...status, expiresAt: Date.now() + 60_000 }).remainingMs, 8_000)
  assert.equal(withRemaining({ ...status, expiresAt: Date.now() - 1_000 }).remainingMs, 0)
  assert.equal(withRemaining({ risk: 'LOW', phase: 'follow', action: 'allow', seconds: 0 }).remainingMs, 0)
})

// ── routes: auth, method and shape fences ─────────────────────────────────

test('the session discovery route holds the request until the ask list changes', async () => {
  const handler = capture(installSessionReviewStatusRoute)[0].handler
  const headers = { host: 'localhost:3080', 'x-auto-approval-session-id': 'no-such-session', 'x-auto-approval-wait-ms': '300' }
  const { res, state } = fakeRes()
  const started = Date.now()
  await handler({ ...LOOPBACK, headers }, res)
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 250, `the route must honour the hold header (waited ${elapsed}ms)`)
  assert.equal(state.statusCode, 200)
  assert.deepEqual(JSON.parse(state.body), { ok: true, value: { reviews: [] } })
})

test('holdWhileValue answers on change and on budget', async () => {
  let value = 'a'
  const changed = fakeRes()
  const pending = holdWhileValue(() => value, 5_000, changed.res)
  value = 'b'
  await pending
  const budget = fakeRes()
  const started = Date.now()
  await holdWhileValue(() => 'steady', 30, budget.res)
  assert.ok(Date.now() - started >= 25, 'the budget path still answers')
})

test('sessionReviewFingerprint is stable for an unchanged ask list', () => {
  const { reviewStates, reviewSessions } = approvalStateForTests()
  const sessionId = 'fingerprint-session'
  const otherSession = 'fingerprint-other-session'
  const callA = 'fp-a'
  const callB = 'fp-b'
  const callC = 'fp-c'
  assert.equal(sessionReviewFingerprint('no-such-session'), '', 'a session holding no ask has an empty fingerprint')
  reviewStates.set(callA, { risk: 'LOW', phase: 'countdown', action: 'allow', seconds: 10, revision: 3 })
  reviewStates.set(callB, { risk: 'LOW', phase: 'countdown', action: 'reject', seconds: 5, revision: 1 })
  reviewStates.set(callC, { risk: 'LOW', phase: 'countdown', action: 'allow', seconds: 8, revision: 7 })
  reviewSessions.set(callA, sessionId)
  reviewSessions.set(callB, sessionId)
  reviewSessions.set(callC, otherSession)
  try {
    const first = sessionReviewFingerprint(sessionId)
    assert.equal(first, 'fp-a:3:countdown|fp-b:1:countdown', 'the fingerprint carries exactly the session\'s own asks')
    assert.equal(sessionReviewFingerprint(sessionId), first, 'a stable list yields a stable fingerprint')
    assert.notEqual(sessionReviewFingerprint(otherSession), first, 'another session lists different asks')
    reviewStates.set(callB, { risk: 'LOW', phase: 'countdown', action: 'reject', seconds: 5, revision: 2 })
    assert.equal(sessionReviewFingerprint(sessionId), 'fp-a:3:countdown|fp-b:2:countdown', 'a revision change must move the fingerprint')
    reviewStates.set(callA, { risk: 'LOW', phase: 'follow', action: 'allow', seconds: 0 })
    assert.equal(sessionReviewFingerprint(sessionId), 'fp-a::follow|fp-b:2:countdown', 'a follow carries no revision and must still move the fingerprint')
  } finally {
    for (const callId of [callA, callB, callC]) {
      reviewStates.delete(callId)
      reviewSessions.delete(callId)
    }
  }
})

test('the session hold wakes when the ask list changes', async () => {
  const { reviewStates, reviewSessions } = approvalStateForTests()
  const sessionId = 'hold-wake-session'
  const callId = 'hold-wake-call'
  reviewStates.set(callId, { risk: 'LOW', phase: 'countdown', action: 'allow', seconds: 10, revision: 3 })
  reviewSessions.set(callId, sessionId)
  try {
    const { res } = fakeRes()
    const started = Date.now()
    const pending = holdWhileValue(() => sessionReviewFingerprint(sessionId), 5_000, res)
    // A settlement replaces the entry: the fingerprint must move with it.
    reviewStates.set(callId, { risk: 'LOW', phase: 'follow', action: 'allow', seconds: 0, source: 'llm' })
    await pending
    assert.ok(Date.now() - started < 2_000, 'a changed ask list must wake the hold, not wait out the budget')
  } finally {
    reviewStates.delete(callId)
    reviewSessions.delete(callId)
  }
})

test('a follow publish wakes the per-ask hold instead of stranding the panel', async () => {
  // The per-ask long poll compares the published revision, and every follow
  // publish replaces the entry with a status that carries no revision — that
  // change from a number to undefined is what wakes the client. If a follow
  // ever spread the countdown status instead, the hold would sit out its whole
  // budget and leave the official panel open after the decision.
  const { reviewStates } = approvalStateForTests()
  const callId = 'hold-follow-call'
  reviewStates.set(callId, { risk: 'LOW', phase: 'countdown', action: 'allow', seconds: 10, revision: 9 })
  try {
    const { res } = fakeRes()
    const started = Date.now()
    const pending = holdWhileUnchanged(callId, 5_000, res)
    const settled = followResolution('countdown', { risk: 'LOW', outcome: 'allowed-once' }, { timedOut: false, aborted: false })
    assert.equal(settled.kind, 'publish')
    assert.equal(settled.follow.revision, undefined, 'a follow must not carry the countdown revision')
    reviewStates.set(callId, settled.follow)
    await pending
    assert.ok(Date.now() - started < 2_000, 'the follow must wake the hold')
  } finally {
    reviewStates.delete(callId)
  }
})

test('the session discovery route keeps the trust and method fences', async () => {
  const handler = capture(installSessionReviewStatusRoute)[0].handler
  const forbidden = await callJson(handler, { ...REMOTE })
  assert.equal(forbidden.status, 403, 'a non-trusted peer must not enumerate asks')
  const wrongMethod = await callJson(handler, { ...LOOPBACK, method: 'POST' })
  assert.equal(wrongMethod.status, 405)
  const noSession = await callJson(handler, LOOPBACK)
  assert.equal(noSession.status, 400)
  assert.equal(noSession.body.error, 'session-id-required')
  const empty = await callJson(handler, { ...LOOPBACK, headers: { host: 'localhost:3080', 'x-auto-approval-session-id': 'no-such-session' } })
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.body, { ok: true, value: { reviews: [] } })
})

test('the reveal route keeps the trust and method fences and never invents a panel', async () => {
  const handler = capture(installRevealRoute)[0].handler
  assert.equal((await callJson(handler, { ...REMOTE, method: 'POST' })).status, 403)
  assert.equal((await callJson(handler, { ...LOOPBACK })).status, 405)
  const unknown = await callJson(handler, { ...LOOPBACK, method: 'POST' })
  assert.deepEqual(unknown.body, { ok: true, value: { revealed: false } }, 'an unknown ask reports no reveal')
})

test('the review-status route still never 404s and stays method-fenced', async () => {
  const handler = capture(installReviewStatusRoute)[0].handler
  const anonymous = await callJson(handler, LOOPBACK)
  assert.equal(anonymous.status, 200)
  assert.deepEqual(anonymous.body, { ok: false, error: 'not-found' })
  const missing = await callJson(handler, {
    ...LOOPBACK,
    headers: { host: 'localhost:3080', 'x-auto-approval-call-id': 'no-such-call' },
  })
  assert.equal(missing.status, 200)
  assert.equal(missing.body.ok, false)
  assert.equal((await callJson(handler, { ...LOOPBACK, method: 'DELETE' })).status, 405)
})

// ── client wiring anchors ─────────────────────────────────────────────────

test('the client long-polls instead of waking on a fixed cadence', () => {
  const shared = readFileSync(new URL('../src/client/approvals/shared.ts', import.meta.url), 'utf8')
  assert.ok(shared.includes("'x-auto-approval-wait-ms'"), 'the poller must ask for the hold')
  assert.ok(shared.includes('REVIEW_WAIT_MS'), 'the hold budget must be a shared constant')
  const sessionWatch = readFileSync(new URL('../src/client/approvals/session-watch.ts', import.meta.url), 'utf8')
  assert.ok(sessionWatch.includes('x-auto-approval-session-id'), 'session discovery must send the session id in a header')
  assert.ok(sessionWatch.includes('approvalStatusStore.publishStatus'), 'discovery must feed the display store')
  const client = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  // A bare class name is satisfied by the entry's own stylesheet; pin the
  // element that renders each one instead.
  assert.ok(client.includes("React.createElement('span', { className: 'dsa-sessionSplit' }"), 'the session control must render as a split control')
  assert.ok(client.includes("React.createElement('span', { className: 'dsa-sessionDivider' }"), 'the split control must show its divider')
  assert.ok(client.includes('const statusState = chipState(activeRecord, Date.now(), isLinkDown())'), 'the control label must read the display store')
  assert.ok(client.includes("React.createElement('span', { className: 'dsa-sessionMainIcon' }"), 'the narrow layout must degrade to a state icon')
  assert.ok(/@media \(max-width:820px\)/.test(client), 'the compact form must be tied to a narrow viewport')
  assert.ok(client.includes('revealApproval(activeRecord?.callId)'), 'the left side must offer the reveal action')
  assert.ok(client.includes("t('panel.awaitingHuman')"), 'the panel body must be rendered in the reader language')
  assert.ok(!client.includes("'conversation.input.dock'"), 'no composer-dock row may come back')
})

test('session discovery mirrors the host ask list into the display store and clears it on leave', async (t) => {
  const sessionId = 'session-watch-session'
  const otherSessionId = 'session-watch-other'
  const originalFetch = globalThis.fetch
  const requests = []
  let reviews = [{ callId: 'sw-1', phase: 'countdown', action: 'reject', seconds: 30, revision: 2 }]
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    if (url !== SESSION_REVIEW_STATUS_ROUTE) throw new Error(`unexpected fetch: ${url}`)
    return { ok: true, json: async () => ({ ok: true, value: { reviews } }) }
  }
  const listListeners = new Set()
  let current = sessionId
  let dispose
  const ctx = {
    get: (name) => (name === 'sessions'
      ? {
          list: {
            getSnapshot: () => ({ current }),
            subscribe: (fn) => {
              listListeners.add(fn)
              return () => listListeners.delete(fn)
            },
          },
        }
      : undefined),
    effect: (fn) => { dispose = fn() },
  }
  t.after(() => {
    dispose?.()
    globalThis.fetch = originalFetch
    approvalStatusStore.clearSession(sessionId)
    approvalStatusStore.clearSession(otherSessionId)
  })
  watchSessionApprovals(ctx, { pollMs: 10, waitMs: 10 })

  await until(() => approvalStatusStore.activeFor(sessionId, Date.now())?.callId === 'sw-1', 'the first ask to reach the display store')
  assert.equal(requests[0].url, SESSION_REVIEW_STATUS_ROUTE)
  assert.equal(requests[0].init?.headers?.['x-auto-approval-session-id'], sessionId, 'discovery is scoped to the session the reader is watching')
  const published = approvalStatusStore.activeFor(sessionId, Date.now())
  assert.equal(published?.action, 'reject')
  assert.equal(published?.seconds, 30)

  // Settlement: the host lists the ask as a follow and the store must show the
  // outcome instead of holding the stale countdown.
  reviews = [{ callId: 'sw-1', phase: 'follow', source: 'llm', action: 'reject', seconds: 0 }]
  await until(() => approvalStatusStore.activeFor(sessionId, Date.now())?.phase === 'follow', 'the settlement to reach the store')
  assert.equal(approvalStatusStore.activeFor(sessionId, Date.now())?.source, 'llm')

  // An ask the host dropped must leave the chip with it, while the settled one
  // keeps its bounded terminal window.
  reviews = [
    { callId: 'sw-1', phase: 'follow', source: 'llm', action: 'reject', seconds: 0 },
    { callId: 'sw-2', phase: 'countdown', action: 'allow', seconds: 20, revision: 1 },
  ]
  await until(() => approvalStatusStore.recordsFor(sessionId, Date.now()).some((record) => record.callId === 'sw-2'), 'both asks in the store')
  reviews = [{ callId: 'sw-1', phase: 'follow', source: 'llm', action: 'reject', seconds: 0 }]
  await until(() => !approvalStatusStore.recordsFor(sessionId, Date.now()).some((record) => record.callId === 'sw-2'), 'the dropped ask to leave the store')
  assert.deepEqual(approvalStatusStore.recordsFor(sessionId, Date.now()).map((record) => record.callId), ['sw-1'], 'an ask that left the host list must not linger')

  // Leaving the session clears the chip through the list subscription.
  current = otherSessionId
  for (const fn of [...listListeners]) fn()
  assert.equal(approvalStatusStore.activeFor(sessionId, Date.now()), undefined, 'leaving the session must clear its chip')
})
