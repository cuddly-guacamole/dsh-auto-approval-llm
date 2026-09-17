/**
 * Settings card · operator-side openings named on the refusal path.
 *
 * A hard deny has no in-session route: the opening is an operator edit of the
 * config file, and the panel never said so. These anchors pin the two operator
 * openings for the DSH_HOME write fuse, the no-opening families, the file that
 * must be edited, and the two accuracy limits that a copy rewrite would
 * otherwise drop: the opening serves structured tools only, and the fenced
 * subtrees cannot be named at all.
 *
 * Run: node --test tests/settings-operator-opening-guidance.test.mjs (tsc + tsdown first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { HOST_ONLY_KEYS } from '../lib/auto/decision.js'

const CLIENT_SRC = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
const LOCALE_SRC = readFileSync(new URL('../src/client/locale.ts', import.meta.url), 'utf8')
const BUNDLE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const ZH = LOCALE_SRC.split('export const en')[0] ?? ''
const EN = LOCALE_SRC.split('export const en')[1] ?? ''

/** The zh/en copy for one locale key. */
function copy(section, key) {
  const m = section.match(new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*'([^']*)'`))
  assert.ok(m, `the ${key} copy is present`)
  return m[1]
}

const OPENINGS = ['settings.advanced.openingNote', 'settings.advanced.manualNote']

test('both dicts carry the operator-opening copy', () => {
  for (const key of OPENINGS) {
    assert.ok(ZH.includes(`'${key}':`), `zh dict carries ${key}`)
    assert.ok(EN.includes(`'${key}':`), `en dict carries ${key}`)
    assert.ok(copy(ZH, key).length > 40, `${key} zh copy is substantial, not a placeholder`)
    assert.ok(copy(EN, key).length > 40, `${key} en copy is substantial, not a placeholder`)
  }
})

test('the copy names both operator openings by their real key names', () => {
  // Negative direction: a copy that points at a key the policy does not own
  // would send the operator to a setting that changes nothing.
  for (const key of ['trustedDshSubpaths', 'maintenanceDshPaths']) {
    assert.ok(HOST_ONLY_KEYS.includes(key), `${key} is a real config-file-only key`)
    assert.ok(copy(ZH, 'settings.advanced.openingNote').includes(key), `zh opening copy names ${key}`)
    assert.ok(copy(EN, 'settings.advanced.openingNote').includes(key), `en opening copy names ${key}`)
  }
})

test('the copy keeps the two accuracy limits of the opening', () => {
  const zh = copy(ZH, 'settings.advanced.openingNote')
  const en = copy(EN, 'settings.advanced.openingNote')
  // The opening serves the structured tools only: the shell write vector stays
  // denied, so a copy promising a general door would misreport the policy.
  assert.ok(zh.includes('结构化') || zh.includes('write/edit'), 'zh copy limits the opening to structured writes')
  assert.ok(en.includes('structured') || en.includes('write/edit'), 'en copy limits the opening to structured writes')
  // The fenced subtrees cannot be named by any opening.
  for (const fenced of ['sessions', 'plugins', 'credentials', 'profiles']) {
    assert.ok(zh.includes(fenced), `zh copy names the fenced subtree ${fenced}`)
    assert.ok(en.includes(fenced), `en copy names the fenced subtree ${fenced}`)
  }
  assert.ok(zh.includes('settings.yaml') && en.includes('settings.yaml'), 'both copies name the file to edit')
})

test('the copy never claims the denial itself can be bypassed', () => {
  // The refusal is terminal for the session; only an operator edit can change
  // what the fuse covers. A rewrite that offers an in-session route would be
  // the fail-open direction this copy exists to prevent.
  const forbidden = ['绕过', '跳过', '无视', 'bypass', 'override', 'work around', 'circumvent']
  for (const key of OPENINGS) {
    for (const [lang, section] of [['zh', ZH], ['en', EN]]) {
      const text = copy(section, key)
      for (const word of forbidden) {
        assert.ok(!text.includes(word), `${lang} ${key} must not offer a bypass wording (${word})`)
      }
    }
  }
})

test('the card renders both paragraphs as display-only copy', () => {
  const body = CLIENT_SRC.slice(
    CLIENT_SRC.indexOf('const buildAdvancedBody'),
    CLIENT_SRC.indexOf('// Timers & breaker card body'),
  )
  for (const key of OPENINGS) {
    assert.ok(body.includes(`t('${key}')`), `the Advanced card renders ${key}`)
  }
  // Display-only: the paragraphs carry no control and no save path of their own.
  for (const key of OPENINGS) {
    const at = body.indexOf(`t('${key}')`)
    const around = body.slice(Math.max(0, at - 220), at + 60)
    assert.ok(!around.includes('CapsuleSelect'), `${key} renders no selector`)
    assert.ok(!around.includes('instantSaveKey'), `${key} renders no save path`)
  }
})

test('the compiled bundle carries the copy', () => {
  for (const key of OPENINGS) assert.ok(BUNDLE.includes(key), `the bundle carries ${key}`)
})
