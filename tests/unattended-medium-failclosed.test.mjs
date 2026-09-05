/**
 * dsh-auto-approval-llm · unattended MEDIUM fail-closed contracts.
 *
 * The LOW branch settles a reviewer failure as rejected immediately in every
 * mode. The MEDIUM branch used to let a failed (or CRITICAL-blocked) verdict
 * fall through to the advisory refresh, so under unattended the countdown
 * expired into riskTimedOutAction('MEDIUM', …, unattended) = allow — a review
 * automation failure was treated like a human timeout. The wiring is inside
 * the answerer closure (not unit-drivable without a host harness), so the
 * behavior is pinned as: the exported pure predicate + the exported timeout
 * action table + a source-wiring anchor on the compiled lib.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { unattendedMustFailClosed, reviewerAutoAllowBlocked } from '../lib/auto/decision.js'
import { riskTimedOutAction } from '../lib/index.js'

test('unattendedMustFailClosed: reviewer failure and CRITICAL-blocked ALLOW must fail closed', () => {
  assert.equal(unattendedMustFailClosed({ decision: 'ESCALATE', failure: 'TIMEOUT' }), true)
  assert.equal(unattendedMustFailClosed({ decision: 'ESCALATE', failure: 'TRANSPORT' }), true)
  assert.equal(unattendedMustFailClosed({ decision: 'ALLOW', riskLevel: 'CRITICAL' }), true)
})

test('unattendedMustFailClosed: decisive and healthy-escalate verdicts stay with the countdown', () => {
  assert.equal(unattendedMustFailClosed({ decision: 'ALLOW', riskLevel: 'HIGH' }), false)
  assert.equal(unattendedMustFailClosed({ decision: 'DENY' }), false)
  assert.equal(unattendedMustFailClosed({ decision: 'ESCALATE' }), false)
})

test('riskTimedOutAction: unattended MEDIUM timeout is allow — the driver the guard pre-empts', () => {
  // Documents the asymmetry: without the guard, any MEDIUM verdict that does
  // not claim the race auto-allows in unattended once the countdown expires.
  assert.equal(riskTimedOutAction('MEDIUM', 'reject', true), 'allow')
  assert.equal(riskTimedOutAction('HIGH', 'allow', true), 'reject', 'HIGH stays fail-closed')
  assert.equal(riskTimedOutAction('MEDIUM', 'reject', false), 'reject')
  assert.equal(riskTimedOutAction('LOW', 'low-risk-allow', false), 'allow')
  assert.equal(riskTimedOutAction('MEDIUM', 'low-risk-allow', false), 'reject')
})

test('MEDIUM branch wiring: the unattended fail-closed guard sits before the takeover block', () => {
  const lib = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  const guardAt = lib.indexOf('if (autoUnattended && unattendedMustFailClosed(review))')
  assert.ok(guardAt > 0, 'the unattended fail-closed guard must be wired in the answerer')
  const takeoverAt = lib.indexOf("if ((llmTakeover || autoUnattended) && !blockedAllow && (review.decision === 'ALLOW' || review.decision === 'DENY'))")
  assert.ok(takeoverAt > guardAt, 'the guard must run before the ALLOW/DENY takeover block')
  // The follow publish mirrors the LOW failure shape (reject + llm-failed
  // resolution so the denial breaker is not fed).
  const scope = lib.slice(guardAt, takeoverAt)
  assert.ok(scope.includes("mediumHandle.claim('rejected')"), 'the guard must claim rejected')
  assert.ok(scope.includes("action: 'reject'"), 'the follow must publish a reject')
  assert.ok(scope.includes("formatDenyFeedback('timeout')"), 'decision feedback must be recorded (LOW parity)')
})

test('reviewerAutoAllowBlocked: only the contradictory CRITICAL ALLOW is blocked', () => {
  assert.equal(reviewerAutoAllowBlocked({ decision: 'ALLOW', riskLevel: 'CRITICAL' }), true)
  assert.equal(reviewerAutoAllowBlocked({ decision: 'ALLOW', riskLevel: 'HIGH' }), false)
  assert.equal(reviewerAutoAllowBlocked({ decision: 'DENY', riskLevel: 'CRITICAL' }), false)
})

test('auto-switch guard: the never->ask flip leaves a debug trail', () => {
  // The guard silently rewrites an Auto session's effective policy; an
  // operator must be able to see why a session stopped auto-answering.
  // Structural anchor on the compiled lib (the flip is a host closure).
  const lib = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  const setPolicyAt = lib.indexOf("approval.setPolicy(agent, 'ask')")
  assert.ok(setPolicyAt > 0, 'the ensureAsk flip is wired')
  const scope = lib.slice(setPolicyAt, setPolicyAt + 400)
  assert.ok(scope.includes("ev: 'auto-switch-never-to-ask'"), 'the flip must emit the debug event')
})
