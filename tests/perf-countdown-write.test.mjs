/**
 * dsh-auto-approval-llm · countdown suffix write suppression.
 *
 * `renderSuffix` ran unconditionally on a 200ms interval, and every write into
 * the button's textContent lands in the body-level MutationObserver that then
 * runs a full document scan — a visible countdown therefore drove ~5 extra
 * scans/second of its own accord. The write is now skipped when the string did
 * not change.
 *
 * Suppression is only safe because it is *string* equality: every real change
 * (the per-second tick, the walk back to clean text, the offline freeze marker)
 * still writes. The negative cases below pin that — a never-writing
 * implementation must fail this file.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { formatCountdownSuffix, shouldWriteCountdownSuffix } from '../lib/client/approvals/shared.js'

test('shouldWriteCountdownSuffix: an unchanged string is not written', () => {
  assert.equal(shouldWriteCountdownSuffix('（8s）', '（8s）'), false)
  assert.equal(shouldWriteCountdownSuffix('（8s·断线）', '（8s·断线）'), false)
})

test('shouldWriteCountdownSuffix: every real change is written', () => {
  // First paint of a panel has no previous value.
  assert.equal(shouldWriteCountdownSuffix(undefined, '（8s）'), true)
  // The per-second tick.
  assert.equal(shouldWriteCountdownSuffix('（8s）', '（7s）'), true)
  assert.equal(shouldWriteCountdownSuffix('（1s）', '（0s）'), true)
  // Entering and leaving the offline freeze.
  assert.equal(shouldWriteCountdownSuffix('（8s）', '（8s·断线）'), true)
  assert.equal(shouldWriteCountdownSuffix('（8s·断线）', '（8s）'), true)
  // Back to the clean label.
  assert.equal(shouldWriteCountdownSuffix('（0s）', ''), true)
})

test('the interval tick writes only when the rendered string changed', () => {
  // Drive the same sequence apply() produces: 5 ticks inside one second.
  let previous
  let writes = 0
  for (const next of ['（8s）', '（8s）', '（8s）', '（8s）', '（7s）']) {
    if (shouldWriteCountdownSuffix(previous, next)) {
      writes += 1
      previous = next
    }
  }
  assert.equal(writes, 2, 'one write per second, not one per tick')
})

test('static anchor: the countdown renderer compares against the live button text', () => {
  const client = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  assert.match(client, /shouldWriteCountdownSuffix\(/, 'renderSuffix must consult the predicate')
  // The suffix must still come from the single formatting owner.
  assert.match(client, /formatCountdownSuffix\(/, 'the displayed shape must stay centralized')
  // The "previous" value must be read from the DOM, not remembered: the
  // official panel owns this button and may rewrite the label between ticks,
  // and a remembered copy would suppress the restore and drop the countdown.
  const render = client.match(/const renderSuffix = \(remaining: number, offline: boolean\) => \{[\s\S]*?\n {4}\}/)
  assert.ok(render, 'renderSuffix must still exist')
  assert.match(render[0], /shouldWriteCountdownSuffix\(button\.textContent/, 'the comparison must read the DOM')
  assert.doesNotMatch(render[0], /lastSuffix/, 'no remembered-copy state may gate the write')
})

test('static anchor: no remembered suffix copy was left behind', () => {
  const client = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(client, /lastSuffix/, 'the memoized variant must not creep back in')
})
