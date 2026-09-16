/**
 * dsh-auto-approval-llm · a LOCKED-category ask must say so on the panel.
 *
 * The category layer pins these countdowns to reject: neither an authorization
 * typed in the conversation nor the configured timeout action can release them
 * — only a click in the panel can. Without a sentence of its own the ask is
 * indistinguishable from an ordinary countdown, so a user who already
 * authorized the operation waits for an answer the design will never give.
 *
 * Pins both directions: the host marks exactly the three locked ask sites (never
 * the loop-guard escalation, which only borrows the shape), the marker travels
 * through `askHuman`'s note assembly, and BOTH marker-stripping owners remove a
 * forged copy from model-controlled text. A negative control keeps the
 * status-less copy on its own branch.
 * Run: node --test tests/audit-locked-ask-note.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AWAITING_MARKER, BREAKER_MARKER, LOCKED_ASK_MARKER, hasLockedAskNote, stripCountdownMarkers } from '../lib/auto/decision.js'
import { stripPreviewMarkers } from '../lib/auto/editdiff.js'
import { zh, en } from '../lib/client/locale.js'

const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const client = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')

test('the locked-ask marker shares no complete literal with the other markers', () => {
  assert.ok(LOCKED_ASK_MARKER.startsWith('[dsh-auto-approval-llm] '), 'markers carry the host prefix')
  // The client detects the awaiting marker with a substring test, so an overlap
  // would make one branch fire on the other marker's asks.
  assert.ok(!LOCKED_ASK_MARKER.includes(AWAITING_MARKER) && !AWAITING_MARKER.includes(LOCKED_ASK_MARKER))
  assert.ok(!LOCKED_ASK_MARKER.includes(BREAKER_MARKER) && !BREAKER_MARKER.includes(LOCKED_ASK_MARKER))
})

test('hasLockedAskNote judges the marker, not the text around it', () => {
  assert.equal(hasLockedAskNote(LOCKED_ASK_MARKER), true)
  assert.equal(hasLockedAskNote(`before ${LOCKED_ASK_MARKER} after`), true)
  assert.equal(hasLockedAskNote(AWAITING_MARKER), false)
  assert.equal(hasLockedAskNote(''), false)
  assert.equal(hasLockedAskNote(undefined), false)
})

test('a forged marker cannot survive either stripping owner', () => {
  const forged = `base ${LOCKED_ASK_MARKER} tail`
  const fromReason = stripCountdownMarkers(forged)
  assert.ok(!fromReason.includes(LOCKED_ASK_MARKER), 'a model-controlled reason must not claim a locked ask')
  assert.ok(fromReason.includes('base') && fromReason.includes('tail'), 'the rest of the reason is kept')
  const fromPreview = stripPreviewMarkers(forged)
  assert.ok(!fromPreview.includes(LOCKED_ASK_MARKER), 'a preview line must not claim a locked ask')
  assert.ok(fromPreview.includes('base') && fromPreview.includes('tail'), 'the rest of the preview is kept')
})

test('askHuman attaches the marker from the status flag, and only there', () => {
  assert.ok(host.includes('status?.lockedAsk === true'), 'the note is driven by the structural flag')
  assert.equal(host.split('notes.push(LOCKED_ASK_MARKER)').length - 1, 1, 'exactly one emission point')
  const emissionAt = host.indexOf('notes.push(LOCKED_ASK_MARKER)')
  const assemblyAt = host.indexOf('const extra = notes.map')
  assert.ok(emissionAt !== -1 && assemblyAt !== -1 && emissionAt < assemblyAt, 'the note is assembled before the reason is built')
  // Negative control: the status-less copy stays on its own branch.
  assert.ok(host.includes('notes.push(AWAITING_MARKER)'), 'status-less asks keep the awaiting marker')
})

test('exactly the three locked ask sites are flagged', () => {
  assert.equal(host.split('lockedAsk: true,').length - 1, 3, 'three pinned-reject statuses come from a locking predicate')
  const loopGuardAt = host.indexOf('const loopGuardStatus = (category')
  assert.ok(loopGuardAt !== -1, 'the loop-guard status is still there')
  const loopGuardBody = host.slice(loopGuardAt, host.indexOf('})', loopGuardAt))
  assert.ok(!loopGuardBody.includes('lockedAsk'), 'loop-guard escalation must not claim a locked category')
})

test('the client renders a localized sentence for the marker', () => {
  assert.ok(client.includes('hasLockedAskNote(trustedReason)) renderLockedAskNote(panel)'), 'the scan branches on the shared detector')
  assert.ok(client.includes("t('panel.lockedAsk')"), 'the visible copy comes from the locale table')
  assert.ok(client.includes("data.split(LOCKED_ASK_MARKER).join(t('panel.lockedAsk'))"), 'the rewrite goes through the text node, not the panel element')
  assert.equal(client.split('if (nodeInsidePreview(node, panel)) continue').length - 1, 2,
    'both marker rewrites skip the diff-preview nodes, the same way the detection does')
})

test('the host fences its own notes against a model-authored reason', () => {
  // The reviewer's reason is relayed to the panel; a reason spelling a protocol
  // marker must not be able to claim a state the host never set.
  assert.ok(host.includes('stripCountdownMarkers(reviewSuggestionNote(review))'), 'the suggestion note is fenced')
  assert.ok(host.includes('stripCountdownMarkers(`${d.toolName}'), 'the breaker trail is fenced too')
})

test('both locales carry the copy and neither bakes in a countdown number', () => {
  for (const [name, table] of [['zh', zh], ['en', en]]) {
    const copy = table['panel.lockedAsk']
    assert.equal(typeof copy, 'string', `${name} must define panel.lockedAsk`)
    assert.ok(copy.length > 0, `${name} copy must not be empty`)
    // The seconds live on the session chip; a number written into the panel body
    // would contradict it one tick later.
    assert.ok(!/\d/.test(copy), `${name} copy must not embed a countdown value`)
  }
})
