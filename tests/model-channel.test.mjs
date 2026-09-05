/**
 * dsh-auto-approval-llm · unified model-channel resolution (Issue: llm-channel-unify).
 *
 * Contract tests over the compiled lib for normalizeLane / resolveTransport /
 * normalizeSharedEndpoint — the pure resolution layer both LLM lanes share.
 * Half-configuration discipline is pinned here: an explicit preset/endpoint
 * choice that is misconfigured resolves to transport 'none' with a reason
 * (consumers fail loudly), never to a silent session fallback.
 * Run: node --test tests/model-channel.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeLane, resolveTransport, normalizeSharedEndpoint } from '../lib/auto/model-channel.js'

const sess = { provider: 'sess-provider', model: 'sess-model' }
const endpoint = { url: 'https://api.example.com/v1', model: 'ep-model', protocol: 'openai' }

// ── normalizeLane ─────────────────────────────────────────────────────────

test('normalizeLane: session cleans leftover preset pair silently', () => {
  assert.deepEqual(
    normalizeLane({ source: 'session', presetProvider: 'deepseek', presetModel: 'deepseek-v4-flash' }),
    { source: 'session', presetProvider: '', presetModel: '' },
  )
})

test('normalizeLane: unknown source falls back to session (fail closed, never throws)', () => {
  // A hand-written settings file carrying a stale 'custom' from the retired
  // 2-source era must not crash — it normalizes to session.
  assert.deepEqual(
    normalizeLane({ source: 'custom', presetProvider: 'deepseek', presetModel: 'm' }),
    { source: 'session', presetProvider: '', presetModel: '' },
  )
})

test('normalizeLane: complete preset pair is preserved trimmed', () => {
  assert.deepEqual(
    normalizeLane({ source: 'preset', presetProvider: '  deepseek ', presetModel: 'deepseek-v4-flash' }),
    { source: 'preset', presetProvider: 'deepseek', presetModel: 'deepseek-v4-flash' },
  )
})

test('normalizeLane: half-configured preset carries an error (fail loud, no silent downgrade)', () => {
  const missingModel = normalizeLane({ source: 'preset', presetProvider: 'deepseek' })
  assert.equal(missingModel.source, 'preset')
  assert.ok(missingModel.error, 'half preset must surface an error')
  const missingProvider = normalizeLane({ source: 'preset', presetModel: 'deepseek-v4-flash' })
  assert.ok(missingProvider.error, 'half preset must surface an error')
  const blank = normalizeLane({ source: 'preset', presetProvider: '   ', presetModel: '' })
  assert.ok(blank.error, 'blank preset must surface an error')
})

test('normalizeLane: endpoint source keeps no preset pair', () => {
  assert.deepEqual(
    normalizeLane({ source: 'endpoint', presetProvider: 'deepseek', presetModel: 'm' }),
    { source: 'endpoint', presetProvider: '', presetModel: '' },
  )
})

// ── normalizeSharedEndpoint ───────────────────────────────────────────────

test('normalizeSharedEndpoint: trims url/model and defaults the protocol to openai', () => {
  assert.deepEqual(
    normalizeSharedEndpoint({ url: '  https://x.example/v1 ', model: ' m1 ' }),
    { url: 'https://x.example/v1', model: 'm1', protocol: 'openai' },
  )
  assert.equal(normalizeSharedEndpoint({ protocol: 'anthropic' }).protocol, 'anthropic')
})

// ── resolveTransport ──────────────────────────────────────────────────────

test('resolveTransport: session follows the session route; none without one', () => {
  assert.deepEqual(resolveTransport('session', normalizeLane({}), endpoint, sess),
    { transport: 'host', provider: 'sess-provider', model: 'sess-model' })
  assert.deepEqual(resolveTransport('session', normalizeLane({}), endpoint, undefined),
    { transport: 'none', reason: 'no session model route' })
})

test('resolveTransport: preset rides the host LLM with the configured pair', () => {
  const lane = normalizeLane({ source: 'preset', presetProvider: 'deepseek', presetModel: 'deepseek-v4-flash' })
  assert.deepEqual(resolveTransport('preset', lane, endpoint, sess),
    { transport: 'host', provider: 'deepseek', model: 'deepseek-v4-flash' })
})

test('resolveTransport: half-configured preset is none with the error reason (never session)', () => {
  const half = normalizeLane({ source: 'preset', presetProvider: 'deepseek' })
  const t = resolveTransport('preset', half, endpoint, sess)
  assert.equal(t.transport, 'none')
  assert.ok('reason' in t && t.reason.includes('preset'), 'reason names the preset misconfiguration')
})

test('resolveTransport: endpoint rides raw fetch with the shared config', () => {
  const lane = normalizeLane({ source: 'endpoint' })
  assert.deepEqual(resolveTransport('endpoint', lane, endpoint, sess),
    { transport: 'raw', baseUrl: 'https://api.example.com/v1', model: 'ep-model', protocol: 'openai' })
})

test('resolveTransport: half-configured endpoint is none (never session fallback)', () => {
  const lane = normalizeLane({ source: 'endpoint' })
  const noUrl = resolveTransport('endpoint', lane, { url: '', model: 'm', protocol: 'openai' }, sess)
  assert.equal(noUrl.transport, 'none')
  const noModel = resolveTransport('endpoint', lane, { url: 'https://x', model: '', protocol: 'openai' }, sess)
  assert.equal(noModel.transport, 'none')
})

test('resolveTransport: anthropic endpoint protocol is honored', () => {
  const lane = normalizeLane({ source: 'endpoint' })
  const t = resolveTransport('endpoint', lane, { url: 'https://x', model: 'm', protocol: 'anthropic' }, sess)
  assert.deepEqual(t, { transport: 'raw', baseUrl: 'https://x', model: 'm', protocol: 'anthropic' })
})
