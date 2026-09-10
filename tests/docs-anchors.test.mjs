/**
 * The docs site's source anchors must still point at real code.
 *
 * Every `docs/*.md` page names source locations by hand, and nothing checked
 * them: `docs/03-static-engine.md` had drifted by up to 47 lines (a whole
 * section's anchors aimed at unrelated statements) with no signal at all. The
 * anchor forms that cannot drift quietly are symbol/literal anchors, and
 * `scripts/check-anchors.mjs` resolves each one against the working tree.
 *
 * This test runs that checker over the WHOLE docs tree, so the gate lives in
 * `npm test` instead of depending on someone remembering to run it. Gating a
 * single page was not a weaker guarantee, it was a different one: ~68% of the
 * anchors sat outside the gate, and that is exactly where every stale anchor
 * was found.
 *
 * The checker's own honesty rules are pinned too:
 *   - a violating anchor is reported as a violation and counted, never dropped;
 *   - an anchor that can only be range-checked is never reported as verified,
 *     and the batch that made this gate honest left ZERO of them — a bare range
 *     proves only that the number is inside the file, so it is not allowed back;
 *   - a span the checker cannot fully parse FAILS the run. It used to print
 *     `UNVERIFIED` and still exit 0, which meant an anchor naming nothing could
 *     sit in a page forever;
 *   - a page cannot silently lose all of its anchors: the pages with none are
 *     listed explicitly below.
 *
 * Run: node --test tests/docs-anchors.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const checker = join(root, 'scripts', 'check-anchors.mjs')

/**
 * Pages that legitimately carry no source anchor: they describe concepts,
 * self-tests, quality gates or the platform matrix, and point at no statement.
 * Listing them is the point — a page that HAD anchors and lost them all is a
 * silent regression, and this set is what makes that detectable.
 */
const PAGES_WITHOUT_ANCHORS = new Set([
  'docs/09-defense-in-depth.md',
  'docs/14-code-map.md',
  'docs/15-quality.md',
  'docs/16-axioms.md',
  'docs/19-platform-support.md',
  'docs/index.md',
])

/** Run the checker and return {status, stdout, stderr} without throwing. */
function runChecker(args) {
  try {
    const stdout = execFileSync(process.execPath, [checker, ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // Without a timeout a hung checker hangs this whole test file: node:test
      // applies no default per-test timeout, so the suite would simply stop.
      timeout: 60_000,
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    }
  }
}

/** The full-tree run, parsed into the numbers the assertions below use. */
function fullRun() {
  const result = runChecker(['--per-doc'])
  const docs = Number(/(\d+) doc\(s\)/.exec(result.stdout)?.[1] ?? Number.NaN)
  const examined = Number(/(\d+) anchor\(s\) examined/.exec(result.stdout)?.[1] ?? Number.NaN)
  const verified = Number(/— (\d+) verified/.exec(result.stdout)?.[1] ?? Number.NaN)
  const range = Number(/(\d+) range-checked only/.exec(result.stdout)?.[1] ?? Number.NaN)
  const unresolved = Number(/(\d+) unparsable span\(s\)/.exec(result.stdout)?.[1] ?? Number.NaN)
  const perDoc = new Map()
  for (const line of result.stdout.split('\n')) {
    const m = /check-anchors: doc (\S+) anchors=(\d+) verified=(\d+) range=(\d+) whole=(\d+) failed=(\d+) unresolved=(\d+)/.exec(line)
    if (m) perDoc.set(m[1].split('\\').join('/'), { anchors: Number(m[2]), verified: Number(m[3]), range: Number(m[4]) })
  }
  return { result, docs, examined, verified, range, unresolved, perDoc }
}

test('the whole docs tree passes the anchor check', () => {
  const run = fullRun()
  assert.equal(run.result.status, 0, `the repo-wide anchor check must pass:\n${run.result.stdout}\n${run.result.stderr}`)
  assert.match(run.result.stdout, /check-anchors: ok/, 'a clean run reports ok')
  assert.ok(run.docs >= 15, `expected the whole docs tree to be checked, got ${run.docs} doc(s)`)
  assert.ok(run.verified >= 100, `expected every page's anchors to be verified, got ${run.verified}`)
})

test('no bare range anchors remain anywhere in the docs tree', () => {
  // The batch that built this gate converted the whole tree to symbol/literal
  // anchors. A range only proves the line number is in bounds — it cannot catch
  // a pointer aimed at the wrong statement, which is the drift this gate exists
  // for. Zero is therefore a ratchet, not a coincidence.
  const run = fullRun()
  assert.equal(run.range, 0, `bare range anchors must not come back, found ${run.range}:\n${run.result.stdout}`)
  assert.match(run.result.stdout, /0 range-checked only/, 'the summary keeps the range bucket visible so it cannot grow silently')
})

test('no unparsable spans: a span the checker cannot resolve fails the run', () => {
  const run = fullRun()
  assert.equal(run.unresolved, 0, `every span must parse:\n${run.result.stdout}`)
})

test('checker: an unparsable span is a failure, not a silent skip', () => {
  // Negative control for the false-green this gate was built to kill. Node 22
  // is likely, but do not assert the exit code alone: the run must also SAY it
  // failed, so a future refactor cannot pass by exiting 1 for an unrelated
  // reason.
  const probe = join(root, `probe-anchor-unparsed-${process.pid}.md`)
  try {
    writeFileSync(probe, [
      '# probe',
      '',
      'no parsable anchor: <span class="lnum">src/auto/trust.ts</span>',
      '',
      'good: <span class="lnum">policy.ts:LassessTool</span>',
      '',
    ].join('\n'))
    const result = runChecker(['--check', `probe-anchor-unparsed-${process.pid}.md`])
    assert.equal(result.status, 1, 'a span with no parsable anchor must fail the check')
    assert.match(result.stdout, /UNVERIFIED/, 'the offending span is named')
    assert.match(result.stdout, /1 unparsable span\(s\)/, 'the summary counts it')
  } finally {
    rmSync(probe, { force: true })
  }
})

test('checker: a broken anchor is a violation, not a silent skip', () => {
  const probe = join(root, `probe-anchor-negative-${process.pid}.md`)
  try {
    writeFileSync(probe, [
      '# probe',
      '',
      'out of bounds: <span class="lnum">policy.ts:L99999-100000</span>',
      '',
      'unknown symbol: <span class="lnum">policy.ts:LdefinitelyNotASymbolXYZ</span>',
      '',
      'good: <span class="lnum">policy.ts:LassessTool</span>',
      '',
    ].join('\n'))
    const result = runChecker(['--check', `probe-anchor-negative-${process.pid}.md`])
    assert.equal(result.status, 1, 'a broken anchor must fail the check')
    assert.match(result.stderr, /VIOLATION/, 'violations are reported')
    assert.match(result.stderr, /out of bounds/, 'the out-of-bounds anchor is named')
    assert.match(result.stderr, /definitelyNotASymbolXYZ/, 'the unknown symbol is named')
    // The count must include the failures: a report that shrinks when checks
    // fail would understate how much was examined.
    const examined = Number(/(\d+) anchor\(s\) examined/.exec(result.stdout)[1])
    assert.equal(examined, 3, `all three anchors must be counted, got ${examined}`)
    assert.match(result.stdout, /2 failed/, 'the failure count is part of the summary')
  } finally {
    rmSync(probe, { force: true })
  }
})

test('no page silently loses all of its anchors', () => {
  const { perDoc } = fullRun()
  assert.ok(perDoc.size >= 15, `expected a per-doc tally for every page, got ${perDoc.size}`)
  for (const [doc, row] of perDoc) {
    if (PAGES_WITHOUT_ANCHORS.has(doc)) continue
    assert.ok(
      row.anchors > 0,
      `${doc} carries no anchors; either restore them or add the page to PAGES_WITHOUT_ANCHORS`,
    )
    assert.equal(row.range, 0, `${doc} still holds bare range anchors`)
  }
})

test('checker: range-only anchors are never reported as verified', () => {
  // The honest-reporting contract: an in-bounds range cannot be proven to point
  // at the right statement, so it gets its own bucket and the summary says so.
  const source = readFileSync(checker, 'utf8')
  assert.ok(
    /range-checked only \(in-bounds; a wrong-code range is not auto-detectable\)/.test(source),
    'the range bucket is labelled as unproven in the summary',
  )
  assert.ok(
    !/buckets\.range \+ buckets\.declaration[^\n]*totalChecked/.test(source),
    'ranges must not be folded into a verified total',
  )
})

test('checker: the script only reads — there is no write mode', () => {
  // An earlier draft shipped a `--write` mode that could never fire (its guard
  // compared a value the finder had seeded from the same field, so the patch
  // list was always empty) and a test that "pinned" it by grepping for the
  // writeFileSync call — which passed on unreachable code. Symbol anchors are
  // self-verifying and a bare range cannot be repaired mechanically, so the
  // honest shape is a read-only checker; pin the absence, and pin that the file
  // system is not opened for writing at all.
  const source = readFileSync(checker, 'utf8')
  // The header comment explains why there is no write mode, so strip comments
  // before asserting the flag itself is gone.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!code.includes('--write'), 'the dead --write mode is gone')
  assert.ok(!/flags\.write/.test(code), 'no flag can select a write mode')
  assert.ok(!/writeFileSync|appendFileSync|mkdirSync|rmSync/.test(code), 'the checker never writes to disk')
  assert.ok(/flags\.check = true/.test(code), 'the only mode is the check')
})
