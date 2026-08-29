// Contract tests for src/auto/redact.ts credential-shaped masking.
//
// Split out of contract.test.mjs when the colon-form redaction coverage was
// added (F1-redact): every redaction pattern here must keep the "miss-hit"
// boundary — short values / negations and non-sensitive keys stay untouched —
// while every recognized secret shape (key=value, sk-/Bearer/AKIA/JWT/PEM,
// connection strings, and the JSON/bare colon forms) is masked.
import test from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets } from '../lib/auto/redact.js'

// ── audit loop — colon-form secret redaction (F1-redact) ────────────────────
// JSON (`{"token": "…"}`) and bare (`token: …`) colon forms used to slip past
// the pre-screen (only `=`/`://` forms were covered) and the replacement chain
// (`KEY=value` only), so command arguments containing them crossed to the
// online reviewer raw. They are now redacted like the `=` forms, while short
// values / negations and non-sensitive keys stay untouched.
test('redactSecrets: JSON quoted colon forms are redacted, key + quotes kept', () => {
  assert.equal(redactSecrets('{"token": "ghp_xYzAbC"}'), '{"token": "[redacted-secret]"}')
  assert.equal(redactSecrets('{"api_key": "value-with-long-content"}'), '{"api_key": "[redacted-secret]"}')
  assert.equal(redactSecrets("{'auth_token': 'A9t0kenValueHere'}"), "{'auth_token': '[redacted-secret]'}")
  assert.equal(redactSecrets('{"password": "aVeryLongPassword1"}'), '{"password": "[redacted-secret]"}')
  assert.ok(!redactSecrets('{"secret": "ShhhItsASecret"}').includes('ShhhItsASecret'))
})

test('redactSecrets: bare colon forms are redacted with a 6-char value gate', () => {
  assert.equal(redactSecrets('token: abc12345'), 'token: [redacted-secret]')
  assert.equal(redactSecrets('api_key: A1b2C3d4E5f6'), 'api_key: [redacted-secret]')
  assert.equal(redactSecrets('use token:abcdefgh999 here'), 'use token: [redacted-secret] here')
  assert.ok(!redactSecrets('password: hunter2hunter2!').includes('hunter2hunter2'))
})

test('redactSecrets: short values and negations are not colon-redacted (no mis-hit)', () => {
  assert.equal(redactSecrets('token: none'), 'token: none')
  assert.equal(redactSecrets('secret: no'), 'secret: no')
  assert.equal(redactSecrets('password: 123'), 'password: 123')
  assert.equal(redactSecrets('token: none, secret: no'), 'token: none, secret: no')
})

test('redactSecrets: non-sensitive keys are never colon-redacted (no mis-hit)', () => {
  for (const text of ['color: red', 'status: ok', 'note: running fine', 'tokenless: abc12345', 'metadata: quiet now']) {
    assert.equal(redactSecrets(text), text, text)
  }
})

test('redactSecrets: existing formats keep redacting alongside the colon forms (regression)', () => {
  const out = redactSecrets(
    'sk-abcdefgh12345678 Bearer abcd1234efgh ' +
    'AKIAZX6FOBMXYZABC123 api_key=xyz ' +
    'token: abc12345 ' +
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c ' +
    'postgres://user:secret@localhost:5432/db')
  assert.ok(!out.includes('sk-abcdefgh12345678'))
  assert.ok(!out.includes('abcd1234efgh'))
  assert.ok(!out.includes('AKIAZX6FOBMXYZABC123'))
  assert.ok(!out.includes('xyz'))
  assert.ok(!out.includes('abc12345'))
  assert.ok(!out.includes('SflKxwR'))
  assert.ok(!out.includes('user:secret@'))
})