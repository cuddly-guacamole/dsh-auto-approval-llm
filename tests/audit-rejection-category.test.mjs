/**
 * Refusal records must name the category that produced them.
 *
 * `scripts/friction-report.mjs` and the audit trail can group refusals by
 * source, but not by category — a whole class of false refusals was therefore
 * uncountable. The records that matter most here are the ones written from
 * `askHuman`'s terminal (timeout-deny, human-deny, llm-deny, llm-failed): that
 * code sits in a scope that cannot see `classifyStaticRisk`'s result, so the
 * label has to travel on the ask's `ReviewStatus` to reach the record.
 *
 * This file pins the plumbing (status carries the label, the terminal record
 * emits it) and the two disciplines that keep the fix honest:
 *
 *   - hard-deny / guard records deliberately carry NO category (the category
 *     layer never took part in those verdicts, and inventing one from the
 *     verdict's own name would be a fabricated classification);
 *   - the value is the closed-set category key, never a path or command text
 *     (an audit field that can hold arbitrary input is a leak channel).
 *
 * Run: node --test tests/audit-rejection-category.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CATEGORY_KEYS } from '../lib/auto/category.js'

const hostSource = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
const hostLib = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')

test('every ask ReviewStatus carries the category label', () => {
  // Each `: ReviewStatus = {` literal is one ask that lands in askHuman's
  // terminal. A new one that forgets the label silently loses its category —
  // which is exactly the gap this change closes — so require all of them.
  const literals = [...hostSource.matchAll(/: ReviewStatus = \{[\s\S]*?\n\s*\}/g)].map((m) => m[0])
  assert.ok(literals.length >= 6, `expected the ask statuses to be found, got ${literals.length}`)
  const missing = literals.filter((body) => !body.includes('category: classified.category,'))
  assert.deepEqual(missing, [], `ask statuses without a category label:\n${missing.join('\n---\n')}`)
})

test('the askHuman terminal record emits the label the status carries', () => {
  const start = hostSource.indexOf('const askHuman = async')
  assert.notEqual(start, -1, 'askHuman is present')
  const body = hostSource.slice(start, start + 20000)
  const recordAt = body.indexOf('const audited = pushHistory({')
  assert.notEqual(recordAt, -1, 'the terminal record is present in askHuman')
  const record = body.slice(recordAt, recordAt + 700)
  assert.ok(
    record.includes('...(status?.category !== undefined'),
    `the terminal record must carry the status category:\n${record}`,
  )
  // A status-less ask (an explicit human decision with no countdown) still
  // needs its label; it arrives as the audit-only argument, which must NOT give
  // the ask a status (that would add a countdown = a behaviour change).
  assert.ok(
    record.includes('auditCategory !== undefined ? { category: auditCategory } : {}'),
    `the terminal record must fall back to the audit-only label:\n${record}`,
  )
  assert.ok(
    /auditCategory\?: string/.test(body.slice(0, 600)),
    'askHuman accepts the audit-only category argument',
  )
})

test('the status-less category ask passes its label without gaining a status', () => {
  // The unlocked protected-metadata ask (the class this batch makes reachable)
  // is deliberately status-less. It must still be countable in the audit trail,
  // so the label is passed positionally as the audit argument — and the status
  // argument stays `undefined` so the ask keeps its "explicit human decision"
  // semantics.
  const call = /return askHuman\(req, undefined, next, false, undefined, undefined, undefined, undefined, (classified\.category|category)\)/.exec(hostSource)
  assert.ok(call !== null, 'the status-less category ask passes its category as the audit label')
  // Control: the branches that DO carry a countdown keep passing a status.
  assert.ok(
    /return askHuman\(req, undefined, next, false, (lockedStatus|status)\)/.test(hostSource),
    'the countdown asks still pass their status',
  )
})

test('the compiled host carries the same wiring (the bundle is what runs)', () => {
  assert.ok(
    /status\?\.category !== undefined/.test(hostLib),
    'the emitted compiled record must spread the status category',
  )
  assert.ok(
    /auditCategory !== undefined/.test(hostLib),
    'the emitted compiled record must spread the audit-only category',
  )
})

test('discipline: hard-deny and guard records carry no category', () => {
  // The category layer never runs for these verdicts, and the earlier design
  // note is explicit that the label is not recomputed for them: guessing one
  // from the denial's own text would be a fabricated classification. Pin the
  // negative so a later "make them consistent" edit has to argue with a test.
  for (const source of [hostSource, hostLib]) {
    const hardDeny = source.slice(source.indexOf("source: 'hard-deny'"), source.indexOf("source: 'hard-deny'") + 400)
    assert.ok(hardDeny.length > 0, 'the hard-deny record is present')
    assert.equal(
      /category\s*:/.test(hardDeny.replace(/categoryDecision[\s\S]*/, '')),
      false,
      `the hard-deny record must not carry a category:\n${hardDeny}`,
    )
  }
})

test('discipline: the label is a closed-set category key, never arbitrary text', () => {
  // The field must only ever be assigned from a category-layer value, so no
  // future edit routes a path, a command string or a free-text reason into this
  // audit field.
  //
  // The assignment set is the source of truth, NOT the regex's own alternation:
  // deriving both from the same pattern made the first version of this test a
  // tautology (the capture group could only ever produce the strings the loop
  // then re-checked). Collect every `category:` assignment in the host and
  // assert the allowed property on each value. The value pattern is an
  // identifier/dotted path only, so a template interpolation (`${…}`) or a type
  // annotation (`category?: string`) is not mistaken for an assignment.
  const values = [...hostSource.matchAll(/\bcategory:\s*([A-Za-z_][A-Za-z0-9_$.]*)/g)]
    .map((m) => m[1])
    // A parameter type annotation (`category: string | undefined`) is not an
    // assignment. A primitive keyword can never be an object-literal property
    // value in compiling TypeScript (it would be a reference to a variable with
    // that name), so filtering them out removes the annotation without opening
    // a hole a real assignment could pass through.
    .filter((value) => !['string', 'number', 'boolean', 'undefined', 'never', 'unknown', 'any'].includes(value))
  assert.ok(values.length >= 4, `expected the category assignments to be found, got ${values.length}`)
  const ALLOWED = new Set(['classified.category', 'category', 'targetCategory', 'status.category', 'auditCategory'])
  const unexpected = values.filter((value) => !ALLOWED.has(value))
  assert.deepEqual(unexpected, [], `category is assigned from something other than the category layer: ${unexpected.join(', ')}`)
  // The spread form must be present, or the status/audit labels would never
  // reach the record even though the assignments above exist.
  assert.ok(values.includes('status.category'), 'the status label is spread into the record')
  assert.ok(values.includes('auditCategory'), 'the audit-only label is spread into the record')
  // The recorded value's origin is the category layer's closed set. Assert the
  // set itself so the field can never hold a path or a command string.
  const keys = [...CATEGORY_KEYS]
  assert.ok(keys.includes('protected'), 'the category key set includes the protected label')
  for (const value of ['/tmp/x', 'rm -rf /', 'sk-secret', 'C:\\Users\\u']) {
    assert.ok(!keys.includes(value), `a category key may never be a path or command text (${value})`)
  }
  // And the field's type is the category string, not `string` at large.
  assert.ok(
    /category\?: string/.test(hostSource),
    'HistoryRecord declares the optional category field',
  )
})
