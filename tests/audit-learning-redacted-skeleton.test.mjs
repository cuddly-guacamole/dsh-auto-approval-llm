/**
 * A learned entry must survive its own persistence. The write side validates
 * the un-redacted signature line and then stores the redacted product, while
 * the load gate matched the stored skeleton against a character class that did
 * not contain `[` — so every skeleton carrying the redactor's marker was
 * dropped on the next load: the confirmation count silently reset and the
 * signature never matured, with no artifact and no warning.
 *
 * Pins the round trip through the real persist/load path, the marker in the
 * gate, and the corrupted-file refusals that must stay in place.
 *
 * Run: node --test tests/audit-learning-redacted-skeleton.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  signatureFor, learningKey, emptyLearningStore, persistLearning, loadLearning,
  recordConfirm, lookupLearning, validateLearningEntry, LEARNING_SIG_VERSION,
} from '../lib/auto/learning.js'

const workspace = 'C:/ws'
const now = Date.now()
const freshFile = () => join(mkdtempSync(join(tmpdir(), 'learn-roundtrip-')), 'learning.json')

test('a credential-shaped signature redacts to a marker skeleton', () => {
  const sig = signatureFor({ kind: 'shell-bash', command: 'curl --api-key > out.txt' })
  assert.ok(sig !== undefined)
  assert.match(sig.skeleton, /\[redacted-secret\]/)
  assert.notEqual(sig.skeleton, sig.signature)
})

test('the redacted entry survives a persist/load round trip', () => {
  const path = freshFile()
  const sig = signatureFor({ kind: 'shell-bash', command: 'curl --api-key > out.txt' })
  const key = learningKey('shell-bash', workspace, sig.signature)
  let store = emptyLearningStore()
  store = recordConfirm(store, key, { workspace, kind: 'shell-bash', skeleton: sig.skeleton }, now)
  persistLearning(path, store)
  const reloaded = loadLearning(path, {})
  assert.equal(Object.keys(reloaded.entries).length, 1, 'the entry must not be dropped on load')
  assert.equal(reloaded.entries[key].skeleton, sig.skeleton)
  assert.equal(lookupLearning(reloaded, { key, workspace, threshold: 1, now }), true)
})

test('repeated confirmations accumulate across restarts', () => {
  const path = freshFile()
  const sig = signatureFor({ kind: 'shell-bash', command: 'curl --access-key > out.txt' })
  const key = learningKey('shell-bash', workspace, sig.signature)
  let store = emptyLearningStore()
  for (let round = 0; round < 3; round += 1) {
    store = recordConfirm(store, key, { workspace, kind: 'shell-bash', skeleton: sig.skeleton }, now + round)
    persistLearning(path, store)
    store = loadLearning(path, {})
  }
  assert.equal(store.entries[key].count, 3, 'three confirmations must survive three saves')
})

test('an unredacted signature still round-trips', () => {
  const path = freshFile()
  const sig = signatureFor({ kind: 'shell-bash', command: 'curl --plain-flag > out.txt' })
  const key = learningKey('shell-bash', workspace, sig.signature)
  const store = recordConfirm(emptyLearningStore(), key, { workspace, kind: 'shell-bash', skeleton: sig.skeleton }, now)
  persistLearning(path, store)
  assert.equal(Object.keys(loadLearning(path, {}).entries).length, 1)
})

test('a hand-edited file with other forbidden characters is still refused', () => {
  const base = {
    sigVersion: LEARNING_SIG_VERSION, workspace, kind: 'shell-bash',
    count: 3, firstAt: now - 1000, lastAt: now,
  }
  for (const skeleton of ['curl *', 'curl {skeleton}', 'curl `id`', 'curl "quoted"', 'curl [not-the-marker]', 'x\\y']) {
    assert.equal(validateLearningEntry({ ...base, skeleton }, now), undefined, `skeleton ${skeleton} must be refused`)
  }
  assert.notEqual(validateLearningEntry({ ...base, skeleton: 'curl --api-key [redacted-secret]' }, now), undefined)
})

test('the persisted file is what the gate reads', () => {
  const path = freshFile()
  const sig = signatureFor({ kind: 'shell-bash', command: 'curl --auth-token > out.txt' })
  const key = learningKey('shell-bash', workspace, sig.signature)
  persistLearning(path, recordConfirm(emptyLearningStore(), key, { workspace, kind: 'shell-bash', skeleton: sig.skeleton }, now))
  const onDisk = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(onDisk.entries[key].skeleton, sig.skeleton)
  assert.equal(Object.keys(loadLearning(path, {}).entries).length, 1)
})

test('a truncated or junk file keeps falling back to an empty store', () => {
  const path = freshFile()
  writeFileSync(path, '{"version":1,"entries":{"a":')
  assert.deepEqual(loadLearning(path, {}).entries, {})
  writeFileSync(path, JSON.stringify({ version: 1, entries: { a: { skeleton: 'curl *' } } }))
  assert.deepEqual(loadLearning(path, {}).entries, {})
})
