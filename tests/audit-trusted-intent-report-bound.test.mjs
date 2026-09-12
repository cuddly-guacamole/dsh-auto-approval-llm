/**
 * dsh-auto-approval-llm · the trusted-intent signature must not outlive its
 * session.
 *
 * `trustedIntentReported` is keyed by the session authority id and written from
 * the pre-execute plane, so every Auto session that reaches the classifier used
 * to add one permanent entry. Its siblings are dropped on `session/disposed`
 * (`firstAutoNoticeSeen`, `requestAtByKey`, `reviewModes`, the breaker maps),
 * and the map has no cap of its own — so it belongs to that teardown.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

test('the disposal handler drops the session signature', () => {
  const disposeStart = host.indexOf("anyCtx.on('session/disposed'")
  assert.notEqual(disposeStart, -1, 'the disposal handler is present')
  const disposeBody = host.slice(disposeStart, disposeStart + 3000)
  assert.match(
    disposeBody,
    /firstAutoNoticeSeen\.delete\(key\)[\s\S]{0,600}trustedIntentReported\.delete\(key\)/,
    'the per-session signature is released with the other per-session state',
  )
})

test('the signature is still keyed by the session authority id', () => {
  assert.ok(host.includes('trustedIntentReported.set(key, signature)'), 'the map still records the last signature')
  assert.ok(host.includes('reportTrustedIntentOrigins(authorityKeyFor(exec), trustedIntents)'), 'the writer still keys by the authority id')
})

test('the entry is not relocated into a shared cap it does not belong to', () => {
  // The map is per-session state, so disposal — not a global FIFO — owns it.
  assert.ok(!host.includes('trustedIntentReported.clear()'), 'a global clear would drop live sessions too')
})
