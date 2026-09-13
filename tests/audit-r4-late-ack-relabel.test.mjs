/**
 * Late client ACK on a settled ask (follow phase).
 *
 * The FEEDBACK route writes the "auto-answered by the configured timeout
 * action (timeout — not a user denial)" notice into the denied tool result.
 * That notice is authored by the host timer when it actually fires; a follow
 * phase, by contrast, is only published AFTER the host resolved the ask, and
 * the resolution may be a human click, an LLM takeover, or a timeout.
 *
 * The double gate that keeps a settled ask from being relabelled relied on
 * `resolvedCallIds`, whose TTL (30s) is shorter than the follow window (120s).
 * An ACK landing after 30s therefore still found the follow state live and
 * wrote a timeout notice for a decision nobody timed out — the deferred answer
 * then reached the model as "no response".
 *
 * The gate now also reads the follow phase itself, so the notice belongs to the
 * host timer alone for the whole follow window. The in-flight fallback (client
 * auto-answers a still-countdown ask) must keep writing it.
 *
 * Run: node --test tests/audit-r4-late-ack-relabel.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { approvalStateForTests, installFeedbackRoute } from '../lib/index.js'

function feedbackHandler() {
  const registrations = []
  const ctx = {
    get: (name) => (name === 'webServer' ? { register: (desc) => registrations.push(desc) } : undefined),
    effect: (fn) => fn(),
  }
  installFeedbackRoute(ctx)
  assert.equal(registrations.length, 1, 'the feedback installer registers exactly one route')
  return registrations[0].handler
}

function fakeRes() {
  const state = { statusCode: 0, body: '' }
  const res = {
    setHeader: () => {},
    writeHead: (code) => { state.statusCode = code },
    end: (chunk) => { state.body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk) },
  }
  return { res, state }
}

function post(payload) {
  const bytes = Buffer.from(JSON.stringify(payload))
  return {
    method: 'POST',
    headers: { host: 'localhost:8080', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]: async function* () { yield bytes },
  }
}

async function ack(handler, payload) {
  const { res, state } = fakeRes()
  await handler(post(payload), res)
  return { status: state.statusCode, body: JSON.parse(state.body) }
}

function freshCallId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

test('an ACK for a settled ask in its follow window never writes a timeout notice', async () => {
  const handler = feedbackHandler()
  const state = approvalStateForTests()
  const callId = freshCallId('r4-follow')
  // The host resolved the ask and published follow; the resolved marker has
  // already aged out of its shorter TTL.
  state.reviewStates.set(callId, { risk: 'MEDIUM', phase: 'follow', action: 'reject', seconds: 10 })
  state.followExpiry.set(callId, Date.now() + 60_000)
  state.resolvedCallIds.delete(callId)

  const res = await ack(handler, { callId, outcome: 'rejected', auto: true })
  assert.equal(res.status, 200)
  assert.equal(
    state.timeoutFeedback.has(callId),
    false,
    'a resolution the host already settled must not be relabelled as a timeout by a late client ACK',
  )
  assert.equal(state.reviewStates.has(callId), false, 'the ACK still releases the follow state')
  assert.equal(state.followExpiry.has(callId), false, 'the ACK still releases the follow expiry')
  state.timeoutFeedback.delete(callId)
})

test('control: an ACK for a still-countdown ask keeps the timeout notice', async () => {
  const handler = feedbackHandler()
  const state = approvalStateForTests()
  const callId = freshCallId('r4-countdown')
  state.reviewStates.set(callId, { risk: 'MEDIUM', phase: 'countdown', action: 'reject', seconds: 10 })

  const res = await ack(handler, { callId, outcome: 'rejected', auto: true })
  assert.equal(res.status, 200)
  const entry = state.timeoutFeedback.get(callId)
  assert.ok(entry, 'the in-flight fallback must keep writing the notice')
  assert.match(entry.text, /not a user denial/)
  state.timeoutFeedback.delete(callId)
  state.reviewStates.delete(callId)
})

test('control: a decision the model already settled still wins over the fallback', async () => {
  const handler = feedbackHandler()
  const state = approvalStateForTests()
  const callId = freshCallId('r4-decision')
  state.reviewStates.set(callId, { risk: 'MEDIUM', phase: 'countdown', action: 'reject', seconds: 10 })
  state.decisionFeedback.set(callId, { text: 'the model denied this call', at: Date.now() })

  const res = await ack(handler, { callId, outcome: 'rejected', auto: true })
  assert.equal(res.status, 200)
  assert.equal(state.timeoutFeedback.has(callId), false, 'the real decision text must not be overwritten')
  state.decisionFeedback.delete(callId)
  state.reviewStates.delete(callId)
})
