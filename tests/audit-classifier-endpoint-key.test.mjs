/**
 * The classifier's endpoint lane sent its request with no credential at all
 * when no key resolved, while the reviewer lane treats exactly that state as a
 * loud half-configuration failure. The silent variant only converts a
 * misconfiguration into an AUTH failure the operator never sees, and it makes
 * the two lanes disagree about what "configured" means.
 *
 * Pins the two lanes onto the same discipline (the failure itself is covered by
 * the ask fallback: the caller's catch turns a classifier error into an ask,
 * so the direction stays fail-closed).
 * Run: node --test tests/audit-classifier-endpoint-key.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
// The reviewer lane moved to its own module, so its half-configuration
// failure is read where it is written now.
const reviewerSrc = readFileSync(fileURLToPath(new URL('../src/auto/review-pipeline.ts', import.meta.url)), 'utf8')

test('the classifier endpoint lane refuses to run without a resolved key', () => {
  const branch = src.indexOf('endpoint source needs a URL and model for classification')
  assert.ok(branch > 0, 'the endpoint branch exists')
  const window = src.slice(branch, branch + 1_400)
  assert.match(window, /if \(!endpointApiKey\) \{/, 'the lane checks the resolved key')
  assert.match(window, /debugLog\(\{ ev: 'classifier-incomplete'/, 'the misconfiguration is observable')
  assert.match(window, /throw new Error\('endpoint source needs a resolved API key for classification'\)/, 'the lane fails loudly')
  // The throw must precede the call: a request without the key is what this
  // guard exists to prevent.
  assert.ok(
    window.indexOf("throw new Error('endpoint source needs a resolved API key for classification')") < window.indexOf('endpointClassifier.classify('),
    'the key check precedes the classify call',
  )
})

test('the reviewer lane keeps its matching discipline', () => {
  assert.match(reviewerSrc, /return \{ failure: 'endpoint source needs a resolved API key' \}/)
  assert.match(reviewerSrc, /debugLog\(\{ ev: 'reviewer-incomplete'/)
})
