/**
 * dsh-auto-approval-llm · loop guard wiring: exactly the auto-allow sites are
 * gated, the escalation settles into the pinned locked shape, and neither the
 * breaker nor the allow trail is touched.
 *
 * Structural anchors mirror the LP3 discipline: every gated site is counted,
 * exempt channels are pinned by negative slices (so "accidentally gating the
 * allowlist" reddens just like "forgetting a site"), and the cross-plane pin
 * is read exactly between the deny terminals and the static allow that would
 * otherwise swallow the escalated call.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { formatAuditLine, OBSERVATION_FIELDS } from '../scripts/audit-query.mjs'

const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const built = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

test('the loop gate fires at exactly the four auto-allow sites, in both planes', () => {
  assert.equal([...host.matchAll(/loopGateFires\(/g)].length, 4, 'static-allow + classifier-allow in pre-execute, static-allow + auto-allow in the answerer')
  assert.equal([...built.matchAll(/loopGateFires\(/g)].length, 4, 'the compiled bundle keeps the same wiring')
})

test('the allowlist and declared-rule channels stay exempt (negative slices)', () => {
  const allowlistAt = host.indexOf("source: 'allowlist-allow'")
  assert.ok(allowlistAt > 0, 'the allowlist site is locatable')
  const allowlistSlice = host.slice(allowlistAt - 900, allowlistAt + 400)
  assert.ok(!allowlistSlice.includes('loopGateFires('), "the operator's declared intent is not loop-gated")
  for (const ruleAt of [...host.matchAll(/source: 'rule-allow'/g)].map((m) => m.index)) {
    const ruleSlice = host.slice(ruleAt - 700, ruleAt + 300)
    assert.ok(!ruleSlice.includes('loopGateFires('), 'the declared-rule allow channel stays exempt')
  }
})

test('the cross-plane pin is read after the deny terminals and before the static allow', () => {
  const categoryDenyAt = host.indexOf("source: 'category-deny'")
  const denyTerminalAt = host.indexOf("return 'rejected'", categoryDenyAt)
  const pinReadAt = host.indexOf('loopGuardPinned.get(req.callId)')
  const lockRefusalAt = host.indexOf('nameChannelLockRefusal({', pinReadAt)
  const staticAllowAt = host.indexOf("if (staticDecision.kind === 'allow') {", pinReadAt)
  assert.ok(categoryDenyAt > 0 && denyTerminalAt > categoryDenyAt, 'the category-deny terminal is locatable')
  assert.ok(pinReadAt > denyTerminalAt, 'the pin is read after the deny terminals (they keep winning)')
  assert.ok(pinReadAt < lockRefusalAt && pinReadAt < staticAllowAt, 'the pin is read before the static allow that would swallow the escalated call')
  const oneShot = host.slice(pinReadAt, pinReadAt + 300)
  assert.ok(oneShot.includes('loopGuardPinned.delete(req.callId)'), 'the pin is consumed on first read (no replay can re-pin a later ask)')
})

test('the escalated ask settles into the pinned locked shape, before the learning query', () => {
  const shape = 'askHuman(req, undefined, next, false, loopGuardStatus(classified.category))'
  assert.equal([...host.matchAll(new RegExp(shape.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].length, 3, 'one cross-plane read + two answerer-plane gates share the pinned shape')
  const statusAt = host.indexOf('const loopGuardStatus = (category: string | undefined): ReviewStatus => ({')
  const status = host.slice(statusAt, statusAt + 400)
  assert.ok(status.includes("action: 'reject'") && status.includes("phase: 'countdown'"), 'the countdown is pinned to reject — unattended it settles as timeout-deny')
  assert.ok(status.includes('config.highRiskSeconds') && !status.includes('riskSeconds('), 'the window mirrors the LOCKED precedent')
  assert.ok(!status.includes('learnable'), 'the pinned ask carries no learnable context')
  const firstPinAt = host.indexOf('loopGuardStatus(classified.category)')
  const learnAttemptAt = host.indexOf('await learnAttempt(')
  assert.ok(firstPinAt > 0 && learnAttemptAt > firstPinAt, 'the escalation path precedes the learning query, so learning can neither answer nor feed on it')
})

test('the gate itself never writes history and never touches the breaker', () => {
  const gateAt = host.indexOf('const loopGateFires = (')
  const gate = host.slice(gateAt, host.indexOf('const loopGuardStatus', gateAt))
  assert.ok(gate.length > 100, 'the gate body is locatable')
  assert.ok(!gate.includes('pushHistory'), 'no history row from the gate itself')
  assert.ok(!gate.includes('applyBreaker') && !gate.includes('denials'), 'the breaker counters stay untouched (no double counting)')
  assert.ok(gate.includes("type: 'loop-guard'") && gate.includes("ev: 'loop-guard'"), 'the escalation leaves a non-decision provenance trail instead')
})

test('the loop state is released with its session and swept with the feedback maps', () => {
  const body = host.slice(host.indexOf("anyCtx.on('session/disposed'", host.indexOf('trustedIntentReported.delete(key)') - 3000))
  assert.ok(body.includes('loopStates.delete(key)'), 'the per-session streak map joins the existing disposal handler')
  assert.ok(!host.includes('loopStates.clear()'), 'no global clear: a disposed session must not drop live sessions')
  const sweepAt = host.indexOf('function sweepFeedbackMaps(): void {')
  const sweep = host.slice(sweepAt, sweepAt + 400)
  assert.ok(sweep.includes('sweepFeedback(loopGuardPinned, { ttlMs: 60_000, maxEntries: 256 })'), 'the one-shot pin inherits the bounded feedback-map sweep')
})

test('audit-query renders the loop-guard provenance fields', () => {
  assert.ok(OBSERVATION_FIELDS.includes('consecutive') && OBSERVATION_FIELDS.includes('threshold'), 'the field table knows the event shape')
  const line = formatAuditLine({ type: 'loop-guard', at: 1, callId: 'c', sessionId: 's', toolName: 'bash', consecutive: 3, threshold: 3 })
  assert.ok(line.startsWith('[loop-guard] ') && line.includes('consecutive=3') && line.includes('threshold=3'), 'the escalation is answerable from the audit trail')
})
