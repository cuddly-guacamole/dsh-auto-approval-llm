/**
 * dsh-auto-approval-llm · retired settings document import contract.
 *
 * The host line that stores settings as a profile patch imported the previous
 * `settings.yaml` once and renamed it. This namespace's stored values stayed in
 * that renamed file and never reached the live configuration, so the row page
 * offers to take them back — and that offer is the whole risk surface:
 *
 *   1. the file is the HOST's document, not ours: a shape this reader does not
 *      model must be dropped rather than guessed, because one click writes
 *      whatever it returns into the live namespace;
 *   2. a host-owned key (the operator's paths, the retired no-op switch) must
 *      never reach an op — the plane refuses it, and the operator owns it;
 *   3. the offer is measured against what the entry's own configuration
 *      DECLARES, not against the resolved configuration: every schema field
 *      carries a default, so the resolved configuration names every card-owned
 *      key and an offer keyed on its absence could never appear. A declaration
 *      vetoes only when it carries a value of its own: the config plane rewrites
 *      the entry config on every save with the effective value of every
 *      card-owned key, so a declaration that restates a schema default is that
 *      echo and not a stored choice. A value is offered only when it DIFFERS
 *      from the effective configuration, because importing a value that is
 *      already in effect changes nothing and only pins a default into an
 *      explicit declaration; and the keys the shipped patch layer states for
 *      this deployment are never offered at all, whatever the document stores
 *      (that half of the predicate lives in tests/c1g-offer-predicate.test.mjs
 *      next to the drift check on the shipped file);
 *   4. nothing but a click may write: an import that runs on mount, on refresh
 *      or on a route read is a silent settings write.
 *
 * The import payload carries the offered values; the undo carries the values the
 * affected fields held before it, so an import is reversible without a second
 * write channel (the retired POST route stays retired). Both go through the one
 * write channel the page owns — the host form — which projects every payload to
 * the card-owned keys again before any op names it.
 *
 * Run: node --test tests/legacy-settings-import.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Config, installSettingsRoute, legacyImportPlan, readLegacySettings, readSettingsSegment } from '../lib/index.js'
import { EDITABLE_CONFIG_KEYS, HOST_ONLY_KEYS, SHIPPED_PINNED_KEYS, plainConfigValue } from '../lib/auto/decision.js'
import { buildMutateOps, legacyImportBefore, legacyImportOf, legacyImportWrite, legacyUndoWrite } from '../lib/client/row-config.js'
import { callSpec, carrierContext, findSpec } from './helpers/carrier-route.mjs'

const NS = 'auto-approval-llm'
const source = (name) => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const CLIENT = source('../src/client/index.ts')
const LOCALE = source('../src/client/locale.ts')
const countOf = (source, needle) => source.split(needle).length - 1
const byPath = (list) => [...list].sort((a, b) => (a.path[0] < b.path[0] ? -1 : 1))

/** A value per host-owned key that the bounded reader accepts, so all 16 are pinned. */
const HOST_ONLY_VALUES = {
  workspaceRoot: '""',
  dshHome: '""',
  tempRoots: '[]',
  trustedDirs: '[]',
  trustedDshSubpaths: '[]',
  maintenanceDshPaths: '[]',
  autoSwitchPolicyToAsk: 'true',
  reviewerContextFacts: 'false',
  rulesDryRun: 'false',
}

/** A retired document carrying every host-owned key plus the card-owned ones. */
const LEGACY_TEXT = [
  'ui-theme:',
  '  mode: dark',
  `${NS}:`,
  '  enabled: true',
  '  timeoutAction: low-risk-allow',
  '  llmReviewScope: low-or-above',
  '  safetyPrompt: ""',
  '  debug: false',
  '  allowlist:',
  '    - mcp__playwright__*',
  '    - mcp__playwright',
  '  categoryPolicy: {}',
  '  lowRiskSeconds: 5',
  '  reviewerReasoning: low',
  ...HOST_ONLY_KEYS.map((key) => `  ${key}: ${HOST_ONLY_VALUES[key] ?? '0'}`),
  'skin-wallpaper:',
  '  enabled: false',
].join('\n')

/** The configuration the namespace declares (its own patch layer). */
const DECLARED = { debug: true }

/** The factory configuration: every schema key at the value the schema declares. */
const FACTORY = plainConfigValue(Config())

/**
 * Whether `declared` stores a value of its own for `key`: a declaration at the
 * schema default is the config plane's echo of the effective value, so only a
 * value the schema does not default to is a stored choice that vetoes.
 */
const declaresOwnValueFor = (declared, key) => Object.prototype.hasOwnProperty.call(declared, key) &&
  JSON.stringify(declared[key]) !== JSON.stringify(FACTORY[key])

const declaresOwnValue = (key) => declaresOwnValueFor(DECLARED, key)

/** The keys the shipped patch layer states for this deployment. */
const PINNED = new Set(SHIPPED_PINNED_KEYS)

/** The retired document as the bounded reader sees it. */
const segment = readSettingsSegment(LEGACY_TEXT, NS)

/**
 * The effective configuration the route serves. It carries the document's own
 * values for every key this fixture does not name — the common shape a real host
 * presents, because both documents were written from the same defaults — so a
 * key that is not named here is in effect exactly as the document stored it.
 * The named keys are the ones the document disagrees with.
 */
const EFFECTIVE = {
  ...segment,
  timeoutAction: 'reject',
  allowlist: [],
  llmReviewScope: 'high',
  lowRiskSeconds: 9,
  debug: true,
  categoryPolicy: { delete: 'auto' },
}

/**
 * The values this document would change, derived from the two fixtures alone so
 * the expectation is not a restatement of the implementation: card-owned, not
 * pinned by the shipped layer, not declared at a value of its own, and absent
 * from the effective configuration or different in it.
 */
const CHANGING = Object.keys(segment)
  .filter((key) => EDITABLE_CONFIG_KEYS.includes(key) && !PINNED.has(key))
  .filter((key) => !declaresOwnValue(key))
  .filter((key) => !Object.prototype.hasOwnProperty.call(EFFECTIVE, key) || JSON.stringify(segment[key]) !== JSON.stringify(EFFECTIVE[key]))

/** Brace-balanced body of the first `marker` in `source` (see the client tests). */
function block(source, marker) {
  const at = source.indexOf(marker)
  assert.notEqual(at, -1, `source marker missing: ${marker}`)
  const signatureEnd = marker.endsWith(')') ? at + marker.length : source.indexOf(')', at + marker.length)
  const open = source.indexOf('{', signatureEnd)
  assert.notEqual(open, -1, `no block body after: ${marker}`)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  return assert.fail(`unbalanced body after: ${marker}`)
}

/** Every `React.useEffect` body, so a write hidden in one can be proven absent. */
function effectBodies(source) {
  const bodies = []
  let from = 0
  for (;;) {
    const at = source.indexOf('React.useEffect(', from)
    if (at === -1) break
    const open = source.indexOf('{', at)
    assert.notEqual(open, -1, 'an effect has a body')
    let depth = 0
    let end = -1
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    assert.notEqual(end, -1, 'every effect body is balanced')
    bodies.push(source.slice(open, end))
    from = end
  }
  assert.ok(bodies.length > 0, 'the client declares effects')
  return bodies
}

/** Settings plane of the route test: records every write it is asked to make. */
function fakeSettings(stored) {
  const value = { ...stored }
  const writes = []
  return {
    describe: () => [{ ns: NS, value, revision: 1, applies: 'live' }],
    writable: true,
    replace: async (ns, next) => { writes.push([ns, next]) },
    get: () => value,
    writeCount: () => writes.length,
  }
}

/** A context whose plugin entry declares `config`, the way the Host exposes it. */
function carrierWithDeclaration(config) {
  const carried = carrierContext()
  carried.ctx.fiber = { entry: { options: { config } } }
  return carried
}

const LOOPBACK = { method: 'GET', headers: { host: 'localhost:3080' } }

// ── detection ─────────────────────────────────────────────────────────────

test('a retired card-owned field the declared configuration lacks, and whose value differs, is offered for import', () => {
  const plan = legacyImportPlan(segment, DECLARED, EFFECTIVE)
  assert.ok(plan.keys.includes('categoryPolicy'), 'a stored value the declaration lacks and the configuration does not already carry is offered')
  assert.ok(plan.keys.includes('llmReviewScope'), 'a key the configuration holds at another value is offered')
  assert.ok(EDITABLE_CONFIG_KEYS.includes('categoryPolicy'), 'precondition: the fixture key is card-owned')
  assert.deepEqual(plan.value.categoryPolicy, {}, 'an empty mapping is read as the empty object it is')
  assert.equal(plan.value.safetyPrompt, undefined, 'a value the configuration already holds is not carried in the payload')
  assert.ok(!plan.keys.includes('safetyPrompt'), 'a field whose stored value is already in effect is not offered')
  assert.ok(!plan.keys.includes('debug'), 'a key the declared configuration carries at a value of its own is never offered')
  assert.equal(DECLARED.debug, true, 'precondition: the declared value is the operator\'s own, not the schema default')
  assert.equal(FACTORY.debug, false, 'precondition: the schema defaults that key to the other value')
  assert.notDeepEqual(EFFECTIVE.debug, segment.debug, 'precondition: the documents disagree about it, so only the declaration keeps it out')
  // Every list-valued card-owned key is declared by the shipped patch layer, so
  // the pin — not the value test — is what keeps the stored allowlist out.
  assert.ok(PINNED.has('allowlist'), 'precondition: the shipped layer states the allowlist')
  assert.deepEqual(segment.allowlist, ['mcp__playwright__*', 'mcp__playwright'], 'precondition: a block list of scalars survives the bounded reader')
  assert.ok(!plan.keys.includes('allowlist'), 'a stored list the shipped layer pins is never offered')
  assert.equal(plan.value.allowlist, undefined, 'and the payload carries nothing for that field')
  assert.ok(!plan.keys.includes('reviewerReasoning'), 'nor one whose stored value matches it through the reader')
  assert.equal(segment.reviewerReasoning, 'low', 'precondition: the fixture stores the value the schema defaults to')
  assert.ok(!Object.prototype.hasOwnProperty.call(plan.value, 'reviewerReasoning'), 'and the payload carries nothing for that field')
})

test('the offer is exactly the values the effective configuration does not already carry', () => {
  const plan = legacyImportPlan(segment, DECLARED, EFFECTIVE)
  assert.deepEqual([...plan.keys].sort(), [...CHANGING].sort(), 'a comparison against the configuration the card serves, not against the declaration alone')
  assert.ok(CHANGING.includes('categoryPolicy'), 'precondition: the fixture really changes a field')
  assert.ok(CHANGING.length < Object.keys(segment).length, 'precondition: the fixture also carries fields that change nothing')
  // A comparison against a configuration that already holds every stored value
  // offers nothing at all: an import could only pin those values in place.
  const settled = { ...EFFECTIVE, categoryPolicy: {}, timeoutAction: segment.timeoutAction, llmReviewScope: segment.llmReviewScope, lowRiskSeconds: segment.lowRiskSeconds, allowlist: segment.allowlist }
  assert.deepEqual(legacyImportPlan(segment, DECLARED, settled).keys, [], 'every stored value already in effect offers nothing')
  assert.ok(plan.keys.length > 0, 'and the same document does offer against the real configuration')
})

test('a mapping is compared by its entries, and a pinned list never reaches the comparison', () => {
  const carried = legacyImportPlan(segment, DECLARED, { ...EFFECTIVE, allowlist: [...segment.allowlist] })
  assert.ok(!carried.keys.includes('allowlist'), 'a pinned list is not offered, not even when the configuration holds the same entries')
  assert.ok(carried.keys.includes('categoryPolicy'), 'and the check stays per key')
  const emptied = legacyImportPlan(segment, DECLARED, { ...EFFECTIVE, allowlist: [] })
  assert.ok(!emptied.keys.includes('allowlist'), 'nor when the configuration holds that list empty')
  // The mapping is the value shape the offer does reach, so the comparison
  // itself is pinned there: same entries in another object are the same value,
  // one differing entry is a different one.
  const mapping = legacyImportPlan(segment, DECLARED, { ...EFFECTIVE, categoryPolicy: { edit: 'ask' } })
  assert.ok(mapping.keys.includes('categoryPolicy'), 'a mapping that differs by one entry differs')
  assert.ok(!legacyImportPlan(segment, DECLARED, { ...EFFECTIVE, categoryPolicy: {} }).keys.includes('categoryPolicy'), 'a mapping with the same entries, in another object, is the same value')
})

test('no host-owned key ever enters the import plan', () => {
  const plan = legacyImportPlan(segment, DECLARED, EFFECTIVE)
  const hostOwned = new Set(HOST_ONLY_KEYS)
  const offered = plan.keys.filter((key) => hostOwned.has(key))
  assert.deepEqual(offered, [], 'an import names card-owned keys alone')
  const carrier = Object.keys(plan.value).filter((key) => hostOwned.has(key))
  assert.deepEqual(carrier, [], 'the payload carries no host-owned value')
  assert.ok(!plan.keys.includes('autoSwitchPolicyToAsk'), 'the retired host-owned no-op switch is never imported')
  assert.ok(Object.prototype.hasOwnProperty.call(segment, 'autoSwitchPolicyToAsk'), 'precondition: the fixture really offers it')
  assert.ok(HOST_ONLY_KEYS.every((key) => Object.prototype.hasOwnProperty.call(segment, key)), 'precondition: the fixture carries every host-owned key')
  assert.deepEqual([...plan.keys].sort(), [...CHANGING].sort(), 'exactly the card-owned keys the declaration lacks and the effective configuration does not already carry are offered')
})

test('a key the declared configuration carries at a value of its own is not offered, even when the values differ', () => {
  const declared = { categoryPolicy: { edit: 'deny' }, debug: true }
  const plan = legacyImportPlan(segment, declared, EFFECTIVE)
  assert.ok(!plan.keys.includes('categoryPolicy'), 'a declared value is the user-visible one and stays')
  assert.ok(!Object.prototype.hasOwnProperty.call(plan.value, 'categoryPolicy'), 'the payload carries no value for it either')
  assert.deepEqual(segment.categoryPolicy, {}, 'precondition: the document stores an empty mapping')
  assert.notDeepEqual(EFFECTIVE.categoryPolicy, declared.categoryPolicy, 'precondition: the declared mapping is a value of its own, not the schema default')
  assert.ok(!plan.keys.includes('debug'), 'a declared switch is not offered either, however it compares to the effective one')
  assert.notDeepEqual(EFFECTIVE.debug, segment.debug, 'precondition: the declared value differs from the effective one too')
  assert.equal(plan.value.debug, undefined, 'and the payload carries nothing for it')
  assert.ok(plan.keys.includes('llmReviewScope'), 'the check is per key, not per document')
})

test('a declaration that carries a value of its own for every key offers nothing to compare against a declaration', () => {
  // The resolved configuration is a different object from the declaration: this
  // pins the reason the offer is NOT measured against it. A fixture that stores
  // a value of its own for every card-owned key offers nothing, whatever the
  // effective configuration names.
  const ownValues = Object.fromEntries(EDITABLE_CONFIG_KEYS.map((key) => [key, { of: 'its own' }]))
  assert.deepEqual(legacyImportPlan(segment, ownValues, FACTORY).keys, [], 'every key declared at a value of its own means no offer')
  const noValues = Object.fromEntries(EDITABLE_CONFIG_KEYS.map((key) => [key, undefined]))
  assert.deepEqual(legacyImportPlan(segment, noValues, noValues).keys, [], 'a declaration that names a key without a value is not the schema default either')
  assert.ok(legacyImportPlan(segment, DECLARED, EFFECTIVE).keys.length > 0, 'and the very same document does offer against a declaration of the shipped shape')
})

test('degenerate documents read as nothing, never as an error', () => {
  assert.deepEqual(readSettingsSegment('', NS), {}, 'an empty file carries no segment')
  assert.deepEqual(readSettingsSegment('ui-theme:\n  mode: dark\n', NS), {}, 'a document without this segment offers nothing')
  assert.deepEqual(readSettingsSegment(`${NS}:\n\nskin-wallpaper:\n  enabled: false\n`, NS), {}, 'an empty segment offers nothing')
  assert.deepEqual(readSettingsSegment(`${NS}:\n  enabled`, NS), {}, 'a line without a separator is not guessed into a key')
  assert.deepEqual(readSettingsSegment(`${NS}:\n\tenabled: true\n`, NS), { enabled: true }, 'the field level is read from the first indented line, so a tab-indented body is one field level like any other')
  assert.deepEqual(readSettingsSegment(`${NS}:\n  enabled: true\n    debug: false\n`, NS), {}, 'a line deeper than a field that already carries a value is a shape this reader does not model, so that field is dropped rather than reported with a value the document contradicts')
  assert.deepEqual(readSettingsSegment(`${NS}:\n  categoryPolicy:\n    delete: auto\n`, NS), {}, 'a nested mapping is dropped rather than flattened into a wrong value')
  assert.deepEqual(readSettingsSegment(`${NS}:\n  allowlist:\n    - key: value\n`, NS), {}, 'a list of mappings is dropped')
  assert.deepEqual(readSettingsSegment(`${NS}:\n  allowlist: [a, b]\n`, NS), {}, 'a flow collection with entries is dropped')
  assert.deepEqual(readSettingsSegment(`${NS}:\n  workspaceRoot: C:\\Users # home\n`, NS), {}, 'a scalar carrying a comment is dropped rather than imported with the comment in it')
  assert.deepEqual(readSettingsSegment(`${NS}:\n  rulesText: |\n    line\n`, NS), {}, 'a block scalar is dropped')
  assert.deepEqual(readSettingsSegment(`${NS}:\n  safetyPrompt: "a\\nb"\n`, NS), {}, 'a quoted scalar with escapes is dropped rather than half-unescaped')
  const partial = readSettingsSegment(`${NS}:\n  enabled: true\n  categoryPolicy:\n    delete: auto\n  debug: false\n`, NS)
  assert.deepEqual(partial, { enabled: true, debug: false }, 'one unmodelled field must not take the whole segment with it')
})

test('an unreadable document reads as no document', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsa-legacy-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.deepEqual(readLegacySettings('', NS), {}, 'no path means no document')
  assert.deepEqual(readLegacySettings(join(dir, 'settings.yaml.imported'), NS), {}, 'a missing file is not an error')
  assert.deepEqual(readLegacySettings(dir, NS), {}, 'a directory in the file position is not an error')
  const broken = join(dir, 'broken.yaml.imported')
  writeFileSync(broken, `${NS}:\n  enabled: true\n  "unterminated: [\n`)
  assert.deepEqual(readLegacySettings(broken, NS), { enabled: true }, 'a truncated tail drops that field alone')
  const nested = join(dir, 'nested', 'settings.yaml.imported')
  mkdirSync(join(dir, 'nested'))
  writeFileSync(nested, LEGACY_TEXT)
  assert.ok(Object.keys(readLegacySettings(nested, NS)).length > 0, 'a readable document is read')
})

// ── the route's offer ─────────────────────────────────────────────────────

test('the read-only route carries the import offer and owns no write path', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsa-legacy-route-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'settings.yaml.imported'), LEGACY_TEXT)
  const stored = { timeoutAction: 'reject', llmReviewScope: 'high', lowRiskSeconds: 9, categoryPolicy: { delete: 'auto' } }
  const settings = fakeSettings(stored)
  const { ctx, specs } = carrierWithDeclaration({ timeoutAction: 'reject' })
  installSettingsRoute(ctx, settings, { rejectGuidance: true }, dir)
  const route = findSpec([...specs.values()], 'settings')
  assert.deepEqual([...route.methods], ['GET'], 'the import offer rides the retained read-only route; no write channel is added')
  const res = await callSpec(route, LOOPBACK)
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.ok(Array.isArray(res.body.value.legacyImport.keys) && res.body.value.legacyImport.keys.length > 0, 'the offer reaches the client through the snapshot it already reads')
  assert.ok(!res.body.value.legacyImport.keys.includes('timeoutAction'), 'a key the shipped layer states is not offered, whatever the declaration carries')
  assert.ok(PINNED.has('timeoutAction'), 'precondition: the shipped layer really states the timeout action')
  assert.ok(res.body.value.legacyImport.keys.includes('llmReviewScope'), 'a key the snapshot serves at another value is offered')
  assert.ok(res.body.value.legacyImport.keys.includes('categoryPolicy'), 'a key whose stored value differs from the one in effect is offered')
  assert.equal(res.body.value.value.llmReviewScope, 'high', 'precondition: the snapshot really carries that stored value')
  // The comparison source is the configuration the snapshot serves. Served at
  // the stored value, the very same key stops being offered, which is what keeps
  // an import from writing values that are already in effect.
  const settled = carrierWithDeclaration({ timeoutAction: 'reject' })
  installSettingsRoute(settled.ctx, fakeSettings({ ...stored, llmReviewScope: 'low-or-above' }), { rejectGuidance: true }, dir)
  const settledRes = await callSpec(findSpec([...settled.specs.values()], 'settings'), LOOPBACK)
  assert.ok(!settledRes.body.value.legacyImport.keys.includes('llmReviewScope'), 'a key the snapshot already serves at the stored value is not offered')
  assert.ok(settledRes.body.value.legacyImport.keys.includes('categoryPolicy'), 'while a key it serves at another value still is')
  assert.deepEqual(Object.keys(res.body.value.legacyImport.value).sort(), [...res.body.value.legacyImport.keys].sort(), 'every offered key carries its value')
  assert.equal(settings.writeCount(), 0, 'reading the offer writes nothing')
  // A route installed without a settings home (every existing caller) offers
  // nothing instead of reaching for the machine's real home directory.
  const bare = carrierWithDeclaration({ timeoutAction: 'reject' })
  installSettingsRoute(bare.ctx, fakeSettings(stored), {})
  const bareRoute = findSpec([...bare.specs.values()], 'settings')
  const bareRes = await callSpec(bareRoute, LOOPBACK)
  assert.equal(bareRes.status, 200)
  assert.deepEqual(bareRes.body.value.legacyImport, { keys: [], value: {} }, 'no settings home means no offer')
})

test('the offer is exactly the values the declaration lacks and the snapshot does not already carry', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsa-legacy-declared-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'settings.yaml.imported'), LEGACY_TEXT)
  // The page's form carries the resolved configuration: it names every field the
  // schema declares a default for. An offer measured against THAT object could
  // never appear on a real host, so the route reads the entry's own
  // configuration instead — the same source the host's config editor writes to,
  // and a declaration that only restates a schema default does not veto there.
  // Whether a field is worth offering is the second question, answered against
  // the configuration the snapshot serves, and the shipped layer's own keys are
  // out of the offer entirely.
  const resolved = { enabled: true, timeoutAction: 'reject', llmReviewScope: 'high', allowlist: [] }
  const declared = { timeoutAction: 'reject' }
  const { ctx, specs } = carrierWithDeclaration(declared)
  installSettingsRoute(ctx, fakeSettings(resolved), {}, dir)
  const res = await callSpec(findSpec([...specs.values()], 'settings'), LOOPBACK)
  const offered = res.body.value.legacyImport.keys
  const expected = Object.keys(segment)
    .filter((key) => EDITABLE_CONFIG_KEYS.includes(key) && !PINNED.has(key) && !declaresOwnValueFor(declared, key))
    .filter((key) => !Object.prototype.hasOwnProperty.call(resolved, key) || JSON.stringify(segment[key]) !== JSON.stringify(resolved[key]))
  assert.deepEqual([...offered].sort(), expected.sort(), 'the offer follows the declaration and the effective values alone')
  assert.ok(offered.includes('categoryPolicy'), 'a field the resolved configuration names at another value is still offered')
  assert.ok(!offered.includes('timeoutAction'), 'and a field the shipped layer states is not, even though the resolved configuration names it too')
  assert.ok(offered.includes('llmReviewScope'), 'a field the declaration lacks and the snapshot serves at another value is offered')
  assert.equal(res.body.value.value.llmReviewScope, 'high', 'the snapshot still serves the resolved value the page renders')
})

test('a host that exposes no entry configuration offers nothing rather than everything', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsa-legacy-undeclared-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'settings.yaml.imported'), LEGACY_TEXT)
  const { ctx, specs } = carrierContext()
  installSettingsRoute(ctx, fakeSettings({ enabled: true }), {}, dir)
  const res = await callSpec(findSpec([...specs.values()], 'settings'), LOOPBACK)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.value.legacyImport, { keys: [], value: {} }, 'without a declaration the whole editable set is not put behind one click')
})

// ── payload ───────────────────────────────────────────────────────────────

test('the import payload names card-owned keys alone, even when handed dirty data', () => {
  const clean = legacyImportOf({ legacyImport: legacyImportPlan(segment, DECLARED, EFFECTIVE) })
  assert.ok(clean !== undefined, 'precondition: the route offers a batch')
  const pending = legacyImportWrite(clean)
  assert.deepEqual(pending.keys, [...clean.keys], 'every offered field is projected, in the offered order')
  assert.deepEqual(Object.keys(pending.write.value ?? {}), [...clean.keys], 'the write carries one value per offered field')
  const ops = buildMutateOps(pending.write)
  assert.ok(ops.length > 0, 'the batch produces ops')
  assert.deepEqual(ops.map((op) => op.path[0]), [...clean.keys], 'one op per offered field, in the card-owned order the op builder uses')
  assert.deepEqual(ops.filter((op) => op.op !== 'set'), [], 'an import only sets fields')
  assert.deepEqual(ops.map((op) => op.path[0]).filter((key) => HOST_ONLY_KEYS.includes(key)), [], 'no op names a host-owned field the route already filtered')
  assert.deepEqual(ops.map((op) => op.path[0]).filter((key) => !EDITABLE_CONFIG_KEYS.includes(key)), [], 'no op names a field outside the card')

  // The route is not the only thing between the file and the plane: a payload
  // that arrives carrying the host-owned keys anyway must still build none.
  const dirty = legacyImportOf({
    legacyImport: {
      keys: [...clean.keys, ...HOST_ONLY_KEYS, 'notAConfigKey'],
      value: { ...clean.value, ...Object.fromEntries(HOST_ONLY_KEYS.map((key) => [key, 'dirty'])), notAConfigKey: 'dirty' },
    },
  })
  const dirtyPending = legacyImportWrite(dirty)
  assert.deepEqual(dirtyPending.keys, [...clean.keys], 'the projection drops exactly the keys the plane does not own')
  assert.deepEqual(buildMutateOps(dirtyPending.write), ops, 'the dirty keys change nothing the clean batch would have written')
})

test('a batch with nothing to offer reads as no batch', () => {
  assert.equal(legacyImportOf({}), undefined)
  assert.equal(legacyImportOf({ legacyImport: { keys: [], value: {} } }), undefined)
  assert.equal(legacyImportOf({ legacyImport: { keys: ['debug'] } }), undefined)
  assert.equal(legacyImportOf({ legacyImport: { keys: ['debug'], value: [] } }), undefined)
  assert.equal(legacyImportOf({ legacyImport: 'debug' }), undefined)
  assert.equal(legacyImportOf(null), undefined)
})

test('the op builder is the last gate: no payload can name a field the plane does not own', () => {
  // Whatever an upstream layer hands over — a route answer, a future key the two
  // tables disagree about — the object that becomes ops is projected here.
  const ops = buildMutateOps({ value: { debug: false, trustedDirs: ['C:/x'], notAConfigKey: 1 } })
  assert.deepEqual(ops.map((op) => op.path[0]), ['debug'], 'only a card-owned field becomes a set op')
  assert.deepEqual(
    buildMutateOps({ unset: [...HOST_ONLY_KEYS, 'notAConfigKey', 'debug'] }).map((op) => op.path[0]),
    ['debug'],
    'an unset is projected by the same rule',
  )
  assert.ok(EDITABLE_CONFIG_KEYS.includes('debug'), 'precondition: the surviving key is card-owned')
  assert.ok(!EDITABLE_CONFIG_KEYS.includes('trustedDirs'), 'precondition: the dropped key is host-owned')
})

// ── silence ───────────────────────────────────────────────────────────────

test('nothing but a click can start an import', () => {
  assert.equal(countOf(CLIENT, 'legacyImportWrite('), 1, 'the import projection is applied in exactly one place')
  const importHandler = block(CLIENT, 'const importLegacySettings = async ()')
  assert.ok(importHandler.includes('legacyImportWrite('), 'that place is the import handler')
  assert.equal(countOf(CLIENT, 'importLegacySettings()'), 1, 'the handler is invoked exactly once')
  assert.ok(CLIENT.includes('onClick: () => { void importLegacySettings() }'), 'the one invocation is a click')
  const undoHandler = block(CLIENT, 'const undoLegacyImport = async ()')
  assert.ok(undoHandler.includes('legacyUndoWrite('), 'the undo projects in its own handler')
  assert.equal(countOf(CLIENT, 'legacyUndoWrite('), 1, 'and nowhere else')
  assert.equal(countOf(CLIENT, 'undoLegacyImport()'), 1, 'the undo handler is invoked exactly once')
  assert.ok(CLIENT.includes('onClick: () => { void undoLegacyImport() }'), 'and that one invocation is a click')
  // An effect runs on mount and on every dependency change: a write there would
  // import the retired document into every open page, with no user action.
  const effects = effectBodies(CLIENT)
  for (const token of ['importLegacySettings', 'undoLegacyImport', 'legacyImportWrite(', 'legacyUndoWrite(']) {
    assert.deepEqual(effects.filter((body) => body.includes(token)), [], `no effect may run ${token}`)
  }
  // One write channel for the page: the host form, projected once, so no import
  // path can name a key the plane refuses or bypass the form's own gate.
  assert.equal(countOf(CLIENT, 'buildMutateOps('), 1, 'every write is projected in one place')
  assert.equal(countOf(CLIENT, 'writeForm.mutate('), 1, 'and every write goes through the one form call')
})

test('the banner is rendered above the form and never without a host form', () => {
  assert.equal(countOf(CLIENT, 'legacyBanner,'), 1, 'the banner is rendered in exactly one place')
  const content = CLIENT.slice(CLIENT.indexOf("const content = React.createElement('div'"))
  assert.match(content, /\n\s+legacyBanner,\n\s+bannerMessage/, 'the banner is the first child of the page column, above every other banner')
  // The read-only body returns before the banner is built: a page with no host
  // form has no write channel, so it must not offer an import at all.
  const readOnlyAt = CLIENT.indexOf("if (writeForm === undefined) {\n    const readOnlyBody")
  assert.ok(readOnlyAt > 0, 'the form-less branch builds the read-only body')
  assert.ok(readOnlyAt < CLIENT.indexOf('const legacyBanner'), 'that branch leaves before the banner exists')
})

test('a banner line that names a count is always handed one', () => {
  const calls = [...CLIENT.matchAll(/t\('(settings\.legacyImport\.[A-Za-z]+)'(?:\s*,\s*\{([^}]*)\})?\)/g)]
  assert.ok(calls.length > 0, 'the client renders the banner lines')
  for (const [whole, key, args] of calls) {
    const texts = [...LOCALE.matchAll(new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'g'))].map((match) => match[1])
    assert.equal(texts.length, 2, `both languages carry ${key}`)
    if (!texts.some((text) => text.includes('{count}'))) continue
    assert.ok((args ?? '').includes('count'), `${key} names a count and must be given one: ${whole}`)
  }
  assert.ok(calls.some(([, key]) => key === 'settings.legacyImport.done'), 'precondition: the imported line is rendered')
})

// ── undo ──────────────────────────────────────────────────────────────────

test('the undo writes the recorded values back and leaves every other field alone', () => {
  const keys = ['timeoutAction', 'llmReviewScope']
  const before = legacyImportBefore({ timeoutAction: 'reject', debug: false, learningEnabled: true }, keys)
  assert.deepEqual(before, { timeoutAction: 'reject' }, 'only the affected fields are recorded')
  assert.deepEqual(
    byPath(buildMutateOps(legacyUndoWrite(before, keys))),
    byPath([{ op: 'set', path: ['timeoutAction'], value: 'reject' }, { op: 'unset', path: ['llmReviewScope'] }]),
    'a recorded value is written back; a field the configuration did not carry returns to its base',
  )
  // A field the configuration never carried has no recorded value: an `unset` is
  // the only honest undo, and path ops leave every unnamed field untouched.
  assert.deepEqual(legacyImportBefore({ debug: false }, keys), {}, 'a missing field is absent, not recorded as undefined')
  assert.deepEqual(
    byPath(buildMutateOps(legacyUndoWrite({}, keys))),
    byPath([{ op: 'unset', path: ['timeoutAction'] }, { op: 'unset', path: ['llmReviewScope'] }]),
    'nothing recorded means every affected field returns to its base',
  )
})

test('the undo cannot name a host-owned field either', () => {
  const dirty = [...HOST_ONLY_KEYS, 'notAConfigKey', 'debug']
  assert.deepEqual(
    byPath(buildMutateOps(legacyUndoWrite(legacyImportBefore({}, dirty), dirty))),
    [{ op: 'unset', path: ['debug'] }],
    'the undo projects to the card-owned fields',
  )
  assert.deepEqual(
    byPath(buildMutateOps(legacyUndoWrite(legacyImportBefore({ debug: false }, dirty), dirty))),
    [{ op: 'set', path: ['debug'], value: false }],
    'a recorded false is written back as false, not dropped as emptiness',
  )
})
