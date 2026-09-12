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
  boundedHoldMs,
  createPanelGate,
  holdWhileUnchanged,
  installRevealRoute,
  installSessionReviewStatusRoute,
  installReviewStatusRoute,
  withRemaining,
} from '../lib/index.js'

const LOOPBACK = { method: 'GET', headers: { host: 'localhost:3080' }, socket: { remoteAddress: '127.0.0.1' } }
const REMOTE = { method: 'GET', headers: { host: 'evil.example' }, socket: { remoteAddress: '203.0.113.9' } }

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
  assert.ok(Date.now() - started >= 15, 'the gate must not open early')
  assert.equal(gate.isCancelled(), false)
})

test('a cancelled gate opens without claiming the panel', async () => {
  const gate = createPanelGate('gate-cancel', 5_000)
  gate.cancel()
  await gate.wait()
  assert.equal(gate.isCancelled(), true, 'a settled ask must never forward its panel')
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
  assert.ok(Date.now() - started >= 25, 'the hold honours its budget')

  const disconnected = fakeRes()
  const pending = holdWhileUnchanged('no-such-call', 5_000, disconnected.res)
  disconnected.res.emit('close')
  await pending
  assert.equal(budget.state.body, '', 'a hold writes nothing itself')
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
  assert.ok(client.includes("'conversation.input.dock'"), 'the capsule must register in the composer dock')
  assert.ok(client.includes('id: \'auto-approval-llm-capsule\''), 'the capsule must own a distinct slot id')
  assert.ok(client.includes('revealApproval(record.callId)'), 'the capsule must offer the show-now entry')
  assert.ok(client.includes("t('panel.awaitingHuman')"), 'the panel body must be rendered in the reader language')
})
