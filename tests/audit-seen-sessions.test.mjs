/**
 * dsh-auto-approval-llm · seen-session tracker contracts.
 *
 * Fix: the remote watcher accumulated every seen sessionId in a plain Set
 * for the browser tab's lifetime (read only at dispose), growing without
 * bound as sessions are created and destroyed. The tracker caps the set with
 * the same FIFO discipline as answeredApprovals.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSeenSessionTracker, MAX_SEEN_SESSIONS } from '../lib/client/approvals/shared.js'

test('createSeenSessionTracker: FIFO eviction keeps the set bounded', () => {
  const tracker = createSeenSessionTracker(undefined, undefined, 3)
  tracker.add('s1')
  tracker.add('s2')
  tracker.add('s3')
  assert.deepEqual([...tracker.seen].sort(), ['s1', 's2', 's3'])
  tracker.add('s4') // beyond cap → oldest evicted
  assert.deepEqual([...tracker.seen].sort(), ['s2', 's3', 's4'])
  tracker.add('s2') // re-add is a no-op, never reorders
  assert.equal(tracker.seen.size, 3)
  tracker.add('s5')
  assert.deepEqual([...tracker.seen].sort(), ['s3', 's4', 's5'], 'insertion order preserves the FIFO window')
})

test('createSeenSessionTracker: default cap applies without argument plumbing', () => {
  const tracker = createSeenSessionTracker()
  for (let i = 0; i < MAX_SEEN_SESSIONS + 10; i += 1) tracker.add(`s${i}`)
  assert.equal(tracker.seen.size, MAX_SEEN_SESSIONS)
  assert.ok(!tracker.seen.has('s0'), 'oldest evicted at the cap')
})