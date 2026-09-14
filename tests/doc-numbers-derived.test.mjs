/**
 * The published docs also state numbers that come from the source tree rather
 * than from the test suite: per-module line counts, the module count, the Config
 * schema key count, the host route count. Those positions were watched by
 * nothing, and twelve of thirteen rows in one table were stale at once while the
 * site claimed every number was checked against the source.
 *
 * The checker is read-only, so this test is safe to run against the tree it
 * describes. It pins the honest direction (the real tree agrees) and the
 * dishonest ones (a stale number, a claim whose wording moved, a source the
 * parser cannot read) so "all agree" cannot come from matching nothing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DERIVED_POINTS, checkDerived, configKeyCount, countLines, measuredCounts, measuredDerived, runChecks, watchedDocumentSources } from '../scripts/check-doc-numbers.mjs'
import { SUITE_REWRITES, applyDerivedRewrites, applySuiteRewrites } from '../scripts/sync-doc-numbers.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const doc = file => readFileSync(join(root, file), 'utf8')

test('the numbers the docs derive from the source tree agree', () => {
  const result = spawnSync(process.execPath, [join(root, 'scripts/check-doc-numbers.mjs')], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, `stale or missing derived numbers:\n${result.stdout}${result.stderr}`)
})

test('a row that leaves the watched table is reported', () => {
  // "The pattern still matched" is not enough for a multi-row table: one row
  // losing the watched shape drops that module out of the gate with nothing
  // reported. The floor is what makes the coverage a ratchet.
  const measured = measuredDerived(root)
  const source = doc('docs/14-code-map.md')
  const dropped = source.replace(/^(│[ ]+[├└]─[ ]+trust\.ts[ ]+\d+.*)$/m, '')
  assert.notEqual(dropped, source, 'the row to drop must exist')
  const problems = checkDerived({ 'docs/14-code-map.md': dropped }, measured).problems
  assert.ok(
    problems.some(problem => problem.includes('row(s)') && problem.includes('left the gate')),
    `expected a shrunk-coverage complaint, got ${JSON.stringify(problems)}`,
  )
})

test('a stale derived number is reported, and the honest tree is not', () => {
  const measured = measuredDerived(root)
  const source = doc('docs/03-static-engine.md')
  assert.deepEqual(checkDerived({ 'docs/03-static-engine.md': source }, measured).problems, [])

  const wrong = measured.lines('src/auto/constants.ts') + 1
  const tampered = source.replace(
    /(\| `constants\.ts` <span class="lnum">[^<]*<\/span> \| )\d+/,
    (all, head) => `${head}${wrong}`,
  )
  const problems = checkDerived({ 'docs/03-static-engine.md': tampered }, measured).problems
  assert.ok(
    problems.some(problem => problem.includes('constants.ts') && problem.includes(String(wrong))),
    `expected a complaint naming constants.ts and ${wrong}, got ${JSON.stringify(problems)}`,
  )
})

test('a derived claim whose wording moved is reported', () => {
  // A pattern that stops matching is how a number leaves the gate silently, so
  // the honest answer is a failure, not an empty result.
  const measured = measuredDerived(root)
  const gutted = doc('docs/12-config.md').replace(/keys, one source of truth/, 'keys, a few of them')
  const problems = checkDerived({ 'docs/12-config.md': gutted }, measured).problems
  assert.ok(
    problems.some(problem => problem.includes('not found')),
    `expected a wording-moved complaint, got ${JSON.stringify(problems)}`,
  )
})

test('a source the parser cannot read fails loudly instead of agreeing', () => {
  // The Config schema is the one derived number with no file of its own: it is a
  // block inside src/index.ts. A parser that returned 0 on a closed block would
  // report every page as agreeing with a count nothing measured.
  const measured = measuredDerived(root)
  const truncated = 'export const Config: z<Config> = z.object({\n  enabled: z.boolean().default(true),\n'
  assert.equal(configKeyCount(truncated), null, 'an unterminated schema block is not a count')
  assert.equal(configKeyCount('nothing to see here'), null, 'a document without the schema is not a count')
  assert.ok(Number.isFinite(measured.configKeys), 'the real schema is measured')

  const problems = checkDerived({}, { ...measured, configKeys: null }).problems
  assert.ok(
    problems.some(problem => problem.includes('cannot be measured')),
    `expected an unmeasurable complaint, got ${JSON.stringify(problems)}`,
  )
})

test('every derived point names a document it can still match', () => {
  const measured = measuredDerived(root)
  // A ratchet, like the anchor test's floors: the coverage must not shrink.
  assert.ok(DERIVED_POINTS.length >= 19, `expected the derived families to be watched, got ${DERIVED_POINTS.length}`)
  for (const point of DERIVED_POINTS) {
    const source = doc(point.file)
    const match = new RegExp(point.pattern.source, point.pattern.flags).exec(source)
    assert.ok(match !== null, `${point.file} does not contain ${point.description}`)
    assert.ok(Number.isFinite(point.expect(match, measured)), `${point.description} (${point.label(match)}) is not measured`)
  }
})

test('every derived point reports its own number when it drifts', () => {
  // One reverse control per point, generated from the point itself: a typo in a
  // pattern, a wrong source binding or a rewrite that edits the wrong digits all
  // show up here, instead of only in the families someone remembered to test.
  const measured = measuredDerived(root)
  for (const point of DERIVED_POINTS) {
    const source = doc(point.file)
    const flags = point.pattern.flags.includes('g') ? point.pattern.flags : `${point.pattern.flags}g`
    const match = new RegExp(point.pattern.source, flags).exec(source)
    assert.ok(match !== null, `${point.file} does not contain ${point.description}`)
    const wrong = point.claimed(match) + 7
    const tampered = source.slice(0, match.index) + point.rewrite(match, wrong) + source.slice(match.index + match[0].length)
    assert.notEqual(tampered, source, `${point.description} rewrite must change the document`)
    const problems = checkDerived({ [point.file]: tampered }, measured).problems
    assert.ok(
      problems.some(problem => problem.includes(point.description) && problem.includes(String(wrong))),
      `${point.description} (${point.label(match)}) must be reported when it says ${wrong}, got ${JSON.stringify(problems)}`,
    )
  }
})

test('the exit code is built from every family, including the derived points', () => {
  // The gate is only as good as the aggregation: dropping one family from the
  // failure list would leave the suite green while the checker printed the
  // problem. Drive runChecks with a tampered document so the real path is taken.
  const sources = watchedDocumentSources()
  const honest = runChecks([], sources)
  assert.deepEqual(honest.failures, [], 'the real tree must produce no failures')

  const tampered = {
    ...sources,
    'docs/17-category-switches.md': sources['docs/17-category-switches.md'].replace(
      /class="lnum">src\/auto\/category\.ts#<\/span>，\d+ 行/,
      'class="lnum">src/auto/category.ts#</span>，1 行',
    ),
  }
  const failures = runChecks([], tampered).failures
  assert.ok(
    failures.some(problem => problem.includes('category module line count') && problem.includes('docs/17-category-switches.md')),
    `the derived family must reach the failure list, got ${JSON.stringify(failures)}`,
  )
})

test('sync rewrites are idempotent on the tree the checker agrees with', () => {
  const measured = measuredDerived(root)
  for (const file of new Set(DERIVED_POINTS.map(point => point.file))) {
    assert.equal(applyDerivedRewrites(doc(file), file, measured), doc(file), `${file} must already be in sync with the source tree`)
  }
  const counts = measuredCounts(root)
  for (const file of new Set(SUITE_REWRITES.map(rewrite => rewrite.file))) {
    let source
    try {
      source = doc(file)
    } catch {
      continue
    }
    assert.equal(applySuiteRewrites(source, file, counts), source, `${file} must already state the measured counts`)
  }
})

test('sync restores a drifted number instead of leaving it stale', () => {
  // The checker and the sync path must agree about what a number means; this is
  // the property that makes `sync-doc-numbers` a repair rather than a second
  // copy of the rules.
  const measured = measuredDerived(root)
  const file = 'docs/03-static-engine.md'
  const source = doc(file)
  const stale = source.replace(
    /(\| `constants\.ts` <span class="lnum">[^<]*<\/span> \| )\d+/,
    (all, head) => `${head}${measured.lines('src/auto/constants.ts') + 1}`,
  )
  assert.notEqual(stale, source, 'the tamper must land')
  assert.equal(applyDerivedRewrites(stale, file, measured), source, 'sync must restore the measured number')
})

test('line counting matches what wc -l reports', () => {
  assert.equal(countLines(''), 0)
  assert.equal(countLines('one\n'), 1)
  assert.equal(countLines('one\ntwo'), 1, 'a file without a trailing newline counts the newlines it has')
  assert.equal(countLines('one\ntwo\n'), 2)
})
