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

const snapshotSession = { snapshotEvents: () => [{ type: 'request/header', data: { header: { config: { provider: 'sess-provider', model: 'sess-model' } } } }] }
const snapshotReq = { callId: 'call-snapshot', toolName: 'bash' }
const snapshotTools = { schemas: () => [] }
const snapshotCredentials = (value) => ({ resolve: async () => ({ value }) })
const snapshotConfig = (over = {}) => ({
  maxArgsChars: 4000,
  reviewerContextFacts: false,
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
