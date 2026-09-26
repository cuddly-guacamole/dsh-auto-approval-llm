/**
 * dsh-auto-approval-llm · rejectGuidanceSeen boundedness contracts.
 *
 * Fix: the dedup set is keyed by (sessionId, callId) — unique per tool call
 * — and would grow without bound in a long-lived process (the guidance
 * window 5/min makes growth slow but strictly unbounded). An insert-order
 * FIFO cap and a session/disposed prefix purge keep it bounded. The
 * injection window cannot be flooded in a unit test, so the contract is
 * pinned on source anchors (a removed cap or purge fails the assertions).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('rejectGuidanceSeen: the dedup set is capped by an insert-order FIFO', () => {
  // The cap and the eviction live with the injection window in
  // src/auto/notices.ts; the set itself is in src/auto/approval-state.ts.
  const notices = readFileSync(new URL('../src/auto/notices.ts', import.meta.url), 'utf8')
  assert.match(notices, /const REJECT_GUIDANCE_SEEN_CAP = \d+/, 'a cap constant must exist')
  assert.match(notices, /rejectGuidanceSeen\.size >= REJECT_GUIDANCE_SEEN_CAP/, 'the cap must gate insertion')
  assert.match(notices, /rejectGuidanceSeen\.delete\(oldest\)/, 'the oldest key must be evicted at the cap')
})

test('rejectGuidanceSeen: session disposal purges the session prefix wholesale', () => {
  // The purge rides the entry's session/disposed handler, which stays put.
  const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(host, /for \(const seenKey of rejectGuidanceSeen\)/, 'a prefix purge must iterate the set')
  assert.match(host, /seenKey\.startsWith\(prefix\)/, 'the purge must match the session:callId prefix')
  assert.match(host, /rejectGuidanceSeen\.delete\(seenKey\)/, 'the purge must remove matching keys')
})