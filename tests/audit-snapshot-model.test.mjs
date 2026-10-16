/**
 * dsh-auto-approval-llm · review snapshot model-frozen contracts.
 *
 * The snapshot resolves route/baseUrl/protocol/model/key ONCE before the
 * first attempt (retry-consistency — a settings change mid-review can never
 * steer retry N>1 to a different endpoint or model). Transport is channel
 * driven (llm-channel-unify): session/preset ride the host LLM, endpoint rides
 * raw fetch over the shared endpoint config. Half-configuration fails loudly —
 * an explicit preset/endpoint choice that is misconfigured never silently
 * degrades to the session model.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReviewSnapshot } from '../lib/index.js'

// A session stand-in carries both readers a host session exposes: the live
// header fold the model route reads, and the event log the tool-argument scan
// reads. The header config and the recorded event carry the same route.
const SESSION_HEADER = { provider: 'sess-provider', model: 'sess-model' }
const snapshotSession = {
  requestHeader: () => ({ config: SESSION_HEADER }),
  snapshotEvents: () => [{ type: 'request/header', data: { header: { config: SESSION_HEADER } } }],
}
const snapshotReq = { callId: 'call-snapshot', toolName: 'bash' }
const snapshotTools = { schemas: () => [] }
const snapshotCredentials = (value) => ({ resolve: async () => ({ value }) })
const snapshotConfig = (over = {}) => ({
  maxArgsChars: 4000,
  safetyPrompt: '',
  rulesText: '',
  classifierSource: 'session',
  classifierProvider: '',
  classifierModel: '',
  reviewerSource: 'session',
  reviewerProvider: '',
  reviewerModel: '',
  endpointUrl: '',
  endpointModel: '',
  endpointProtocol: 'openai',
  ...over,
})
const runSnapshot = (credentialValue, over = {}) =>
  buildReviewSnapshot(snapshotCredentials(credentialValue), snapshotTools, snapshotSession, snapshotReq, snapshotConfig(over), {})

test('direct review snapshot: the raw-endpoint model is frozen into the snapshot (not reread on retries)', async () => {
  // The snapshot contract says route/baseUrl/protocol/model/system/key are
  // resolved ONCE before the first attempt; a live settings change mid-review
  // must not steer retry N>1 to a different model. Pin the frozen field.
  const snap = await runSnapshot('sk-test', {
    reviewerSource: 'endpoint',
    endpointUrl: 'http://127.0.0.1:9999/v1',
    endpointModel: 'direct-model',
  })
  assert.equal(snap.transport, 'raw')
  assert.equal(snap.model, 'direct-model')
  assert.equal(snap.apiKey, 'sk-test')
  // Host snapshots carry no model field (the route owns the model).
  const host = await runSnapshot('sk-test')
  assert.equal(host.transport, 'host')
  assert.equal('model' in host, false)
})

// ── channel transport contracts ───────────────────────────────────────────

test('review snapshot: default session source routes through the session model', async () => {
  const snap = await runSnapshot('sk-test', { reviewerSource: 'session' })
  assert.equal(snap.transport, 'host')
  assert.deepEqual(snap.route, { provider: 'sess-provider', model: 'sess-model' })
})

test('review snapshot: preset source with a complete host pair uses the preset route', async () => {
  const snap = await runSnapshot('sk-test', {
    reviewerSource: 'preset',
    reviewerProvider: 'deepseek',
    reviewerModel: 'deepseek-v4-flash',
  })
  assert.equal(snap.transport, 'host')
  assert.deepEqual(snap.route, { provider: 'deepseek', model: 'deepseek-v4-flash' })
})

test('review snapshot: preset source half-wired fails loudly instead of silently falling back to the session', async () => {
  // An operator who picked 'preset' asked for a specific model; a silent
  // session-model degradation would hide the misconfiguration (fail-closed).
  const missingModel = await runSnapshot('sk-test', {
    reviewerSource: 'preset',
    reviewerProvider: 'deepseek',
  })
  assert.ok('failure' in missingModel, 'a half-wired preset source must surface a failure')
  const missingProvider = await runSnapshot('sk-test', {
    reviewerSource: 'preset',
    reviewerModel: 'deepseek-v4-flash',
  })
  assert.ok('failure' in missingProvider, 'a half-wired preset source must surface a failure')
})

test('review snapshot: endpoint source rides raw fetch with the shared config and key', async () => {
  const snap = await runSnapshot('sk-test', {
    reviewerSource: 'endpoint',
    endpointUrl: 'http://127.0.0.1:18777/v1',
    endpointModel: 'mock-model',
  })
  assert.equal(snap.transport, 'raw')
  assert.equal(snap.baseUrl, 'http://127.0.0.1:18777/v1')
  assert.equal(snap.model, 'mock-model')
  assert.equal(snap.apiKey, 'sk-test')
})

test('review snapshot: endpoint source without a stored key fails loudly (no doomed AUTH attempt)', async () => {
  const oldFlag = process.env.DSH_AUTO_APPROVAL_READ_CRED_FILE
  process.env.DSH_AUTO_APPROVAL_READ_CRED_FILE = '0'
  try {
    const snap = await runSnapshot(undefined, {
      reviewerSource: 'endpoint',
      endpointUrl: 'http://127.0.0.1:18777/v1',
      endpointModel: 'mock-model',
    })
    assert.ok('failure' in snap, 'an endpoint review without a resolved key must surface a failure')
  } finally {
    if (oldFlag === undefined) delete process.env.DSH_AUTO_APPROVAL_READ_CRED_FILE
    else process.env.DSH_AUTO_APPROVAL_READ_CRED_FILE = oldFlag
  }
})

test('review snapshot: endpoint source half-wired (blank model) fails loudly', async () => {
  const snap = await runSnapshot('sk-test', {
    reviewerSource: 'endpoint',
    endpointUrl: 'http://127.0.0.1:18777/v1',
    endpointModel: '',
  })
  assert.ok('failure' in snap, 'a half-wired endpoint source must surface a failure')
})

test('review snapshot: session source ignores leftover preset/endpoint garbage', async () => {
  // Only a session source carrying stale preset/endpoint values is silently
  // cleaned — the source switch is authoritative.
  const snap = await runSnapshot('sk-test', {
    reviewerSource: 'session',
    reviewerProvider: 'deepseek',
    reviewerModel: 'deepseek-v4-flash',
    endpointUrl: 'http://127.0.0.1:18777/v1',
    endpointModel: 'x',
  })
  assert.equal(snap.transport, 'host')
  assert.deepEqual(snap.route, { provider: 'sess-provider', model: 'sess-model' })
})

test('review snapshot: anthropic endpoint protocol flows into the snapshot', async () => {
  const snap = await runSnapshot('sk-test', {
    reviewerSource: 'endpoint',
    endpointUrl: 'http://127.0.0.1:18777',
    endpointModel: 'claude-x',
    endpointProtocol: 'anthropic',
  })
  assert.equal(snap.transport, 'raw')
  assert.equal(snap.protocol, 'anthropic')
})

test('review snapshot: systemone is refused loudly, never sent as a chat-shaped request', async () => {
  // systemone answers a typed `answers` object, never assistant text. The deep
  // review lane reads text, so selecting systemone there must fail with a
  // message that names the restriction — not send a chat-shaped request and
  // settle on empty text (which a caller could read as "no objection").
  const snap = await runSnapshot('sk-test', {
    reviewerSource: 'endpoint',
    endpointUrl: 'http://127.0.0.1:18777',
    endpointModel: 'jev-1.13-free',
    endpointProtocol: 'systemone',
  })
  assert.equal('transport' in snap, false, 'no transport is resolved for a refused protocol')
  assert.match(snap.failure, /systemone/)
  assert.match(snap.failure, /fast-judgment lane/)
  assert.match(snap.failure, /deep-review lane/)
})

test('review snapshot: responses is a chat-shaped protocol and is NOT refused', async () => {
  // The refusal must be specific to systemone: responses carries text, so the
  // deep-review lane uses it normally.
  const snap = await runSnapshot('sk-test', {
    reviewerSource: 'endpoint',
    endpointUrl: 'http://127.0.0.1:18777',
    endpointModel: 'gpt-x',
    endpointProtocol: 'responses',
  })
  assert.equal(snap.transport, 'raw')
  assert.equal(snap.protocol, 'responses')
})

test('review: a systemone deep review never sends a request to the endpoint', async () => {
  // The refusal must happen at snapshot time, BEFORE any request: the design's
  // requirement is "fail loudly ... rather than sending a chat-shaped request
  // and returning empty text". A local server counts the requests it receives.
  const { createServer } = await import('node:http')
  // The review loop lives in its own module (the entry wires it), so the test
  // drives it where it is written.
  const { reviewWithLLM } = await import('../lib/auto/review-pipeline.js')
  let received = 0
  const server = createServer((req, res) => {
    received += 1
    req.resume()
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}') })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    const config = snapshotConfig({
      reviewerSource: 'endpoint',
      endpointUrl: base,
      endpointModel: 'jev-1.13-free',
      endpointProtocol: 'systemone',
    })
    const outcome = await reviewWithLLM(
      snapshotCredentials('sk-test'), { stream: () => { throw new Error('the host LLM must not be used') } },
      snapshotTools, snapshotSession, { ...snapshotReq, signal: new AbortController().signal }, config,
      5_000, {}, { maxRetries: 0, budgetMs: 5_000, asyncPath: false },
    )
    assert.equal(outcome.review.decision, 'ESCALATE', 'the review escalates instead of settling')
    assert.match(outcome.review.failure, /fast-judgment lane/)
    assert.equal(received, 0, 'not one request may reach the endpoint')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
