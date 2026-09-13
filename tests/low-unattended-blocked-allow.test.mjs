/**
 * The LOW branch must carry the same unattended fail-closed guard the MEDIUM
 * branch has: a CRITICAL-flagged ALLOW the auto-allow guard refused must not
 * ride the LOW countdown into riskTimedOutAction('LOW', …, unattended) =
 * allow. The guard stays scoped to that shape — a genuine ESCALATE (no
 * failure, no CRITICAL flag) keeps the deliberate hand-off to the human
 * countdown, and attended sessions keep the standing human ask.
 * Run: node --test tests/low-unattended-blocked-allow.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { unattendedMustFailClosed } from '../lib/auto/decision.js'

const host = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')

test('the fail-closed guard stays scoped: escalation hand-off is out, blocked allow is in', () => {
  assert.equal(unattendedMustFailClosed({ decision: 'ESCALATE' }), false)
  assert.equal(unattendedMustFailClosed({ decision: 'ESCALATE', failure: 'timeout' }), true)
  assert.equal(unattendedMustFailClosed({ decision: 'ALLOW', riskLevel: 'CRITICAL' }), true)
})

test('both the LOW and the MEDIUM branches consult the guard', () => {
  const hits = host.match(/unattendedMustFailClosed\(/g) ?? []
  assert.equal(hits.length, 2, `LOW and MEDIUM must each call the guard, got ${hits.length}`)
})

test('the LOW branch settles a rejection through its own handle for the blocked shape', () => {
  const claims = host.match(/lowHandle\.claim\('rejected'\)/g) ?? []
  assert.equal(claims.length, 3, `LOW claims rejections for deny, reviewer-failure and blocked-allow, got ${claims.length}`)
})
