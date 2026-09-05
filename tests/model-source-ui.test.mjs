/**
 * dsh-auto-approval-llm · Issue #5 model-source UI sync anchors.
 *
 * Six new config keys must thread through every client mirror of the schema:
 * the Draft interface, draftOf, valueOf, the review card's save key list, the
 * invalid-config mirror tables, and the source-switch UI copy. Each sync point
 * is a silent-drift surface — this pins them all to the compiled bundle so a
 * refactor that drops one wiring fails here.
 * Run: node --test tests/model-source-ui.test.mjs (tsdown first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const keys = [
  'classifierModelSource',
  'classifierProvider',
  'classifierModel',
  'reviewerModelSource',
  'reviewerHostProvider',
  'reviewerHostModel',
]

test('client bundle: all six model-source keys thread through draftOf', () => {
  // draftOf reads each stored key with a safe fallback ('session' for the
  // source switch, '' for the provider/model strings).
  for (const key of keys) {
    const at = client.indexOf(`value?.${key}`)
    assert.ok(at !== -1, `draftOf must read ${key} from the stored value`)
  }
  assert.ok(client.includes('classifierModelSource: value?.classifierModelSource === "custom" ? "custom" : "session"'), 'classifier source defaults to session')
  assert.ok(client.includes('reviewerModelSource: value?.reviewerModelSource === "custom" ? "custom" : "session"'), 'reviewer source defaults to session')
})

test('client bundle: the review card save key list carries all six keys', () => {
  // REVIEW_KEYS decides what a card save persists; a dropped key silently
  // never saves. Anchor the array literal members (compiled with double
  // quotes). Check each key appears right after the REVIEW_KEYS array opener.
  const at = client.indexOf('REVIEW_KEYS = [')
  assert.ok(at !== -1, 'REVIEW_KEYS array is present')
  const block = client.slice(at, at + 500)
  for (const key of keys) {
    assert.ok(block.includes(`"${key}"`), `REVIEW_KEYS must carry ${key}`)
  }
})

test('client bundle: valueOf persists the source switch and non-empty custom pairs', () => {
  // valueOf writes the source always, and provider/model only while non-empty
  // (mirroring the reviewer-trio convention) so empty strings never persist.
  const at = client.indexOf('value.classifierModelSource = draft.classifierModelSource')
  assert.ok(at !== -1, 'classifier source switch persists unconditionally')
  assert.ok(client.includes('if (draft.classifierProvider.trim()) value.classifierProvider'), 'classifier provider persists only when non-empty')
  assert.ok(client.includes('if (draft.classifierModel.trim()) value.classifierModel'), 'classifier model persists only when non-empty')
  const r = client.indexOf('value.reviewerModelSource = draft.reviewerModelSource')
  assert.ok(r !== -1, 'reviewer source switch persists unconditionally')
  assert.ok(client.includes('if (draft.reviewerHostProvider.trim()) value.reviewerHostProvider'), 'reviewer host provider persists only when non-empty')
  assert.ok(client.includes('if (draft.reviewerHostModel.trim()) value.reviewerHostModel'), 'reviewer host model persists only when non-empty')
})

test('client bundle: the invalid-config mirror tables know the new keys', () => {
  // Stored values of the wrong type or an unknown source enum must be flagged
  // by the red banner; a mirror table that forgets a key silently skips it.
  const typesAt = client.indexOf('INVALID_CONFIG_TYPES')
  const enumsAt = client.indexOf('INVALID_CONFIG_ENUMS')
  assert.ok(typesAt !== -1 && enumsAt > typesAt, 'both mirror tables are bundled')
  const tables = client.slice(typesAt, client.indexOf('function findInvalidConfigKeys'))
  for (const key of keys) {
    assert.ok(tables.includes(key), `mirror tables mention ${key}`)
  }
  assert.ok(tables.includes('classifierModelSource: ["session", "custom"]'), 'classifier source enum is validated')
  assert.ok(tables.includes('reviewerModelSource: ["session", "custom"]'), 'reviewer source enum is validated')
})

test('client bundle: the source-switch UI copy is wired (no retired key regression)', () => {
  // The two source sections render through the locale map with the "custom"
  // option and the follow-session default.
  for (const key of ['settings.reviewer.source.classifier', 'settings.reviewer.source.reviewer', 'settings.reviewer.source.provider', 'settings.reviewer.source.model', 'option.modelSource.session', 'option.modelSource.custom']) {
    assert.ok(client.includes(key), `locale key ${key} is referenced by the UI`)
  }
  // The retired provider-dropdown family must stay gone.
  for (const banned of ['settings.reviewer.followSession', 'settings.reviewer.loadingModels', 'settings.reviewer.provider\':']) {
    assert.ok(!client.includes(banned), `retired key ${banned} must not resurface`)
  }
})

test('client bundle: the catalog routes are referenced by the pickers', () => {
  assert.ok(client.includes('/providers'), 'providers route is fetched')
  assert.ok(client.includes('/llm-models'), 'llm-models route is fetched')
  assert.ok(!client.includes('auto-approval-llm/models'), 'the retired models path stays out of the client too')
})

test('client bundle: the source menu offers presets and hides the inputs unless custom', () => {
  // The Issue #5 interaction: the source menu lists 跟随会话 / 自定义 / every
  // discovered `provider/model` preset; picking a preset fills the pair with no
  // input row, choosing 自定义 reveals the provider/model inputs. Anchor the
  // wiring helpers in the compiled bundle.
  assert.ok(client.includes('const presetLabel = '), 'the preset label helper is bundled')
  assert.ok(client.includes('preset:'), 'preset menu values are composed')
  assert.ok(client.includes('llmPresetModels'), 'the flattened preset list state exists')
  assert.ok(client.includes('currentMenuValue'), 'the menu-value derivation is bundled')
  assert.ok(client.includes('applyMenuValue'), 'the menu-value application is bundled')
  assert.ok(client.includes('sourceSection'), 'the shared source-section renderer is bundled')
  assert.ok(client.includes('dsa-provider-suggest') === false && client.includes('dsa-model-suggest') === false,
    'the double-click datalist suggestions are gone')
})
