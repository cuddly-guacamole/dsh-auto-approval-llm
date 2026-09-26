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
// The review snapshot (and with it the frozen reasoning effort and output
// budget) moved to its own module; the entry keeps the wiring that calls it.
const REVIEW_SRC = readFileSync(new URL('../lib/auto/review-pipeline.js', import.meta.url), 'utf8')

/**
 * Argument block of every `name(` call in the compiled host, from the call to
 * its own `});`. Slicing per call keeps a construction site from being covered
 * by the text of an unrelated one elsewhere in the file.
 */
function callBlocks(source, name) {
  const blocks = []
  for (const match of source.matchAll(new RegExp(`${name}\\(`, 'g'))) {
    const end = source.indexOf('});', match.index)
    assert.notEqual(end, -1, `${name}( at offset ${match.index} is not closed with });`)
    blocks.push(source.slice(match.index, end + 3))
  }
  return blocks
}

test('host wiring: the classifier construction derives its override from classifierSource', () => {
  const helperAt = HOST_SRC.indexOf('const classifierOverrideFor =')
  const helperEnd = HOST_SRC.indexOf('let classifier = createDshClassifier(', helperAt)
  assert.ok(helperAt !== -1 && helperEnd > helperAt, 'the override derivation is declared before the construction')
  const helper = HOST_SRC.slice(helperAt, helperEnd)
  // Distinguishing facts rather than the whole ternary expression: hoisting the
  // pair into a local, wrapping it in Boolean(...), reordering the operands or
  // using shorthand properties are behaviour-equivalent and must not redden,
  // while gutting the guard must. The negative direction is what makes the
  // facts load-bearing: a version that always returned {} leaves the operator's
  // chosen pair a no-op even though every identifier survives.
  for (const fact of [
    /cfg\.classifierSource === 'preset'/,
    /cfg\.classifierProvider\.length > 0/,
    /cfg\.classifierModel\.length > 0/,
    /provider: cfg\.classifierProvider/,
    /model: cfg\.classifierModel/,
    /:\s*\{\}/,
  ]) assert.match(helper, fact, `the override derivation is missing ${fact}`)
  assert.doesNotMatch(helper, /&&\s*false/, 'the override derivation must not be short-circuited to an empty route')
  // Both constructions — the initial one and the settings rebuild — must
  // actually spread that derivation into the classifier options.
  const constructions = callBlocks(HOST_SRC, 'createDshClassifier')
  assert.equal(constructions.length, 2, 'the host constructs the classifier once and rebuilds it on settings changes')
  for (const block of constructions) assert.ok(block.includes('...classifierOverrideFor(config)'), 'the derived override is spread into the construction')
  assert.ok(!HOST_SRC.includes('classifierPair'), 'no retired classifierPair marker may resurface')
})

test('host wiring: the fast-decision lane records its own latency samples', () => {
  // The classifier lane joined latency telemetry (2026-09-05): every fast
  // decision (settled or failed) pushes a sample tagged channel:classifier.
  const sites = HOST_SRC.match(/channel: 'classifier'/g) ?? []
  assert.ok(sites.length >= 2, 'classifier latency pushes both the settled and the failed path')
  assert.ok(HOST_SRC.includes('classifierStart'), 'the classifier call is timed')
})

test('host wiring: LLM-adjudicated history records carry the wall-clock milliseconds', () => {
  // 2026-09-05: history rows for LLM decisions show how long the LLM took —
  // the classifier fast path measures the classify call; a deep-review
  // takeover measures from the approval request to the claim resolution.
  assert.ok(HOST_SRC.includes('llmTookMs: Date.now() - classifierStart'), 'the classifier record carries its elapsed classify time')
  assert.ok(HOST_SRC.includes("source.startsWith('llm')"), 'the deep-review takeover derives its ms from the llm source')
  assert.ok(HOST_SRC.includes('llmTookMs'), 'the field is emitted into history records')
})

test('host wiring: reasoning effort and output budget reach the LLM calls', () => {
  // 2026-09-05: deep-review output budget (reviewerMaxTokens, default 2048)
  // is frozen into the snapshot; a non-default reasoning effort is forwarded
  // to the host prepareCall, and the classifier lane forwards its own effort.
  //
  // The claim is the FREEZE, so the anchor is the snapshot assignment, not the
  // setting name: `reviewerMaxTokens` is also a schema key in the entry, so a
  // bare `includes` on the name stayed green while the snapshot stopped
  // carrying the budget at all. Both transports resolve it into the snapshot.
  const budget = [...REVIEW_SRC.matchAll(/maxTokens: config\.reviewerMaxTokens \?\? 2_048/g)].length
  assert.equal(budget, 2, 'both snapshot transports freeze the configured output budget')
  assert.ok(REVIEW_SRC.includes("snapshot.reasoningEffort"), 'the reviewer snapshot carries the frozen effort')
  // Every classifier construction path forwards the configured effort: the
  // initial construction and the settings rebuild through createDshClassifier,
  // and the endpoint lane through createEndpointClassifier. Only live lines
  // count — a commented-out option keeps the text in the product, so a plain
  // substring count would let the control die inside a comment.
  const optionLines = (source) => [...source.matchAll(/reasoningEffort: config\.classifierReasoning \?\? ''/g)]
    .filter(match => /^\s*$/.test(source.slice(source.lastIndexOf('\n', match.index) + 1, match.index)))
  assert.equal(optionLines(HOST_SRC).length, 3, 'every classifier construction path forwards the configured reasoning effort on a live line')
  const constructions = [
    ...callBlocks(HOST_SRC, 'createDshClassifier'),
    ...callBlocks(HOST_SRC, 'createEndpointClassifier'),
  ]
  assert.equal(constructions.length, 3, 'the host has three classifier construction sites')
  for (const block of constructions) {
    assert.equal(optionLines(block).length, 1, 'the construction forwards the configured reasoning effort on a live line')
  }
})
