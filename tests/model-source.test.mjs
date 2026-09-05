/**
 * dsh-auto-approval-llm · Issue #5 model-source switches (fast-decision lane).
 *
 * Contract tests over the compiled lib for the classifier lane:
 *  - resolveConfig normalizes classifierModelSource/provider/model (custom only
 *    when complete; session otherwise; never throws — 2026-08-26 half-config
 *    bootstrap crash precedent).
 *  - createDshClassifier receives the custom override only when the lane is a
 *    complete custom pair, so the fake-runtime stream carries the chosen route
 *    while the default session lane stays byte-identical.
 * Run: node --test tests/model-source.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveConfig, Config } from '../lib/index.js'
import { createDshClassifier } from '../lib/auto/dsh-classifier.js'

// ── L1: resolveConfig normalization ───────────────────────────────────────

test('resolveConfig: custom lane with a complete pair is preserved', () => {
  const cfg = resolveConfig(Config({
    classifierModelSource: 'custom',
    classifierProvider: 'deepseek',
    classifierModel: 'deepseek-v4-flash',
  }))
  assert.equal(cfg.classifierModelSource, 'custom')
  assert.equal(cfg.classifierProvider, 'deepseek')
  assert.equal(cfg.classifierModel, 'deepseek-v4-flash')
})

test('resolveConfig: session lane is default and strips any leftover custom pair', () => {
  const cfg = resolveConfig(Config({
    classifierProvider: 'deepseek',
    classifierModel: 'deepseek-v4-flash',
  }))
  assert.equal(cfg.classifierModelSource, 'session')
  assert.equal(cfg.classifierProvider, '')
  assert.equal(cfg.classifierModel, '')
})

test('resolveConfig: half-configured custom lane (one side missing) normalizes to session, never throws', () => {
  // Regression anchor for the 2026-08-26 bootstrap crash: a provider without a
  // model (or vice versa) used to throw during resolveConfig/constructor.
  const one = resolveConfig(Config({ classifierModelSource: 'custom', classifierProvider: 'deepseek' }))
  assert.equal(one.classifierModelSource, 'session')
  assert.equal(one.classifierProvider, '')
  const other = resolveConfig(Config({ classifierModelSource: 'custom', classifierModel: 'deepseek-v4-flash' }))
  assert.equal(other.classifierModelSource, 'session')
  assert.equal(other.classifierModel, '')
})

test('resolveConfig: empty-string custom pair is not honored', () => {
  const cfg = resolveConfig(Config({
    classifierModelSource: 'custom',
    classifierProvider: '   ',
    classifierModel: '',
  }))
  assert.equal(cfg.classifierModelSource, 'session')
})

test('resolveConfig: stored custom values survive a settings round-trip untouched when complete', () => {
  const cfg = resolveConfig(Config({
    classifierModelSource: 'custom',
    classifierProvider: 'deepseek',
    classifierModel: 'deepseek-v4-flash',
  }))
  assert.equal(cfg.classifierModelSource, 'custom')
  assert.equal(cfg.classifierProvider, 'deepseek')
  assert.equal(cfg.classifierModel, 'deepseek-v4-flash')
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

test('classify: custom override pair wins over the per-call session route', async () => {
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
  // host wiring must never forward a lone side (resolveConfig normalizes it
  // away first). Pin the throw so a future wiring bug fails loudly here.
  assert.throws(() => createDshClassifier({}, { provider: 'deepseek' }), /together/)
  assert.throws(() => createDshClassifier({}, { model: 'deepseek-v4-flash' }), /together/)
})

// ── L3 wiring anchors against the compiled host ───────────────────────────

const HOST_SRC = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

test('host wiring: the classifier construction derives its override from classifierModelSource', () => {
  const helperAt = HOST_SRC.indexOf('const classifierOverrideFor')
  const preStart = HOST_SRC.indexOf("'tools/pre-execute'")
  assert.ok(helperAt !== -1 && preStart > helperAt)
  const block = HOST_SRC.slice(helperAt, preStart)
  assert.ok(block.includes('classifierModelSource'), 'the override derivation reads the model-source switch')
  assert.ok(block.includes('classifierOverrideFor(config)'), 'the construction spreads the derived override')
  assert.ok(!block.includes('classifierPair'), 'no retired classifierPair marker may resurface')
})
