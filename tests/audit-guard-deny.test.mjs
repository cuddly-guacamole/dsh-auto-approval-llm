/**
 * dsh-auto-approval-llm · host-guard denial audit contracts (F1).
 *
 * The host consults `tools.guard` registrations only after an allow decision,
 * so every guard denial overrides an `allowed-once` record the pre-execute
 * plane just wrote for the same call (the tool never dispatches). These tests
 * pin that a guard denial now appends its own durable history/audit line
 * (source `guard`, outcome rejected, fuse reason carried like the pre-execute
 * `hard-deny` record) without amending the prior record, and that the
 * tool-stats adjudicated-source whitelist keeps the resulting pair from ever
 * being double-tallied as an allow + a deny. The guard wiring cannot be booted
 * in a unit test (it lives inside apply()), so the closure is pinned on the
 * compiled host source exactly like tests/audit-preexecute-lists.test.mjs.
 *
 * Run: node --test tests/audit-guard-deny.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { aggregateToolStats, recordInBucket } from '../lib/auto/tool-stats.js'

const LIB = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

/** The compiled guard registration closure, sliced between its own markers. */
function guardRegion() {
  const start = LIB.indexOf('anyCtx.tools?.guard?.((exec) => {')
  const end = LIB.indexOf('// ── direct-human-approval tool', start)
  assert.ok(start !== -1, 'the guard registration is locatable')
  assert.ok(end > start, 'the guard registration ends before the direct-human block')
  return LIB.slice(start, end)
}

test('guard deny: exactly one history+audit record (source guard, outcome rejected) precedes the denial', () => {
  const region = guardRegion()
  const pushes = region.split('pushHistory(').length - 1
  assert.equal(pushes, 1, 'one guard denial writes exactly one decision record')
  const recordStart = region.indexOf('pushHistory({')
  const recordEnd = region.indexOf('})', recordStart)
  const recordBody = region.slice(recordStart, recordEnd)
  assert.ok(recordBody.includes("sessionId: authorityKeyFor(exec)"), 'record is keyed on the Auto authority session')
  assert.ok(recordBody.includes('toolName: exec.name'), 'record carries the tool name')
  assert.ok(recordBody.includes("outcome: 'rejected'"), 'a guard denial is recorded as rejected')
  assert.ok(recordBody.includes("source: 'guard'"), 'a guard denial carries its own source (separable from hard-deny)')
  assert.ok(recordBody.includes('reason,'), 'the fuse denial reason is handed to the audit record')
})

test('guard deny: non-denials return before any record; the record precedes the returned reason', () => {
  const region = guardRegion()
  const autoIdx = region.indexOf('if (!isAutoExecution(exec))')
  const undefIdx = region.indexOf('if (reason === undefined)')
  const pushIdx = region.indexOf('pushHistory(')
  const retIdx = region.indexOf('return reason')
  assert.ok(autoIdx !== -1 && autoIdx < pushIdx, 'non-Auto executions never record')
  assert.ok(undefIdx !== -1 && undefIdx < pushIdx, 'a pass (undefined reason) records nothing')
  assert.ok(pushIdx < retIdx, 'every denial is recorded before the reason is returned to the host')
  // Both fuse checks funnel into one audited terminal — no early unrecorded
  // return of a fuse result can bypass the audit.
  assert.ok(!/return hard/.test(region), 'the hard fuse does not return before the audit')
  assert.ok(!/return symlinkEscapeReason/.test(region), 'the symlink fuse does not return before the audit')
})

test('guard deny: a recording failure never softens the denial and never stays silent', () => {
  const region = guardRegion()
  assert.ok(region.includes('guard-deny-audit-failure'), 'a failed audit append leaves a debug trace')
  assert.ok(region.includes('guard-deny-record-error'), 'a record exception leaves a debug trace')
  assert.ok(region.includes('the call stays denied'), 'both failure channels state the denial stands')
  // The terminal `return reason` sits outside the try/catch, so whatever the
  // record attempt does the host still receives the fuse reason — a broken
  // audit can never let the guarded call dispatch.
  const catchIdx = region.indexOf('catch (error)')
  const retIdx = region.indexOf('return reason')
  assert.ok(catchIdx !== -1 && retIdx > catchIdx, 'the denial return is unconditional after the record attempt')
})

// ── aggregation semantics (terminal state of a fused call) ────────────────
test('tool-stats: guard and the static fuses are not adjudications — a fused call is never double-tallied', () => {
  const fusedPair = [
    { toolName: 'write', outcome: 'allowed-once', source: 'static-allow' },
    { toolName: 'write', outcome: 'rejected', source: 'guard' },
  ]
  for (const tab of ['allow', 'deny', 'human']) {
    assert.equal(recordInBucket({ toolName: 'write', outcome: 'allowed-once', source: 'static-allow' }, tab), false, `static-allow outside ${tab}`)
    assert.equal(recordInBucket({ toolName: 'write', outcome: 'rejected', source: 'guard' }, tab), false, `guard outside ${tab}`)
    assert.equal(recordInBucket({ toolName: 'write', outcome: 'rejected', source: 'hard-deny' }, tab), false, `hard-deny outside ${tab}`)
  }
  // The chips whitelist keeps BOTH lines of a fused call out of every bucket:
  // the pre-execute allow never surfaces alone and the pair is never counted
  // once as an allow and once as a deny.
  const stats = aggregateToolStats(fusedPair)
  assert.deepEqual(stats.allow, [], 'the fused call never counts as an allow')
  assert.deepEqual(stats.deny, [], 'the fused call never counts as a deny')
  assert.deepEqual(stats.human, [], 'the fused call never counts as a human decision')
  assert.deepEqual(stats.humanDenied, [], 'the fused call never marks the tool human-denied')
})

test('tool-stats: the guard line is a rejection, never a second allowed-once (no allow+allow terminal)', () => {
  // A guard override can only ever append `outcome: rejected` after the
  // pre-execute allow line — the terminal record of the pair is a denial, so
  // no aggregation can read the same call as two allows.
  const pair = [
    { toolName: 'read', outcome: 'allowed-once', source: 'allowlist-allow' },
    { toolName: 'read', outcome: 'rejected', source: 'guard' },
  ]
  assert.equal(pair.filter((r) => r.outcome === 'allowed-once').length, 1)
  assert.equal(pair.filter((r) => r.outcome === 'rejected').length, 1)
  assert.equal(pair[pair.length - 1].outcome, 'rejected', 'the later guard line is the terminal state')
  // Allowlist-allow and guard are both non-adjudicated fuse-plane sources, so
  // even the historical line cannot inflate the allow chips.
  const stats = aggregateToolStats(pair)
  assert.deepEqual(stats.allow, [])
  assert.deepEqual(stats.deny, [])
})
