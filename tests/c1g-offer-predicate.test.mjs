/**
 * dsh-auto-approval-llm · the import offer's predicate (declaration at the
 * factory default, shipped-layer pins).
 *
 * The offer reads the entry's own configuration. The config plane rewrites that
 * config on every save with the effective value of every card-owned key, so
 * reading a default-valued declaration as a stored operator choice emptied the
 * offer on every installation that had saved once — and the banner, with the
 * only button that could take the retired document back, disappeared for good.
 * Two rules keep the offer meaningful and unchanged by a save:
 *
 *   1. a declaration vetoes an offer only when it carries a value of its own —
 *      a value equal to the schema default is the plane echoing the schema, not
 *      somebody's stored choice;
 *   2. the keys the shipped patch layer declares for this deployment are never
 *      offered: that layer states the policy this installation runs with, and a
 *      stale document must not reload a relaxed timeout action or a replaced
 *      allowlist in one click.
 *
 * The fixtures are built from the real schema defaults and the real shipped
 * patch (`cordis.patch.yml`), and the pinned list is asserted against that file
 * rather than against itself, so neither reference can drift from what the
 * plugin ships. The route cases exercise the same predicate through the
 * read-only snapshot the page reads.
 *
 * Run: node --test tests/c1g-offer-predicate.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Config, installSettingsRoute, legacyImportPlan, readSettingsSegment } from '../lib/index.js'
import { EDITABLE_CONFIG_KEYS, HOST_ONLY_KEYS, SHIPPED_PINNED_KEYS, plainConfigValue } from '../lib/auto/decision.js'
import { callSpec, carrierContext, findSpec } from './helpers/carrier-route.mjs'

const NS = 'auto-approval-llm'
const LOOPBACK = { method: 'GET', headers: { host: 'localhost:3080' } }

/** The factory configuration: every schema key at the value the schema declares. */
const FACTORY = plainConfigValue(Config())

/** The seven stored values the retired document disagrees with this install about. */
const STORED_TARGETS = {
  reviewerReasoning: 'low',
  classifierReasoning: 'low',
  redactResults: true,
  categoryMode: 'aggressive',
  privilegeAutoReview: true,
  protectedAutoReview: true,
  learningEnabled: true,
}

/**
 * The shipped patch layer's card-owned keys, stored at other values, so the pin
 * has to be what keeps them out: each one is a key the effective configuration
 * does not already hold at the stored value.
 */
const STORED_PINNED = {
  enabled: false,
  timeoutAction: 'low-risk-allow',
  allowlist: ['mcp__playwright__*'],
  denyList: ['bash'],
  humanOnlyList: ['bash'],
  maxConsecutiveDenials: 9,
  maxTotalDenials: 90,
}

/** Stored values that change nothing: equal to the factory defaults. */
const STORED_NOOPS = {
  safetyPrompt: '',
  llmReviewScope: 'low-or-above',
  categoryPolicy: {},
  lowRiskSeconds: FACTORY.lowRiskSeconds,
}

/** Fixture comparator: the schema's values are plain data, so JSON is the whole comparison. */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

/** The retired document text the bounded reader parses. */
function documentText(stored) {
  const lines = [`${NS}:`]
  for (const [key, value] of Object.entries(stored)) {
    if (Array.isArray(value)) {
      lines.push(`  ${key}:`)
      for (const item of value) lines.push(`    - ${item}`)
      continue
    }
    if (value !== null && typeof value === 'object') {
      lines.push(`  ${key}: {}`)
      continue
    }
    lines.push(`  ${key}: ${value === '' ? "''" : String(value)}`)
  }
  lines.push('skin-wallpaper:', '  enabled: false')
  return lines.join('\n')
}

const documentSegment = (stored) => readSettingsSegment(documentText(stored), NS)
const BASE_STORED = { ...STORED_TARGETS, ...STORED_PINNED, ...STORED_NOOPS }
const BASE_DOCUMENT = documentSegment(BASE_STORED)

/**
 * What the offer must be, derived from the fixtures alone: card-owned, not
 * host-owned, not shipped-pinned, and carrying a value the effective
 * configuration does not already hold.
 */
function expectedOffer(segment, current) {
  return Object.keys(segment)
    .filter((key) => EDITABLE_CONFIG_KEYS.includes(key))
    .filter((key) => !HOST_ONLY_KEYS.includes(key))
    .filter((key) => !SHIPPED_PINNED_KEYS.includes(key))
    .filter((key) => !Object.prototype.hasOwnProperty.call(current, key) || !same(segment[key], current[key]))
    .sort()
}

/** The declaration a saved install hands over: every card-owned key at its effective value. */
const ECHO_DECLARATION = Object.fromEntries(EDITABLE_CONFIG_KEYS.map((key) => [key, FACTORY[key]]))

// ── the shipped layer's keys ──────────────────────────────────────────────

/** Shipped patch lines with comments stripped: the header prose names pinned values. */
const patchLines = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  .split(/\r?\n/)
  .filter((line) => !/^\s*#/.test(line))
const indentOf = (line) => line.length - line.trimStart().length

/** The `config:` block of the entry the patch inserts, keyed by the entry id. */
function shippedEntryConfig() {
  const entryAt = patchLines.findIndex((line) => /^- insert:$/.test(line))
  assert.notEqual(entryAt, -1, 'the shipped patch inserts the loader entry')
  const idAt = patchLines.findIndex((line, index) => index > entryAt && /^\s+-\s+id:\s*auto-approval-llm\s*$/.test(line))
  assert.notEqual(idAt, -1, 'the inserted entry is this plugin')
  const configAt = patchLines.findIndex((line, index) => index > idAt && /^\s+config:\s*$/.test(line))
  assert.notEqual(configAt, -1, 'the inserted entry carries its own config block')
  const base = indentOf(patchLines[configAt])
  const rows = []
  for (let i = configAt + 1; i < patchLines.length; i += 1) {
    const line = patchLines[i]
    if (line.trim() === '') continue
    if (indentOf(line) <= base) break
    rows.push(line)
  }
  const keyIndent = Math.min(...rows.map(indentOf))
  const config = {}
  for (const row of rows) {
    const field = new RegExp(`^ {${keyIndent}}([A-Za-z_][A-Za-z0-9_]*):\\s*(.*)$`).exec(row)
    // A shape this reader does not model would be silently dropped, and the
    // drift check below would then agree with a shorter list than the file has.
    assert.notEqual(field, null, `the shipped config block is a flat key list: ${JSON.stringify(row)}`)
    const raw = field[2]
    config[field[1]] = raw === '[]' ? [] : raw === '{}' ? {} : raw === 'true' ? true : raw === 'false' ? false : /^-?\d+$/.test(raw) ? Number(raw) : raw
  }
  return config
}

test('the shipped entry config block is pinned by name, and the pin covers its card-owned half', () => {
  const config = shippedEntryConfig()
  const keys = Object.keys(config)
  assert.ok(keys.length >= 9, `the shipped entry declares its own defaults: ${keys.join(',')}`)
  const cardOwned = keys.filter((key) => EDITABLE_CONFIG_KEYS.includes(key))
  assert.ok(cardOwned.length > 0, 'precondition: the shipped layer names card-owned keys')
  assert.deepEqual([...SHIPPED_PINNED_KEYS].sort(), [...cardOwned].sort(), 'the pinned list IS the shipped layer\'s card-owned keys')
  assert.deepEqual([...new Set(SHIPPED_PINNED_KEYS)], SHIPPED_PINNED_KEYS, 'the pinned list carries no duplicate')
  assert.ok(SHIPPED_PINNED_KEYS.includes('timeoutAction'), 'precondition: the shipped layer states the timeout action')
  assert.ok(SHIPPED_PINNED_KEYS.includes('allowlist'), 'precondition: the shipped layer states the allowlist')
  // The host-owned half of the block is excluded by HOST_ONLY_KEYS already;
  // pinning it as well would be a second copy of that list.
  assert.ok(keys.some((key) => HOST_ONLY_KEYS.includes(key)), 'precondition: the shipped layer also names host-owned keys')
  assert.deepEqual(SHIPPED_PINNED_KEYS.filter((key) => HOST_ONLY_KEYS.includes(key)), [], 'the pin is the card-owned half, not a copy of the host-owned list')
  assert.ok(!SHIPPED_PINNED_KEYS.includes('debug'), 'a key the shipped layer does not name is not pinned')
  // Every pinned value restates the schema default: that is what makes the pin
  // the only reason those keys stay out of the offer, never the value test.
  for (const key of cardOwned) {
    assert.deepEqual(config[key], FACTORY[key], `the shipped layer restates the schema default for ${key}`)
  }
})

// ── the declaration predicate ─────────────────────────────────────────────

test('a declaration that restates the schema default does not veto the offer', () => {
  const plan = legacyImportPlan(BASE_DOCUMENT, ECHO_DECLARATION, FACTORY)
  assert.deepEqual(
    [...plan.keys].sort(),
    ['categoryMode', 'classifierReasoning', 'learningEnabled', 'privilegeAutoReview', 'protectedAutoReview', 'redactResults', 'reviewerReasoning'],
    'the seven stored values the echoed defaults no longer hide',
  )
  assert.deepEqual([...plan.keys].sort(), expectedOffer(BASE_DOCUMENT, FACTORY), 'the offer is what the two documents disagree about')
  const declared = Object.keys(ECHO_DECLARATION)
  assert.ok(STORED_TARGETS.reviewerReasoning !== FACTORY.reviewerReasoning, 'precondition: the document and the schema disagree about the offered keys')
  assert.ok(declared.includes('reviewerReasoning'), 'precondition: the declaration names the offered key at the schema default')
  assert.deepEqual(ECHO_DECLARATION.reviewerReasoning, FACTORY.reviewerReasoning, 'precondition: that declaration value IS the default')
  assert.ok(!plan.keys.includes('safetyPrompt'), 'a stored value already in effect is not offered')
  assert.ok(!plan.keys.includes('llmReviewScope'), 'nor one the schema defaults to and the document restates')
})

test('the offer is the same before and after the host writes its echo', () => {
  // The pre-save declaration is what the shipped layer alone declares; the
  // post-save one is the plane's echo of every card-owned key. The retired
  // document and the effective configuration are identical in both reads.
  const config = shippedEntryConfig()
  const before = legacyImportPlan(BASE_DOCUMENT, config, FACTORY)
  const after = legacyImportPlan(BASE_DOCUMENT, ECHO_DECLARATION, FACTORY)
  assert.deepEqual(after.keys, before.keys, 'a save does not change the offer')
  assert.deepEqual(Object.keys(after.value).sort(), Object.keys(before.value).sort(), 'nor the payload it carries')
  assert.deepEqual([...after.keys].sort(), expectedOffer(BASE_DOCUMENT, FACTORY), 'and the offer is the one the documents disagree about')
  assert.ok(before.keys.length > 0, 'precondition: the offer is not empty in either read')
  assert.ok(ECHO_DECLARATION.enabled === FACTORY.enabled, 'precondition: the echoed declaration is the schema again, not a stored choice')
})

test('a declaration that stores a value of its own still vetoes the offer', () => {
  const segment = documentSegment({ ...BASE_STORED, debug: true })
  const declared = { ...ECHO_DECLARATION, debug: true }
  const plan = legacyImportPlan(segment, declared, FACTORY)
  assert.equal(FACTORY.debug, false, 'precondition: the schema defaults this key to false')
  assert.equal(segment.debug, true, 'precondition: the document stores the other value')
  assert.notDeepEqual(declared.debug, FACTORY.debug, 'precondition: the declaration is a value of its own, not a schema echo')
  assert.ok(!plan.keys.includes('debug'), 'a stored value the operator can see and edit is not put back behind one click')
  assert.equal(plan.value.debug, undefined, 'the payload carries nothing for it either')
  assert.ok(plan.keys.includes('learningEnabled'), 'the check is per key, not per document')
})

test('a declaration no longer vetoes merely by naming a key', () => {
  // The same document, the same effective configuration, and a declaration at
  // the schema default: the value is what decides, not the presence.
  const segment = documentSegment({ ...BASE_STORED, debug: true })
  const plan = legacyImportPlan(segment, { ...ECHO_DECLARATION, debug: false }, FACTORY)
  assert.equal(FACTORY.debug, false, 'precondition: the default is the declared value here')
  assert.ok(plan.keys.includes('debug'), 'a declaration that only restates the schema does not protect the key')
})

// ── the shipped-layer pin ─────────────────────────────────────────────────

test('no key the shipped layer pins is ever offered, whatever the document stores', () => {
  const plan = legacyImportPlan(BASE_DOCUMENT, ECHO_DECLARATION, FACTORY)
  for (const key of SHIPPED_PINNED_KEYS) {
    assert.ok(EDITABLE_CONFIG_KEYS.includes(key), `precondition: ${key} is card-owned`)
    assert.ok(!HOST_ONLY_KEYS.includes(key), `precondition: ${key} is not excluded by the host-owned list`)
    assert.ok(!same(BASE_DOCUMENT[key], FACTORY[key]), `precondition: the document stores another value for ${key}`)
    assert.ok(!plan.keys.includes(key), `${key} is declared by the shipped layer and is never offered`)
    assert.equal(plan.value[key], undefined, `and the payload carries no value for ${key}`)
  }
  assert.equal(BASE_STORED.timeoutAction, 'low-risk-allow', 'precondition: the document would relax the shipped refusal')
  assert.equal(BASE_STORED.allowlist.length, 1, 'precondition: the document would replace the shipped allowlist')
  assert.ok(!plan.keys.includes('timeoutAction'), 'a timeout action the shipped layer states is not offered')
  assert.ok(!plan.keys.includes('allowlist'), 'a stored allowlist is not offered either, even though the reader returns it')
  assert.deepEqual(BASE_DOCUMENT.allowlist, ['mcp__playwright__*'], 'precondition: the bounded reader really returns the list')
  assert.deepEqual(expectedOffer(BASE_DOCUMENT, FACTORY), [...plan.keys].sort(), 'the pin is part of the offer, not a post-filter')
})

test('the guard is wired into the offer, so a pin that stops being consulted fails here', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const planAt = source.indexOf('export function legacyImportPlan(')
  assert.notEqual(planAt, -1, 'the offer predicate is declared')
  // The body of the function ends at the next closing brace that starts a line.
  const planEnd = source.indexOf('\n}\n', planAt)
  assert.notEqual(planEnd, -1, 'the offer predicate has an end')
  const plan = source.slice(planAt, planEnd)
  assert.ok(plan.includes('SHIPPED_PINNED_KEYS'), 'the offer consults the shipped-layer pin')
  assert.ok(plan.includes('FACTORY_CONFIG_DEFAULTS'), 'and the schema defaults it compares a declaration against')
})

// ── the other two exclusions ──────────────────────────────────────────────

test('no host-owned key enters the offer or the payload, even at stored values of its own', () => {
  const stored = {}
  for (const key of HOST_ONLY_KEYS) {
    const fallback = FACTORY[key]
    stored[key] = typeof fallback === 'boolean' ? !fallback
      : typeof fallback === 'number' ? fallback + 1
        : Array.isArray(fallback) ? ['C:/probe']
          : 'C:/probe'
  }
  const segment = documentSegment({ ...BASE_STORED, ...stored })
  const plan = legacyImportPlan(segment, ECHO_DECLARATION, FACTORY)
  for (const key of HOST_ONLY_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(segment, key), `precondition: the document carries ${key}`)
    assert.ok(!same(segment[key], FACTORY[key]), `precondition: the stored value for ${key} differs from the default`)
    assert.ok(!plan.keys.includes(key), `${key} is host-owned and is never offered`)
    assert.ok(!Object.prototype.hasOwnProperty.call(plan.value, key), `and the payload carries nothing for ${key}`)
  }
  // The two shipped keys that are also host-owned keep both reasons to stay out,
  // and the first one alone is enough: the offer loop is card-owned keys only.
  assert.ok(HOST_ONLY_KEYS.includes('maxArgsChars') && HOST_ONLY_KEYS.includes('notifyUser'), 'precondition: the shipped layer also names host-owned keys')
  assert.ok(!plan.keys.includes('maxArgsChars') && !plan.keys.includes('notifyUser'), 'the host-owned half of the shipped block is excluded as host-owned')
  assert.ok(!plan.keys.includes('autoSwitchPolicyToAsk'), 'the retired host-owned no-op switch is never imported')
  assert.deepEqual([...plan.keys].sort(), expectedOffer(segment, FACTORY), 'the offer is the card-owned keys the two documents disagree about')
})

test('a declaration that carries a value of its own for every key offers nothing', () => {
  // The effective configuration here is the schema itself, so the value test
  // alone would offer everything the document disagrees with: the declaration
  // is what empties the batch.
  const stored = Object.fromEntries(EDITABLE_CONFIG_KEYS.map((key) => [key, { of: 'its own' }]))
  assert.deepEqual(legacyImportPlan(BASE_DOCUMENT, stored, FACTORY).keys, [], 'every card-owned key declared at a value of its own means no offer')
  assert.ok(legacyImportPlan(BASE_DOCUMENT, ECHO_DECLARATION, FACTORY).keys.length > 0, 'and the very same document does offer against a declaration that is the schema')
})

// ── the route's offer ─────────────────────────────────────────────────────

/** A context whose plugin entry declares `config`, the way the host exposes it. */
function carrierWithDeclaration(config) {
  const carried = carrierContext()
  carried.ctx.fiber = { entry: { options: { config } } }
  return carried
}

/** Settings plane of the route test: records every write it is asked to make. */
function fakeSettings(stored) {
  const value = { ...stored }
  const writes = []
  return {
    describe: () => [{ ns: NS, value, revision: 1, applies: 'live' }],
    writable: true,
    get: () => value,
    replace: async (ns, next) => { writes.push([ns, next]) },
    writeCount: () => writes.length,
  }
}

test('a host that exposes no entry configuration offers nothing rather than everything', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsa-c1g-undeclared-'))
  const warnings = []
  const original = console.warn
  console.warn = (...args) => { warnings.push(args.join(' ')) }
  try {
    const { ctx, specs } = carrierContext()
    const settings = fakeSettings(FACTORY)
    installSettingsRoute(ctx, settings, FACTORY, dir)
    writeFileSync(join(dir, 'settings.yaml.imported'), documentText(BASE_STORED))
    const route = findSpec([...specs.values()], 'settings')
    const first = await callSpec(route, LOOPBACK)
    const second = await callSpec(route, LOOPBACK)
    assert.equal(first.status, 200)
    assert.deepEqual(first.body.value.legacyImport, { keys: [], value: {} }, 'without a declaration the whole editable set is not put behind one click')
    assert.deepEqual(second.body.value.legacyImport, { keys: [], value: {} }, 'and a second read answers the same way')
    assert.equal(warnings.length, 1, 'the missing declaration is reported once per process')
    assert.match(warnings[0], /the host exposed no entry configuration/, 'the report names the missing declaration')
    assert.equal(settings.writeCount(), 0, 'reading the offer writes nothing')
  } finally {
    console.warn = original
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the route offers the same seven values after the host has written its echo', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsa-c1g-route-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'settings.yaml.imported'), documentText(BASE_STORED))
  const settings = fakeSettings(FACTORY)
  const { ctx, specs } = carrierWithDeclaration(ECHO_DECLARATION)
  installSettingsRoute(ctx, settings, FACTORY, dir)
  const route = findSpec([...specs.values()], 'settings')
  const res = await callSpec(route, LOOPBACK)
  assert.equal(res.status, 200)
  assert.deepEqual(
    [...res.body.value.legacyImport.keys].sort(),
    ['categoryMode', 'classifierReasoning', 'learningEnabled', 'privilegeAutoReview', 'protectedAutoReview', 'redactResults', 'reviewerReasoning'],
    'the snapshot still carries the offer after a save',
  )
  assert.deepEqual(Object.keys(res.body.value.legacyImport.value).sort(), [...res.body.value.legacyImport.keys].sort(), 'every offered key carries its value')
  assert.ok(!res.body.value.legacyImport.keys.includes('timeoutAction'), 'a key the shipped layer states is not offered')
  assert.ok(!res.body.value.legacyImport.keys.includes('allowlist'), 'nor a stored allowlist')
  assert.equal(res.body.value.value.learningEnabled, FACTORY.learningEnabled, 'precondition: the snapshot serves the effective configuration, not the retired document')
  assert.equal(settings.writeCount(), 0, 'reading the offer writes nothing')
})
