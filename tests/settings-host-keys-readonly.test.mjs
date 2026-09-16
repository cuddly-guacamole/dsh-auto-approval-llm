/**
 * Settings card · read-only rows for the config-file-only keys.
 *
 * The card shows the HOST_ONLY_KEYS set as display-only rows: the list comes
 * from the single owner the save path preserves (never a second hand-written
 * copy), each row carries the resolved effective value, and no row is a
 * control. These anchors pin the derivation, the value rendering and the
 * absence of any write path for those keys.
 *
 * Run: node --test tests/settings-host-keys-readonly.test.mjs (tsc + tsdown first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { HOST_ONLY_KEYS } from '../lib/auto/decision.js'
import { hostOnlyRows, formatHostKeyValue } from '../lib/client/host-keys.js'

const CLIENT_SRC = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
const LOCALE_SRC = readFileSync(new URL('../src/client/locale.ts', import.meta.url), 'utf8')
const BUNDLE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const ZH = LOCALE_SRC.split('export const en')[0] ?? ''
const EN = LOCALE_SRC.split('export const en')[1] ?? ''

/** Source between two markers, so a render block can be inspected in isolation. */
function region(src, from, to) {
  const at = src.indexOf(from)
  assert.ok(at > 0, `the ${from} marker is present`)
  const end = src.indexOf(to, at)
  assert.ok(end > at, `the ${to} marker follows ${from}`)
  return src.slice(at, end)
}

test('the read-only list is derived from the host-only owner, in owner order', () => {
  const rows = hostOnlyRows({})
  assert.deepEqual(rows.map((r) => r.key), [...HOST_ONLY_KEYS], 'one row per host-only key, same order')
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length, 'no duplicate key')
  // Negative direction: a value bag carrying unrelated keys must not invent rows.
  const invented = hostOnlyRows({ notARealKey: 'x', anotherKey: 1 }).map((r) => r.key)
  assert.deepEqual(invented, [...HOST_ONLY_KEYS], 'rows come from the owner list, not from the value bag')
})

test('an unset host-only value renders as the empty placeholder', () => {
  const effective = { workspaceRoot: '', tempRoots: [], trustedDshSubpaths: [] }
  const rows = new Map(hostOnlyRows(effective).map((r) => [r.key, r.value]))
  for (const key of ['workspaceRoot', 'tempRoots', 'trustedDshSubpaths']) {
    assert.equal(rows.get(key), null, `${key} has no effective value`)
  }
  // A key absent from the bag is unset too, not an error.
  assert.equal(rows.get('maintenanceDshPaths'), null, 'a missing key is unset')
  assert.equal(formatHostKeyValue(undefined), null)
  assert.equal(formatHostKeyValue(null), null)
})

test('false and 0 survive as values (they are set, not unset)', () => {
  // Truthiness rendering would silently swallow the two fail-closed defaults.
  assert.equal(formatHostKeyValue(false), 'false')
  assert.equal(formatHostKeyValue(0), '0')
  assert.equal(formatHostKeyValue(true), 'true')
  const rows = new Map(hostOnlyRows({ rulesDryRun: false, loopDetectionThreshold: 0 }).map((r) => [r.key, r.value]))
  assert.equal(rows.get('rulesDryRun'), 'false', 'false is a value, not an empty cell')
  assert.equal(rows.get('loopDetectionThreshold'), '0', '0 is a value, not an empty cell')
})

test('lists render as a comma-joined value, never as [object Object]', () => {
  assert.equal(formatHostKeyValue(['C:\\a', 'D:\\b']), 'C:\\a, D:\\b')
  assert.equal(formatHostKeyValue([]), null)
  assert.equal(formatHostKeyValue(['']), null)
  assert.equal(formatHostKeyValue({ a: 1 }), '{"a":1}')
})

test('the card renders the rows from the owner list and adds no control', () => {
  const body = region(CLIENT_SRC, 'const buildAdvancedBody', '// Timers & breaker card body')
  assert.ok(body.includes('hostOnlyRows('), 'the rows come from the shared reader')
  assert.ok(body.includes('HOST_ONLY_KEYS.length'), 'the note count is derived from the owner list')
  assert.ok(body.includes("t('settings.advanced.yamlKeysShow')"), 'the list has an explicit show toggle')
  assert.ok(body.includes("t('settings.advanced.yamlKeysHide')"), 'the list has an explicit hide toggle')
  assert.ok(body.includes('dsa-defaultAllow'), 'the panel reuses the display-only container style')
  for (const key of HOST_ONLY_KEYS) {
    assert.ok(!body.includes(`instantSaveKey('${key}'`), `${key} must not gain an instant-save control`)
  }
})

test('no host-only key rides a card save overlay (the list stays display-only)', () => {
  const slices = ['TIMER_KEYS', 'REVIEW_KEYS', 'SECURITY_KEYS', 'UTILITY_KEYS', 'LEARNING_KEYS']
    .map((name) => {
      const m = CLIENT_SRC.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))
      assert.ok(m, `the ${name} slice is present`)
      return { name, keys: [...m[1].matchAll(/'([a-zA-Z][a-zA-Z0-9]*)'/g)].map((x) => x[1]) }
    })
  for (const key of HOST_ONLY_KEYS) {
    for (const slice of slices) {
      assert.ok(!slice.keys.includes(key), `${key} must not ride the ${slice.name} save overlay`)
    }
  }
})

test('the note copy is derived, not an enumerated stale list', () => {
  const zhNote = ZH.match(/'settings\.advanced\.yamlNote':\s*'([^']*)'/)?.[1] ?? ''
  const enNote = EN.match(/'settings\.advanced\.yamlNote':\s*'([^']*)'/)?.[1] ?? ''
  assert.ok(zhNote.includes('{count}'), 'the zh note carries the derived count')
  assert.ok(enNote.includes('{count}'), 'the en note carries the derived count')
  for (const key of HOST_ONLY_KEYS) {
    assert.ok(!zhNote.includes(key) && !enNote.includes(key), `the note must not enumerate ${key} by hand`)
  }
  for (const key of ['settings.advanced.yamlKeys', 'settings.advanced.yamlKeysShow', 'settings.advanced.yamlKeysHide', 'settings.advanced.yamlEmpty']) {
    assert.ok(ZH.includes(`'${key}':`), `zh dict carries ${key}`)
    assert.ok(EN.includes(`'${key}':`), `en dict carries ${key}`)
  }
})

test('the compiled bundle keeps the derivation and the copy', () => {
  assert.ok(BUNDLE.includes('HOST_ONLY_KEYS'), 'the owner constant is bundled, not inlined as a literal list')
  assert.ok(BUNDLE.includes('hostOnlyRows'), 'the shared reader is wired into the card')
  for (const key of ['settings.advanced.yamlKeys', 'settings.advanced.yamlKeysShow', 'settings.advanced.yamlKeysHide', 'settings.advanced.yamlEmpty']) {
    assert.ok(BUNDLE.includes(key), `the bundle carries ${key}`)
  }
})
