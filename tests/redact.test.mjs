// Contract tests for src/auto/redact.ts credential-shaped masking.
//
// Split out of contract.test.mjs when the colon-form redaction coverage was
// added (F1-redact): every redaction pattern here must keep the "miss-hit"
// boundary — short values / negations and non-sensitive keys stay untouched —
// while every recognized secret shape (key=value, sk-/Bearer/AKIA/JWT/PEM,
// connection strings, and the JSON/bare colon forms) is masked.
import test from 'node:test'
import assert from 'node:assert/strict'
import { redactResultValue, redactSecrets } from '../lib/auto/redact.js'

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

// ── audit loop — depth-bound redaction fix (F2-redact) ──────────────────────
// redactResultValue used to return objects/arrays beyond maxDepth through
// entirely (and skipped SECRET_KEYS field checks at depth === maxDepth), so
// deeply nested secret fields/values leaked to the model. maxDepth now bounds
// CONTAINER recursion only: string values are still cleaned at any depth, and
// field names are checked at every visited layer.
test('redactResultValue: string values are still cleaned beyond maxDepth (no leak)', () => {
  // The `data` string sits at depth 7 (default maxDepth=6): container
  // recursion stops, but the string itself still runs through redactSecrets.
  const deep = { l1: { l2: { l3: { l4: { l5: { l6: { data: 'sk-abcdefgh12345678' } } } } } } }
  const out = redactResultValue(deep)
  assert.equal(out.l1.l2.l3.l4.l5.l6.data, '[redacted-secret]')
  assert.ok(!JSON.stringify(out).includes('sk-abcdefgh12345678'))
  // A shallower cap still cleans the strings it reaches past the bound.
  const mid = { a: { b: 'sk-abcdefgh12345678' } }
  assert.equal(redactResultValue(mid, 0, 1).a.b, '[redacted-secret]')
  // Array element at depth 7 is cleaned too.
  const arr = [[[[[[['sk-abcdefgh12345678']]]]]]]
  assert.ok(!JSON.stringify(redactResultValue(arr)).includes('sk-abcdefgh12345678'))
})

test('redactResultValue: SECRET_KEYS field names are checked at depth === maxDepth', () => {
  // The {token: …} object sits at depth 6: the old `depth < maxDepth` guard
  // skipped the field-name check there, so the value leaked raw.
  const deep = { a: { b: { c: { d: { e: { f: { token: 'sk-abcdefgh12345678' } } } } } } }
  const out = redactResultValue(deep)
  assert.equal(out.a.b.c.d.e.f.token, '[redacted:field]')
  assert.ok(!JSON.stringify(out).includes('sk-abcdefgh12345678'))
})

test('redactResultValue: containers beyond maxDepth are passed through whole (perf guard kept)', () => {
  // The inner {token: …} container sits at depth 7: object/array recursion
  // stops there, so its field names are not checked — that is the documented
  // trade-off behind maxDepth (raise it when a stronger guarantee is needed).
  // Pass-through keeps the fast path (original references, no copying).
  const deep = { a: { b: { c: { d: { e: { f: { g: { token: 'sk-abcdefgh12345678' } } } } } } } }
  const same = redactResultValue(deep)
  assert.equal(same, deep)
  assert.equal(same.a.b.c.d.e.f.g.token, 'sk-abcdefgh12345678')
})

test('redactResultValue: shallow behavior is unchanged (regression)', () => {
  const out = redactResultValue({ token: 'sk-abcdefgh12345678', data: 'Bearer abcdefgh12345678', nested: { apiKey: 'x' } })
  assert.equal(out.token, '[redacted:field]')
  assert.equal(out.nested.apiKey, '[redacted:field]')
  assert.ok(out.data.includes('[redacted-secret]'))
  assert.ok(!JSON.stringify(out).includes('sk-abcdefgh12345678'))
})

test('redactResultValue: benign values keep the exact original reference (fast path)', () => {
  const plain = { x: 1, y: 'ok', z: { w: [1, 2] } }
  assert.equal(redactResultValue(plain), plain)
  const deepBenign = { a: { b: { c: { d: { e: { f: { g: { note: 'plain deep text' } } } } } } } }
  assert.equal(redactResultValue(deepBenign), deepBenign)
})
