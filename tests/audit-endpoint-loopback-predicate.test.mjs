/**
 * The cleartext-http fence in validateReviewerBaseUrl and the loopback
 * predicate used by the endpoint caller must be ONE predicate: a spelling the
 * caller treats as loopback (and therefore reaches without pinning) must not be
 * refused at configuration time, and a non-loopback host must never be let
 * through in cleartext.
 * Run: node --test tests/audit-endpoint-loopback-predicate.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isLoopbackHostname, validateReviewerBaseUrl } from '../lib/auto/trust.js'

const LOOPBACK_URLS = [
  'http://localhost:11434',
  'http://127.0.0.1:11434',
  'http://127.1.2.3:8080',
  'http://[::1]:11434',
  'http://[::ffff:127.0.0.1]:11434',
]

const NON_LOOPBACK_URLS = [
  'http://example.com',
  'http://api.example.com:8080',
  'http://192.168.1.10:8080',
  'http://10.0.0.1',
  'http://169.254.169.254',
  'http://[::ffff:10.0.0.1]:8080',
]

test('validateReviewerBaseUrl: every loopback spelling allows cleartext http', () => {
  for (const url of LOOPBACK_URLS) {
    const result = validateReviewerBaseUrl(url)
    assert.equal(result.ok, true, `${url} should be accepted as loopback`)
    assert.equal(result.insecure, true, `${url} is cleartext`)
  }
})

test('validateReviewerBaseUrl: non-loopback cleartext http stays refused', () => {
  for (const url of NON_LOOPBACK_URLS) {
    const result = validateReviewerBaseUrl(url)
    assert.equal(result.ok, false, `${url} must not be accepted in cleartext`)
  }
})

test('validateReviewerBaseUrl: https off loopback is accepted', () => {
  const result = validateReviewerBaseUrl('https://api.example.com/v1')
  assert.equal(result.ok, true)
  assert.equal(result.insecure, false)
})

test('both predicates agree on the loopback spellings', () => {
  for (const url of LOOPBACK_URLS) {
    const host = new URL(url).hostname
    assert.equal(isLoopbackHostname(host), true, `${host} (from ${url}) should be loopback`)
  }
  for (const url of NON_LOOPBACK_URLS) {
    const host = new URL(url).hostname
    assert.equal(isLoopbackHostname(host), false, `${host} (from ${url}) should not be loopback`)
  }
})
