/**
 * dsh-auto-approval-llm · /feedback route write-side contract.
 *
 * The route answers `200 {ok:true}` for EVERY callId, including one the plugin
 * never issued. Its actual contract therefore has two halves that the response
 * cannot tell apart:
 *
 *   - a callId the plugin issued  -> record the timeout feedback text, and
 *                                    release a follow-phase review state;
 *   - a callId it never issued    -> write nothing at all.
 *
 * Pinning status 200 plus "the body was read" only proves the no-op half, so a
 * regression that dropped the write entirely used to leave the suite green.
 * `approvalStateForTests()` exposes the callId-keyed maps so both halves can be
 * asserted against the real handler.
 *
 * Run: node --test tests/feedback-route-write.test.mjs (tsc first)
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

/** Seed one live ask and return its callId, cleaning up whatever it leaves behind. */
function withLiveAsk({ phase = 'countdown' } = {}) {
  const callId = `feedback-write-${phase}-${Math.random().toString(36).slice(2, 10)}`
  const state = approvalStateForTests()
  state.reviewStates.set(callId, { risk: 'MEDIUM', phase, action: 'reject', seconds: 10 })
  if (phase === 'follow') state.followExpiry.set(callId, Date.now() + 60_000)
  return callId
}

test('a live ask: the ACK records the timeout feedback text', async () => {
  const handler = feedbackHandler()
  const callId = withLiveAsk()
  const state = approvalStateForTests()
  assert.equal(state.timeoutFeedback.has(callId), false, 'precondition: no feedback entry yet')

  const res = await ack(handler, { callId, outcome: 'rejected', auto: true })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { ok: true })

  const entry = state.timeoutFeedback.get(callId)
  assert.ok(entry, 'the route must WRITE feedback for a callId the plugin issued')
  assert.match(entry.text, /auto-rejected by the configured timeout action/)
  assert.match(entry.text, /not a user denial/)
  assert.ok(Number.isFinite(entry.at), 'the entry is timestamped')
  state.timeoutFeedback.delete(callId)
  state.reviewStates.delete(callId)
})

test('the recorded text follows the outcome the client answered with', async () => {
  // Same seeded ask, opposite outcome: a guard that hard-coded one branch would
  // still pass the previous test.
  const handler = feedbackHandler()
  const callId = withLiveAsk()
  const state = approvalStateForTests()
  const res = await ack(handler, { callId, outcome: 'allowed-once', auto: true })
  assert.equal(res.status, 200)
  assert.match(state.timeoutFeedback.get(callId).text, /auto-approved by the configured timeout action/)
  state.timeoutFeedback.delete(callId)
  state.reviewStates.delete(callId)
})

test('a follow-phase ask: the ACK releases the follow state early', async () => {
  const handler = feedbackHandler()
  const callId = withLiveAsk({ phase: 'follow' })
  const state = approvalStateForTests()
  assert.equal(state.reviewStates.get(callId).phase, 'follow', 'precondition: the ask is in follow')
  assert.ok(state.followExpiry.has(callId), 'precondition: the follow expiry is armed')

  const res = await ack(handler, { callId, outcome: 'allowed-once', auto: true })
  assert.equal(res.status, 200)
  assert.equal(state.followExpiry.has(callId), false, 'the follow expiry is released, not left to the TTL sweep')
  assert.equal(state.reviewStates.has(callId), false, 'the review state is released with it')
  state.timeoutFeedback.delete(callId)
})

test('an unknown callId: the no-op half writes nothing anywhere', async () => {
  const handler = feedbackHandler()
  const state = approvalStateForTests()
  const callId = `never-issued-${Math.random().toString(36).slice(2, 10)}`
  const res = await ack(handler, { callId, outcome: 'rejected', auto: true })
  assert.equal(res.status, 200, 'the ACK stays a 200 no-op')
  assert.deepEqual(res.body, { ok: true })
  assert.equal(state.timeoutFeedback.has(callId), false, 'no timeout feedback for a foreign callId')
  assert.equal(state.decisionFeedback.has(callId), false, 'no decision feedback for a foreign callId')
  assert.equal(state.reviewStates.has(callId), false, 'no review state is fabricated')
  assert.equal(state.followExpiry.has(callId), false, 'no follow expiry is fabricated')
})

test('a decision the model already settled is never relabelled as a timeout', async () => {
  // decisionFeedback takes precedence: the same callId can be in both maps, and
  // the timeout label must not overwrite a real decision with "no response".
  const handler = feedbackHandler()
  const state = approvalStateForTests()
  const callId = `feedback-decision-${Math.random().toString(36).slice(2, 10)}`
  state.decisionFeedback.set(callId, { text: 'the model denied this call', at: Date.now() })
  const res = await ack(handler, { callId, outcome: 'rejected', auto: true })
  assert.equal(res.status, 200)
  assert.equal(
    state.timeoutFeedback.has(callId),
    false,
    'a decision feedback must suppress the timeout write for the same callId',
  )
  assert.equal(state.decisionFeedback.get(callId).text, 'the model denied this call', 'the decision text is untouched')
  state.decisionFeedback.delete(callId)
})
