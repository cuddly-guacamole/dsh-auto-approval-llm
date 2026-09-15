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
import { riskTimedOutAction, autoPermissionAuthority } from '../lib/index.js'
import { GATED_PRESET } from '../lib/auto/constants.js'

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

test('own-spec restore: the never->ask normalization leaves a durable line', () => {
  // The restore runs inside the host closure; the decision layer emits the
  // audit line and the host wires the helper. Both halves are pinned.
  const lib = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  const moduleLib = readFileSync(fileURLToPath(new URL('../lib/auto/preset-migration.js', import.meta.url)), 'utf8')
  assert.ok(lib.includes('enforceOwnSpec('), 'the host wires the restore helper')
  assert.ok(moduleLib.includes('preset-spec-restore'), 'the decision layer emits the restore audit line')
})

test('own-spec restore: a mid-flight never override is re-read after a deferred tick', () => {
  // agent/created and the boot scan only see a session at its birth; a live
  // session handed a never override must be re-checked from session/event, and
  // the append deferred so it cannot re-enter the publishing append.
  const lib = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  const at = lib.lastIndexOf("event.data?.policy === 'never'")
  assert.ok(at > 0, 'the override checkpoint is wired')
  const scope = lib.slice(at, at + 900)
  assert.ok(scope.includes('setTimeout('), 'the restore is deferred past the append reentrancy guard')
  assert.ok(scope.includes('enforceOwnSpec('), 'the deferred callback re-reads the raw state before restoring')
})

test('autoPermissionAuthority: the raw gate walks the parent chain', () => {
  // A subagent session whose own preset is not gated must still be judged on
  // the parent it inherits from — the same chain the answerer gate reads.
  const parentAgent = (id) => {
    if (id !== 'parent-1') return undefined
    if (parentAgent.cached === undefined) parentAgent.cached = { session: { id: 'parent-1' } }
    return parentAgent.cached
  }
  const parent = parentAgent('parent-1')
  const child = { session: { id: 'child-1', header: { origin: 'subagent', parentSession: 'parent-1' } } }
  const plain = { session: { id: 'solo' } }
  const parentGated = { permissionState: (session) => (session?.id === 'parent-1' ? { preset: GATED_PRESET } : { preset: 'manual' }) }
  assert.equal(autoPermissionAuthority({ agent: child }, parentAgent, parentGated, [GATED_PRESET]), parent)
  const allGated = { permissionState: () => ({ preset: GATED_PRESET }) }
  assert.equal(autoPermissionAuthority({ agent: plain }, parentAgent, allGated, [GATED_PRESET]), plain)
  assert.equal(autoPermissionAuthority({ agent: child }, parentAgent, { permissionState: () => ({ preset: 'manual' }) }, [GATED_PRESET]), undefined)
  // The legacy alias is accepted only when the caller passes the alias set.
  const legacyAuto = { permissionState: () => ({ preset: 'auto' }) }
  assert.equal(autoPermissionAuthority({ agent: plain }, parentAgent, legacyAuto, [GATED_PRESET, 'auto']), plain)
  assert.equal(autoPermissionAuthority({ agent: plain }, parentAgent, legacyAuto, [GATED_PRESET]), undefined)
})
