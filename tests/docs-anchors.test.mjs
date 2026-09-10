/**
 * The docs site's source anchors must still point at real code.
 *
 * Every `docs/*.md` page names source lines by hand, and nothing checked them:
 * `docs/03-static-engine.md` had drifted by up to 47 lines (a whole section's
 * anchors aimed at unrelated statements) with no signal at all. The anchor forms
 * that cannot drift quietly are now symbol/literal anchors, and
 * `scripts/check-anchors.mjs` resolves each one against the working tree.
 *
 * This test runs that checker over the page it was built for, so the gate lives
 * in `npm test` instead of depending on someone remembering to run it. The
 * checker's own honesty rules are pinned too: a violating anchor must be
 * reported as a violation rather than silently dropped from the count, and an
 * anchor that can only be range-checked must not be reported as verified.
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

/** Run the checker and return {status, stdout, stderr} without throwing. */
function runChecker(args) {
  try {
    const stdout = execFileSync(process.execPath, [checker, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    }
  }
}

test('docs/03: every anchor resolves against the current source', () => {
  const result = runChecker(['--check', 'docs/03-static-engine.md'])
  assert.equal(result.status, 0, `the anchor check must pass:\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /check-anchors: ok/, 'a clean run reports ok')
  // The page must actually carry anchors: a page with none would pass trivially.
  assert.match(result.stdout, /(\d+) anchor\(s\) resolved/)
  const resolved = Number(/(\d+) anchor\(s\) resolved/.exec(result.stdout)[1])
  assert.ok(resolved >= 30, `expected the page's anchors to be checked, got ${resolved}`)
})

test('the whole docs tree is gated, not just one page', () => {
  // Gating a single page leaves every other page's anchors unchecked — and a
  // drifted anchor is silent by nature, so "some pages are checked" is not a
  // weaker guarantee, it is a different one. The default run (no path
  // arguments) covers docs/*.md.
  const result = runChecker([])
  assert.equal(result.status, 0, `the repo-wide anchor check must pass:\n${result.stdout}\n${result.stderr}`)
  const docs = Number(/(\d+) doc\(s\)/.exec(result.stdout)[1])
  assert.ok(docs >= 15, `expected the whole docs tree to be checked, got ${docs} doc(s)`)
  const resolved = Number(/(\d+) anchor\(s\) resolved/.exec(result.stdout)[1])
  assert.ok(resolved >= 100, `expected every page's anchors to be examined, got ${resolved}`)
  // The run must not be reporting an all-verified story: most remaining anchors
  // are bare ranges, and the summary has to say so rather than fold them into
  // the verified count.
  assert.match(result.stdout, /range-checked only/, 'bare ranges keep their own bucket')
})

test('checker: a broken anchor is a violation, not a silent skip', () => {
  // Negative control. The probe document lives at the repo root — the one place
  // `.gitignore` (`/*` whitelist) already ignores, which is where this repo's
  // scratch probes conventionally go — because the checker resolves document
  // paths relative to the repo root. It is removed in `finally`.
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
    const resolved = Number(/(\d+) anchor\(s\) resolved/.exec(result.stdout)[1])
    assert.equal(resolved, 3, `all three anchors must be counted, got ${resolved}`)
    assert.match(result.stdout, /2 failed/, 'the failure count is part of the summary')
  } finally {
    rmSync(probe, { force: true })
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
