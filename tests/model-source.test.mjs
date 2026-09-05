/**
 * dsh-auto-approval-llm · model-source switches (fast-decision lane), 3-source era.
 *
 * Contract tests over the compiled lib for the classifier lane:
 *  - resolveConfig normalizes classifierSource/provider/model (session default;
 *    preset only when complete; never throws — 2026-08-26 half-config crash
 *    precedent; the channel layer surfaces half-config errors consumers fail
 *    loudly on).
 *  - createDshClassifier receives the preset override only when the lane is a
 *    complete preset pair, so the fake-runtime stream carries the chosen route
 *    while the default session lane stays byte-identical.
 * Run: node --test tests/model-source.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveConfig, Config } from '../lib/index.js'
import { createDshClassifier, createEndpointClassifier } from '../lib/auto/dsh-classifier.js'

// ── L1: resolveConfig normalization ───────────────────────────────────────

test('resolveConfig: preset lane with a complete pair is preserved', () => {
  const cfg = resolveConfig(Config({
    classifierSource: 'preset',
    classifierProvider: 'deepseek',
    classifierModel: 'deepseek-v4-flash',
  }))
  assert.equal(cfg.classifierSource, 'preset')
  assert.equal(cfg.classifierProvider, 'deepseek')
  assert.equal(cfg.classifierModel, 'deepseek-v4-flash')
})

test('resolveConfig: session lane is default and strips any leftover preset pair', () => {
  const cfg = resolveConfig(Config({
    classifierProvider: 'deepseek',
    classifierModel: 'deepseek-v4-flash',
  }))
  assert.equal(cfg.classifierSource, 'session')
  assert.equal(cfg.classifierProvider, '')
  assert.equal(cfg.classifierModel, '')
})

test('resolveConfig: half-configured preset lane resolves without throwing (channel error surfaces at consumers)', () => {
  // Regression anchor for the 2026-08-26 bootstrap crash: a provider without a
  // model (or vice versa) used to throw during resolveConfig/constructor. Now
  // the source stays 'preset' and the channel error is consumed loudly at
  // dispatch time — resolveConfig itself must never throw.
  const one = resolveConfig(Config({ classifierSource: 'preset', classifierProvider: 'deepseek' }))
  assert.equal(one.classifierSource, 'preset')
  const other = resolveConfig(Config({ classifierSource: 'preset', classifierModel: 'deepseek-v4-flash' }))
  assert.equal(other.classifierSource, 'preset')
})

test('resolveConfig: empty-string preset pair is not honored as a live preset', () => {
  const cfg = resolveConfig(Config({
    classifierSource: 'preset',
    classifierProvider: '   ',
    classifierModel: '',
  }))
  assert.equal(cfg.classifierSource, 'preset', 'the operator explicitly chose preset; consumers fail loudly')
})

test('resolveConfig: endpoint source with shared config is preserved', () => {
  const cfg = resolveConfig(Config({
    classifierSource: 'endpoint',
    endpointUrl: 'http://127.0.0.1:18777/v1',
    endpointModel: 'mock-model',
  }))
  assert.equal(cfg.classifierSource, 'endpoint')
  assert.equal(cfg.endpointUrl, 'http://127.0.0.1:18777/v1')
  assert.equal(cfg.endpointModel, 'mock-model')
})

test('resolveConfig: stale custom enum from the retired era normalizes to session', () => {
  const cfg = resolveConfig(Config({
    classifierModelSource: 'custom',
    classifierProvider: 'deepseek',
    classifierModel: 'deepseek-v4-flash',
  }))
  assert.equal(cfg.classifierSource, 'session')
})

// ── L2: classifier override routing through createDshClassifier ───────────

const routeInput = (extra = {}) => ({
  toolName: 'git_push',
  arguments: { remote: 'origin' },
  workspaceRoot: 'C:/ws',
  policyReason: 'push to origin',
  trustedUserMessages: [],
  route: { provider: 'sess', model: 'sess-model' },
  ...extra,
})

const okChunks = () => [
  { type: 'text-delta', index: 0, text: '{"decision":"allow","reason":"' },
  { type: 'text-delta', index: 0, text: 'ok"}' },
  { type: 'finish', reason: { kind: 'stop' } },
]

function fakeRuntime(chunks) {
  const captured = []
  const runtime = {
    async *stream(options) {
      captured.push(options)
      for (const chunk of chunks) yield chunk
    },
  }
  return { runtime, captured }
}

test('classify: preset override pair wins over the per-call session route', async () => {
  const { runtime, captured } = fakeRuntime(okChunks())
  const classifier = createDshClassifier(runtime, {
    timeoutMs: 100,
    maxOutputTokens: 64,
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
  })
  await classifier.classify(routeInput(), new AbortController().signal)
  assert.equal(captured[0].provider, 'deepseek')
  assert.equal(captured[0].model, 'deepseek-v4-flash')
})

test('classify: no override means the session route from the input wins (byte-identical default)', async () => {
  const { runtime, captured } = fakeRuntime(okChunks())
  const classifier = createDshClassifier(runtime, { timeoutMs: 100, maxOutputTokens: 64 })
  await classifier.classify(routeInput(), new AbortController().signal)
  assert.equal(captured[0].provider, 'sess')
  assert.equal(captured[0].model, 'sess-model')
})

test('classify: half-configured override pair must not reach the classifier (would throw)', async () => {
  // createDshClassifier throws when exactly one override side is present; the
  // host wiring must never forward a lone side. Pin the throw so a future
  // wiring bug fails loudly here.
  assert.throws(() => createDshClassifier({}, { provider: 'deepseek' }), /together/)
  assert.throws(() => createDshClassifier({}, { model: 'deepseek-v4-flash' }), /together/)
})

test('endpoint classify: a blank endpoint is refused before any network call', async () => {
  const endpointClassifier = createEndpointClassifier({ timeoutMs: 100, maxOutputTokens: 64 })
  await assert.rejects(
    endpointClassifier.classify(routeInput(), new AbortController().signal, { url: '', model: '' }),
    /needs a URL and model/,
  )
})

// ── L3 wiring anchors against the compiled host ───────────────────────────

const HOST_SRC = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

test('host wiring: the classifier construction derives its override from classifierSource', () => {
  const helperAt = HOST_SRC.indexOf('const classifierOverrideFor')
  const preStart = HOST_SRC.indexOf("'tools/pre-execute'")
  assert.ok(helperAt !== -1 && preStart > helperAt)
  const block = HOST_SRC.slice(helperAt, preStart)
  assert.ok(block.includes('classifierSource'), 'the override derivation reads the source switch')
  assert.ok(block.includes('classifierOverrideFor(config)'), 'the construction spreads the derived override')
  assert.ok(!block.includes('classifierPair'), 'no retired classifierPair marker may resurface')
})
