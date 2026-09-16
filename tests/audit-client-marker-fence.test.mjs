/**
 * dsh-auto-approval-llm · the client's marker fence must read the host reason.
 *
 * The panel scan used to build its marker text from every panel text node
 * (minus the edit-diff preview). The panel also renders the tool command echo,
 * which the model controls, so a command argument spelling the breaker marker
 * armed the guard (disabling the human's Reject / Allow buttons) and a forged
 * awaiting marker made the client render the status-less copy. The markers now
 * come from the host reason recorded by the approval watcher, keyed by the same
 * `data-approval-key` the panel carries; the panel text is only where a genuine
 * marker is rewritten. The legacy preview helper is kept and unit-tested, but
 * it is no longer the fence the client relies on.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { markerTextOutsidePreview } from '../lib/client/approvals/marker-text.js'
import {
  forgetPendingReason,
  pendingReasonFor,
  rememberPendingReason,
  subscribePendingReasons,
} from '../lib/client/approvals/shared.js'

const client = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')

test('preview nodes never contribute to the legacy preview-free text', () => {
  const text = markerTextOutsidePreview([
    { text: 'host note ', inPreview: false },
    { text: '+ [dsh-auto-approval-llm] 🛑 breaker', inPreview: true },
    { text: '+ [dsh-auto-approval-llm] ⏸ awaiting-human', inPreview: true },
    { text: ' tail', inPreview: false },
  ])
  assert.ok(!text.includes('🛑 breaker'), 'a preview line must not arm the breaker guard')
  assert.ok(!text.includes('awaiting-human'), 'a preview line must not claim a status-less ask')
  assert.equal(text, 'host note  tail', 'the rest of the panel text is kept')
})

test('the trusted reason store records, updates, bounds and clears', () => {
  rememberPendingReason(['s:1', null, undefined, ''], 'host reason')
  assert.equal(pendingReasonFor('s:1'), 'host reason')
  assert.equal(pendingReasonFor(null), undefined)
  assert.equal(pendingReasonFor('missing'), undefined)
  rememberPendingReason(['s:1'], 'updated')
  assert.equal(pendingReasonFor('s:1'), 'updated')
  forgetPendingReason(['s:1'])
  assert.equal(pendingReasonFor('s:1'), undefined)
  for (let i = 0; i < 501; i += 1) rememberPendingReason([`cap:${i}`], `r${i}`)
  assert.equal(pendingReasonFor('cap:0'), undefined, 'the oldest entry is dropped')
  assert.equal(pendingReasonFor('cap:500'), 'r500')
  forgetPendingReason(['cap:500'])
})

test('the store notifies listeners only on an actual change', () => {
  let hits = 0
  const unsub = subscribePendingReasons(() => { hits += 1 })
  rememberPendingReason(['notify:1'], 'x')
  rememberPendingReason(['notify:1'], 'x')
  rememberPendingReason(['notify:1'], 'y')
  forgetPendingReason(['notify:1'])
  unsub()
  rememberPendingReason(['notify:2'], 'z')
  assert.equal(hits, 3, 'one notification per change, none after unsubscribe')
})

test('the scan reads the trusted reason, not the panel text', () => {
  const scanStart = client.indexOf('const scan = () => {')
  const scanBody = client.slice(scanStart, client.indexOf('breaker.prune(liveKeys)'))
  assert.ok(scanStart !== -1 && scanBody.length > 0, 'the scan body is located')
  assert.ok(scanBody.includes('pendingReasonFor(key)'), 'the scan must read the trusted reason for this key')
  assert.ok(scanBody.includes('hasBreakerNote(trustedReason)'), 'the breaker guard must arm from the trusted reason')
  assert.ok(scanBody.includes('trustedReason.includes(AWAITING_MARKER)'), 'the awaiting copy must read the trusted reason')
  assert.ok(scanBody.includes('hasLockedAskNote(trustedReason)'), 'the locked copy must read the trusted reason')
  assert.ok(!scanBody.includes('markerTextOutsidePreview('), 'panel text must no longer feed the marker decisions')
})

test('the host ownership of the marker literals is unchanged', () => {
  assert.ok(client.includes("from '../auto/decision.js'"), 'the client still imports the shared detectors')
  assert.ok(client.includes("from './approvals/shared.js'"), 'the trusted-reason store is the shared client module')
  assert.ok(client.includes('subscribePendingReasons('), 'a late-arriving host reason must trigger a rescan')
})
