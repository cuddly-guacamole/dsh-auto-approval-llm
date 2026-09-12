/**
 * Leaving a session must not let a finished ask light up again. `clearSession`
 * only deleted the records, so the guarantee depended on the render path having
 * pruned them into tombstones first; a late `resolve()` for the same callId
 * (the host keeps listing a settled ask for its own window) re-created the
 * record and showed the outcome for another full terminal TTL.
 * Run: node --test tests/audit-clear-session-tombstone.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApprovalStatusStore } from '../lib/client/approvals/status-store.js'

test('a cleared session does not revive a settled ask through a late resolve', () => {
  let now = 1_000
  const store = createApprovalStatusStore(() => now)
  store.publishStatus('s1', 'c1', { phase: 'countdown', action: 'allow', seconds: 10, revision: 1 })
  store.resolve('s1', 'c1', 'timeout', 'reject')
  assert.equal(store.recordsFor('s1', now).length, 1, 'the settled record is visible')

  store.clearSession('s1')
  assert.equal(store.recordsFor('s1', now).length, 0, 'leaving the session drops the record')

  // The host still lists the settled ask, so a late resolve for the same id
  // arrives: it must not re-create the terminal record.
  store.resolve('s1', 'c1', 'llm', 'allow')
  assert.equal(store.recordsFor('s1', now).length, 0, 'a late resolve must not revive the cleared outcome')

  // And the discovery watcher republishing the same settled ask is inert too.
  store.publishStatus('s1', 'c1', { phase: 'follow', action: 'allow', source: 'llm' })
  assert.equal(store.recordsFor('s1', now).length, 0, 'a replayed follow must not revive it either')
})

test('clearing one session leaves another session alone', () => {
  const now = 5_000
  const store = createApprovalStatusStore(() => now)
  store.publishStatus('s1', 'c1', { phase: 'countdown', action: 'allow', seconds: 10, revision: 1 })
  store.publishStatus('s2', 'c2', { phase: 'countdown', action: 'allow', seconds: 10, revision: 1 })
  store.clearSession('s1')
  assert.equal(store.recordsFor('s2', now).length, 1, 'the other session keeps its ask')
  assert.equal(store.activeFor('s2', now)?.callId, 'c2')
})

test('an unterminated (live) ask is still dropped without a tombstone', () => {
  const now = 9_000
  const store = createApprovalStatusStore(() => now)
  store.observePending('s1', 'c1')
  store.clearSession('s1')
  assert.equal(store.recordsFor('s1', now).length, 0)
  // A live ask may legitimately be re-observed when the reader returns.
  store.observePending('s1', 'c1')
  assert.equal(store.recordsFor('s1', now).length, 1, 'a pending ask is not tombstoned by clearing')
})
