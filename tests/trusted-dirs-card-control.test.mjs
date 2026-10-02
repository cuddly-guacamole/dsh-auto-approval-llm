/**
 * dsh-auto-approval-llm · trusted directories settings-card control contract.
 *
 * `trustedDirs` used to be a host-only key: the operator declared the
 * directories they routinely read/write outside the workspace by hand-editing
 * the profile patch (`cordis.patch.yml`), and the settings card had no control
 * for it. The card now owns it, which turns key ownership into three things
 * that fail SILENTLY — the control renders nowhere, the save button never
 * enables, or the save writes nowhere:
 *
 *   1. ownership: the key has to sit in `EDITABLE_CONFIG_KEYS` (the list the
 *      host marks volatile, `src/index.ts`) and out of `HOST_ONLY_KEYS` (the
 *      list the op builder drops by name). The two lists must stay disjoint —
 *      a key in both is written by neither, with both gates green;
 *   2. persistence: a card save is projected by `buildMutateOps`, so the
 *      `set` op for the key is the only proof the value can reach the config
 *      plane. This assertion fails both when the control is absent and when
 *      persistence is broken, which is why it is the load-bearing one;
 *   3. the draft round trip: a newline-joined textarea becomes ≥2 entries on
 *      submit, and the card's own dirty predicate notices the edit. Without the
 *      dirty term the save button is permanently disabled — `cardDirty`
 *      compares `String(draft[k])`, so `['a,b']` and `['a','b']` both
 *      stringify to `'a,b'` and a real edit reads as "not dirty".
 *
 * Ownership moves the VALUE, never the clamp. `resolveConfig` still drops
 * every non-absolute, credential-tree, home / DSH_HOME / critical-tree entry and
 * warns about each one, and `rootsFor` still reads the clamped array. The card
 * is a second way to spell a path, not a way around the fence, so the clamp
 * assertions below are the safety regression guard: if one of them fails, the
 * card has become an opening, and this file is the wrong place to make it pass.
 *
 * Run: node --test tests/trusted-dirs-card-control.test.mjs (tsc + tsdown first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Config, resolveConfig } from '../lib/index.js'
import { EDITABLE_CONFIG_KEYS, HOST_ONLY_KEYS, plainConfigValue } from '../lib/auto/decision.js'
import { buildMutateOps } from '../lib/client/row-config.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(join(root, relative), 'utf8')

const CLIENT = read('src/client/index.ts')
const LOCALE = read('src/client/locale.ts')

/**
 * The source between two anchors.
 *
 * Brace balancing is the wrong tool for the shapes scanned below: the first `{`
 * after `const buildCategoryBody = ()` is a React props object, not the body.
 * Both markers are mandatory — a renamed anchor fails loudly instead of
 * producing an empty slice that satisfies every `!includes` assertion.
 */
function region(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker)
  assert.notEqual(a, -1, `source marker missing: ${startMarker}`)
  const b = src.indexOf(endMarker, a + startMarker.length)
  assert.notEqual(b, -1, `region end missing after ${startMarker}: ${endMarker}`)
  assert.ok(b > a, `region end must follow its start: ${startMarker}`)
  return src.slice(a, b)
}

// ── 1. ownership ──────────────────────────────────────────────────────────

test('the key is card-owned, host ownership dropped, and the two lists disjoint', () => {
  assert.ok(EDITABLE_CONFIG_KEYS.includes('trustedDirs'), 'the card owns it, so the host marks it volatile')
  assert.ok(!HOST_ONLY_KEYS.includes('trustedDirs'), 'the op builder no longer drops it by name')
  assert.deepEqual(
    EDITABLE_CONFIG_KEYS.filter((key) => HOST_ONLY_KEYS.includes(key)),
    [],
    'the two owner lists stay disjoint',
  )
})

// ── 2. persistence (the load-bearing assertion) ───────────────────────────

test('a card save reaches the config plane: the set op for trustedDirs is emitted', () => {
  assert.deepEqual(
    buildMutateOps({ value: { trustedDirs: ['D:/t'] } }),
    [{ op: 'set', path: ['trustedDirs'], value: ['D:/t'] }],
    'the submitted directories become a set op, unfiltered',
  )
})

test('a newline-joined draft value is a list, so a pasted block reaches the plane whole', () => {
  // Two directories the operator would paste, one per line, the way the
  // textarea hands them over: the card's own splitter (asserted in the next
  // test) turns this into two entries, and both must survive the projection.
  const pasted = 'D:/work\nE:/archive'
  const submitted = pasted.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  assert.equal(submitted.length, 2, 'precondition: the paste really is two entries')
  assert.deepEqual(
    buildMutateOps({ value: { trustedDirs: submitted } }),
    [{ op: 'set', path: ['trustedDirs'], value: ['D:/work', 'E:/archive'] }],
    'a multi-line paste is not truncated to one directory',
  )
})

// ── 3. the draft round trip ───────────────────────────────────────────────

test('the draft holds the directories as one newline-joined string, and submits the list() split', () => {
  const draft = region(CLIENT, 'interface Draft {', 'function draftOf(')
  assert.ok(
    /\r?\n\s+trustedDirs: string\r?\n/.test(draft),
    'the draft mirrors the newline-joined textarea, like allowlist',
  )
  assert.ok(/\r?\n\s+allowlist: string\r?\n/.test(draft), 'precondition: the allowlist template is still a string')

  const valueOf = region(CLIENT, 'function valueOf(', 'const INVALID_CONFIG_TYPES')
  assert.ok(
    valueOf.includes('trustedDirs: list(draft.trustedDirs)'),
    'submitting routes the textarea through the list() splitter',
  )
  assert.ok(
    valueOf.includes('allowlist: list(draft.allowlist)'),
    'precondition: the card splits its other newline-joined lists the same way',
  )
  assert.ok(
    /const list = \(raw: string\) => raw\.split\(\/\\r\?\\n\/\)/.test(valueOf),
    'the splitter separates on newlines, so one absolute path per line is the unit',
  )
  assert.ok(
    valueOf.includes('.filter(Boolean)'),
    'the splitter drops blank lines rather than submitting empty directories',
  )

  const draftOf = region(CLIENT, 'function draftOf(', 'function valueOf(')
  assert.ok(
    draftOf.includes("trustedDirs: (value?.trustedDirs ?? []).join('\\n')"),
    'loading joins the stored array back into the textarea',
  )
})

test('the card renders the control and the save carries the key', () => {
  const body = region(CLIENT, 'const buildCategoryBody = ()', 'const buildCategoryFooter = ()')
  assert.ok(
    body.includes("field(t('settings.category.trustedDirs')"),
    'the control sits in the category card, next to the position-mode rows',
  )
  assert.ok(
    /value: draft\.trustedDirs,[\s\S]{0,160}?rows: 4,[\s\S]{0,80}?className: 'dsa-textarea'/.test(body),
    'the control is a rows=4 dsa-textarea bound to the draft',
  )
  assert.ok(
    body.includes("onChange: (e: any) => update({ trustedDirs: e.target.value })"),
    'typing goes through the normal draft path, so 保存 still applies it',
  )
  assert.ok(
    body.includes("t('settings.category.trustedDirsHint')"),
    'the control carries its hint',
  )

  const footer = region(CLIENT, 'const buildCategoryFooter = ()', 'const buildUtilityBody = ()')
  assert.ok(
    footer.includes("saveCard(['categoryPolicy', 'categoryMode', 'privilegeAutoReview', 'protectedAutoReview', 'trustedDirs'], 'category')"),
    'the save overlay names the key, or the op builder never sees it',
  )
  assert.ok(
    footer.includes('trustedDirs: baseDraft.trustedDirs ?? \'\''),
    'discard returns the field to its stored value',
  )
})

test('the dirty predicate carries a trustedDirs term (without it the save button is dead)', () => {
  const dirty = region(CLIENT, 'const categoryDirty =', 'const learningDirty =')
  assert.ok(
    dirty.includes('draft.trustedDirs !== baseDraft.trustedDirs'),
    'an edited directory must read as a dirty card',
  )
  // The reason the plain `cardDirty` helper cannot carry this key: it compares
  // `String(...)`, so an array-shaped value collapses to one comma-joined
  // string and a real edit reads as unchanged.
  const cardDirty = region(CLIENT, 'const cardDirty =', 'const timerDirty =')
  assert.ok(
    cardDirty.includes("String((draft as any)[k] ?? '')"),
    'precondition: the shared predicate stringifies, so it cannot see a list edit',
  )
})

test('both dictionaries carry the label and the hint, and the hint states the clamp', () => {
  const zh = LOCALE.split('export const en')[0] ?? ''
  const en = LOCALE.split('export const en')[1] ?? ''
  for (const [dict, name, label] of [[zh, 'zh', '信任目录'], [en, 'en', 'Trusted directories']]) {
    assert.ok(dict.includes("'settings.category.trustedDirs':"), `${name} dict carries the label key`)
    assert.ok(dict.includes(`'${label}'`), `${name} label is the approved copy`)
    assert.ok(dict.includes("'settings.category.trustedDirsHint':"), `${name} dict carries the hint key`)
  }
  const hint = (dict) => dict.match(/'settings\.category\.trustedDirsHint':\s*'([^']*)'/)?.[1] ?? ''
  // The hint has to tell the operator the fence is still there, or the control
  // reads as "any path goes".
  for (const [dict, name] of [[zh, 'zh'], [en, 'en']]) {
    const copy = hint(dict)
    assert.ok(copy.includes('每行一个绝对路径') || copy.includes('One absolute path per line'), `${name} hint states the one-path-per-line unit`)
    assert.ok(copy.includes('凭据目录') || copy.includes('credential tree'), `${name} hint names the credential-tree clamp`)
    assert.ok(copy.includes('家目录') || copy.includes('home directory'), `${name} hint names the home clamp`)
    assert.ok(copy.includes('DSH_HOME'), `${name} hint names the DSH_HOME clamp`)
  }
})

// ── 4. the clamp is untouched (safety regression guard) ───────────────────

test('the clamp still drops every untrusted shape and keeps the one real directory', () => {
  // If this fails the card has become an opening: the value is still validated
  // on the way in, the textarea is only a second way to spell a path.
  const out = resolveConfig(Config({ trustedDirs: ['rel/path', 'C:/Users/u/.ssh', 'C:/ok'] }))
  assert.deepEqual(
    out.trustedDirs,
    ['c:\\ok'],
    'non-absolute and credential-tree entries are dropped; the plain absolute one survives',
  )
})

test('the clamp still drops a home-relative directory', () => {
  const out = resolveConfig(Config({ trustedDirs: ['C:/ok'] }))
  assert.deepEqual(out.trustedDirs, ['c:\\ok'], 'precondition: the plain directory is kept')
  // A directory inside the real home is dropped whatever the spelling, and the
  // drop is warned about rather than silent.
  const warnings = []
  const warn = console.warn
  console.warn = (message) => { warnings.push(String(message)) }
  try {
    const home = process.env.USERPROFILE ?? process.env.HOME
    const inside = home.replace(/\\/g, '/')
    const out2 = resolveConfig(Config({ trustedDirs: [`${inside}/work`] }))
    assert.deepEqual(out2.trustedDirs, [], 'a directory under the home root is not trusted')
    assert.ok(
      warnings.some((line) => line.includes('ignoring trustedDir')),
      'the drop is warned about in the startup log, as the hint says',
    )
  } finally {
    console.warn = warn
  }
})

// ── 5. schema ─────────────────────────────────────────────────────────────

test('the schema still types the field as an array of strings', () => {
  assert.deepEqual(plainConfigValue(Config({}).trustedDirs), [], 'the default is still an empty list')
  // The field is volatile now — that is what the host writes through, and it is
  // the same shape every other card-owned key hands out.
  assert.equal(typeof Config({}).trustedDirs, 'object', 'a card-owned schema field is a volatile reference')
  assert.deepEqual(
    plainConfigValue(Config({ trustedDirs: ['D:/t'] }).trustedDirs),
    ['D:/t'],
    'a configured value is readable through the same reference',
  )
  assert.throws(() => Config({ trustedDirs: 'C:/x' }), 'a bare string is not a directory list')
})
