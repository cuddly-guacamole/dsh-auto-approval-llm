/**
 * dsh-auto-approval-llm · settings key ownership gate.
 *
 * Every settings key has exactly one owner:
 *   - card-owned: the settings card renders a control for it, so a card save
 *     may write it; or
 *   - host-owned: it is listed in HOST_ONLY_KEYS, so `preserveHostKeys` keeps
 *     the stored value and no card save can change it.
 *
 * POST /settings replaces the WHOLE namespace and refills only the
 * HOST_ONLY_KEYS entries, so a key present in neither set is physically deleted
 * from settings.yaml by the next unrelated card save — silently, with no banner
 * and no log. This gate pins the invariant that makes that class impossible,
 * and pins the three keys deliberately retired from the card.
 *
 * Run: node --test tests/settings-key-ownership.test.mjs (tsc + tsdown first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { HOST_ONLY_KEYS } from '../lib/auto/decision.js'

const HOST = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const CLIENT = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')

/** Top-level keys of the host Config schema (`Config` z.object literal). */
function configKeys() {
  const at = HOST.indexOf('export const Config: z<Config> = z.object({')
  assert.ok(at > 0, 'the host Config schema is present')
  const body = HOST.slice(at, HOST.indexOf('\n})', at))
  return [...body.matchAll(/^ {2}([a-zA-Z_$][a-zA-Z0-9_$]*):/gm)].map((m) => m[1])
}

/** Keys of the client draft mirror (`draftOf`'s returned literal). */
function draftKeys() {
  const at = CLIENT.indexOf('function draftOf(value: any): Draft {')
  assert.ok(at > 0, 'the client draft mirror is present')
  const body = CLIENT.slice(at, CLIENT.indexOf('\n  }', at))
  return [...body.matchAll(/^ {4}([a-zA-Z_$][a-zA-Z0-9_$]*):/gm)].map((m) => m[1])
}

/** Members of one per-card key slice, e.g. TIMER_KEYS. */
function sliceKeys(name) {
  const m = CLIENT.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))
  assert.ok(m, `the ${name} slice is present`)
  return [...m[1].matchAll(/'([a-zA-Z][a-zA-Z0-9]*)'/g)].map((x) => x[1])
}

/** Every file under src/, so a dead locale key can be proven absent tree-wide. */
function srcFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...srcFiles(full))
    else out.push(full)
  }
  return out
}

/** Keys retired from the card: no control, so they must be host-owned. */
const RETIRED = [
  // control locale key that must be gone from the client render tree
  { key: 'rulesDryRun', control: 'settings.rulesDryRun' },
  { key: 'breakerAntiHijackMs', control: 'settings.breakerAntiHijack' },
  { key: 'reviewMaxRetries', control: 'settings.reviewer.maxRetries' },
]

const SLICES = ['TIMER_KEYS', 'REVIEW_KEYS', 'SECURITY_KEYS', 'UTILITY_KEYS', 'LEARNING_KEYS']

/** Source between two markers, so a render block can be counted in isolation. */
function region(src, from, to) {
  const at = src.indexOf(from)
  assert.ok(at > 0, `the ${from} marker is present`)
  const end = src.indexOf(to, at)
  assert.ok(end > at, `the ${to} marker follows ${from}`)
  return src.slice(at, end)
}

test('the first screen keeps exactly three instant-save controls', () => {
  // The first screen is what a user sees without expanding any sub-card: three
  // rows (answering switch / timeout action / review-scope preset). Everything
  // else moved into the Advanced sub-card, so this count is a deliberate
  // contract, not an accident of layout.
  const body = region(CLIENT, 'const topLevelBody = React.createElement(', 'const buildAdvancedBody')
  const rows = [...body.matchAll(/row\(t\('settings\.[a-zA-Z.]+'\)/g)].length
  assert.equal(rows, 3, 'the first screen renders three instant-save rows')
  for (const control of ['settings.enable', 'settings.timeoutAction', 'settings.llmScope.preset']) {
    assert.ok(body.includes(`row(t('${control}')`), `${control} stays on the first screen`)
  }
})

test('the key parser sees the host schema and the draft mirror', () => {
  // Parser sanity: without this, a renamed anchor would make every check below
  // vacuously pass on empty key lists.
  assert.ok(configKeys().includes('enabled'), 'configKeys() parses the host schema')
  assert.ok(configKeys().includes('rulesDryRun'), 'configKeys() covers a retired key')
  assert.ok(draftKeys().includes('enabled'), 'draftKeys() parses the draft mirror')
  assert.ok(draftKeys().includes('rulesDryRun'), 'draftKeys() covers a retired key')
})

test('every Config key is card-projected or host-owned (no silent-delete gap)', () => {
  const covered = new Set([...draftKeys(), ...HOST_ONLY_KEYS])
  const missing = configKeys().filter((k) => !covered.has(k))
  assert.deepEqual(
    missing,
    [],
    `a key in neither draftOf nor HOST_ONLY_KEYS is deleted from settings.yaml by the next card save: ${missing.join(', ')}`,
  )
})

test('the card-retired keys are host-owned', () => {
  for (const { key } of RETIRED) {
    assert.ok(
      HOST_ONLY_KEYS.includes(key),
      `${key} has no card control, so it must be listed in HOST_ONLY_KEYS`,
    )
  }
})

test('the card-retired keys keep no control and no card-slice membership', () => {
  for (const { key, control } of RETIRED) {
    assert.ok(!CLIENT.includes(control), `${control} must not be rendered by the settings card`)
    for (const slice of SLICES) {
      assert.ok(!sliceKeys(slice).includes(key), `${key} must not ride the ${slice} save overlay`)
    }
  }
})

test('negative direction: control-bearing keys stay card-owned (gate is not vacuous)', () => {
  // If every key were host-owned, the gate above would pass while the card
  // silently stopped saving anything. These keys must stay editable.
  for (const key of ['learningEnabled', 'learningThreshold', 'panelDelayMs']) {
    assert.ok(!HOST_ONLY_KEYS.includes(key), `${key} is card-editable and must not be host-only`)
  }
  assert.ok(draftKeys().includes('learningEnabled'), 'learningEnabled stays draft-projected')
  assert.ok(sliceKeys('TIMER_KEYS').includes('panelDelayMs'), 'panelDelayMs stays in its card slice')
  assert.ok(sliceKeys('UTILITY_KEYS').includes('rejectGuidance'), 'rejectGuidance stays in its card slice')
})

test('the retired floating-button locale key is gone from the whole src tree', () => {
  const hits = srcFiles(new URL('../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
    .filter((file) => readFileSync(file, 'utf8').includes('buttonPosition'))
  assert.deepEqual(hits, [], `settings.buttonPosition is dead copy (no consumer): ${hits.join(', ')}`)
})
