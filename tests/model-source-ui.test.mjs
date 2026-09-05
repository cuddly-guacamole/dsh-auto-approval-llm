/**
 * dsh-auto-approval-llm · model-source UI sync anchors (3-source era).
 *
 * The model-source keys must thread through every client mirror of the
 * schema: the Draft interface, draftOf, valueOf, the review card's save key
 * list, the invalid-config mirror tables, and the source-switch UI copy. Each
 * sync point is a silent-drift surface — this pins them all to the compiled
 * bundle so a refactor that drops one wiring fails here.
 * Run: node --test tests/model-source-ui.test.mjs (tsdown first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const keys = [
  'classifierSource',
  'classifierProvider',
  'classifierModel',
  'reviewerSource',
  'reviewerProvider',
  'reviewerModel',
  'endpointUrl',
  'endpointModel',
  'endpointProtocol',
]

test('client bundle: all model-source keys thread through draftOf', () => {
  for (const key of keys) {
    const at = client.indexOf(`value?.${key}`)
    assert.ok(at !== -1, `draftOf must read ${key} from the stored value`)
  }
  // Sources default to session via a 3-value membership test (tsdown expands
  // the array literal across lines — anchor the semantic pieces).
  const classifierAt = client.indexOf('classifierSource: [')
  assert.ok(classifierAt !== -1, 'classifier source switch is in draftOf')
  const classifierBlock = client.slice(classifierAt, classifierAt + 200)
  assert.ok(classifierBlock.includes('"session"') && classifierBlock.includes('"preset"') && classifierBlock.includes('"endpoint"'), 'classifier source carries all three values')
  const reviewerAt = client.indexOf('reviewerSource: [', classifierAt)
  assert.ok(reviewerAt !== -1, 'reviewer source switch is in draftOf')
  const reviewerBlock = client.slice(reviewerAt, reviewerAt + 200)
  assert.ok(reviewerBlock.includes('"session"') && reviewerBlock.includes('"preset"') && reviewerBlock.includes('"endpoint"'), 'reviewer source carries all three values')
})

test('client bundle: the review card save key list carries all model-source keys', () => {
  const at = client.indexOf('REVIEW_KEYS = [')
  assert.ok(at !== -1, 'REVIEW_KEYS array is present')
  const block = client.slice(at, at + 500)
  for (const key of keys) {
    assert.ok(block.includes(`"${key}"`), `REVIEW_KEYS must carry ${key}`)
  }
})

test('client bundle: valueOf persists the source switches and non-empty pairs', () => {
  const at = client.indexOf('value.classifierSource = ')
  assert.ok(at !== -1, 'classifier source switch persists unconditionally')
  assert.ok(client.includes('if (draft.classifierProvider.trim()) value.classifierProvider'), 'classifier provider persists only when non-empty')
  assert.ok(client.includes('if (draft.classifierModel.trim()) value.classifierModel'), 'classifier model persists only when non-empty')
  const r = client.indexOf('value.reviewerSource = ')
  assert.ok(r !== -1, 'reviewer source switch persists unconditionally')
  assert.ok(client.includes('if (draft.reviewerProvider.trim()) value.reviewerProvider'), 'reviewer provider persists only when non-empty')
  assert.ok(client.includes('if (draft.reviewerModel.trim()) value.reviewerModel'), 'reviewer model persists only when non-empty')
  assert.ok(client.includes('if (draft.endpointUrl.trim()) value.endpointUrl'), 'endpoint url persists only when non-empty')
  assert.ok(client.includes('if (draft.endpointModel.trim()) value.endpointModel'), 'endpoint model persists only when non-empty')
})

test('client bundle: the invalid-config mirror tables know the new keys and 3-value sources', () => {
  const typesAt = client.indexOf('INVALID_CONFIG_TYPES')
  const enumsAt = client.indexOf('INVALID_CONFIG_ENUMS')
  assert.ok(typesAt !== -1 && enumsAt > typesAt, 'both mirror tables are bundled')
  const tables = client.slice(typesAt, client.indexOf('function findInvalidConfigKeys'))
  for (const key of keys) {
    assert.ok(tables.includes(key), `mirror tables mention ${key}`)
  }
  // The enum tables carry the 3-value source union (tsdown may expand arrays).
  const classifierAt = tables.indexOf('classifierSource: [')
  assert.ok(classifierAt !== -1, 'classifier source enum entry is present')
  const cBlock = tables.slice(classifierAt, classifierAt + 150)
  assert.ok(cBlock.includes('"session"') && cBlock.includes('"preset"') && cBlock.includes('"endpoint"'), 'classifier source union has all three values')
  const reviewerAt = tables.indexOf('reviewerSource: [', classifierAt)
  assert.ok(reviewerAt !== -1, 'reviewer source enum entry is present')
  const rBlock = tables.slice(reviewerAt, reviewerAt + 150)
  assert.ok(rBlock.includes('"session"') && rBlock.includes('"preset"') && rBlock.includes('"endpoint"'), 'reviewer source union has all three values')
})

test('client bundle: the source-switch UI copy is wired (no retired key regression)', () => {
  for (const key of ['settings.reviewer.source.classifier', 'settings.reviewer.source.reviewer', 'settings.reviewer.source.provider', 'settings.reviewer.source.model', 'option.modelSource.session', 'option.modelSource.preset', 'option.modelSource.endpoint', 'settings.reviewer.endpointLegacy']) {
    assert.ok(client.includes(key), `locale key ${key} is referenced by the UI`)
  }
  // The retired provider-dropdown family must stay gone.
  for (const banned of ['settings.reviewer.followSession', 'settings.reviewer.loadingModels', 'settings.reviewer.provider\':']) {
    assert.ok(!client.includes(banned), `retired key ${banned} must not resurface`)
  }
})

test('client bundle: the catalog routes are referenced by the preset pickers', () => {
  assert.ok(client.includes('/providers'), 'providers route is fetched')
  assert.ok(client.includes('/llm-models'), 'llm-models route is fetched')
  assert.ok(!client.includes('auto-approval-llm/models'), 'the retired models path stays out of the client too')
})

test('client bundle: the 3-source menu drives the lanes directly', () => {
  // The 3-source era drives the menu straight from the draft source; choosing
  // a preset catalog chip fills the pair. No reverse-derivation helpers remain.
  assert.ok(client.includes('const presetLabel = '), 'the preset label helper is bundled')
  assert.ok(client.includes('llmPresetModels'), 'the flattened preset list state exists')
  assert.ok(client.includes('setLaneSource'), 'the direct source setter is bundled')
  assert.ok(client.includes('choosePreset'), 'the preset chip chooser is bundled')
  assert.ok(client.includes('sourceSection'), 'the shared source-section renderer is bundled')
  assert.ok(!client.includes('currentMenuValue'), 'the retired reverse menu derivation is gone')
  assert.ok(!client.includes('applyMenuValue'), 'the retired menu application is gone')
  assert.ok(!client.includes('dsa-provider-suggest') && !client.includes('dsa-model-suggest'),
    'the double-click datalist suggestions are gone')
})

test('client bundle: history latency renders per-lane lines for reviewer and classifier', () => {
  // The fast-decision lane joined latency telemetry (2026-09-05): the recent
  // approvals card shows one line per lane with a lane label.
  assert.ok(client.includes('latencyLine'), 'the shared latency-line renderer is bundled')
  assert.ok(client.includes('settings.history.llmLatencyReviewer'), 'reviewer lane label key is referenced')
  assert.ok(client.includes('settings.history.llmLatencyClassifier'), 'classifier lane label key is referenced')
  assert.ok(client.includes('llmLatencyClassifier'), 'the classifier summary state is fetched')
})

test('client bundle: history rows show the LLM decision wall-clock when present', () => {
  // 2026-09-05: records with llmTookMs render a " · LLM 123ms" suffix through
  // the shared formatter; the formatter keeps sub-second values in ms.
  assert.ok(client.includes('formatTookMs'), 'the took-ms formatter is bundled')
  assert.ok(client.includes('llmTookMs ? ` · LLM ${formatTookMs(r.llmTookMs)}`'), 'history lines append the LLM wall-clock')
  assert.ok(client.includes('ms < 1000 ? `${ms}ms`') || client.includes('ms < 1e3 ? `${ms}ms`'), 'sub-second values stay in milliseconds')
})

test('client bundle: reasoning-effort and output-budget controls are wired', () => {
  // 2026-09-05: per-lane reasoning effort (default + off..max presets) and the
  // deep-review output budget joined the model card.
  assert.ok(client.includes('reasoningOptions'), 'the reasoning option builder is bundled')
  assert.ok(client.includes('option.reasoning.default'), 'the default option label is localized')
  assert.ok(client.includes('settings.reviewer.reviewerReasoning'), 'reviewer reasoning control key is referenced')
  assert.ok(client.includes('settings.reviewer.classifierReasoning'), 'classifier reasoning control key is referenced')
  assert.ok(client.includes('settings.reviewer.reviewerMaxTokens'), 'the output-budget control key is referenced')
  for (const v of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.ok(client.includes(`value: "${v}"`), `reasoning preset ${v} is offered`)
  }
})

test('client bundle: reasoning picker fetches adapter-declared efforts per preset lane', () => {
  // 2026-09-06 (dynamic picker): the card fetches /reasoning-efforts for the
  // lane's CURRENT preset pair and narrows the picker to that model's declared
  // efforts; a stale response for a pair the user switched away from is
  // dropped; no catalog → the full vocabulary fallback stays available.
  assert.ok(client.includes('laneEfforts'), 'per-lane effort catalog state is bundled')
  assert.ok(client.includes('latestEffortPair'), 'the stale-response guard ref is bundled')
  assert.ok(client.includes('REASONING_EFFORTS_ROUTE}?provider=') || client.includes('REASONING_EFFORTS_ROUTE}?provider=${encodeURIComponent'), 'the client fetches the host reasoning-efforts route with the lane pair')
  assert.ok(client.includes('draft.reviewerSource === "preset"') || client.includes('draft.reviewerSource === \'preset\''), 'reviewer efforts load only on a preset source')
  assert.ok(client.includes('options.some((o) => o.value === current)'), 'a stored effort outside the catalog is kept visible')
})

test('client bundle: history card has a separate clear-timings action left of clear-history', () => {
  // 2026-09-06: the "清空计时" button clears only the LLM latency telemetry
  // (separate host route, DELETE), while "清空历史" keeps clearing only the
  // approval records. Both live in the history-card footer, timings first.
  assert.ok(client.includes('LLM_LATENCY_ROUTE'), 'the latency clear route constant is bundled')
  assert.ok(client.includes('clearLatency'), 'the clear-timings handler is bundled')
  assert.ok(client.includes('confirm.clearLatency'), 'the clear-timings confirmation is localized')
  assert.ok(client.includes('settings.history.clearLatency'), 'the clear-timings button label key is referenced')
  assert.ok(client.includes('clearHistory'), 'the clear-history handler stays bundled')
  assert.ok(client.includes('hasLatency'), 'the timings-present guard is bundled')
})
