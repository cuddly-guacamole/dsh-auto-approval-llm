/**
 * dsh-auto-approval-llm · the redaction pre-screen must cover every rule.
 *
 * `redactSecrets` returns early unless the cheap `SECRET_FEATURES` pre-screen
 * matches, and its doc states it is a strict superset of every literal the
 * rules below can match. `KEY_SPACE_RULE` was written for the shapes that have
 * no `=`/`:` to key off (`npm config set //x:_authToken TOKEN`), so its
 * matches need neither character: `api_key abcdefgh` skipped the scan and the
 * compound credential reached the audit/log surfaces unmasked.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets } from '../lib/auto/redact.js'

test('space-separated compound credentials are masked', () => {
  for (const value of ['api_key abcdefgh', 'API-KEY 0123456789abcdef', 'access_token deadbeefdeadbeef', 'refresh_secret supersecretvalue']) {
    const masked = redactSecrets(value)
    assert.ok(masked.includes('[redacted-secret]'), `${value} must be masked`)
    assert.ok(!masked.includes('abcdefgh') && !masked.includes('deadbeefdeadbeef'), `${value} value must not survive`)
  }
})

test('the narrowness of the space rule is preserved', () => {
  assert.equal(redactSecrets('the token was abcdef12345678'), 'the token was abcdef12345678', 'prose is not a credential line')
  assert.equal(redactSecrets('api key abcdefgh'), 'api key abcdefgh', 'a bare space-separated word is not the compound form')
})

test('the existing rules keep working', () => {
  assert.ok(redactSecrets('apiKey=abcdefghijkl').includes('[redacted-secret]'))
  assert.ok(redactSecrets('Bearer abcdefghijkl').includes('[redacted-secret]'))
  assert.equal(redactSecrets('an ordinary line'), 'an ordinary line')
})
