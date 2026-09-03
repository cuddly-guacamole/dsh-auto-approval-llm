/**
 * dsh-auto-approval-llm · spaced-equals redaction contracts.
 *
 * Fix: `token = abc123456789` (spaces around the equals) slipped the
 * `KEY=value` replacement pattern, so credential-shaped material in
 * spaced assignment form crossed to the reviewer / history unreviewed.
 * The pattern now tolerates optional whitespace around the equals.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets } from '../lib/auto/redact.js'

test('redactSecrets: spaced-equals key=value forms are redacted like the tight form', () => {
  assert.equal(redactSecrets('token = abc123456789'), 'token = [redacted-secret]')
  assert.equal(redactSecrets('api_key = A1b2C3d4E5f6'), 'api_key = [redacted-secret]')
  assert.equal(redactSecrets('password = hunter2hunter2!'), 'password = [redacted-secret]')
  assert.equal(redactSecrets('secret = abc123456789'), 'secret = [redacted-secret]')
  // The tight form keeps redacting (regression).
  assert.ok(!redactSecrets('api_key=xyz').includes('xyz'))
  // Non-sensitive keys stay untouched (no over-block).
  assert.equal(redactSecrets('color = red'), 'color = red')
  assert.equal(redactSecrets('answer = 42'), 'answer = 42')
})