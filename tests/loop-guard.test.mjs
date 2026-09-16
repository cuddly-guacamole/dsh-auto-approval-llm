/**
 * dsh-auto-approval-llm · loop guard pure core and threshold setting.
 *
 * The loop key is the EXACT call identity (tool name + sanitized-arguments
 * hash) — deliberately wider than the learning signature's bounded skeleton,
 * which returns undefined for exactly the quoted/dynamic/glob forms a stuck
 * loop tends to produce. Two key namespaces, two purposes: the learning
 * signature answers "has a human confirmed this shape before"; the loop key
 * answers "is this the same call again". The streak advances only across
 * gated-site calls and resets on any different key (strict consecutiveness);
 * firing deletes the entry (fire-and-reset: a human allow never buys a
 * permanent exemption).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fnv1a32, loopKeyFor, createLoopState, recordLoopCall, normalizeLoopThreshold, LOOP_GUARD_MAX_KEYS } from '../lib/auto/loop-guard.js'
import { resolveConfig } from '../lib/index.js'

test('fnv1a32: matches the published FNV-1a 32-bit vectors and discriminates inputs', () => {
  // The hash is a stored-key wire format, so it is pinned to known vectors
  // (offset basis for '', one 0x61 step for 'a') instead of compared with itself.
  assert.equal(fnv1a32(''), '811c9dc5')
  assert.equal(fnv1a32('a'), 'e40c292c')
  assert.equal(fnv1a32('bash\u0000{"command":"ls"}'), '483eb77d')
  assert.notEqual(fnv1a32('bash\u0000{"command":"ls"}'), fnv1a32('bash\u0000{"command":"ls -la"}'))
})

test('loopKeyFor: the same call yields the same key regardless of argument key order', () => {
  const left = loopKeyFor('write', { file_path: 'a.txt', content: 'x' })
  const right = loopKeyFor('write', { content: 'x', file_path: 'a.txt' })
  assert.equal(left, right, 'one call, one key: object key order must not matter')
  assert.notEqual(loopKeyFor('write', { file_path: 'b.txt', content: 'x' }), left, 'different arguments are a different key')
  assert.notEqual(loopKeyFor('bash', { command: 'ls' }), loopKeyFor('pwsh', { command: 'ls' }), 'the tool name is part of the key')
})

test('loopKeyFor: missing arguments fall back to a tool-level key', () => {
  // The fallback is exactly "tool name + separator + empty body": pinning the
  // vector keeps `undefined` from folding into the '{}' body an explicit
  // empty-arguments call produces.
  assert.equal(loopKeyFor('web_fetch', undefined), fnv1a32('web_fetch\u0000'))
  assert.equal(loopKeyFor('web_fetch', undefined), '8b8b560a')
  assert.notEqual(loopKeyFor('web_fetch', undefined), loopKeyFor('web_fetch', {}), 'no arguments is not the same call as empty arguments')
  assert.notEqual(loopKeyFor('web_fetch', undefined), loopKeyFor('web_search', undefined))
})

test('recordLoopCall: the Nth identical call fires exactly once, then the streak restarts', () => {
  const state = createLoopState()
  assert.deepEqual(recordLoopCall(state, 'k', 3), { consecutive: 1, fired: false })
  assert.deepEqual(recordLoopCall(state, 'k', 3), { consecutive: 2, fired: false })
  assert.deepEqual(recordLoopCall(state, 'k', 3), { consecutive: 3, fired: true })
  assert.deepEqual(recordLoopCall(state, 'k', 3), { consecutive: 1, fired: false }, 'fire-and-reset: the human allow bought no exemption')
})

test('recordLoopCall: a different key breaks the streak (strict consecutiveness)', () => {
  const state = createLoopState()
  recordLoopCall(state, 'a', 3)
  recordLoopCall(state, 'a', 3)
  recordLoopCall(state, 'b', 3)
  const fourth = recordLoopCall(state, 'a', 3)
  assert.deepEqual(fourth, { consecutive: 1, fired: false }, 'a→a→b→a never fires')
})

test('recordLoopCall: the per-session table stays bounded (least-recently-updated eviction)', () => {
  const state = createLoopState()
  for (let i = 0; i < LOOP_GUARD_MAX_KEYS; i += 1) recordLoopCall(state, `k${i}`, 5)
  assert.equal(state.inner.size, LOOP_GUARD_MAX_KEYS)
  // Re-touch k0: it is still the oldest INSERTED key but no longer the
  // least-RECENTLY-updated one, so the next eviction must take k1. Plain
  // insertion order would evict k0 and quietly turn the table into a FIFO that
  // drops live streaks first.
  recordLoopCall(state, 'k0', 5)
  recordLoopCall(state, 'k-new', 5)
  assert.equal(state.inner.size, LOOP_GUARD_MAX_KEYS, 'one entry was evicted, never grown')
  assert.equal(state.inner.has('k1'), false, 'k1 is now the least-recently-updated key and is the one evicted')
  assert.equal(state.inner.has('k0'), true, 'the re-touched key survives')
  assert.equal(state.inner.has(`k${LOOP_GUARD_MAX_KEYS - 1}`), true, 'recent keys survive')
})

test('normalizeLoopThreshold: 0 stays off, 1 clamps to 2 with a warning, the rest pass through', () => {
  assert.deepEqual(normalizeLoopThreshold(undefined), { value: 0, warned: false })
  assert.deepEqual(normalizeLoopThreshold(0), { value: 0, warned: false })
  assert.deepEqual(normalizeLoopThreshold(1), { value: 2, warned: true }, 'threshold 1 would ask on every allowed call')
  assert.deepEqual(normalizeLoopThreshold(3), { value: 3, warned: false })
  assert.deepEqual(normalizeLoopThreshold(-4), { value: 0, warned: false })
  assert.deepEqual(normalizeLoopThreshold('3'), { value: 0, warned: false }, 'non-number input is off, never a crash')
})

test('resolveConfig: the loop threshold defaults to off and clamps 1 to 2', () => {
  assert.equal(resolveConfig({ timeoutAction: 'reject' }).loopDetectionThreshold, 0, 'default off')
  assert.equal(resolveConfig({ timeoutAction: 'reject', loopDetectionThreshold: 3 }).loopDetectionThreshold, 3)
  assert.equal(resolveConfig({ timeoutAction: 'reject', loopDetectionThreshold: 1 }).loopDetectionThreshold, 2)
  assert.equal(resolveConfig({ timeoutAction: 'reject', loopDetectionThreshold: 1.7 }).loopDetectionThreshold, 2, 'floored to 1, then clamped — hand-edited storage never reaches the every-call-asks value')
})
