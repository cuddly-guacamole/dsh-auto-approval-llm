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

test('static anchor: the countdown renderer suppresses unchanged writes', () => {
  const client = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  assert.match(client, /shouldWriteCountdownSuffix\(/, 'renderSuffix must consult the predicate')
  // The suffix must still come from the single formatting owner.
  assert.match(client, /formatCountdownSuffix\(/, 'the displayed shape must stay centralized')
  // Whatever remembers the last written string must be cleared when the panel
  // is released, or a re-armed panel could inherit a stale "already written".
  const updatePanel = client.match(/const updatePanel = \(panel: any, key: string, info: CountdownInfo\) => \{[\s\S]*?\n {2}\}\r?\n/)
  assert.ok(updatePanel, 'updatePanel must still exist')
  assert.match(updatePanel[0], /lastSuffix\.delete\(/, 'the per-button memory must be released')
})

test('static anchor: the suffix memory is keyed per button, not per panel', () => {
  const client = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  assert.match(client, /new WeakMap[<(]/, 'the memory must not keep detached buttons alive')
})
