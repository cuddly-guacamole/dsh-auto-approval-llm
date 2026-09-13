/**
 * A claim that settles a rejection because the reviewer's ALLOW was
 * CRITICAL-flagged and the auto-allow guard refused it must be labeled
 * 'llm-blocked' — not 'llm-allow' (the reviewer never agreed with the
 * outcome) and not 'llm-failed' (the reviewer answered fine; the policy
 * overrode it). The new input rides the same structured channel as
 * reviewerFailure, so the wiring site must derive it from the registered
 * verdict via reviewerAutoAllowBlocked and pass it through.
 * Run: node --test tests/approval-source-critical-block.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { approvalSource } from '../lib/auto/decision.js'

const host = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
const decision = readFileSync(fileURLToPath(new URL('../lib/auto/decision.js', import.meta.url)), 'utf8')

test('a blocked CRITICAL-ALLOW claim is labeled llm-blocked', () => {
  assert.equal(
    approvalSource({ outcome: 'rejected', timedOut: false, claimed: true, auto: false, reviewerDecision: 'ALLOW', reviewerBlockedAllow: true }),
    'llm-blocked',
  )
})

test('without the blocked flag a claimed ALLOW stays llm-allow (no false positives)', () => {
  assert.equal(
    approvalSource({ outcome: 'rejected', timedOut: false, claimed: true, auto: false, reviewerDecision: 'ALLOW' }),
    'llm-allow',
  )
  assert.equal(
    approvalSource({ outcome: 'allowed-once', timedOut: false, claimed: true, auto: false, reviewerDecision: 'ALLOW' }),
    'llm-allow',
  )
})

test('a reviewer failure keeps priority over the blocked-allow flag', () => {
  assert.equal(
    approvalSource({ outcome: 'rejected', timedOut: false, claimed: true, auto: false, reviewerDecision: 'ALLOW', reviewerFailure: true, reviewerBlockedAllow: true }),
    'llm-failed',
  )
})

test('the new word exists once in the policy module and the host wires the flag', () => {
  const wordHits = decision.match(/llm-blocked/g) ?? []
  assert.equal(wordHits.length, 1, `'llm-blocked' must exist exactly once in lib/auto/decision.js, got ${wordHits.length}`)
  // tsc emits the spread as a single `reviewerBlockedAllow: true` property at
  // the approvalSource call site; the derivation keeps its own variable name
  // and calls reviewerAutoAllowBlocked(follow) next to followFailed.
  const wiringHits = host.match(/reviewerBlockedAllow/g) ?? []
  assert.equal(wiringHits.length, 1, `the host must pass reviewerBlockedAllow into approvalSource, got ${wiringHits.length} hits`)
  assert.match(host, /followBlocked = follow !== undefined && reviewerAutoAllowBlocked\(follow\)/)
})
