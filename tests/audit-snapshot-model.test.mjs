/**
 * dsh-auto-approval-llm · review snapshot model-frozen contracts.
 *
 * Fix: the snapshot doc promised model was resolved ONCE with
 * route/baseUrl/protocol/key, but the interface carried no model field and
 * every online attempt re-read the live config (which settings/updated can
 * swap mid-review), steering retries toward a different model. The model is
 * now frozen into the snapshot exactly like the endpoint and the key.
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
  reviewerProtocol: 'openai',
  reviewerModel: '',
  reviewerBaseUrl: '',
  reviewerModelSource: 'session',
  reviewerHostProvider: '',
  reviewerHostModel: '',
  ...over,
})
const runSnapshot = (credentialValue, over = {}) =>
  buildReviewSnapshot(snapshotCredentials(credentialValue), snapshotTools, snapshotSession, snapshotReq, snapshotConfig(over), {})

test('direct review snapshot: the reviewer model is frozen into the snapshot (not reread on retries)', async () => {
  // The snapshot contract says route/baseUrl/protocol/model/system/key are
  // resolved ONCE before the first attempt; a live settings change mid-review
  // must not steer retry N>1 to a different model. Pin the frozen field.
  const snap = await runSnapshot('sk-test', { reviewerBaseUrl: 'http://127.0.0.1:9999', reviewerModel: 'direct-model' })
  assert.equal(snap.online, true)
  assert.equal(snap.model, 'direct-model')
  // Offline snapshots carry no model field at all (the route owns the model).
  const offline = await runSnapshot('sk-test')
  assert.equal(offline.online, false)
  assert.equal('model' in offline, false)
})

// ── Issue #5: offline lane model source (session fallback vs custom host pair) ──

test('review snapshot: default session source routes through the session model', async () => {
  const snap = await runSnapshot('sk-test', { reviewerModelSource: 'session' })
  assert.equal(snap.online, false)
  assert.deepEqual(snap.route, { provider: 'sess-provider', model: 'sess-model' })
})

test('review snapshot: custom source with a complete host pair uses the custom route', async () => {
  const snap = await runSnapshot('sk-test', {
    reviewerModelSource: 'custom',
    reviewerHostProvider: 'deepseek',
    reviewerHostModel: 'deepseek-v4-flash',
  })
  assert.equal(snap.online, false)
  assert.deepEqual(snap.route, { provider: 'deepseek', model: 'deepseek-v4-flash' })
})

test('review snapshot: custom source half-wired fails loudly instead of silently falling back to the session', async () => {
  // An operator who picked 'custom' asked for a specific model; a silent
  // session-model degradation would hide the misconfiguration (fail-closed).
  const missingModel = await runSnapshot('sk-test', {
    reviewerModelSource: 'custom',
    reviewerHostProvider: 'deepseek',
  })
  assert.ok('failure' in missingModel, 'a half-wired custom source must surface a failure')
  const missingProvider = await runSnapshot('sk-test', {
    reviewerModelSource: 'custom',
    reviewerHostModel: 'deepseek-v4-flash',
  })
  assert.ok('failure' in missingProvider, 'a half-wired custom source must surface a failure')
})

test('review snapshot: online endpoint wins over the model source (orthogonal dimension)', async () => {
  // A configured baseUrl always takes the online raw-fetch branch; the model
  // source switch only governs the offline lane.
  const snap = await runSnapshot('sk-test', {
    reviewerBaseUrl: 'http://127.0.0.1:9999',
    reviewerModel: 'direct-model',
    reviewerModelSource: 'custom',
    reviewerHostProvider: 'deepseek',
    reviewerHostModel: 'deepseek-v4-flash',
  })
  assert.equal(snap.online, true)
  assert.equal(snap.model, 'direct-model')
})