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
  assert.match(
    client,
    /originalText\(allow\)\r?\n\s*else if \(reject\) reject\.textContent = originalText\(reject\)\r?\n\s*clearInterval\(interval\)/,
    'expiry restores the clean button text and stops the ticker without deleting the entry',
  )
})