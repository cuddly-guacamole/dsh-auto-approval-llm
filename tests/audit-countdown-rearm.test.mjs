/**
 * dsh-auto-approval-llm · countdown re-arm anchor contracts.
 *
 * Fix: updatePanel deleted its intervals entry on expiry; the next scan
 * (every DOM mutation) then re-armed the countdown with the marker's static
 * seconds and left a stale "（0s）" suffix forever. The entry is now kept so
 * the intervals.has() guard stays armed until the panel leaves the DOM, and
 * the clean button text is restored at expiry.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('static anchors: expired countdown keeps its interval entry (no re-arm), suffix restored', () => {
  const client = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  // Expiry stops the ticker only; the entry stays registered (the
  // intervals.has() guard in updatePanel then blocks re-arming). The
  // live-keys sweep in scan() may still release the key — that is the legal
  // delete — so the anchor pins the expiry branch text, not a global absence.
  assert.match(client, /\/\/ Expired: stop ticking but KEEP the key registered/, 'the expiry branch documents the no-re-arm contract')
  // Pinned as "the expiry branch does these things", not as one exact statement
  // sequence: the countdown write-suppression work legitimately inserted
  // suffix-memory cleanup between the restore and the clearInterval, and an
  // adjacency anchor would have reported that as a regression. The negative
  // assertion below is what still holds the no-re-arm contract.
  const expiry = client.match(/\/\/ Expired: stop ticking but KEEP the key registered[\s\S]*?\n {6}\}/)
  assert.ok(expiry, 'the expiry branch must still exist')
  assert.match(expiry[0], /textContent = originalText\(allow\)/, 'expiry restores the clean allow text')
  assert.match(expiry[0], /reject\.textContent = originalText\(reject\)/, 'expiry restores the clean reject text')
  assert.match(expiry[0], /clearInterval\(interval\)/, 'expiry stops the ticker')
  assert.doesNotMatch(expiry[0], /intervals\.delete\(/, 'expiry must not release the key (no re-arm)')
})