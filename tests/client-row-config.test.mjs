/**
 * dsh-auto-approval-llm · row configuration seat contract.
 *
 * The settings form moved from the bundle-level seat to the row-level seat: the
 * bundle page is handed no Host form, while the row page hands over the form of
 * the row's namespace and is its only writer. Every way this can go wrong is
 * SILENT at runtime — the entry renders nowhere, or a control writes nowhere —
 * so each is pinned here:
 *
 *   1. a key the page never dispatches renders the entry nowhere, with no error
 *      (`rowConfigKey` = `<package name>#<row id>`, spelled by the page owner);
 *   2. the form is resolved by the ROW ID, so the row id, the bundle patch's
 *      insert id and the Host settings namespace have to be one string;
 *   3. an absent form rendered as a form shows every field at its default and
 *      reads to the user as lost settings; and
 *   4. a write without the revision the editor read, or carrying a key the Host
 *      config plane does not project, is refused — or lands on the wrong value.
 *
 * Run: node --test tests/client-row-config.test.mjs (tsdown first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EDITABLE_CONFIG_KEYS, HOST_ONLY_KEYS } from '../lib/auto/decision.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(join(root, relative), 'utf8')

const CLIENT = read('src/client/index.ts')
const CONTRACT = read('src/client/row-config.ts')
const LOCALE = read('src/client/locale.ts')
const HOST = read('src/index.ts')
// The settings namespace constant lives in the route table module, so it is
// read where it is declared rather than from the entry that re-imports it.
const ROUTE_TABLE = read('src/auto/route-table.ts')
const PATCH = read('cordis.patch.yml')
const BUNDLE = read('lib/client.js')

const countOf = (source, needle) => source.split(needle).length - 1

/**
 * The brace-balanced `{…}` body that starts at the first `{` after `marker`.
 *
 * Indentation is the bundler's business (the compiled bundle uses tabs where
 * the source uses spaces), so counting braces keeps one extraction working for
 * both. The signature's parameter list is skipped: a destructured parameter
 * carries braces of its own, and stopping at one of those would hand back two
 * identifiers instead of the body. A missing marker fails loudly rather than
 * returning an empty slice that would satisfy every `!includes` check below.
 */
function block(source, marker) {
  const at = source.indexOf(marker)
  assert.notEqual(at, -1, `source marker missing: ${marker}`)
  const signatureEnd = marker.endsWith(')') ? at + marker.length : source.indexOf(')', at + marker.length)
  assert.notEqual(signatureEnd, -1, `no signature end after: ${marker}`)
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
  return assert.fail(`unbalanced block after: ${marker}`)
}

const literal = (source, name) => {
  const match = new RegExp(`export const ${name} = '([^']+)'`).exec(source)
  assert.ok(match, `${name} is exported as a literal`)
  return match[1]
}

// ── 1. the seat and its key ───────────────────────────────────────────────

test('the row seat is registered under the key the Plugins page dispatches', () => {
  const bundleName = literal(CONTRACT, 'PLUGIN_PACKAGE_NAME')
  const rowId = literal(CONTRACT, 'PLUGIN_ROW_ID')
  const slot = literal(CONTRACT, 'ROW_CONFIG_SLOT')

  assert.equal(bundleName, '@quill507/dsh-auto-approval-llm', 'the package name is what the page keys a bundle by')
  assert.equal(slot, 'plugins.row.config', 'the seat is the row configuration slot')
  // The page's own rule, spelled here: `${bundle}#${rowId}`.
  assert.equal(`${bundleName}#${rowId}`, '@quill507/dsh-auto-approval-llm#auto-approval-llm')

  // The registration must carry the slot name as a literal: the anchor checker
  // reads literals out of the entry, so a constant there hides the seat from it.
  assert.ok(
    CLIENT.includes(`ctx.slots.inject('${slot}', () => ctx.slots.register({`),
    'the entry injects the row seat by its literal name',
  )
  assert.ok(CLIENT.includes(`name: '${slot}',`), 'the registration names the same slot')
  assert.ok(CLIENT.includes('key: ROW_CONFIG_KEY,'), 'the registered key is the composed row key')
  assert.ok(BUNDLE.includes(slot), 'the compiled bundle registers the row seat')
  assert.ok(
    BUNDLE.includes('const ROW_CONFIG_KEY = rowConfigKey(PLUGIN_PACKAGE_NAME, PLUGIN_ROW_ID)'),
    'the compiled bundle composes the key from the owner rule',
  )
})

test('the row id, the bundle patch and the settings namespace are one string', () => {
  const rowId = literal(CONTRACT, 'PLUGIN_ROW_ID')
  const bundleName = literal(CONTRACT, 'PLUGIN_PACKAGE_NAME')

  // The page resolves the form by `formFor(rowId)` against the namespaces the
  // Host describes, so a row id that differs from the namespace by one
  // character gives EVERY visitor the read-only body instead of the form.
  const namespace = /const SETTINGS_NS = '([^']+)'/.exec(ROUTE_TABLE)?.[1]
  assert.equal(namespace, rowId, 'the Host settings namespace is the row id')

  const insertId = /- insert:\s*\n\s*- id: ([A-Za-z0-9._-]+)/.exec(PATCH)?.[1]
  assert.equal(insertId, rowId, 'the row id is the one the bundle patch declares')
  const insertedName = /- insert:[\s\S]{0,240}?name: '([^']+)'/.exec(PATCH)?.[1]
  assert.equal(insertedName, bundleName, 'the bundle name is the package the patch inserts')
})

// ── 2. the retired bundle seat ────────────────────────────────────────────

test('the bundle-level configuration seat stays retired', () => {
  // The bundle page is never handed a form, so a seat registered there can only
  // draw a second, unbacked copy of this form. The page renders the section
  // only while something registers there, so retiring the seat removes the
  // section rather than leaving an empty one.
  for (const [name, source] of [['entry', CLIENT], ['contract', CONTRACT], ['bundle', BUNDLE]]) {
    assert.ok(!source.includes('plugins.bundle.config'), `no bundle-level seat survives in the ${name}`)
  }
  // Non-vacuity: the seat that replaced it is registered, so the assertion
  // above cannot pass by way of an empty registration set.
  assert.ok(BUNDLE.includes('plugins.row.config'), 'the row seat is registered')
  assert.equal(countOf(CLIENT, '}, PluginConfigEntry)'), 1, 'exactly one seat renders the row configuration entry')
})

// ── 2b. the retired settings-card seat ────────────────────────────────────

test('the settings-card seat stays retired', () => {
  // The installed host's slot directory declares no `settings.plugin.item`, so a
  // seat registered there draws nothing at runtime and hides the retirement.
  // The configuration entry reaches the card body through the row seat alone.
  for (const [name, source] of [['entry', CLIENT], ['contract', CONTRACT], ['bundle', BUNDLE]]) {
    assert.ok(!source.includes('settings.plugin.item'), `no settings-card seat survives in the ${name}`)
  }
  // Non-vacuity: the card body and the row seat that renders it are both here,
  // so the assertions above cannot pass by way of a removed card.
  assert.ok(BUNDLE.includes('function SettingsSection('), 'the settings body survives its seat')
  assert.ok(BUNDLE.includes('plugins.row.config'), 'the row seat is registered')
})

// ── 3. the absent-form body ───────────────────────────────────────────────

test('an absent form renders the read-only body, never an empty form', () => {
  const body = block(BUNDLE, 'function ConfigUnavailableBody(')
  assert.ok(body.includes('settings.unavailable.banner'), 'the body states that the settings are unavailable')
  assert.ok(body.includes('settings.unavailable.hint'), 'the body says what it is showing instead')
  assert.ok(body.includes('data-dsa-settings-unavailable'), 'the body carries the branch marker')
  assert.ok(body.includes('EDITABLE_CONFIG_KEYS'), 'the body lists the form\'s own keys')
  assert.ok(body.includes('formatHostKeyValue('), 'each listed key shows its resolved value')
  assert.ok(body.includes('settings.advanced.yamlEmpty'), 'an unset value has an explicit placeholder')
  assert.ok(body.includes('settings.pluginConfigError'), 'the config plane\'s own failure is carried here too')
  // A control here would edit nothing: toggles, inputs and save buttons all go
  // through the write channel the absent form is the evidence for.
  for (const control of ['dsa-capsule', 'instantSaveKey(', 'CapsuleSelect', 'settings.save', 'Button']) {
    assert.ok(!body.includes(control), `the read-only body renders no ${control} control`)
  }

  // And the entry really takes that branch, before any control is built.
  const entry = block(CLIENT, 'function SettingsSection(')
  assert.ok(entry.includes('dsa-card dsa-cardOpen'), 'precondition: the extracted region really is the settings body')
  assert.ok(entry.includes('if (writeForm === undefined)'), 'the entry branches on the missing form')
  const branch = entry.indexOf('if (writeForm === undefined) {')
  const controls = entry.indexOf('const update = (patch: Partial<Draft>)')
  assert.ok(branch > 0 && controls > branch, 'the read-only branch returns before the editable body is built')
})

test('the degradation is decided from the form alone, in one place', () => {
  assert.ok(CLIENT.includes('const writeForm = usableForm(form)'), 'the entry validates the form before using it')
  assert.equal(countOf(CLIENT, 'usableForm('), 1, 'one decision, not one condition per control')
  const usable = block(CONTRACT, 'export function usableForm(')
  for (const guard of ['state.status !== \'ready\'', 'state.value === undefined', 'state.writable === false', 'typeof form.mutate !== \'function\'']) {
    assert.ok(usable.includes(guard), `a form missing ${guard} is not usable`)
  }
})

// ── 4. the write channel ──────────────────────────────────────────────────

test('every save goes through form.mutate with the revision the editor read', () => {
  const submit = block(CLIENT, 'const submit = async (write: ConfigWrite)')
  assert.ok(submit.includes('buildMutateOps('), 'the write is projected before it is sent')
  assert.match(submit, /writeForm\.mutate\(ops,[^)]*revision/, 'the mutation carries the revision fence')
  assert.ok(submit.includes('writeForm.state.revision'), 'the fence is the revision the form read')
  assert.match(BUNDLE, /writeForm\.mutate\(ops,[^)]*revision/, 'the compiled bundle keeps the fenced call')
  assert.equal(countOf(CLIENT, 'writeForm.mutate'), 1, 'the form is the only writer of the settings namespace')
})

test('no save is posted to the plugin route any more', () => {
  const calls = CLIENT.split('fetch(SETTINGS_ROUTE').slice(1)
  assert.ok(calls.length >= 3, 'the route still serves reads')
  const posts = calls.filter((chunk) => chunk.slice(0, 240).includes("method: 'POST'"))
  assert.deepEqual(posts, [], 'every remaining route call is a read')
  // The routes unrelated to the form are untouched: credentials, the learning
  // store, history and the model catalog keep their own writes.
  for (const route of ['REVIEWER_CREDENTIAL_ROUTE', 'LEARNING_STORE_ROUTE', 'HISTORY_ROUTE', 'LLM_MODELS_ROUTE']) {
    assert.ok(CLIENT.includes(route), `${route} stays on the plugin's own transport`)
  }
})

// ── 5. non-volatile keys ──────────────────────────────────────────────────

test('a key the config plane does not project never reaches a write', () => {
  const ops = block(CONTRACT, 'export function buildMutateOps(')
  assert.ok(ops.includes('EDITABLE_CONFIG_KEYS'), 'the projection iterates the volatile owner list')
  assert.ok(!ops.includes('Object.keys('), 'the projection never takes whatever the payload carries')

  // Precondition, so the filter is load-bearing: the payload really does carry
  // host-derived keys today.
  const valueOf = block(CLIENT, 'function valueOf(')
  for (const key of ['trustedDirs', 'breakerAntiHijackMs']) {
    assert.ok(valueOf.includes(key), `valueOf emits the host-derived ${key}`)
    assert.ok(HOST_ONLY_KEYS.includes(key), `${key} is host-owned`)
    assert.ok(!EDITABLE_CONFIG_KEYS.includes(key), `${key} is not the form's to write`)
  }
  assert.deepEqual(
    EDITABLE_CONFIG_KEYS.filter((key) => HOST_ONLY_KEYS.includes(key)),
    [],
    'the two owner lists stay disjoint',
  )
})

// ── 6. the copy ───────────────────────────────────────────────────────────

test('the read-only copy exists in both dictionaries', () => {
  const zh = LOCALE.split('export const en')[0] ?? ''
  const en = LOCALE.split('export const en')[1] ?? ''
  for (const key of ['settings.unavailable.banner', 'settings.unavailable.hint']) {
    assert.ok(zh.includes(`'${key}':`), `zh dictionary carries ${key}`)
    assert.ok(en.includes(`'${key}':`), `en dictionary carries ${key}`)
  }
  assert.ok(BUNDLE.includes('settings.unavailable.banner'), 'the bundle references the banner copy')
})
